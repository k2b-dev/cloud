import { afterAll, beforeAll, expect, test } from "bun:test";
import { databaseSuite, useMigratedDatabase } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { ensureAiConversationSidebarIndex } from "./conversation-indexes";

// The sidebar's query (`listSidebarConversations` in store.ts): its table, filter and order. The order is checked against
// the store's source below, so the index and the query cannot drift apart unnoticed.
const SIDEBAR_ORDER = "ORDER BY conversation.pinned_at DESC NULLS LAST, conversation.last_used_at DESC, conversation.id";
const sidebarPlan = async (owner: string, limit: number | null) => {
  const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(
    `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
      SELECT conversation.id FROM ai.conversations conversation
      WHERE conversation.place_type IS NULL
        AND conversation.created_by_user_id = $1::uuid
        AND conversation.archived_at IS NULL
        AND NOT (conversation.pinned_at IS NULL AND COALESCE(conversation.done,
          conversation.last_used_at <= now() - interval '7 days'
          AND NOT EXISTS (SELECT 1 FROM ai.turns active_turn WHERE active_turn.conversation_id = conversation.id
            AND NOT COALESCE(active_turn.run_config ? 'background', false) AND active_turn.status IN ('queued', 'running', 'waiting_for_action'))
          AND NOT EXISTS (SELECT 1 FROM ai.queued_messages pending WHERE pending.conversation_id = conversation.id
            AND (pending.status='pending' OR (pending.status='failed' AND pending.automation_source IS NULL)))))
      ${SIDEBAR_ORDER}${limit === null ? "" : ` LIMIT ${limit}`}`,
    [owner],
  );
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
};

databaseSuite()("the sidebar's chat index", () => {
  let database: Awaited<ReturnType<typeof useMigratedDatabase>>;
  const people = ["6c000000-0000-4000-8000-000000000001", "6c000000-0000-4000-8000-000000000002", "6c000000-0000-4000-8000-000000000003"];
  const owner = people[0]!;
  beforeAll(async () => {
    database = await useMigratedDatabase("ai_conversation_indexes");
    for (const id of people)
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`sidebar-${id}`},'local','user')`;
    // A person who keeps a lot: 5,000 chats each, 15 pinned, 1,500 archived, 100 marked done, 2,400 unused for more than
    // a week (done by age), the rest open and used over the last days; two more people with as many.
    for (const [index, id] of people.entries())
      await sql`
        INSERT INTO ai.conversations(short_id, title, created_by_user_id, created_at, updated_at, last_used_at, pinned_at, archived_at, done)
        SELECT ${`s${index}`} || lpad(n::text, 5, '0'), 'Chat ' || n, ${id}::uuid,
          now() - make_interval(hours => n), now() - make_interval(hours => n),
          CASE WHEN n % 5000 BETWEEN 2500 AND 4899 THEN now() - make_interval(days => 8 + n % 300) ELSE now() - make_interval(mins => n) END,
          CASE WHEN n <= 15 THEN now() - make_interval(mins => n) END,
          CASE WHEN n BETWEEN 1001 AND 2500 THEN now() - make_interval(days => 1) END,
          CASE WHEN n BETWEEN 901 AND 1000 THEN true END
        FROM generate_series(1, 5000) n`;
    await sql`ANALYZE ai.conversations`.simple();
  }, 120_000);
  afterAll(async () => {
    await sql.close();
    await database?.drop();
  });

  test("the store's sidebar query still orders the way the index does", async () => {
    const store = await Bun.file(new URL("./store.ts", import.meta.url)).text();
    expect(store).toContain(SIDEBAR_ORDER);
  });

  test("the sidebar reads its page from the index in order, where it sorted every open chat before", async () => {
    await sql`DROP INDEX IF EXISTS ai.idx_ai_conversations_owner_sidebar`.simple();
    const before = await sidebarPlan(owner, 41);
    expect(await ensureAiConversationSidebarIndex()).toBe(true);
    await sql`ANALYZE ai.conversations`.simple();
    const after = await sidebarPlan(owner, 41);
    const whole = await sidebarPlan(owner, null);
    console.info(
      `sidebar plan without the index:\n${before}\n\nwith it (first page of 41):\n${after}\n\nwith it (every open chat):\n${whole}`,
    );
    expect(before).toContain("Sort");
    expect(after).toContain("idx_ai_conversations_owner_sidebar");
    expect(after).not.toContain("Sort");
    expect(whole).toContain("idx_ai_conversations_owner_sidebar");
    expect(whole).not.toContain("Sort");
  });

  test("a repeated migration keeps the valid index, and an interrupted build is replaced", async () => {
    expect(await ensureAiConversationSidebarIndex()).toBe(true);
    // An invalid leftover, as an interrupted CREATE INDEX CONCURRENTLY leaves it.
    await sql`UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = to_regclass('ai.idx_ai_conversations_owner_sidebar')`.simple();
    expect(await ensureAiConversationSidebarIndex()).toBe(true);
    const [index] = await sql<{ valid: boolean }[]>`SELECT indisvalid AS valid FROM pg_catalog.pg_index
      WHERE indexrelid = to_regclass('ai.idx_ai_conversations_owner_sidebar')`;
    expect(index?.valid).toBe(true);
  });
});
