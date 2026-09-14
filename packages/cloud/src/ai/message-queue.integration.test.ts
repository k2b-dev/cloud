import { test, expect } from "bun:test";
import { sql } from "bun";
import {
  migrateAiMessageQueue,
  enqueueChatMessage,
  drainQueuedMessages,
  listQueuedMessages,
  updateQueuedMessage,
  editQueuedMessage,
} from "./message-queue";
import { aiFileStore } from "./files-store";
import { aiConversations } from "./store";
import type { AiConversationService } from "./types";

const available = await sql`SELECT to_regclass('ai.conversations') AS table_name`
  .then((rows) => Boolean(rows[0]?.table_name))
  .catch(() => false);
const integration = available ? test : test.skip;
// Uses the same local Postgres fixture contract as store.integration.test.ts.
integration("durable queue is FIFO, idempotent and isolated from a newer composer draft", async () => {
  await migrateAiMessageQueue();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
    VALUES (${crypto.randomUUID()},'local','user','Queue test','queue@example.test','Queue','Test') RETURNING id`;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  const file = await aiFileStore.createUserUpload({
    conversationId: chat.id,
    path: "source.txt",
    bytes: new TextEncoder().encode("original"),
    mediaType: "text/plain",
  });
  const enqueue = async (text: string) => {
    const before = await aiConversations.getConversation({ conversationId: chat.id });
    const draft = await aiConversations.saveDraft({
      conversationId: chat.id,
      ownerUserId: user!.id,
      expectedRevision: before!.draft.revision,
      content: [{ type: "text", text }],
    });
    if (!draft.ok) throw new Error("fixture draft failed");
    const input: Parameters<AiConversationService["submitChatTurn"]>[0] = {
      conversationId: chat.id,
      modelProfileId: "fixture",
      runConfig: {
        kind: "chat",
        input: text,
        toolSource: { kind: "none" },
        files: {
          attached: [
            {
              path: file.path,
              mediaType: file.mediaType,
              size: file.size,
              version: file.version,
              origin: file.origin,
              updatedAt: file.updatedAt,
            },
          ],
          available: [],
          total: 1,
        },
      },
      userMessage: { role: "user", content: [{ type: "text", text }] },
      expectedDraftRevision: draft.draft.revision,
      expectedProjectId: null,
    };
    const id = crypto.randomUUID();
    await enqueueChatMessage(id, input, draft.draft.content);
    await enqueueChatMessage(id, input, draft.draft.content);
    return id;
  };
  try {
    const first = await enqueue("First");
    const second = await enqueue("Second");
    expect((await listQueuedMessages(chat.id)).map((item) => item.id)).toEqual([first, second]);
    expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: user!.id })).toBe(false);
    expect(await aiConversations.setConversationDone({ conversationId: chat.id, ownerUserId: user!.id, done: true })).toEqual({
      ok: false,
      reason: "active_turn",
    });
    await sql`UPDATE ai.files SET bytes=${new TextEncoder().encode("changed")},size=7,version=version+1 WHERE conversation_id=${chat.id}::uuid AND path=${file.path}`;
    const before = await aiConversations.getConversation({ conversationId: chat.id });
    await aiConversations.saveDraft({
      conversationId: chat.id,
      ownerUserId: user!.id,
      expectedRevision: before!.draft.revision,
      content: [{ type: "text", text: "Still editing" }],
    });
    const jobs: Array<{ conversationId: string; turnId: string }> = [];
    const push = async (job: { conversationId: string; turnId: string }) => {
      jobs.push(job);
    };
    await Promise.all([drainQueuedMessages(push, chat.id), drainQueuedMessages(push, chat.id)]);
    expect(jobs).toHaveLength(1);
    const [snapshot] = await sql<
      { bytes: Uint8Array }[]
    >`SELECT bytes FROM ai.turn_files WHERE turn_id=${jobs[0]!.turnId}::uuid AND path=${file.path}`;
    expect(new TextDecoder().decode(snapshot!.bytes)).toBe("original");
    expect((await listQueuedMessages(chat.id)).map((item) => item.id)).toEqual([second]);
    expect((await aiConversations.getConversation({ conversationId: chat.id }))?.draft.content).toEqual([
      { type: "text", text: "Still editing" },
    ]);
    await drainQueuedMessages(push, chat.id);
    expect(jobs).toHaveLength(1);
    await sql`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${jobs[0]!.turnId}::uuid`;
    await drainQueuedMessages(push, chat.id);
    expect(jobs).toHaveLength(2);
    expect(await listQueuedMessages(chat.id)).toEqual([]);
    expect(await updateQueuedMessage(chat.id, first, "retry")).toBe(false);
    await sql`UPDATE ai.files SET bytes=${new TextEncoder().encode("original")},size=8,version=${file.version} WHERE conversation_id=${chat.id}::uuid AND path=${file.path}`;
    const third = await enqueue("Cancel me");
    expect(await editQueuedMessage(chat.id, third, "Edited in queue")).toBe(true);
    expect((await listQueuedMessages(chat.id))[0]?.content).toEqual([{ type: "text", text: "Edited in queue" }]);
    expect(await updateQueuedMessage(chat.id, third, "cancel")).toBe(true);
    expect(await listQueuedMessages(chat.id)).toEqual([]);
    await sql`UPDATE ai.turns SET status='completed',completed_at=now() WHERE id=${jobs[1]!.turnId}::uuid`;
    const fourth = await enqueue("Retry after a dispatch failure");
    await sql`UPDATE ai.queued_messages SET submission=jsonb_set(submission,'{expectedProjectId}',to_jsonb(${crypto.randomUUID()}::text)) WHERE id=${fourth}::uuid`;
    await drainQueuedMessages(push, chat.id);
    expect((await listQueuedMessages(chat.id))[0]?.failed).toBe(true);
    expect(jobs).toHaveLength(2);
    await sql`UPDATE ai.queued_messages SET submission=jsonb_set(submission,'{expectedProjectId}','null'::jsonb) WHERE id=${fourth}::uuid`;
    expect(await updateQueuedMessage(chat.id, fourth, "retry")).toBe(true);
    await drainQueuedMessages(push, chat.id);
    expect(jobs).toHaveLength(3);
  } finally {
    await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
  }
}, 30_000);
