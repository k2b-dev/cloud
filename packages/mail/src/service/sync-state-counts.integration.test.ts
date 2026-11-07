import { afterAll, beforeAll, expect } from "bun:test";
import { SQL } from "bun";
import { createMigratedDatabase, ownTestDatabase, testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { mailboxSyncStateCountsQuery } from "./sync-state-counts";

const test = testFor("database");
const mailboxId = "00000000-0000-4000-8000-000000000001";
const resourceId = "00000000-0000-4000-8000-000000000002";
const otherMailbox = "00000000-0000-4000-8000-000000000003";
const otherResource = "00000000-0000-4000-8000-000000000004";
let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
let db: SQL;
beforeAll(async () => {
  if (!testInfra.database) return;
  database = await createMigratedDatabase("mail_sync_state_plan");
  ownTestDatabase(database.name);
  db = new SQL(database.url, { max: 1 });
  for (const [mailbox, resource, shortId] of [
    [mailboxId, resourceId, "Plan01"],
    [otherMailbox, otherResource, "Plan02"],
  ]) {
    await db`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailbox}::uuid, ${shortId}, 'Sync plan fixture')`;
    await db`INSERT INTO mail.remote_resources (id, mailbox_id, remote_locator, server_identity, scope_fingerprint)
      VALUES (${resource}::uuid, ${mailbox}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)})`;
    await db`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username,
      imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
      VALUES (${mailbox}::uuid, ${mailbox}::uuid, 'Plan fixture', 'plan@example.test', 'plan@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'fixture-only')`;
    await db`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, remote_locator)
      VALUES (${resource}::uuid, ${resource}::uuid, ${mailbox}::uuid, '{}'::jsonb)`;
  }
});
// Bound each fixture insertion below the ordinary test timeout, retaining realistic cardinality.
for (let first = 1; first <= 432000; first += 54000) {
  const start = first;
  beforeAll(async () => {
    if (!testInfra.database) return;
    // 600 runs/hour * 24 hours * 30 days, with normal cursor/stats width. Fixed dates.
    await db`INSERT INTO mail.sync_runs (id, remote_resource_id, binding_id, fence_token, generation, kind, state,
    started_at, finished_at, cursor_before, cursor_after, stats)
    SELECT md5(n::text)::uuid, ${resourceId}::uuid, ${resourceId}::uuid, n, 1, 'incremental', 'completed',
      at, at + interval '1 second', cursor, cursor, '{"imported":0,"flagsUpdated":0,"removed":0}'::jsonb
    FROM generate_series(${start}::int, ${start + 53999}::int) n,
      LATERAL (SELECT '2026-11-01T12:00:00Z'::timestamptz - n * interval '6 seconds' AS at) moment,
      LATERAL (SELECT '{"uidValidity":"10","highestSeenUid":80227,"backfillComplete":true,"backfillNextHigh":null,"flagNextLow":null,"reconcileNextLow":null,"lastFlagSweepAt":"2026-11-01T11:59:00Z","lastReconcileAt":"2026-11-01T11:59:00Z"}'::jsonb AS cursor) cursors`;
  });
}
beforeAll(async () => {
  if (!testInfra.database) return;
  await db`INSERT INTO mail.sync_runs (remote_resource_id, binding_id, fence_token, generation, kind, state, started_at)
    VALUES (${resourceId}::uuid, ${resourceId}::uuid, 1, 1, 'incremental', 'running', '2026-01-01'),
      (${resourceId}::uuid, ${resourceId}::uuid, 1, 1, 'incremental', 'running', '2026-11-01T11:59:00Z'),
      (${resourceId}::uuid, ${resourceId}::uuid, 1, 1, 'incremental', 'failed', '2026-11-01T11:59:00Z'),
      (${otherResource}::uuid, ${otherResource}::uuid, 1, 1, 'incremental', 'running', '2026-11-01T11:59:00Z')`;
  await db`ANALYZE mail.sync_runs`;
  await db`ANALYZE mail.remote_resources`;
});
afterAll(async () => {
  await db?.close();
  await database?.drop();
});
const beforeQuery = `SELECT run.state, COUNT(*)::int AS count FROM mail.sync_runs run
 JOIN mail.remote_resources resource ON resource.id = run.remote_resource_id
 WHERE resource.mailbox_id = $1::uuid AND (run.state = 'running' OR run.started_at > now() - $2::int * interval '1 hour') GROUP BY run.state`;

test("generic operator counts seek running and recent runs without scanning 30-day history", async () => {
  const freeze = (query: string) => query.replaceAll("now()", "'2026-11-01T12:00:00Z'::timestamptz");
  const explain = (query: string) =>
    db.begin(async (tx) => {
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.unsafe(`PREPARE counts(uuid,int) AS ${freeze(query)}`).simple();
      try {
        return JSON.stringify(await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE counts('${mailboxId}',24)`).simple());
      } finally {
        await tx`DEALLOCATE counts`.simple();
      }
    });
  const before = await explain(beforeQuery);
  const after = await explain(mailboxSyncStateCountsQuery);
  console.info("generic sync counts execution ms", {
    before: before.match(/"Execution Time":([\d.]+)/)?.[1],
    after: after.match(/"Execution Time":([\d.]+)/)?.[1],
  });

  expect(after).toMatch(/sync_runs_(running|resource_not_completed)_idx/);
  expect(after).toContain("sync_runs_resource_idx");
  const old = await db.unsafe<{ state: string; count: number }[]>(freeze(beforeQuery), [mailboxId, 24]);
  const current = await db.unsafe<{ state: string; count: number }[]>(freeze(mailboxSyncStateCountsQuery), [mailboxId, 24]);
  const sorted = (rows: typeof old) => [...rows].sort((a, b) => String(a.state).localeCompare(String(b.state)));
  expect(sorted(current)).toEqual(sorted(old));
  expect(sorted(current)).toEqual([
    { state: "completed", count: 14399 },
    { state: "failed", count: 1 },
    { state: "running", count: 2 },
  ]);
  expect(sorted(await db.unsafe<{ state: string; count: number }[]>(freeze(mailboxSyncStateCountsQuery), [mailboxId, 1]))).toEqual([
    { state: "completed", count: 599 },
    { state: "failed", count: 1 },
    { state: "running", count: 2 },
  ]);
  expect(await db.unsafe<{ state: string; count: number }[]>(freeze(mailboxSyncStateCountsQuery), [otherMailbox, 24])).toEqual([
    { state: "running", count: 1 },
  ]);
  expect(
    await db.unsafe<{ state: string; count: number }[]>(freeze(mailboxSyncStateCountsQuery), ["00000000-0000-4000-8000-000000000005", 24]),
  ).toEqual([]);
});
