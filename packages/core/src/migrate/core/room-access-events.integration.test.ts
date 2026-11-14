import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";
import { meterSql } from "../../../../../scripts/fixtures/sql-meter";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as auth } from "./auth";
import { migrate as events } from "./events";
import { migrate } from "./room-access-events";
import { migrate as settings } from "./settings";

databaseSuite()("identity recipient enumeration after a bulk directory write", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>>;
  const group = "10000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    database = await useFreshDatabase("identity_recipients");
    await auth();
    await settings();
    await events();
    await migrate();
  });
  afterAll(async () => {
    await database?.drop();
  });

  test("nested and directory members are deduplicated", async () => {
    const ids = [1, 2, 3, 4].map((n) => `20000000-0000-4000-8000-00000000000${n}`);
    const child = "10000000-0000-4000-8000-000000000002";
    await sql`INSERT INTO auth.users(id, uid, provider, profile)
      SELECT value::uuid, value, 'local', 'user' FROM unnest(${toPgTextArray(ids)}::text[]) value`;
    await sql`INSERT INTO auth.groups(id, cn, name, provider) VALUES
      (${group}::uuid, 'parent', 'parent', 'local'), (${child}::uuid, 'child', 'child', 'local')`;
    await sql`INSERT INTO auth.group_groups_v2(parent_group_id, child_group_id) VALUES (${group}::uuid, ${child}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2(user_id, group_id) VALUES
      (${ids[0]}::uuid, ${group}::uuid), (${ids[0]}::uuid, ${child}::uuid), (${ids[1]}::uuid, ${child}::uuid)`;
    await sql`INSERT INTO auth.ipa_user_effective_groups(user_id, group_name) VALUES
      (${ids[0]}::uuid, 'parent'), (${ids[2]}::uuid, 'parent')`;
    const recipients = async () =>
      (
        await sql<{ user_id: string }[]>`SELECT payload->'d'->>'userId' AS user_id
      FROM events.outbox WHERE app_id = 'core' AND kind = 'live' ORDER BY user_id`
      ).map((row) => row.user_id);
    await sql`DELETE FROM events.outbox`;
    await sql`INSERT INTO auth.access(group_id, permission) VALUES (${group}::uuid, 'read')`;
    expect(await recipients()).toEqual(ids.slice(0, 3));
    await sql`DELETE FROM auth.access`;
    await sql`DELETE FROM auth.groups`;
    await sql`DELETE FROM auth.users`;
  });

  test("a structural group grant enumerates memberships once and invalidates each person once", async () => {
    const meter = await meterSql();
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
        // Keep the small-table statistics and reusable plan from the CI failure.
        // Count actual work instead of asserting an elapsed-time deadline.
        await tx`ALTER TABLE auth.users SET (autovacuum_enabled = false)`;
        await tx`ALTER TABLE auth.user_groups_v2 SET (autovacuum_enabled = false)`;
        await tx`INSERT INTO auth.users(uid, provider, profile) SELECT 'existing-' || i, 'local', 'user' FROM generate_series(1, 4) i`;
        await tx`INSERT INTO auth.groups(id, cn, name, provider) VALUES (${group}::uuid, 'bulk', 'bulk', 'local')`;
        await tx`INSERT INTO auth.user_groups_v2(user_id, group_id) SELECT id, ${group}::uuid FROM auth.users`;
        await tx`ANALYZE auth.users`;
        await tx`ANALYZE auth.user_groups_v2`;
        // Prime the trigger's reusable plan before the bulk write, as preceding
        // tests in the CI shard do on their shared connection.
        await tx`INSERT INTO auth.access(group_id, permission) VALUES (${group}::uuid, 'read')`;
        await tx`INSERT INTO auth.users(uid, provider, profile)
          SELECT 'bulk-' || i, 'local', 'user' FROM generate_series(1, 4996) i`;
        await tx`INSERT INTO auth.user_groups_v2(user_id, group_id) SELECT id, ${group}::uuid FROM auth.users WHERE uid LIKE 'bulk-%'`;
        await tx`INSERT INTO auth.ipa_user_effective_groups(user_id, group_name) SELECT id, 'bulk' FROM auth.users WHERE uid LIKE 'bulk-%' LIMIT 1`;
        await tx`DELETE FROM events.outbox`;
        const scans = () => tx<{ scans: number }[]>`SELECT coalesce(sum(seq_scan + idx_scan), 0)::int AS scans
          FROM pg_stat_xact_user_tables WHERE schemaname = 'auth' AND relname IN ('user_groups_v2', 'ipa_user_effective_groups')`;
        const before = (await scans())[0]!.scans;
        const statements = await meter.during(() => tx`INSERT INTO auth.access(group_id, permission) VALUES (${group}::uuid, 'read')`);
        expect(statements).toHaveLength(1);
        const after = (await scans())[0]!.scans;
        // One scan of each membership relation for the single affected group.
        expect(after - before).toBeLessThanOrEqual(2);
        const [row] = await tx<{ count: number; unique: number }[]>`SELECT count(*)::int AS count,
          count(DISTINCT payload->'d'->>'userId')::int AS unique FROM events.outbox WHERE app_id = 'core' AND kind = 'live'`;
        expect(row).toEqual({ count: 5000, unique: 5000 });
      });
    } finally {
      await meter.close();
    }
  });
});
