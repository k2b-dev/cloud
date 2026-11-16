import { expect, spyOn } from "bun:test";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import {
  AI_MESSAGE_QUEUE_LIMIT,
  assertQueuedMessageQuota,
  drainQueuedMessages,
  editQueuedMessage,
  enqueueChatMessage,
  listQueuedMessages,
  migrateAiMessageQueue,
  queuedMessageReceipt,
  reconcileQueuedInterruptions,
  requestQueuedMessageSendNow,
  updateQueuedMessage,
} from "./message-queue";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { AiQuotaError, aiQuotas } from "./quotas";
import { aiConversations } from "./store";
import { aiToolAudit } from "./tool-audit";
import type { AiConversationService } from "./types";

const integration = testFor("database");
type Submission = Parameters<AiConversationService["submitChatTurn"]>[0];

const fixture = async () => {
  await migrateAiMessageQueue();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
    VALUES (${crypto.randomUUID()},'local','user','Queue owner','queue-owner@example.test','Queue','Owner') RETURNING id`;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  const input = (text: string, origin: AiStoredMessageOrigin = { kind: "person", id: user!.id }): Submission => ({
    conversationId: chat.id,
    modelId: "fixture",
    userMessage: { role: "user", content: [{ type: "text", text }] },
    runConfig: {
      kind: "chat",
      input: text,
      accessSubject: { type: "user", userId: user!.id },
      writerOrigin: origin,
      toolSource: { kind: "none" },
    },
  });
  const add = async (text: string, origin?: AiStoredMessageOrigin) => {
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input(text, origin), [{ type: "text", text }]);
    return id;
  };
  return {
    chat,
    userId: user!.id,
    input,
    add,
    async close() {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    },
  };
};

integration("one FIFO combines people, automations and chats; only the person's own entry can be edited", async () => {
  const f = await fixture();
  try {
    const person = await f.add("From me");
    const automation = await f.add("From Code", { kind: "automation", id: "code-version", runId: "code-run" });
    const otherChat = await f.add("From chat", { kind: "chat", id: f.chat.shortId, turnId: "source-turn" });
    const entries = await listQueuedMessages(f.chat.id, { userId: f.userId });
    expect(entries.map(({ id, origin, authorIsViewer }) => [id, origin.kind, authorIsViewer])).toEqual([
      [person, "person", true],
      [automation, "automation", false],
      [otherChat, "chat", false],
    ]);
    expect(entries[2]?.origin).toMatchObject({ name: f.chat.title, href: `/app/assistant?conversation=${f.chat.shortId}` });
    const hidden = await listQueuedMessages(f.chat.id, { userId: "00000000-0000-4000-8000-000000000099" });
    expect(hidden[2]?.origin).toEqual({ kind: "chat", id: f.chat.shortId, name: f.chat.title });
    expect(await editQueuedMessage(f.chat.id, automation, "Changed", f.userId)).toBe(false);
    expect(await editQueuedMessage(f.chat.id, person, "Edited", f.userId)).toBe(true);
    expect(await updateQueuedMessage(f.chat.id, automation, "cancel")).toBe(true);
    const jobs: Array<{ conversationId: string; turnId: string }> = [];
    await drainQueuedMessages(async (job) => {
      jobs.push(job);
    }, f.chat.id);
    expect(jobs).toHaveLength(1);
    expect((await aiConversations.listMessages({ conversationId: f.chat.id }))[0]?.meta?.writerOrigin).toEqual({
      kind: "person",
      id: f.userId,
    });
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([otherChat]);
  } finally {
    await f.close();
  }
});

integration("the personal queue limit retains legacy entries above the limit", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < AI_MESSAGE_QUEUE_LIMIT; i++) await f.add(`Entry ${i}`);
    await expect(f.add("Overflow")).rejects.toThrow(`full (${AI_MESSAGE_QUEUE_LIMIT} messages)`);
    const legacy = crypto.randomUUID();
    await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,origin,author_user_id)
      VALUES (${legacy}::uuid,${f.chat.id}::uuid,${JSON.stringify(f.input("Legacy"))}::text::jsonb,'[]'::jsonb,NULL,NULL)`;
    await migrateAiMessageQueue();
    expect(await listQueuedMessages(f.chat.id)).toHaveLength(AI_MESSAGE_QUEUE_LIMIT + 1);
    await expect(f.add("Still full")).rejects.toThrow("full");
    expect((await listQueuedMessages(f.chat.id, { userId: f.userId })).at(-1)).toMatchObject({ id: legacy, authorIsViewer: true });
  } finally {
    await f.close();
  }
});

