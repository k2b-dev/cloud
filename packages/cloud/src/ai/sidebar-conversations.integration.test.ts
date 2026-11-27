import { beforeAll, expect, test } from "bun:test";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { AI_SIDEBAR_CONVERSATIONS_MAX } from "./limits";
import { migrateCloudAi } from "./migrate";
import { aiConversations } from "./store";

const suite = databaseSuite();

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-sidebar-${suffix}`}, 'local', 'user', 'AI Sidebar Test', ${`ai-sidebar-${suffix}@example.test`}, 'AI', 'Sidebar')
    RETURNING id
  `;
  return row!.id;
};

suite("the sidebar's open chats", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("a person with more open chats than the sidebar holds gets one bounded statement, pinned first, then the newest", async () => {
    const userId = await insertUser();
    try {
      // More open chats than the sidebar lists, each used a second after the one before (recently, so none counts as done by
      // age); the oldest is pinned.
      const total = AI_SIDEBAR_CONVERSATIONS_MAX + 20;
      const created = [];
      for (let n = 1; n <= total; n++) created.push(await aiConversations.createConversation({ ownerUserId: userId, title: `Chat ${n}` }));
      for (const [index, chat] of created.entries())
        await sql`UPDATE ai.conversations SET last_used_at = now() - ${total - index} * interval '1 second' WHERE id = ${chat.id}::uuid`;
      await aiConversations.setConversationPinned({ conversationId: created[0]!.id, ownerUserId: userId, pinned: true });

      const meter = await meterSql();
      let page: Awaited<ReturnType<typeof aiConversations.listSidebarConversations>> = [];
      let more: typeof page = [];
      try {
        const statements = await meter.during(async () => {
          page = await aiConversations.listSidebarConversations({ ownerUserId: userId });
        });
        expect(statements).toHaveLength(1);
        // One more than the sidebar shows, so the caller knows the list goes on, still in one statement.
        const probe = await meter.during(async () => {
          more = await aiConversations.listSidebarConversations({ ownerUserId: userId, limit: AI_SIDEBAR_CONVERSATIONS_MAX + 1 });
        });
        expect(probe).toHaveLength(1);
      } finally {
        await meter.close();
      }
      expect(page).toHaveLength(AI_SIDEBAR_CONVERSATIONS_MAX);
      expect(page[0]?.title).toBe("Chat 1");
      expect(page[1]?.title).toBe(`Chat ${total}`);
      expect(more).toHaveLength(AI_SIDEBAR_CONVERSATIONS_MAX + 1);
      // A larger request never lifts the bound.
      expect(await aiConversations.listSidebarConversations({ ownerUserId: userId, limit: 10_000 })).toHaveLength(
        AI_SIDEBAR_CONVERSATIONS_MAX + 1,
      );
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("the counts say whether the person has archived chats, in their one statement", async () => {
    const userId = await insertUser();
    try {
      const chat = await aiConversations.createConversation({ ownerUserId: userId, title: "Archived later" });
      expect((await aiConversations.getConversationCounts({ ownerUserId: userId })).hasArchived).toBe(false);
      await sql`UPDATE ai.conversations SET archived_at = now() WHERE id = ${chat.id}::uuid`;
      const meter = await meterSql();
      let counts: Awaited<ReturnType<typeof aiConversations.getConversationCounts>> | undefined;
      try {
        const statements = await meter.during(async () => {
          counts = await aiConversations.getConversationCounts({ ownerUserId: userId });
        });
        expect(statements).toHaveLength(1);
      } finally {
        await meter.close();
      }
      expect(counts?.hasArchived).toBe(true);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
