import { afterAll, beforeAll, expect, test } from "bun:test";
import { suiteFor, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import {
  AiMessageQueueConflict,
  AUTOMATION_QUEUE_LIMIT,
  AUTOMATION_QUEUE_SOURCE_LIMIT,
  drainQueuedMessages,
  editQueuedMessage,
  enqueueAutomationChatMessage,
  enqueueChatMessage,
  listQueuedMessages,
  type QueuedChatSubmission,
} from "./message-queue";
import { aiConversations } from "./store";

const owner = "50000000-0000-4000-8000-000000000001";
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
    expect((await listQueuedMessages(chat.id)).map((row) => row.id)).toHaveLength(33);
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.draft.content).toEqual([]);
  });

  test("a stale revision cannot promote; a stale caller payload cannot replace a later edit", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const input = submission(chat.id, "Original");
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input, [{ type: "text", text: "Original" }]);
    expect(await editQueuedMessage(chat.id, id, "Latest edit")).toBeTrue();
    await expect(aiConversations.submitChatTurn({ ...input, queuedMessageId: id, queuedMessageRevision: "0" })).rejects.toThrow(
      "Queued message is no longer ready.",
    );
    const result = await aiConversations.submitChatTurn({ ...input, queuedMessageId: id });
    expect(result.message.message).toMatchObject({ content: [{ type: "text", text: "Latest edit" }] });
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
    expect(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`).toEqual([{ status: "pending", error: null }]);
    await drainQueuedMessages(push, chat.id, async (current) => current);
    expect(jobs).toHaveLength(1);
  });

  test("blocked person heads cannot crowd a ready chat out of the sweep", async () => {
    for (let n = 0; n < 33; n++) {
      const blocked = await aiConversations.createConversation({ ownerUserId: owner });
      await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status,error)
        VALUES(${crypto.randomUUID()}::uuid,${blocked.id}::uuid,'{}','[]','failed','dispatch_failed')`;
      await enqueueChatMessage(crypto.randomUUID(), submission(blocked.id, "Behind failed head"), []);
    }
    const ready = await aiConversations.createConversation({ ownerUserId: owner });
    await enqueueChatMessage(crypto.randomUUID(), submission(ready.id, "Ready"), []);
    const jobs: string[] = [];
    await drainQueuedMessages(async (job) => {
      jobs.push(job.conversationId);
    });
    expect(jobs).toContain(ready.id);
  });

  test("a transient database refusal leaves the accepted automation pending for recovery", async () => {
    const chat = await aiConversations.createConversation({ ownerUserId: owner });
    const id = crypto.randomUUID();
    const input = submission(chat.id, "Retry infrastructure", "code-transient");
    input.runConfig.send = { id, accountId: owner, keyHash: "transient", requestHash: "test-input" };
    await sql.begin((db) => enqueueAutomationChatMessage(id, input, [], db));
    await drainQueuedMessages(
      async () => {},
      chat.id,
      async () => {
        throw Object.assign(new Error("Deadlock"), { code: "ERR_POSTGRES_SERVER_ERROR", errno: "40P01" });
      },
    );
    expect(await sql`SELECT status,error FROM ai.queued_messages WHERE id=${id}::uuid`).toEqual([{ status: "pending", error: null }]);
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
});
