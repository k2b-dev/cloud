import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "./migrate";
import { publicAiStoredMessages } from "./public-projection";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-page-${suffix}`}, 'local', 'user', 'AI Page Test', ${`ai-page-${suffix}@example.test`}, 'AI', 'Page')
    RETURNING id
  `;
  return row!.id;
};

const cleanupFixture = async (input: { userId: string; conversationIds: string[] }) => {
  for (const conversationId of input.conversationIds) {
    await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
  }
  await sql`DELETE FROM auth.users WHERE id = ${input.userId}::uuid`;
};

const insertMessage = async (input: {
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  compacted?: boolean;
  kind?: "message" | "summary";
  loopId?: string;
  meta?: unknown;
  content?: unknown[];
}) => {
  await sql`
    INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text, loop_id, meta, compacted_at)
    VALUES (
      ${createAiShortId()},
      ${input.conversationId},
      ${input.seq},
      ${input.kind ?? "message"},
      ${input.role},
      ${JSON.stringify({ role: input.role, content: input.content ?? [{ type: "text", text: input.text }] })}::jsonb,
      ${input.text},
      ${input.loopId ?? null},
      ${input.meta ? JSON.stringify(input.meta) : null}::jsonb,
      ${input.compacted ? new Date().toISOString() : null}
    )
  `;
};

