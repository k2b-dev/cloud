import { expect } from "bun:test";
import { inLockOrder } from "../../../../scripts/fixtures/lock-order";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../../../../scripts/fixtures/test-short-id";
import { sql } from "../runtime/clients";
import { serviceAccounts } from "../services/service-accounts";
import {
  drainQueuedMessages,
  enqueueChatMessage,
  listQueuedMessages,
  migrateAiMessageQueue,
  requestQueuedMessageSendNow,
} from "./message-queue";
import { userResourceContext } from "./projects.test-fixture";
import { AiMessageQueueConflict } from "./queue-conflict";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import { abortAiTurn } from "./runtime";
import { aiConversations } from "./store";
import type { AiConversationService } from "./types";

const integration = testFor("database");
type Submission = Parameters<AiConversationService["submitChatTurn"]>[0];

/** A chat with a running turn and two waiting entries, one of a person and one of an automation (fictional data). */
const fixture = async () => {
  await migrateAiMessageQueue();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
    VALUES (${crypto.randomUUID()},'local','user','Hold owner','hold-owner@example.test','Hold','Owner') RETURNING id`;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  const input = (text: string, origin: AiStoredMessageOrigin): Submission => ({
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
  const add = async (text: string, origin: AiStoredMessageOrigin = { kind: "person", id: user!.id }) => {
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input(text, origin), [{ type: "text", text }]);
    return id;
  };
  const [turn] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id, conversation_id, status)
    VALUES (${`hold-${crypto.randomUUID()}`}, ${chat.id}::uuid, 'running') RETURNING id`;
  const person = await add("Danach eine kurze Zusammenfassung für Tom.");
  const automation = await add("Lagerbestand prüfen", { kind: "automation", id: "fictional-automation", runId: "fictional-run" });
  /** A person's Stop, then the turn ends as stopped. */
  const stop = async () => {
    expect((await aiConversations.requestTurnAbort({ conversationId: chat.id, turnId: turn!.id, reason: "user" })).found).toBe(true);
    await sql`UPDATE ai.turns SET status='aborted', completed_at=now() WHERE id=${turn!.id}::uuid`;
  };
  const jobs: Array<{ conversationId: string; turnId: string }> = [];
  const drain = () =>
    drainQueuedMessages(async (job) => {
      jobs.push(job);
    }, chat.id);
  const started = async () =>
    (
      await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id=${chat.id}::uuid AND id <> ${turn!.id}::uuid`
    )[0]!.count;
  return {
    chat,
    userId: user!.id,
    turnId: turn!.id,
    input,
    person,
    automation,
    add,
    stop,
    drain,
    jobs,
    started,
    async finish(turnId: string) {
      await sql`UPDATE ai.turns SET status='completed', completed_at=now() WHERE id=${turnId}::uuid`;
    },
    async close() {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    },
  };
};

integration("a held queue stays waiting even when its stored Stop timestamp is eight seconds old", async () => {
  const f = await fixture();
  try {
    await f.stop();
    await f.drain();
    // This ages only the stored timestamp; it does not simulate eight seconds of runtime timers.
    await sql`UPDATE ai.conversations SET queue_held_at = queue_held_at - interval '8 seconds' WHERE id=${f.chat.id}::uuid`;
    await f.drain();
    expect(f.jobs).toEqual([]);
    expect(await f.started()).toBe(0);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.person, f.automation]);
  } finally {
    await f.close();
  }
});

integration("inter-chat work waits after Stop and leaves the background batch until the person resumes", async () => {
  const f = await fixture();
  const source = await aiConversations.createConversation({ ownerUserId: f.userId });
  try {
    const turn = await aiConversations.createCompactionTurn({
      conversationId: source.id,
      modelId: "fixture",
      runConfig: { kind: "compact" },
    });
    const created = await aiConversations.createInterChatMessage({
      sourceConversationId: source.id,
      sourceTurnId: turn.id,
      sourceCallId: "hold-delivery",
      targetChatId: f.chat.shortId,
      actorUserId: f.userId,
      text: "Please check the stock.",
      idempotencyKey: `hold-delivery-${source.id}`,
    });
    if (!created.ok) throw new Error("Fixture inter-chat message was not created");
    await f.stop();
    expect((await aiConversations.listPendingInterChatMessages()).map(({ id }) => id)).not.toContain(created.message.id);
    expect(
      await aiConversations.deliverInterChatMessage({
        messageId: created.message.id,
        modelId: "fixture",
        runConfig: { kind: "chat", input: "Please check the stock.", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Please check the stock." }] },
      }),
    ).toEqual({ delivered: false, reason: "busy" });
    expect(await f.started()).toBe(0);
    await f.add("Jetzt bitte weiter.");
    expect((await aiConversations.listPendingInterChatMessages()).map(({ id }) => id)).toContain(created.message.id);
  } finally {
    await sql`DELETE FROM ai.conversations WHERE id=${source.id}::uuid`;
    await f.close();
  }
});

integration("a routine cancellation leaves the normal queue flow intact", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await aiConversations.requestTurnAbort({
          conversationId: f.chat.id,
          turnId: f.turnId,
          reason: "routine_paused",
        })
      ).found,
    ).toBe(true);
    await sql`UPDATE ai.turns SET status='aborted', completed_at=now() WHERE id=${f.turnId}::uuid`;
    await f.drain();
    expect(f.jobs).toHaveLength(1);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.automation]);
  } finally {
    await f.close();
  }
});

integration("a candidate selected before Stop cannot promote after the stopped turn ends", async () => {
  const f = await fixture();
  try {
    const [candidate] = await sql<{ submission: Submission }[]>`
      SELECT submission FROM ai.queued_messages WHERE id=${f.person}::uuid`;
    await f.stop();
    await expect(aiConversations.submitChatTurn({ ...candidate!.submission, queuedMessageId: f.person })).rejects.toThrow(
      "Queued message is no longer ready.",
    );
    expect(await f.started()).toBe(0);
    expect((await listQueuedMessages(f.chat.id)).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: f.person, state: "pending" },
      { id: f.automation, state: "pending" },
    ]);
  } finally {
    await f.close();
  }
});

integration("Send now starts exactly its entry; the rest stays held", async () => {
  const f = await fixture();
  try {
    await f.stop();
    expect(await requestQueuedMessageSendNow(f.chat.id, f.automation)).toEqual({ interrupt: null });
    await f.drain();
    expect(f.jobs).toHaveLength(1);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.person]);
    await f.finish(f.jobs[0]!.turnId);
    await f.drain();
    expect(f.jobs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

integration("a new message of the person resumes the queue in its order; an automation's message does not", async () => {
  const f = await fixture();
  try {
    await f.stop();
    await f.add("Neue Prüfung", { kind: "automation", id: "fictional-automation", runId: "fictional-run-2" });
    await f.drain();
    expect(f.jobs).toEqual([]);
    const mine = await f.add("Und jetzt bitte weiter.");
    await f.drain();
    expect(f.jobs).toHaveLength(1);
    // Normal order again: the oldest entry goes first, the new message waits at the end.
    const remaining = (await listQueuedMessages(f.chat.id)).map(({ id }) => id);
    expect(remaining[0]).toBe(f.automation);
    expect(remaining.at(-1)).toBe(mine);
    expect(remaining).not.toContain(f.person);
  } finally {
    await f.close();
  }
});

integration("Stop and completion acquire the chat before the turn, without a lock-order inversion", async () => {
  const f = await fixture();
  try {
    const results = await inLockOrder<unknown>(
      async (holder) => {
        await holder`SELECT id FROM ai.conversations WHERE id=${f.chat.id}::uuid FOR UPDATE`;
      },
      [
        () => aiConversations.completeTurn({ conversationId: f.chat.id, turnId: f.turnId, status: "completed" }),
        () => aiConversations.requestTurnAbort({ conversationId: f.chat.id, turnId: f.turnId, reason: "user" }),
      ],
    );
    expect(results).toEqual(["completed", { found: false }]);
    await f.drain();
    expect(f.jobs).toEqual([]);
  } finally {
    await f.close();
  }
});

integration("archive rechecks a promotion committed while it waited for the chat lock", async () => {
  const f = await fixture();
  try {
    await f.stop();
    await requestQueuedMessageSendNow(f.chat.id, f.person);
    const [archived] = await inLockOrder(
      async (holder) => {
        await holder`SELECT id FROM ai.conversations WHERE id=${f.chat.id}::uuid FOR UPDATE`;
        const [turn] = await holder<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status)
          VALUES(${testShortId()},${f.chat.id}::uuid,'queued') RETURNING id`;
        await holder`UPDATE ai.queued_messages SET status='submitted',submitted_turn_id=${turn!.id}::uuid,
          submission='{}'::jsonb,content='[]'::jsonb WHERE id=${f.person}::uuid`;
      },
      [() => aiConversations.archiveConversation({ conversationId: f.chat.id, ownerUserId: f.userId })],
    );
    expect(archived).toBe(false);
    expect(await aiConversations.getConversation({ conversationId: f.chat.id })).not.toBeNull();
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).toEqual([f.automation]);
  } finally {
    await f.close();
  }
});

