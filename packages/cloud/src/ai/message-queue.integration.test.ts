import { expect } from "bun:test";
import { testFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { aiFileStore } from "./files-store";
import {
  AiQueuedMessageTooLarge,
  drainQueuedMessages,
  editQueuedMessage,
  enqueueChatMessage,
  listQueuedMessages,
  migrateAiMessageQueue,
  updateQueuedMessage,
} from "./message-queue";
import { aiQuoteModelText } from "./quote-markers";
import { aiConversations } from "./store";
import type { AiConversationService, AiDraftContentPart } from "./types";

const integration = testFor("database");
// Uses the same local Postgres fixture contract as store.integration.test.ts.
integration(
  "durable queue is FIFO, idempotent and isolated from a newer composer draft",
  async () => {
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
        modelId: "fixture",
        runConfig: {
          kind: "chat",
          input: text,
          client: { kind: "cli", cwd: "/work", os: "Linux", shell: "bash", localTools: "ask" },
          localContext: { instructions: [{ path: "/work/AGENTS.md", content: "Rules." }], skills: [], selectedSkills: [] },
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
      expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: jobs[0]!.turnId })).toMatchObject({
        client: { cwd: "/work" },
        localContext: { instructions: [{ path: "/work/AGENTS.md", content: "Rules." }] },
      });
      expect((await aiConversations.getConversation({ conversationId: chat.id }))?.lastUsedAt).toBe(before!.lastUsedAt);
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
      expect(await editQueuedMessage(chat.id, third, "Edited in queue", { signedInSession: true, authorUserId: user!.id })).toBe(true);
      expect((await listQueuedMessages(chat.id))[0]?.content).toEqual([{ type: "text", text: "Edited in queue" }]);
      const restricted = async (id: string) =>
        (
          await sql<{ restricted: boolean }[]>`SELECT COALESCE((submission#>>'{runConfig,sourceRestricted}')::boolean,false) AS restricted
          FROM ai.queued_messages WHERE id=${id}::uuid`
        )[0]?.restricted;
      // A session's edit keeps the message unrestricted; an edit from cld is accepted and restricts it.
      expect(await restricted(third)).toBe(false);
      expect(await editQueuedMessage(chat.id, third, "Edited from the terminal", { signedInSession: false, authorUserId: user!.id })).toBe(
        true,
      );
      expect(await restricted(third)).toBe(true);
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
  },
  30_000,
);

integration(
  "an edit in the queue keeps the message's checked quotes and the bound of 20000 characters with them, also when it restricts the turn",
  async () => {
    await migrateAiMessageQueue();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail,given_name,sn)
    VALUES (${crypto.randomUUID()},'local','user','Queue quotes','queue-quotes@example.test','Queue','Quotes') RETURNING id`;
    const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
    // Ten quotes of 1999 characters leave room for ten characters of the person's own words.
    const quotes = Array.from({ length: 10 }, (_, index) => ({
      messageId: `Ans${index}`,
      from: "assistant" as const,
      text: `${index}`.repeat(1_999),
    }));
    const content: AiDraftContentPart[] = [
      { type: "text", text: "Kurz" },
      ...quotes.map((quote) => ({ type: "quote" as const, messageId: quote.messageId, text: quote.text })),
    ];
    const userMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Kurz" },
        ...quotes.map((quote) => ({ type: "text" as const, text: aiQuoteModelText(quote) })),
      ],
    };
    const id = crypto.randomUUID();
    try {
      const input: Parameters<AiConversationService["submitChatTurn"]>[0] = {
        conversationId: chat.id,
        modelId: "fixture",
        runConfig: {
          kind: "chat",
          input: userMessage.content,
          toolSource: { kind: "none" },
          quotes,
          writerOrigin: { kind: "person", id: user!.id },
          turnTrigger: { kind: "person", id: user!.id },
        },
        userMessage,
        expectedDraftRevision: chat.draft.revision,
        expectedProjectId: null,
      };
      await enqueueChatMessage(id, input, content);
      await expect(editQueuedMessage(chat.id, id, "Etwas mehr Text", { signedInSession: true, authorUserId: user!.id })).rejects.toThrow(
        AiQueuedMessageTooLarge,
      );
      // An edit from a source without a signed-in session restricts the turn; the checked quotes stay as they were.
      expect(await editQueuedMessage(chat.id, id, "Morgen?", { signedInSession: false, authorUserId: user!.id })).toBe(true);
      const [row] = await sql<
        { submission: { userMessage: { content: { text: string }[] }; runConfig: { quotes: unknown; sourceRestricted?: boolean } } }[]
      >`SELECT submission FROM ai.queued_messages WHERE id = ${id}::uuid`;
      expect(row!.submission.runConfig.sourceRestricted).toBe(true);
      expect(row!.submission.runConfig.quotes).toEqual(quotes);
      expect(row!.submission.userMessage.content.map((part) => part.text)).toEqual([
        "Morgen?",
        ...quotes.map((quote) => aiQuoteModelText(quote)),
      ]);
      // The queued message becomes a restricted turn whose message keeps who wrote it, what started it, and its quotes.
      const jobs: Array<{ conversationId: string; turnId: string }> = [];
      await drainQueuedMessages(async (job) => {
        jobs.push(job);
      }, chat.id);
      expect(jobs).toHaveLength(1);
      expect(await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: jobs[0]!.turnId })).toMatchObject({
        sourceRestricted: true,
        quotes,
      });
      const [sent] = await sql<{ meta: Record<string, unknown> }[]>`
      SELECT meta FROM ai.messages WHERE conversation_id = ${chat.id}::uuid AND role = 'user'`;
      expect(sent!.meta).toMatchObject({
        quotes,
        writerOrigin: { kind: "person", id: user!.id },
        turnTrigger: { kind: "person", id: user!.id },
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  },
);

integration("cancellation retains the send account and trigger without assigning personal authorship", async () => {
  await migrateAiMessageQueue();
  const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
    VALUES (${crypto.randomUUID()},'local','user') RETURNING id`;
  const chat = await aiConversations.createConversation({ ownerUserId: user!.id });
  const id = crypto.randomUUID();
  const turnTrigger = { kind: "automation" as const, id: "c_report" };
  const send = { id, accountId: user!.id, keyHash: "a".repeat(64), requestHash: "b".repeat(64) };
  try {
    await enqueueChatMessage(
      id,
      {
        conversationId: chat.id,
        modelId: "fixture",
        expectedProjectId: null,
        userMessage: { role: "user", content: [{ type: "text", text: "Automation message" }] },
        runConfig: {
          kind: "chat",
          input: "Automation message",
          writerOrigin: { kind: "automation", id: "c_report", runId: "run" },
          turnTrigger,
          send,
          toolSource: { kind: "none" },
        },
      },
      [{ type: "text", text: "Automation message" }],
    );
    expect(await updateQueuedMessage(chat.id, id, "cancel")).toBeTrue();
    const [entry] = await sql<{ author_user_id: string | null; origin: unknown; submission: unknown; content: unknown }[]>`
      SELECT author_user_id,origin,submission,content FROM ai.queued_messages WHERE id=${id}::uuid`;
    expect(entry).toEqual({
      author_user_id: null,
      origin: { kind: "automation", id: "c_report", runId: "run" },
      submission: { runConfig: { send, turnTrigger } },
      content: [],
    });
  } finally {
    await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
  }
});
