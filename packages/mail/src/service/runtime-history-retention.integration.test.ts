import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { buildRuntimeHistoryIndexes, migrate } from "../migrate";
import { cleanupMailRuntimeHistory, runtimeHistoryBatches } from "./runtime-history-retention";

const suite = suiteFor("database", "nats", "valkey");
const now = new Date("2026-11-11T12:00:00Z");
const mailbox = "00000000-0000-4000-8000-000000000101";
const resource = "00000000-0000-4000-8000-000000000102";
const connection = "00000000-0000-4000-8000-000000000103";
const binding = "00000000-0000-4000-8000-000000000104";

suite("Mail runtime history retention", () => {
  beforeAll(async () => {
    await sql`INSERT INTO mail.mailboxes (id, short_id, name) VALUES (${mailbox}::uuid, 'Ret001', 'Retention fixture')`;
    await sql`INSERT INTO mail.remote_resources (id, mailbox_id, remote_locator, server_identity, scope_fingerprint)
      VALUES (${resource}::uuid, ${mailbox}::uuid, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)})`;
    await sql`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username,
      imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
      VALUES (${connection}::uuid, ${mailbox}::uuid, 'Retention fixture', 'retention@example.test', 'retention@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls', 'password', 'fixture-only')`;
    await sql`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, remote_locator)
      VALUES (${binding}::uuid, ${resource}::uuid, ${connection}::uuid, '{}'::jsonb)`;
    await buildRuntimeHistoryIndexes();
  });
  beforeEach(async () => {
    await sql`DELETE FROM mail.sync_runs WHERE remote_resource_id = ${resource}::uuid`;
    await sql`DELETE FROM mail.automation_log WHERE mailbox_id = ${mailbox}::uuid`;
  });
  afterAll(async () => {
    await sql`DELETE FROM mail.sync_runs WHERE remote_resource_id = ${resource}::uuid`;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox}::uuid`;
  });

  const seedRuns = (count: number, state = "completed", at = "2026-11-01T12:00:00Z") => sql`
    INSERT INTO mail.sync_runs (remote_resource_id, binding_id, fence_token, generation, kind, state,
      started_at, finished_at, cursor_before, cursor_after, stats)
    SELECT ${resource}::uuid, ${binding}::uuid, n, 1, 'incremental', ${state}, ${at}::timestamptz,
      CASE WHEN ${state} = 'running' THEN NULL ELSE ${at}::timestamptz END,
      '{"highestSeenUid":1000}'::jsonb, '{"highestSeenUid":1001}'::jsonb, '{"imported":1}'::jsonb
    FROM generate_series(1,${count}::int) n`;

  test("retains three days of successes and thirty days of errors, including null finish times", async () => {
    await seedRuns(1, "completed", "2026-11-07T12:00:00Z");
    await seedRuns(1, "completed", "2026-11-09T12:00:00Z");
    await seedRuns(1, "failed", "2026-11-07T12:00:00Z");
    await seedRuns(1, "failed", "2026-10-11T12:00:00Z");
    await seedRuns(1, "stale_fence", "2026-10-11T12:00:00Z");
    await seedRuns(1, "cancelled", "2026-10-11T12:00:00Z");
    await seedRuns(1, "running", "2026-01-01T12:00:00Z");
    await sql`UPDATE mail.sync_runs SET finished_at = NULL WHERE state = 'cancelled'`;
    expect(await cleanupMailRuntimeHistory({ now })).toEqual({ syncRuns: 4, automationLog: 0, automationOrder: 0 });
    const rows = await sql<{ state: string }[]>`SELECT state FROM mail.sync_runs ORDER BY state`;
    expect(rows.map((row) => row.state)).toEqual(["completed", "failed", "running"]);
  });

  test("drains a forty-thousand-row backlog across bounded, independently committed batches", async () => {
    await seedRuns(40_001);
    const started = performance.now();
    let deleted = 0;
    for (let pass = 0; pass < 12; pass += 1) {
      const result = await cleanupMailRuntimeHistory({ now, batchSize: 1_000, maxBatches: 4 });
      expect(result.syncRuns).toBeLessThanOrEqual(4_000);
      if (pass === 0) expect(result.syncRuns).toBe(4_000);
      deleted += result.syncRuns;
      if (deleted === 40_001) break;
    }
    expect(deleted).toBe(40_001);
    expect(await sql`SELECT id FROM mail.sync_runs`).toHaveLength(0);
    console.info("Mail history backlog drain", { deleted, durationMs: Math.round(performance.now() - started) });
  });

  test("skips locked rows and preserves committed sync cleanup when another table fails", async () => {
    await seedRuns(2);
    await sql.begin(async (locker) => {
      await locker`SELECT id FROM mail.sync_runs ORDER BY id LIMIT 1 FOR UPDATE`;
      expect((await cleanupMailRuntimeHistory({ now })).syncRuns).toBe(1);
    });
    await sql`INSERT INTO mail.automation_log (mailbox_id, item, created_at)
      VALUES (${mailbox}::uuid, '{}'::jsonb, '2026-10-01T12:00:00Z')`;
    await sql
      .unsafe(`CREATE FUNCTION mail.reject_retention_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'retention failure fixture'; END $$`)
      .simple();
    await sql
      .unsafe(`CREATE TRIGGER reject_retention_probe BEFORE DELETE ON mail.automation_log
      FOR EACH ROW EXECUTE FUNCTION mail.reject_retention_probe()`)
      .simple();
    try {
      await expect(cleanupMailRuntimeHistory({ now })).rejects.toThrow("Mail runtime history cleanup failed");
      expect(await sql`SELECT id FROM mail.sync_runs`).toHaveLength(0);
      expect(await sql`SELECT id FROM mail.automation_log`).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER reject_retention_probe ON mail.automation_log`;
      await sql`DROP FUNCTION mail.reject_retention_probe()`;
    }
    expect((await cleanupMailRuntimeHistory({ now })).automationLog).toBe(1);
  });

  test("upgrades build indexes in the background and generic cleanup plans seek the age index", async () => {
    for (const source of runtimeHistoryBatches) await sql.unsafe(`DROP INDEX ${source.index}`).simple();
    await migrate();
    for (const source of runtimeHistoryBatches) {
      const [index] = await sql<{ present: boolean }[]>`SELECT to_regclass(${source.index}) IS NOT NULL AS present`;
      expect(index?.present).toBe(false);
    }
    await seedRuns(20_000);
    await seedRuns(20_000, "failed", "2026-10-01T12:00:00Z");
    expect((await cleanupMailRuntimeHistory({ now })).syncRuns).toBe(0);
    await buildRuntimeHistoryIndexes();
    await sql`ANALYZE mail.sync_runs`;
    for (const source of runtimeHistoryBatches.filter((source) => source.key === "syncRuns")) {
      const plan = await sql.begin(async (tx) => {
        await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
        await tx.unsafe(`PREPARE retention_batch(timestamptz,int) AS ${source.query}`).simple();
        try {
          return JSON.stringify(await tx`EXPLAIN (FORMAT JSON) EXECUTE retention_batch('2026-10-12T12:00:00Z',25)`);
        } finally {
          await tx`DEALLOCATE retention_batch`.simple();
        }
      });
      expect(plan).toContain(source.index.replace("mail.", ""));
      expect(plan).toContain('"Node Type":"Tid Scan"');
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
      expect(plan).not.toContain('"Node Type":"Sort"');
    }
  });

  test("database statement budgets stop a slow auxiliary batch and release its locks", async () => {
    await seedRuns(1);
    await sql`INSERT INTO mail.automation_log (mailbox_id, item, created_at)
      VALUES (${mailbox}::uuid, '{}'::jsonb, '2026-10-01T12:00:00Z')`;
    await sql
      .unsafe(`CREATE FUNCTION mail.slow_retention_probe() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(1); RETURN OLD; END $$`)
      .simple();
    await sql
      .unsafe(`CREATE TRIGGER slow_retention_probe BEFORE DELETE ON mail.automation_log
      FOR EACH ROW EXECUTE FUNCTION mail.slow_retention_probe()`)
      .simple();
    try {
      const result = await cleanupMailRuntimeHistory({ now, maxDurationMs: 400 });
      expect(result.syncRuns).toBe(1);
      expect(result.automationLog).toBe(0);
      expect(await sql`SELECT id FROM mail.automation_log`).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER slow_retention_probe ON mail.automation_log`;
      await sql`DROP FUNCTION mail.slow_retention_probe()`;
    }
    expect((await cleanupMailRuntimeHistory({ now })).automationLog).toBe(1);
  });
});
