import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { aiCapabilityId } from "./capabilities";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";
import { aiToolAudit } from "./tool-audit";

const canUseAiDatabase = async () => {
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!row?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

const insertUser = async (label: string) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-inter-chat-${label}-${suffix}`}, 'local', 'user', ${`Inter Chat ${label}`}, ${`${suffix}@example.test`}, 'Inter', 'Chat')
    RETURNING id
  `;
  return row!.id;
};

describe.skipIf(!(await canUseAiDatabase()))("AI conversation resources and inter-chat messages (integration)", () => {
  test("indexes structured refs and searches their owned chat occurrences", async () => {
    const userId = await insertUser("resources");
    const first = await aiConversations.createConversation({ ownerUserId: userId, title: "Release" });
    const second = await aiConversations.createConversation({ ownerUserId: userId, title: "Mail" });
    try {
      await aiConversations.indexConversationResources({
        conversationId: first.id,
        callId: "call-1",
        resources: [{ ref: { type: "notebooks.note", id: "nT1234" }, title: "Release notes" }],
      });
      await aiConversations.indexConversationResources({
        conversationId: first.id,
        callId: "call-2",
        resources: [{ ref: { type: "notebooks.note", id: "nT1234" }, href: "/app/notebooks/nB1234/nT1234" }],
      });
      await aiConversations.indexConversationResources({
        conversationId: second.id,
        resources: [{ ref: { type: "mail.message", id: "eM1234" }, title: "Deployment notice" }],
      });
      await aiConversations.submitChatTurn({
        conversationId: first.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: "The migration timeline is Friday.", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "The migration timeline is Friday." }] },
      });

      const local = await aiConversations.listConversationResources({ conversationId: first.id, search: "nT1234" });
      expect(local.resources).toHaveLength(1);
      expect(local.resources[0]).toMatchObject({
        ref: { type: "notebooks.note", id: "nT1234" },
        title: "Release notes",
        href: "/app/notebooks/nB1234/nT1234",
        sourceCallId: "call-2",
      });

      const across = await aiConversations.listUserConversationResources({
        ownerUserId: userId,
        search: "deployment",
      });
      expect(across.resources).toHaveLength(1);
      expect(across.resources[0]).toMatchObject({ ref: { type: "mail.message", id: "eM1234" }, chat: { shortId: second.shortId } });

      const chats = await aiConversations.listConversations({
        ownerUserId: userId,
        refs: [{ type: "notebooks.note", id: "nT1234" }],
      });
      expect(chats.map((chat) => chat.shortId)).toEqual([first.shortId]);

      const messages = await aiConversations.searchConversationMessages({
        conversationId: first.id,
        query: "migration timeline",
      });
      expect(messages.messages).toHaveLength(1);
      expect(messages.messages[0]?.shortId).toMatch(/^[A-Za-z0-9]{6}$/);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${first.id}::uuid, ${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("delivers one attributable idempotent message into another owned chat", async () => {
    const userId = await insertUser("delivery");
    const otherUserId = await insertUser("other");
    const source = await aiConversations.createConversation({ ownerUserId: userId, title: "Source" });
    const target = await aiConversations.createConversation({ ownerUserId: userId, title: "Target" });
    const idleTarget = await aiConversations.createConversation({ ownerUserId: userId, title: "Idle target" });
    const otherIdleTarget = await aiConversations.createConversation({
      ownerUserId: userId,
      title: "Other idle target",
    });
    const archived = await aiConversations.createConversation({ ownerUserId: userId, title: "Archived" });
    const foreign = await aiConversations.createConversation({ ownerUserId: otherUserId, title: "Foreign" });
    try {
      expect(await aiConversations.archiveConversation({ conversationId: archived.id, ownerUserId: userId })).toBe(true);
      const sourceTurn = await aiConversations.createCompactionTurn({
        conversationId: source.id,
        modelProfileId: "test-model",
        runConfig: { kind: "compact" },
      });
      await aiToolAudit.noteCapabilityDispatch({
        conversationId: source.id,
        turnId: sourceTurn.id,
        callId: "call-message",
        toolName: aiCapabilityId("assistant", "chat.message"),
        idempotencyKey: "ai-inter-chat-test",
      });
      expect(
        await aiConversations.getCapabilityInvocationOrigin({
          idempotencyKey: "ai-inter-chat-test",
          toolName: "assistant.other-action",
        }),
      ).toBeNull();
      const origin = await aiConversations.getCapabilityInvocationOrigin({
        idempotencyKey: "ai-inter-chat-test",
        toolName: aiCapabilityId("assistant", "chat.message"),
      });
      expect(origin).toMatchObject({
        conversationId: source.id,
        conversationShortId: source.shortId,
        turnId: sourceTurn.id,
        turnShortId: sourceTurn.shortId,
        callId: "call-message",
      });
      const created = await aiConversations.createInterChatMessage({
        sourceConversationId: origin!.conversationId,
        sourceTurnId: origin!.turnId,
        sourceCallId: origin!.callId,
        targetChatId: target.shortId,
        actorUserId: userId,
        text: "Please verify the release date.",
        idempotencyKey: "ai-inter-chat-test",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const duplicate = await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-message",
        targetChatId: target.shortId,
        actorUserId: userId,
        text: "Please verify the release date.",
        idempotencyKey: "ai-inter-chat-test",
      });
      expect(duplicate.ok && duplicate.message.id).toBe(created.message.id);

      const foreignResult = await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-foreign",
        targetChatId: foreign.shortId,
        actorUserId: userId,
        text: "Do not deliver.",
        idempotencyKey: "ai-inter-chat-foreign",
      });
      expect(foreignResult).toEqual({ ok: false, reason: "not_found" });
      const archivedResult = await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-archived",
        targetChatId: archived.shortId,
        actorUserId: userId,
        text: "Do not deliver.",
        idempotencyKey: "ai-inter-chat-archived",
      });
      expect(archivedResult).toEqual({ ok: false, reason: "not_found" });

      const text = `Assistant message from chat ${source.shortId} (${source.title}):\n\nPlease verify the release date.`;
      const delivered = await aiConversations.deliverInterChatMessage({
        messageId: created.message.id,
        modelProfileId: "test-model",
        runConfig: { kind: "chat", input: text, toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text }] },
        sourceHref: `/app/assistant?conversation=${source.shortId}`,
      });
      expect(delivered.delivered).toBe(true);
      const messages = await aiConversations.listMessages({ conversationId: target.id });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        loopId: delivered.delivered ? delivered.turn.id : null,
        meta: {
          agentMessage: {
            id: created.message.shortId,
            sourceChatId: source.shortId,
            sourceTurnId: sourceTurn.shortId,
            sourceTitle: source.title,
            sourceHref: `/app/assistant?conversation=${source.shortId}`,
          },
        },
      });

      const queued = await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-busy",
        targetChatId: target.shortId,
        actorUserId: userId,
        text: "Wait until the active target turn finishes.",
        idempotencyKey: "ai-inter-chat-busy",
      });
      expect(queued.ok).toBe(true);
      if (queued.ok) {
        expect(
          await aiConversations.deliverInterChatMessage({
            messageId: queued.message.id,
            modelProfileId: "test-model",
            runConfig: { kind: "chat", input: queued.message.text, toolSource: { kind: "none" } },
            userMessage: { role: "user", content: [{ type: "text", text: queued.message.text }] },
          }),
        ).toEqual({ delivered: false, reason: "busy" });
      }

      const deliverable = await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-deliverable",
        targetChatId: idleTarget.shortId,
        actorUserId: userId,
        text: "Do not starve behind the busy target.",
        idempotencyKey: "ai-inter-chat-deliverable",
      });
      expect(deliverable.ok).toBe(true);
      await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-same-target",
        targetChatId: idleTarget.shortId,
        actorUserId: userId,
        text: "Wait behind the first message for this target.",
        idempotencyKey: "ai-inter-chat-same-target",
      });
      await aiConversations.createInterChatMessage({
        sourceConversationId: source.id,
        sourceTurnId: sourceTurn.id,
        sourceCallId: "call-other-target",
        targetChatId: otherIdleTarget.shortId,
        actorUserId: userId,
        text: "Deliver independently.",
        idempotencyKey: "ai-inter-chat-other-target",
      });
      expect((await aiConversations.listPendingInterChatMessages({ limit: 2 })).map((message) => message.targetChatId)).toEqual([
        idleTarget.shortId,
        otherIdleTarget.shortId,
      ]);

      const [recursiveSource] = delivered.delivered
        ? await sql<{ recursive: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM ai.messages
              WHERE conversation_id = ${target.id}::uuid
                AND loop_id = ${delivered.turn.id}
                AND meta ? 'agentMessage'
            ) AS recursive
          `
        : [{ recursive: false }];
      expect(recursiveSource?.recursive).toBe(true);

      const recursive = await aiConversations.createInterChatMessage({
        sourceConversationId: target.id,
        sourceTurnId: delivered.delivered ? delivered.turn.id : sourceTurn.id,
        sourceCallId: "call-recursive",
        targetChatId: source.shortId,
        actorUserId: userId,
        text: "This must not cascade.",
        idempotencyKey: "ai-inter-chat-recursive",
      });
      expect(recursive).toEqual({ ok: false, reason: "recursive" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${source.id}::uuid, ${target.id}::uuid, ${idleTarget.id}::uuid, ${otherIdleTarget.id}::uuid, ${archived.id}::uuid, ${foreign.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherUserId}::uuid)`;
    }
  });
});
