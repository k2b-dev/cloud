import { beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const insertUser = async (label: string) => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-resources-${label}-${suffix}`}, 'local', 'user', ${`Resource ${label}`}, ${`${suffix}@example.test`}, 'Resource', 'Owner')
    RETURNING id
  `;
  return row!.id;
};

databaseSuite()("AI conversation resources (integration)", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
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
        modelId: "test-model",
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
});