integration("archiving a chat with queued entries lets them lapse (#108)", async () => {
  const f = await fixture();
  try {
    await f.stop();
    const bytes = new TextEncoder().encode("Fictional attachment");
    await sql`INSERT INTO ai.queued_message_files(message_id,path,bytes,media_type,size,origin,updated_at,version)
      VALUES(${f.person}::uuid,'note.txt',${bytes},'text/plain',${bytes.length},'upload',now(),1)`;
    expect(await aiConversations.archiveConversation({ conversationId: f.chat.id, ownerUserId: f.userId })).toEqual({
      discardedQueuedMessages: 2,
    });
    expect(await listQueuedMessages(f.chat.id)).toEqual([]);
    const lapsed = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error FROM ai.queued_messages WHERE conversation_id=${f.chat.id}::uuid ORDER BY position`;
    expect(lapsed).toEqual([
      { status: "cancelled", error: "chat_archived" },
      { status: "cancelled", error: "chat_archived" },
    ]);
    const files = await sql`SELECT message_id FROM ai.queued_message_files WHERE message_id=${f.person}::uuid`;
    expect(files).toEqual([]);
    const retained = await sql`SELECT id FROM ai.queued_messages WHERE conversation_id=${f.chat.id}::uuid
      AND (submission <> '{}'::jsonb OR content <> '[]'::jsonb)`;
    expect(retained).toEqual([]);
    await expect(aiConversations.submitChatTurn(f.input("Too late", { kind: "person", id: f.userId }))).rejects.toBeInstanceOf(
      AiMessageQueueConflict,
    );
    // A stale Stop request arriving after archive must not put the old hold back before restore.
    expect(await aiConversations.requestTurnAbort({ conversationId: f.chat.id, turnId: f.turnId, reason: "user" })).toEqual({
      found: false,
    });
    expect(await aiConversations.restoreConversation({ conversationId: f.chat.id, ownerUserId: f.userId })).toMatchObject({
      id: f.chat.id,
    });
    const resumed = await aiConversations.submitChatTurn(f.input("After restore", { kind: "automation", id: "routine" }));
    expect(resumed.turn.status).toBe("queued");
    await f.drain();
    expect(f.jobs).toEqual([]);
  } finally {
    await f.close();
  }
});

integration("direct submissions identify the person before admission: a service account cannot bypass or lift the hold", async () => {
  const f = await fixture();
  const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind)
    VALUES (${`hold-${crypto.randomUUID()}`},'standalone') RETURNING id`;
  try {
    const serviceAccount = await serviceAccounts.get({ id: account!.id });
    if (!serviceAccount) throw new Error("Missing service account fixture");
    await f.stop();
    // Emptying the queue must not let the next automated direct submission ignore the durable hold.
    await sql`DELETE FROM ai.queued_messages WHERE conversation_id=${f.chat.id}::uuid`;
    const input = f.input("Direct message", { kind: "person", id: f.userId });
    delete input.runConfig.writerOrigin;
    input.runConfig.actor = { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["write"] };
    await expect(aiConversations.submitChatTurn(input)).rejects.toMatchObject({
      code: "queue_held",
      message: "A person stopped this chat; only their next message resumes it.",
    });
    expect(await f.started()).toBe(0);
    // Explicit platform automation provenance cannot resume it either.
    await expect(aiConversations.submitChatTurn(f.input("Automation", { kind: "automation", id: account!.id }))).rejects.toThrow(
      "A person stopped this chat; only their next message resumes it.",
    );
    input.runConfig.actor = userResourceContext({ type: "user", userId: f.userId }).actor;
    const person = await aiConversations.submitChatTurn(input);
    await f.finish(person.turn.id);
    // The person's direct message cleared the hold, so a subsequent service-account turn is admitted.
    input.runConfig.actor = { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["write"] };
    expect((await aiConversations.submitChatTurn(input)).turn.status).toBe("queued");
  } finally {
    await f.close();
    await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
  }
});

integration("a later Stop withdraws an in-flight Send now and leaves its entry waiting", async () => {
  const f = await fixture();
  try {
    const requested = await requestQueuedMessageSendNow(f.chat.id, f.automation);
    expect(requested?.interrupt?.turnId).toBe(f.turnId);
    expect((await listQueuedMessages(f.chat.id)).find(({ id }) => id === f.automation)?.state).toBe("sending");
    await f.stop();
    const [entry] = await sql<{ send_requested_at: Date | null; interrupted_turn_id: string | null }[]>`
      SELECT send_requested_at,interrupted_turn_id FROM ai.queued_messages WHERE id=${f.automation}::uuid`;
    expect(entry).toEqual({ send_requested_at: null, interrupted_turn_id: null });
    await f.drain();
    expect(f.jobs).toEqual([]);
    expect((await listQueuedMessages(f.chat.id)).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: f.person, state: "pending" },
      { id: f.automation, state: "pending" },
    ]);
  } finally {
    await f.close();
  }
});

