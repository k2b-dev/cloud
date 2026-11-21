import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import {
  AI_MESSAGE_QUEUE_LIMIT,
  AiMessageQueueConflict,
  AiQueuedChatStartError,
  AUTOMATION_QUEUE_LIMIT,
  AUTOMATION_QUEUE_SOURCE_LIMIT,
  drainQueuedMessages,
  editQueuedMessage,
  enqueueAutomationChatMessage,
  enqueueChatMessage,
  listQueuedMessages,
  migrateAiMessageQueue,
  type QueuedChatSubmission,
  reconcileQueuedInterruptions,
  requestQueuedMessageSendNow,
  updateQueuedMessage,
} from "./message-queue";
import { userResourceContext } from "./projects.test-fixture";
import { AiQuotaError } from "./quotas";
import { aiQuoteModelText } from "./quote-markers";
import { aiConversations } from "./store";

const owner = "50000000-0000-4000-8000-000000000001";
const { actor: author } = userResourceContext({ type: "user", userId: owner });
if (author.kind !== "user") throw new Error("fixture actor must be a user");
suiteFor(
  "database",
  "valkey",
  "nats",
)("separate automation queue admission", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  beforeAll(async () => {
    database = await useMigratedDatabase("automation_queue");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${owner}::uuid,'automation-queue-owner','local','user')`;
  }, 30_000);
  afterEach(() => mock.restore());
  afterAll(async () => {
    await database?.drop();
  });

  const submission = (conversationId: string, text: string, source?: string): QueuedChatSubmission => ({
    conversationId,
    modelId: "fixture",
    expectedProjectId: null,
    userMessage: { role: "user", content: [{ type: "text", text }] },
    runConfig: {
      kind: "chat",
      input: text,
      toolSource: { kind: "none" },
      ...(source
        ? {
            writerOrigin: { kind: "automation", id: source },
            turnTrigger: { kind: "automation", id: source },
          }
        : {}),
    },
  });

  test("32 automation entries leave composer capacity and its draft untouched", async () => {
    expect(AUTOMATION_QUEUE_LIMIT).toBe(32);
    expect(AUTOMATION_QUEUE_SOURCE_LIMIT).toBe(1);
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    await sql`UPDATE ai.conversations SET draft_content='[{"type":"text","text":"My unfinished draft"}]'::jsonb,
      draft_revision=7 WHERE id=${chat.id}::uuid`;
    for (let n = 0; n < AUTOMATION_QUEUE_LIMIT; n++) {
      const input = submission(chat.id, `Automation ${n}`, `code-${n}`);
      await sql.begin((db) => enqueueAutomationChatMessage(crypto.randomUUID(), input, [{ type: "text", text: `Automation ${n}` }], db));
    }
    for (const source of ["code-0", "code-overflow"])
      await expect(
        sql.begin((db) => enqueueAutomationChatMessage(crypto.randomUUID(), submission(chat.id, "Overflow", source), [], db)),
      ).rejects.toBeInstanceOf(AiMessageQueueConflict);
    const current = await aiConversations.getConversation({ conversationId: chat.id });
    expect(current?.draft).toMatchObject({ revision: 7, content: [{ type: "text", text: "My unfinished draft" }] });
    const personId = crypto.randomUUID();
    await enqueueChatMessage(personId, { ...submission(chat.id, "Person"), expectedDraftRevision: 7 }, [{ type: "text", text: "Person" }]);
    expect(AI_MESSAGE_QUEUE_LIMIT).toBe(20);
    for (let n = 1; n < AI_MESSAGE_QUEUE_LIMIT; n++) await enqueueChatMessage(crypto.randomUUID(), submission(chat.id, `Person ${n}`), []);
    await expect(enqueueChatMessage(crypto.randomUUID(), submission(chat.id, "Person overflow"), [])).rejects.toBeInstanceOf(
      AiMessageQueueConflict,
    );
    expect((await listQueuedMessages(chat.id)).map((row) => row.id)).toHaveLength(AUTOMATION_QUEUE_LIMIT + AI_MESSAGE_QUEUE_LIMIT);
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.draft.content).toEqual([]);
  });

  test("receipt backfill keeps the original acceptance time and its key window", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Existing send", "backfill-source");
    input.runConfig.send = { id, accountId: owner, keyHash: "backfill-key", requestHash: "backfill-input" };
    await sql.begin((db) => enqueueAutomationChatMessage(id, input, [], db));
    await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '25 hours' WHERE id=${id}::uuid`;
    await sql`DROP TRIGGER chat_send_receipt_immutable ON ai.chat_send_receipts`;
    await migrateAiMessageQueue();
    const [receipt] = await sql<{ original: boolean; expired: boolean }[]>`SELECT
      r.created_at=q.created_at AS original,
      r.created_at <= clock_timestamp()-interval '24 hours' AS expired
      FROM ai.chat_send_receipts r JOIN ai.queued_messages q ON q.id=r.queued_message_id WHERE r.id=${id}::uuid`;
    expect(receipt).toEqual({ original: true, expired: true });
    await sql`DELETE FROM ai.chat_send_receipts WHERE id=${id}::uuid`;
    await migrateAiMessageQueue();
    // A completed migration does not rescan old queue payloads on every host start.
    expect(await sql`SELECT id FROM ai.chat_send_receipts WHERE id=${id}::uuid`).toHaveLength(0);
  });

  test("a stale revision cannot promote; a stale caller payload cannot replace a later edit", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const input = submission(chat.id, "Original");
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input, [{ type: "text", text: "Original" }]);
    expect(await editQueuedMessage(chat.id, id, "Latest edit", { signedInSession: false, author })).toBe("edited");
    await expect(aiConversations.submitChatTurn({ ...input, queuedMessageId: id, queuedMessageRevision: "0" })).rejects.toThrow(
      "Queued message is no longer ready.",
    );
    const result = await aiConversations.submitChatTurn({ ...input, queuedMessageId: id });
    expect(result.message.message).toMatchObject({ content: [{ type: "text", text: "Latest edit" }] });
    expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: result.turn.id })).toMatchObject({
      sourceRestricted: true,
    });
  });

  test("send now races a quoted edit and promotes one current revision", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    await aiConversations.submitChatTurn(submission(chat.id, "Old work"));
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Original");
    const quotes = [{ messageId: "Quote07", from: "assistant" as const, text: "Checked passage" }];
    input.runConfig.quotes = quotes;
    input.userMessage = {
      role: "user",
      content: [
        { type: "text", text: "Original" },
        { type: "text", text: aiQuoteModelText(quotes[0]!) },
      ],
    };
    input.runConfig.input = input.userMessage.content;
    input.runConfig.writerOrigin = { kind: "person", id: owner };
    input.runConfig.turnTrigger = { kind: "person", id: owner };
    input.runConfig.send = { id, accountId: owner, keyHash: "c7-key", requestHash: "c7-input" };
    await enqueueChatMessage(id, input, [
      { type: "text", text: "Original" },
      { type: "quote", messageId: "Quote07", text: "Checked passage" },
    ]);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = sql.begin(async (tx) => {
      await tx`SELECT id FROM ai.conversations WHERE id=${chat.id}::uuid FOR UPDATE`;
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      const edit = editQueuedMessage(chat.id, id, "Current revision", { signedInSession: false, author });
      const request = requestQueuedMessageSendNow(chat.id, id);
      release.resolve();
      await blocker;
      const [edited, sent] = await Promise.all([edit, request]);
      expect(sent).not.toBeNull();
      await reconcileQueuedInterruptions(chat.id);
      const jobs: { turnId: string }[] = [];
      const push = async (job: { turnId: string }) => {
        jobs.push(job);
      };
      await Promise.all([drainQueuedMessages(push, chat.id), drainQueuedMessages(push, chat.id)]);
      expect(jobs).toHaveLength(1);
      const config = await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: jobs[0]!.turnId });
      expect(config).toMatchObject({
        quotes,
        writerOrigin: { kind: "person", id: owner },
        turnTrigger: { kind: "person", id: owner },
        send: { id },
      });
      const [message] = await aiConversations.listTurnMessages({ conversationId: chat.id, loopId: jobs[0]!.turnId });
      expect(message?.message).toMatchObject({
        content: [{ type: "text", text: edited === "edited" ? "Current revision" : "Original" }, expect.anything()],
      });
      if (edited === "edited") expect(config).toMatchObject({ sourceRestricted: true });
      expect(message?.meta?.quotes).toEqual(quotes);
    } finally {
      release.resolve();
      await blocker;
    }
  });
  test("concurrent drain starts the current revision exactly once", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const input = submission(chat.id, "Original");
    await enqueueChatMessage(crypto.randomUUID(), input, [{ type: "text", text: "Original" }]);
    const jobs: string[] = [];
    const push = async (job: { turnId: string }) => {
      jobs.push(job.turnId);
    };
    await Promise.all([drainQueuedMessages(push, chat.id), drainQueuedMessages(push, chat.id)]);
    expect(jobs).toHaveLength(1);
    expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(1);
  });
  test("startup and shutdown leave automation pending until its host policy is available", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Waiting for runtime", "code-startup");
    input.runConfig.send = { id, accountId: owner, keyHash: "test-startup", requestHash: "test-input" };
    await sql.begin((db) => enqueueAutomationChatMessage(id, input, [], db));
    const jobs: string[] = [];
    const push = async (job: { turnId: string }) => {
      jobs.push(job.turnId);
    };
    await drainQueuedMessages(push, chat.id);
    expect(await sql<{ status: string; error: string | null }[]>`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`).toEqual(
      [{ status: "pending", error: null }],
    );
    await drainQueuedMessages(push, chat.id, async (current) => current);
    expect(jobs).toHaveLength(1);
  });

  test("retryable quota heads cannot crowd a ready chat out of the sweep", async () => {
    const originalSubmit = aiConversations.submitChatTurn;
    for (let n = 0; n < 33; n++) {
      const blocked = await aiConversations.createConversation({ ownerUserId: owner });
      await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,error,quota_checked_at)
        VALUES(${crypto.randomUUID()}::uuid,${blocked.id}::uuid,(${JSON.stringify(submission(blocked.id, "Quota head"))}::text)::jsonb,'[]','failed','quota_exhausted',clock_timestamp())`;
      await enqueueChatMessage(crypto.randomUUID(), submission(blocked.id, "Behind failed head"), []);
    }
    const submit = spyOn(aiConversations, "submitChatTurn");
    submit.mockImplementation(async (input, db) => {
      if (input.runConfig.input === "Quota head") throw new AiQuotaError("quota_exhausted", "Still empty");
      return originalSubmit(input, db);
    });
    const ready = await aiConversations.createConversation({ ownerUserId: owner });
    await enqueueChatMessage(crypto.randomUUID(), submission(ready.id, "Ready"), []);
    const jobs: string[] = [];
    await drainQueuedMessages(async (job) => {
      jobs.push(job.conversationId);
    });
    expect(jobs).toContain(ready.id);
    expect(submit.mock.calls.filter(([input]) => input.runConfig.input === "Quota head").length).toBeGreaterThan(0);
  });

  test("unknown errors stay visibly pending, retry after 15 seconds, and typed refusals remain final", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, submission(chat.id, "Retry me"), [{ type: "text", text: "Retry me" }]);
    const submit = spyOn(aiConversations, "submitChatTurn").mockRejectedValue(new TypeError("Temporary setup failure"));
    await drainQueuedMessages(async () => {}, chat.id);
    expect(Array.from(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`)).toMatchObject([
      { status: "pending", error: "dispatch_failed" },
    ]);
    expect(await listQueuedMessages(chat.id)).toMatchObject([{ id, failed: true }]);
    await drainQueuedMessages(async () => {}, chat.id);
    expect(submit).toHaveBeenCalledTimes(1);
    // PostgreSQL owns the clock; move only the due-time seam instead of sleeping.
    await sql`UPDATE ai.queued_messages SET quota_checked_at=clock_timestamp()-interval '16 seconds' WHERE id=${id}::uuid`;
    submit.mockRejectedValue(new AiQueuedChatStartError("model_policy_mismatch"));
    await drainQueuedMessages(async () => {}, chat.id);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(Array.from(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`)).toMatchObject([
      { status: "failed", error: "model_policy_mismatch" },
    ]);
    await drainQueuedMessages(async () => {}, chat.id);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(await updateQueuedMessage(chat.id, id, "cancel")).toBeTrue();
  });

  test("person infrastructure retries end at the existing 30-minute queued-turn admission deadline", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, submission(chat.id, "Broken setup"), []);
    const submit = spyOn(aiConversations, "submitChatTurn").mockRejectedValue(new Error("Setup unavailable"));
    await drainQueuedMessages(async () => {}, chat.id);
    await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '31 minutes',
      quota_checked_at=clock_timestamp()-interval '16 seconds' WHERE id=${id}::uuid`;
    await drainQueuedMessages(async () => {}, chat.id);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(Array.from(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`)).toMatchObject([
      { status: "failed", error: "dispatch_failed" },
    ]);
    expect(await listQueuedMessages(chat.id)).toMatchObject([{ id, failed: true }]);
    expect(await updateQueuedMessage(chat.id, id, "cancel")).toBeTrue();
  });

  test.each(["55P03", "40P01", "40001", "57014"])("SQLSTATE %s leaves the accepted automation unchanged for recovery", async (sqlState) => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Retry infrastructure", "code-transient");
    input.runConfig.send = { id, accountId: owner, keyHash: `transient-${sqlState}`, requestHash: "test-input" };
    await sql.begin((db) => enqueueAutomationChatMessage(id, input, [], db));
    await drainQueuedMessages(
      async () => {},
      chat.id,
      async () => {
        throw Object.assign(new Error("Transaction retry"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState });
      },
    );
    expect(Array.from(await sql`SELECT status,error,quota_checked_at,revision::text FROM ai.queued_messages WHERE id=${id}::uuid`)).toEqual(
      [{ status: "pending", error: null, quota_checked_at: null, revision: "0" }],
    );
    const jobs: string[] = [];
    await drainQueuedMessages(
      async (job) => {
        jobs.push(job.turnId);
      },
      chat.id,
      async (current) => current,
    );
    expect(jobs).toHaveLength(1);
  });

  test("an entry accepted two hours ago survives NOWAIT contention and starts after the lock is released", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const blocker = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Old accepted message", "old-contended-source");
    input.runConfig.send = { id, accountId: owner, keyHash: "old-contended", requestHash: "test-input" };
    await sql.begin((db) => enqueueAutomationChatMessage(id, input, [], db));
    await sql`UPDATE ai.queued_messages SET created_at=clock_timestamp()-interval '2 hours' WHERE id=${id}::uuid`;
    await sql.begin(async (holder) => {
      await holder`SET LOCAL lock_timeout='3s'`;
      await holder`SELECT id FROM ai.conversations WHERE id=${blocker.id}::uuid FOR UPDATE`;
      await drainQueuedMessages(
        async () => {},
        chat.id,
        async (current, db) => {
          await db`SELECT id FROM ai.conversations WHERE id=${blocker.id}::uuid FOR SHARE NOWAIT`;
          return current;
        },
      );
    });
    expect(Array.from(await sql`SELECT status,error,quota_checked_at FROM ai.queued_messages WHERE id=${id}::uuid`)).toEqual([
      { status: "pending", error: null, quota_checked_at: null },
    ]);
    const jobs: string[] = [];
    await drainQueuedMessages(
      async (job) => {
        jobs.push(job.turnId);
      },
      chat.id,
      async (current) => current,
    );
    expect(jobs).toHaveLength(1);
    expect(Array.from(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`)).toEqual([
      { status: "submitted", error: null },
    ]);
  });
});
