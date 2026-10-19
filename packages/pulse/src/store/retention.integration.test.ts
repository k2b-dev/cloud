import { beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { updateBase } from "../service/base-management";
import { cleanupFixtureBase, fixtureBase, fixtureClock, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { retentionPreview } from "./retention";
import { settingsFixture } from "./settings.test-fixture";
import { quoteIdentifier as q } from "./validation";

const suite = suiteFor("database", "clickhouse");
suite("Pulse per-base retention", () => {
  beforeAll(installFixtureStore, 30_000);
  test("TTL definitions converge and shorter retention previews real rows and estimated bytes", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      settings = settingsFixture();
    try {
      await createBaseLifecycle(store)(base.id);
      // ClickHouse DateTime TTL arithmetic must never use far-future fixture dates (overflow in 2106).
      await store.query(
        `INSERT INTO ${q(base.database)}._events(id,ts,kind,sensitive,version) SELECT generateUUIDv4(),now64(3)-INTERVAL 2 DAY,'ttl','private fixture',1`,
      );
      const old = { retention_days: 30, rollup_retention_days: 365, sensitive_retention_hours: 24 };
      const next = { rawRetentionDays: 1, rollupRetentionDays: 1, sensitiveRetentionHours: 1 };
      const preview = await retentionPreview(base.id, old, next, fixtureClock, store);
      expect(preview.map((p) => ({ kind: p.kind, cutoff: p.cutoff }))).toEqual([
        { kind: "raw", cutoff: "2026-10-16T12:00:00.000Z" },
        { kind: "rollup", cutoff: "2026-10-16T12:00:00.000Z" },
        { kind: "sensitive", cutoff: "2026-10-17T11:00:00.000Z" },
      ]);
      // Samples have no TTL: the frozen preview fixture remains present on any test date.
      await store.query(
        `INSERT INTO ${q(base.database)}._samples(row_id,series_id,ts,value,version) VALUES(generateUUIDv4(),generateUUIDv4(),parseDateTime64BestEffort('2026-10-15T12:00:00Z'),1,1)`,
      );
      const [user] = await sql<
        { id: string }[]
      >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`retention-${base.id}`},'local','user','Retention fixture') RETURNING id`;
      try {
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
        const result = await updateBase({ baseId: base.id, user: { id: user!.id }, ...next, clock: fixtureClock, store });
        expect(result).toMatchObject({ ok: false, error: { code: "PULSE_RETENTION_CONFIRMATION_REQUIRED", status: 409 } });
      } finally {
        await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
      }
      const measured = await retentionPreview(base.id, old, next, fixtureClock, store);
      expect(measured[0]!.rows).toBeGreaterThan(0);
      expect(measured[0]!.bytes).toBeGreaterThan(0);
      // Keep row TTL at 30 days so OPTIMIZE can demonstrate column erasure independently.
      await sql`UPDATE pulse.bases SET retention_days=30,rollup_retention_days=2,sensitive_retention_hours=1 WHERE id=${base.id}::uuid`;
      await sql`UPDATE pulse.base_stores SET reconcile_needed=true WHERE base_id=${base.id}::uuid`;
      await createBaseLifecycle(store)(base.id);
      for (const [table, fragment] of [
        ["_events", "toIntervalDay(30)"],
        ["_rollups", "toIntervalDay(2)"],
        ["_state_changes", "toIntervalDay(30)"],
      ] as const) {
        const [row] = await store.query(`SHOW CREATE TABLE ${q(base.database)}.${table}`);
        const ddl = String(row?.statement);
        expect(ddl).toContain(fragment);
        if (table === "_events") expect(ddl).toContain("toIntervalHour(1)");
      }
      await store.query(`OPTIMIZE TABLE ${q(base.database)}._events FINAL`);
      const [row] = await store.query(`SELECT sensitive FROM ${q(base.database)}._events WHERE kind='ttl'`);
      expect(row?.sensitive).toBe("");
    } finally {
      settings.restore();
      await cleanupFixtureBase(base);
    }
  }, 60_000);
});