integration("a late Stop holds a completed foreground turn's queue, but stopping a background routine does not", async () => {
  const f = await fixture();
  try {
    await f.finish(f.turnId);
    expect(await aiConversations.requestTurnAbort({ conversationId: f.chat.id, turnId: f.turnId, reason: "user" })).toEqual({
      found: false,
    });
    await f.drain();
    expect(f.jobs).toEqual([]);
    await f.add("Resume before background Stop");
    const [background] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status,run_config)
      VALUES(${testShortId()},${f.chat.id}::uuid,'running','{"kind":"chat","background":{}}'::jsonb) RETURNING id`;
    expect((await aiConversations.requestTurnAbort({ conversationId: f.chat.id, turnId: background!.id, reason: "user" })).found).toBe(
      true,
    );
    await f.drain();
    expect(f.jobs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

integration("the global sweep skips held chats and resumes them only after a person writes", async () => {
  const f = await fixture();
  try {
    await f.stop();
    const jobs: Array<{ conversationId: string; turnId: string }> = [];
    const sweep = () =>
      drainQueuedMessages(async (job) => {
        jobs.push(job);
      });
    await sweep();
    expect(jobs.filter(({ conversationId }) => conversationId === f.chat.id)).toEqual([]);
    expect(await f.started()).toBe(0);
    await f.add("Continue from sweep");
    await sweep();
    expect(jobs.filter(({ conversationId }) => conversationId === f.chat.id)).toHaveLength(1);
    expect((await listQueuedMessages(f.chat.id)).map(({ id }) => id)).not.toContain(f.person);
  } finally {
    await f.close();
  }
});

integration("a stale Stop does not withdraw Send now interrupting a different active turn", async () => {
  const f = await fixture();
  try {
    await f.finish(f.turnId);
    const [active] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id,conversation_id,status)
      VALUES(${testShortId()},${f.chat.id}::uuid,'running') RETURNING id`;
    const requested = await requestQueuedMessageSendNow(f.chat.id, f.automation);
    expect(requested?.interrupt?.turnId).toBe(active!.id);
    await aiConversations.requestTurnAbort({ conversationId: f.chat.id, turnId: f.turnId, reason: "user" });
    // The old click holds the chat, but cannot orphan the newer turn's interrupt handshake.
    const [entry] = await sql<{ interrupted_turn_id: string | null; requested: boolean }[]>`
      SELECT interrupted_turn_id,send_requested_at IS NOT NULL AS requested FROM ai.queued_messages WHERE id=${f.automation}::uuid`;
    expect(entry).toEqual({ interrupted_turn_id: active!.id, requested: true });
    expect(await aiConversations.getTurn({ conversationId: f.chat.id, turnId: active!.id })).toMatchObject({
      cancellationReason: "queue_interrupt",
    });
  } finally {
    await f.close();
  }
});

integration("a service-account Stop aborts its target without holding the foreground queue", async () => {
  const f = await fixture();
  const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind)
    VALUES (${`stop-${crypto.randomUUID()}`},'standalone') RETURNING id`;
  try {
    const serviceAccount = await serviceAccounts.get({ id: account!.id });
    if (!serviceAccount) throw new Error("Missing service account fixture");
    await abortAiTurn({
      conversationId: f.chat.id,
      turnId: f.turnId,
      actor: { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["write"] },
    });
    expect(await aiConversations.getTurn({ conversationId: f.chat.id, turnId: f.turnId })).toMatchObject({
      status: "aborted",
      cancellationReason: "service_account",
    });
    const [chat] = await sql<{ queue_held_at: Date | null }[]>`SELECT queue_held_at FROM ai.conversations WHERE id=${f.chat.id}::uuid`;
    expect(chat?.queue_held_at).toBeNull();
    await f.drain();
    expect(f.jobs).toHaveLength(1);
  } finally {
    await f.close();
    await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
  }
});