databaseSuite()("listMessagesPage (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("projects internal message loop ids to the public Turn id", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const turnId = crypto.randomUUID();
      const turnShortId = createAiShortId();
      await sql`
        INSERT INTO ai.turns (id, short_id, conversation_id, status, model_profile_id, completed_at)
        VALUES (${turnId}::uuid, ${turnShortId}, ${conversation.id}::uuid, 'completed', 'test-model', now())
      `;
      await insertMessage({ conversationId: conversation.id, seq: 1, role: "user", text: "go", loopId: turnId });
      await insertMessage({ conversationId: conversation.id, seq: 2, role: "assistant", text: "done", loopId: turnId });

      const page = await aiConversations.listMessagesPage({ conversationId: conversation.id });
      const messages = await publicAiStoredMessages(page.messages, conversation);

      expect(messages.map((message) => message.loopId)).toEqual([turnShortId, turnShortId]);
      expect(messages.every((message) => message.conversationId === conversation.shortId)).toBe(true);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("windows newest-first with lossless cursor paging", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      for (let seq = 1; seq <= 12; seq++) {
        await insertMessage({ conversationId: conversation.id, seq, role: seq % 2 ? "user" : "assistant", text: `msg ${seq}` });
      }

      // Newest window of 5: seq 8-12, more history above.
      const first = await aiConversations.listMessagesPage({ conversationId: conversation.id, limit: 5 });
      expect(first.messages.map((message) => message.seq)).toEqual([8, 9, 10, 11, 12]);
      expect(first.hasMore).toBe(true);

      // Page older from the window's oldest seq.
      const second = await aiConversations.listMessagesPage({ conversationId: conversation.id, beforeSeq: 8, limit: 5 });
      expect(second.messages.map((message) => message.seq)).toEqual([3, 4, 5, 6, 7]);
      expect(second.hasMore).toBe(true);

      const third = await aiConversations.listMessagesPage({ conversationId: conversation.id, beforeSeq: 3, limit: 5 });
      expect(third.messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(third.hasMore).toBe(false);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("never splits a compaction seq group and hides superseded summaries", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);

      // Compacted history: archived rows on seq 1-2, the active summary shares seq 2.
      await insertMessage({ conversationId: conversation.id, seq: 1, role: "user", text: "old 1", compacted: true });
      await insertMessage({ conversationId: conversation.id, seq: 2, role: "assistant", text: "old 2", compacted: true });
      await insertMessage({ conversationId: conversation.id, seq: 2, role: "assistant", text: "summary", kind: "summary" });
      await insertMessage({ conversationId: conversation.id, seq: 3, role: "user", text: "new question" });
      await insertMessage({ conversationId: conversation.id, seq: 4, role: "assistant", text: "new answer" });

      // limit counts DISTINCT seqs — the seq-2 group (archived row + summary) stays intact.
      const window = await aiConversations.listMessagesPage({ conversationId: conversation.id, limit: 3 });
      expect(window.messages.map((message) => `${message.seq}:${message.kind}`)).toEqual([
        "2:message",
        "2:summary",
        "3:message",
        "4:message",
      ]);
      expect(window.hasMore).toBe(true);

      // The summary sorts after the archived row sharing its seq (same as listMessages).
      const older = await aiConversations.listMessagesPage({ conversationId: conversation.id, beforeSeq: 2, limit: 5 });
      expect(older.messages.map((message) => message.seq)).toEqual([1]);
      expect(older.hasMore).toBe(false);

      // Full-view parity: same visibility rules as listMessages.
      const full = await aiConversations.listMessages({ conversationId: conversation.id });
      const paged = await aiConversations.listMessagesPage({ conversationId: conversation.id, limit: 100 });
      expect(paged.messages.map((message) => message.id)).toEqual(full.map((message) => message.id));
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("searches visible seq groups losslessly and keeps forked history searchable", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const source = await aiConversations.createConversation({ ownerUserId: userId });
      const target = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(source.id, target.id);

      await insertMessage({ conversationId: source.id, seq: 1, role: "user", text: "needle old" });
      await insertMessage({ conversationId: source.id, seq: 2, role: "assistant", text: "needle detail", compacted: true });
      await insertMessage({
        conversationId: source.id,
        seq: 2,
        role: "assistant",
        text: "needle hidden",
        kind: "summary",
        compacted: true,
      });
      await insertMessage({ conversationId: source.id, seq: 2, role: "assistant", text: "needle current", kind: "summary" });
      await insertMessage({ conversationId: source.id, seq: 3, role: "assistant", text: "needle newest" });

      const first = await aiConversations.searchConversationMessages({ conversationId: source.id, query: "needle", limit: 1 });
      expect(first.messages.map((message) => `${message.seq}:${message.kind}`)).toEqual(["3:message"]);
      expect(first.nextCursor).toBe("3");

      const second = await aiConversations.searchConversationMessages({
        conversationId: source.id,
        query: "needle",
        beforeSeq: 3,
        limit: 1,
      });
      expect(second.messages.map((message) => `${message.seq}:${message.kind}`)).toEqual(["2:message", "2:summary"]);
      expect(JSON.stringify(second.messages.map((message) => message.message))).not.toContain("hidden");

      await aiConversations.copyMessages({ sourceConversationId: source.id, targetConversationId: target.id, throughSeq: 3 });
      const forked = await aiConversations.searchConversationMessages({ conversationId: target.id, query: "newest" });
      expect(forked.messages.map((message) => message.seq)).toEqual([3]);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("builds a compact full-conversation turn index", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const turnId = crypto.randomUUID();
      await sql`
        INSERT INTO ai.turns (id, short_id, conversation_id, status, model_profile_id, completed_at)
        VALUES (${turnId}::uuid, ${createAiShortId()}, ${conversation.id}::uuid, 'completed', 'test-model', now())
      `;
      await insertMessage({
        conversationId: conversation.id,
        seq: 1,
        role: "user",
        text: "Create a report",
        loopId: turnId,
        content: [
          { type: "text", text: "Create a report" },
          { type: "text", text: '<attachment path="/data.csv" media-type="text/csv" size="12" />' },
        ],
      });
      await insertMessage({ conversationId: conversation.id, seq: 2, role: "assistant", text: "I created the report.", loopId: turnId });
      await insertMessage({
        conversationId: conversation.id,
        seq: 3,
        role: "user",
        text: "Make it shorter",
        loopId: turnId,
        meta: { steerId: "steer-1" },
      });
      await insertMessage({
        conversationId: conversation.id,
        seq: 4,
        role: "assistant",
        text: "Here is the shorter version.",
        loopId: turnId,
      });
      await sql`
        INSERT INTO ai.tool_calls (turn_id, conversation_id, call_id, tool_name, status, approval_state)
        VALUES (${turnId}::uuid, ${conversation.id}::uuid, 'present-1', 'present', 'completed', 'not_required')
      `;

      const timeline = await aiConversations.listConversationTimeline({ conversationId: conversation.id });
      expect(timeline).toHaveLength(2);
      expect(timeline[0]).toMatchObject({
        seq: 1,
        userPreview: "Create a report",
        assistantPreview: "I created the report.",
        isSteer: false,
        inputFileCount: 1,
        outputFileCount: 1,
        toolCount: 1,
      });
      expect(timeline[1]).toMatchObject({
        seq: 3,
        userPreview: "Make it shorter",
        assistantPreview: "Here is the shorter version.",
        isSteer: true,
      });
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });
});