integration("a service-account subject cannot bypass personal-chat ownership through the queue", async () => {
  const f = await fixture();
  try {
    const submission = f.input("Mailbox Code", { kind: "automation", id: "mailbox-code" });
    submission.runConfig.accessSubject = { type: "service_account", serviceAccountId: f.userId };
    await expect(enqueueChatMessage(crypto.randomUUID(), submission, [{ type: "text", text: "Mailbox Code" }])).rejects.toThrow(
      "owning person's",
    );
    expect(await listQueuedMessages(f.chat.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

integration("a composer entry stays queued during an approval wait and consumes the submitted draft", async () => {
  const f = await fixture();
  try {
    const { turn } = await aiConversations.submitChatTurn(f.input("Waiting"));
    await sql`UPDATE ai.turns SET status='waiting_for_action' WHERE id=${turn.id}::uuid`;
    const draft = await aiConversations.saveDraft({
      conversationId: f.chat.id,
      ownerUserId: f.userId,
      expectedRevision: 0,
      content: [{ type: "text", text: "Still typing" }],
    });
    expect(draft.ok).toBe(true);
    const submission = f.input("Still typing");
    submission.expectedDraftRevision = 1;
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, submission, [{ type: "text", text: "Still typing" }]);
    const jobs: unknown[] = [];
    await drainQueuedMessages(async (job) => {
      jobs.push(job);
    }, f.chat.id);
    expect(jobs).toEqual([]);
    expect((await listQueuedMessages(f.chat.id))[0]?.id).toBe(id);
    expect((await aiConversations.getConversation({ conversationId: f.chat.id }))?.draft.content).toEqual([]);
  } finally {
    await f.close();
  }
});

integration("quota rejection marks not sent before it can interrupt the current turn", async () => {
  const f = await fixture();
  const quota = spyOn(aiQuotas, "assertAllowed").mockRejectedValue(new AiQuotaError("quota_exhausted", "Fixture quota exhausted"));
  try {
    const { turn } = await aiConversations.submitChatTurn(f.input("Continue current work"));
    const submission = f.input("Urgent");
    submission.runConfig.assistantChat = true;
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, submission, [{ type: "text", text: "Urgent" }]);
    await expect(assertQueuedMessageQuota(f.chat.id, id)).rejects.toThrow("Fixture quota exhausted");
    expect(quota).toHaveBeenCalledWith({ type: "user", userId: f.userId }, "fixture");
    expect((await listQueuedMessages(f.chat.id))[0]?.state).toBe("failed");
    expect((await aiConversations.getTurn({ conversationId: f.chat.id, turnId: turn.id }))?.cancelRequestedAt).toBeNull();
  } finally {
    quota.mockRestore();
    await f.close();
  }
});

integration("send now is idempotent, keeps other positions, and supplies interrupted-turn context", async () => {
  const f = await fixture();
  try {
    const { turn } = await aiConversations.submitChatTurn(f.input("Old turn"));
    const first = await f.add("First");
    const now = await f.add("Urgent");
    const last = await f.add("Last");
    const request = await requestQueuedMessageSendNow(f.chat.id, now);
    expect(request?.interrupt?.request).toMatchObject({ found: true, ownerless: true });
    expect(await queuedMessageReceipt(f.chat.id, now)).toMatchObject({ state: "sending", turnId: null });
    await requestQueuedMessageSendNow(f.chat.id, now);
    expect(await aiConversations.completeTurn({ conversationId: f.chat.id, turnId: turn.id, status: "completed" })).toBe("interrupted");
    expect((await aiConversations.listMessages({ conversationId: f.chat.id })).at(-1)?.meta?.queueInterrupted).toBe(true);
    const jobs: Array<{ conversationId: string; turnId: string }> = [];
    const push = async (job: { conversationId: string; turnId: string }) => {
      jobs.push(job);
    };
    await Promise.all([drainQueuedMessages(push, f.chat.id), drainQueuedMessages(push, f.chat.id)]);
    expect(jobs).toHaveLength(1);
    const next = await aiConversations.getTurnRunConfig({ conversationId: f.chat.id, turnId: jobs[0]!.turnId });
    const prompt = next?.kind !== "compact" ? (next?.systemPrompt ?? "") : "";
    expect(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1))).toMatchObject({
      interruptedTurnId: turn.shortId,
      messageOrigin: { kind: "person", id: f.userId },
    });
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([first, last]);
    await requestQueuedMessageSendNow(f.chat.id, now);
    await drainQueuedMessages(push, f.chat.id);
    expect(jobs).toHaveLength(1);
    expect(await queuedMessageReceipt(f.chat.id, now)).toMatchObject({ state: "submitted" });
  } finally {
    await f.close();
  }
});

for (const outcome of ["finished", "expired", "unknown"] as const) {
  integration(`client effect ${outcome}: wait on the existing deadline, journal once or leave the entry not sent`, async () => {
    const f = await fixture();
    try {
      const { turn } = await aiConversations.submitChatTurn(f.input("Run local tool"));
      const claim = await aiConversations.claimTurn({
        conversationId: f.chat.id,
        turnId: turn.id,
        leaseOwner: "client-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      expect(claim).not.toBeNull();
      await aiConversations.savePendingTurnAction({
        conversationId: f.chat.id,
        turnId: turn.id,
        callId: "local-call",
        kind: "client_tool",
        status: "pending",
        name: "local_bash",
        args: { command: "effect" },
        approvalScope: "local",
        allowAlways: false,
        frontendMode: "client",
        resolvedEvent: null,
      });
      await aiConversations.suspendTurn({
        conversationId: f.chat.id,
        turnId: turn.id,
        leaseOwner: "client-worker",
        blocks: [],
        seq: 1,
        waitingBudgetMs: 24 * 60 * 60_000,
      });
      const id = await f.add("Urgent");
      expect((await requestQueuedMessageSendNow(f.chat.id, id))?.interrupt?.waitingForClient).toBe(true);
      const [deadline] = await sql<{ unchanged: boolean }[]>`SELECT q.interruption_deadline <= t.deadline AS unchanged
        FROM ai.queued_messages q JOIN ai.turns t ON t.id=q.interrupted_turn_id WHERE q.id=${id}::uuid`;
      expect(deadline?.unchanged).toBe(true);
      await reconcileQueuedInterruptions(f.chat.id);
      expect(await queuedMessageReceipt(f.chat.id, id)).toMatchObject({ state: "sending" });
      // Even an ownerless interrupted turn cannot finish while this effect is unresolved.
      expect(await aiConversations.completeTurn({ conversationId: f.chat.id, turnId: turn.id, status: "aborted" })).toBe(
        "waiting_for_client",
      );
      if (outcome === "expired") {
        await sql`UPDATE ai.queued_messages SET interruption_deadline=now()-interval '1 second' WHERE id=${id}::uuid`;
      } else {
        await aiConversations.resolvePendingTurnAction({
          conversationId: f.chat.id,
          turnId: turn.id,
          callId: "local-call",
          event: {
            type: "tool_result",
            callId: "local-call",
            result: outcome === "unknown" ? { code: "ACTION_OUTCOME_UNKNOWN" } : { written: true },
          },
        });
      }
      if (outcome === "unknown")
        expect(await aiConversations.completeTurn({ conversationId: f.chat.id, turnId: turn.id, status: "aborted" })).toBe(
          "waiting_for_client",
        );
      await reconcileQueuedInterruptions(f.chat.id);
      await reconcileQueuedInterruptions(f.chat.id);
      if (outcome === "finished") {
        expect((await aiConversations.getTurn({ conversationId: f.chat.id, turnId: turn.id }))?.status).toBe("aborted");
        const receipts = (await aiConversations.listMessages({ conversationId: f.chat.id })).filter(
          ({ message }) => message.role === "tool_result",
        );
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.message).toMatchObject({ callId: "local-call", result: { written: true } });
        const jobs: unknown[] = [];
        await drainQueuedMessages(async (job) => {
          jobs.push(job);
        }, f.chat.id);
        expect(jobs).toHaveLength(1);
      } else {
        expect(await queuedMessageReceipt(f.chat.id, id)).toMatchObject({ state: "failed" });
        expect((await aiConversations.getTurn({ conversationId: f.chat.id, turnId: turn.id }))?.status).toBe("waiting_for_action");
        expect((await listQueuedMessages(f.chat.id))[0]).toMatchObject({ state: "failed", id });
      }
    } finally {
      await f.close();
    }
  });
}

for (const receipt of ["missing", "journaled"] as const) {
  integration(`an ownerless server effect is ${receipt}: require a durable outcome before confirming interruption`, async () => {
    const f = await fixture();
    try {
      const { turn } = await aiConversations.submitChatTurn(f.input("Old work"));
      await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
      await sql`INSERT INTO ai.tool_calls(turn_id,conversation_id,call_id,tool_name,status,started_at)
        VALUES(${turn.id}::uuid,${f.chat.id}::uuid,'server-effect','write_file','running',now())`;
      if (receipt === "journaled")
        await aiConversations.createSessionStore({ conversationId: f.chat.id, turnId: turn.id }).append({
          role: "tool_result",
          callId: "server-effect",
          name: "write_file",
          result: { written: true },
        });
      const id = await f.add("Urgent");
      await requestQueuedMessageSendNow(f.chat.id, id);
      await reconcileQueuedInterruptions(f.chat.id);
      if (receipt === "missing") {
        expect(await queuedMessageReceipt(f.chat.id, id)).toMatchObject({ state: "failed" });
        expect(await aiConversations.getTurn({ conversationId: f.chat.id, turnId: turn.id })).toMatchObject({
          status: "running",
          cancellationReason: null,
        });
      } else {
        expect(await aiConversations.getTurn({ conversationId: f.chat.id, turnId: turn.id })).toMatchObject({ status: "aborted" });
        expect(await queuedMessageReceipt(f.chat.id, id)).toMatchObject({ state: "sending" });
      }
    } finally {
      await f.close();
    }
  });
}

integration("a durable interruption blocks server and nested capability starts even before the live control arrives", async () => {
  const f = await fixture();
  try {
    const { turn } = await aiConversations.submitChatTurn(f.input("Old work"));
    const id = await f.add("Urgent");
    await requestQueuedMessageSendNow(f.chat.id, id);
    const target = { conversationId: f.chat.id, turnId: turn.id, callId: "later", toolName: "send" };
    expect(await aiToolAudit.noteToolStarted(target)).toBe(false);
    expect(await aiToolAudit.noteCapabilityDispatch({ ...target, requestId: crypto.randomUUID() })).toBe(false);
    const calls = await sql`SELECT call_id FROM ai.tool_calls WHERE turn_id=${turn.id}::uuid AND started_at IS NOT NULL`;
    expect(calls).toEqual([]);
  } finally {
    await f.close();
  }
});

integration("the start barrier does not wait on a concurrent audit insert that references the same turn", async () => {
  const f = await fixture();
  try {
    const { turn } = await aiConversations.submitChatTurn(f.input("Current work"));
    const target = { conversationId: f.chat.id, turnId: turn.id, callId: "parallel", toolName: "write_file" };
    // An uncommitted ai.tool_calls insert holds FOR KEY SHARE on the turn through its foreign key.
    // A FOR UPDATE barrier waited on it and deadlocked with the second audit write of the same step.
    await sql.begin(async (tx) => {
      await tx`INSERT INTO ai.tool_calls (turn_id, conversation_id, call_id, tool_name, location, status)
        VALUES (${turn.id}::uuid, ${f.chat.id}::uuid, 'other', 'write_file', 'server', 'running')`;
      const outcome = await Promise.race([
        aiToolAudit.noteToolStarted(target).then((started) => ({ started })),
        Bun.sleep(2_000).then(() => "waited on the foreign-key lock" as const),
      ]);
      expect(outcome).toEqual({ started: true });
    });
    const started = await aiToolAudit.noteCapabilityDispatch({ ...target, callId: "nested", requestId: crypto.randomUUID() });
    expect(started).toBe(true);
  } finally {
    await f.close();
  }
});
