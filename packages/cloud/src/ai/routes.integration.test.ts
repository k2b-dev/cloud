import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { __aiRoutesTest, aiRoutes } from "./routes";
import { createAiShortId } from "./short-id";
import { aiConversations } from "./store";

const databaseAvailable = async () => {
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!row?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

const suite = (await databaseAvailable()) ? describe : describe.skip;

const insertUser = async (): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-routes-${suffix}`}, 'local', 'user', 'AI Routes', ${`ai-routes-${suffix}@example.test`}, 'AI', 'Routes')
    RETURNING id
  `;
  return row!.id;
};

describe("global AI route registration", () => {
  test("mounts personalization learning activity behind authentication", async () => {
    const response = await aiRoutes.request("/memory-learning-runs?page=1&perPage=20");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Authentication required" });
  });
});

suite("global AI conversation boundaries", () => {
  test("replaces a turn waiting for action when its user message is retried", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
      });
      await sql`
        UPDATE ai.turns
        SET status = 'waiting_for_action', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${first.turn.id}::uuid
      `;

      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id)).toBe("ready");
      expect((await aiConversations.getTurn({ conversationId: chat.id, turnId: first.turn.id }))?.status).toBe("aborted");

      const retry = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
        truncateFromSeq: first.message.seq,
      });
      expect(retry.turn.status).toBe("queued");
      expect((await aiConversations.getActiveTurn({ conversationId: chat.id }))?.turn.id).toBe(retry.turn.id);
      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id)).toBe("busy");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("changes or removes one Project between turns but not during an active turn", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const first = await aiProjects.create({ subject, name: "First Project" });
    const second = await aiProjects.create({ subject, name: "Second Project" });
    const chat = await aiConversations.createConversation({ ownerUserId: userId, projectId: first.id });
    try {
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 1, 'message', 'user', '{"role":"user","content":["Hello"]}'::jsonb, 'Hello')
      `;
      expect(
        await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: second.id }),
      ).toMatchObject({ ok: true, conversation: { projectId: second.id } });
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: null })).toMatchObject(
        { ok: true, conversation: { projectId: null } },
      );

      await sql`
        INSERT INTO ai.turns (short_id, conversation_id, status)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 'running')
      `;
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: first.id })).toEqual({
        ok: false,
        reason: "active_turn",
      });
    } finally {
      await sql`DELETE FROM ai.projects WHERE id IN (${first.id}::uuid, ${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("stores one optimistic-concurrency draft and keeps identical autosaves idempotent", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({
      ownerUserId: userId,
      draft: [{ type: "text", text: "Initial" }],
    });
    try {
      const unchanged = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: chat.draft.content,
      });
      expect(unchanged).toMatchObject({ ok: true, draft: { revision: chat.draft.revision } });

      const changed = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "resource", ref: { type: "mail.draft", id: "Drf123" } }],
      });
      expect(changed).toMatchObject({ ok: true, draft: { revision: chat.draft.revision + 1 } });
      expect(
        await aiConversations.saveDraft({
          conversationId: chat.id,
          ownerUserId: userId,
          expectedRevision: chat.draft.revision,
          content: [],
        }),
      ).toEqual({ ok: false, reason: "conflict" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("creates a launch draft at a directly submitable revision", async () => {
    const userId = await insertUser();
    try {
      const conversation = await aiConversations.createConversation({
        ownerUserId: userId,
        draft: [
          { type: "text", text: "Help me write this email." },
          { type: "resource", ref: { type: "mail.draft", id: "Draft1" } },
        ],
      });

      expect(conversation.draft).toMatchObject({ revision: 1, content: [{ type: "text" }, { type: "resource" }] });
      const identical = await aiConversations.saveDraft({
        conversationId: conversation.id,
        ownerUserId: userId,
        expectedRevision: 1,
        content: conversation.draft.content,
      });
      expect(identical.ok && identical.draft.revision).toBe(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
