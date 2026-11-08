import { beforeAll, expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const suite = databaseSuite();
suite("personal place conversations", () => {
  beforeAll(migrateCloudAi);
  test("first-message creation is unique per person and place; restart archives without losing refs", async () => {
    const users: string[] = [];
    try {
      for (const name of ["Lea", "Ben"]) {
        const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name)
          VALUES (${`place-${name}-${crypto.randomUUID()}`}, 'local', 'user', ${name}) RETURNING id`;
        users.push(user!.id);
      }
      const lea = users[0]!;
      const ben = users[1]!;
      const place = { ref: { type: "fixture.conversation", id: "Marta1" }, title: "Marta" };
      const draft = [{ type: "text" as const, text: "Shorten this reply" }];
      expect(await aiConversations.findPlaceConversation({ ownerUserId: lea, ref: place.ref })).toBeNull();
      expect(await aiConversations.listConversations({ ownerUserId: lea, place: "any" })).toEqual([]);
      await expect(aiConversations.createPlaceConversation({ ownerUserId: lea, place, draft: [] })).rejects.toThrow("first message");
      const chats = await Promise.all(
        Array.from({ length: 3 }, () => aiConversations.createPlaceConversation({ ownerUserId: lea, place, draft })),
      );
      const chat = chats[0]!;
      expect(new Set(chats.map((item) => item.id)).size).toBe(1);
      expect(chat.place).toEqual(place);
      expect(chat.draft.content).toEqual(draft);
      expect(await aiConversations.listConversations({ ownerUserId: lea })).toEqual([]);
      expect(await aiConversations.listSidebarConversations({ ownerUserId: lea })).toEqual([]);
      expect(
        (await aiConversations.listConversations({ ownerUserId: lea, place: "any", refs: [place.ref] })).map((item) => item.id),
      ).toEqual([chat.id]);
      expect(await aiConversations.listConversationsPage({ ownerUserId: lea, page: 1, perPage: 10 })).toMatchObject({
        total: 0,
        items: [],
      });
      expect(
        await aiConversations.listConversationsPage({ ownerUserId: lea, place: "fixture.conversation:Marta1", page: 1, perPage: 10 }),
      ).toMatchObject({ total: 1, items: [{ place }] });
      expect(await aiConversations.findPlaceConversation({ ownerUserId: ben, ref: place.ref })).toBeNull();
      expect(await aiConversations.listConversations({ ownerUserId: ben, place: "any", search: "Marta" })).toEqual([]);
      expect(await aiConversations.listConversationsPage({ ownerUserId: ben, place: "any", page: 1, perPage: 10 })).toMatchObject({
        total: 0,
        items: [],
      });
      expect(await aiConversations.getConversationByShortId({ ownerUserId: ben, shortId: chat.shortId })).toBeNull();
      expect(await aiConversations.archivePlaceConversation({ ownerUserId: ben, conversationId: chat.id, ref: place.ref })).toBe(false);
      expect(await aiConversations.archivePlaceConversation({ ownerUserId: lea, conversationId: chat.id, ref: place.ref })).toBe(true);
      expect(await aiConversations.findPlaceConversation({ ownerUserId: lea, ref: place.ref })).toBeNull();
      const replacement = await aiConversations.createPlaceConversation({ ownerUserId: lea, place, draft });
      expect(replacement.id).not.toBe(chat.id);
      expect(await aiConversations.restoreConversation({ ownerUserId: lea, conversationId: chat.id })).toBeNull();
      expect((await aiConversations.listConversations({ ownerUserId: lea, place: "any", archived: true }))[0]?.id).toBe(chat.id);
    } finally {
      for (const user of users) {
        await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${user}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${user}::uuid`;
      }
    }
  });
});
