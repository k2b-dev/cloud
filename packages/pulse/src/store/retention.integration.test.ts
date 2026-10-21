import { beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import * as lifecycle from "../service/base-lifecycle";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { updateBase } from "../service/base-management";
import { cleanupFixtureBase, fixtureBase, fixtureClock, fixtureStore, installFixtureStore } from "./base-store.test-fixture";
import { retentionPreview } from "./retention";
import { settingsFixture } from "./settings.test-fixture";
import { quoteIdentifier as q } from "./validation";

const suite = suiteFor("database", "clickhouse");
suite("Pulse per-base retention", () => {
  beforeAll(installFixtureStore, 30_000);
  test("sensitive preview counts only nonempty fields before the cutoff and their own size", async () => {
    const base = await fixtureBase(),
      store = fixtureStore();
    try {
      await createBaseLifecycle(store)(base.id);
      // Disable TTL for deterministic historical fixtures, regardless of the date ClickHouse runs.
      await store.query(`ALTER TABLE ${q(base.database)}._events REMOVE TTL`);
      await store.query(`ALTER TABLE ${q(base.database)}._events MODIFY COLUMN sensitive REMOVE TTL`);
      await store.query(`INSERT INTO ${q(base.database)}._events(id,ts,kind,sensitive,payload,version) VALUES
        ('11111111-1111-4111-8111-111111111111','2026-10-17 10:00:00','old-private','private','payload',1),
        ('22222222-2222-4222-8222-222222222222','2026-10-17 10:00:00','old-empty','','payload',1),
        ('33333333-3333-4333-8333-333333333333','2026-10-17 11:00:00','boundary','private','payload',1),
        ('44444444-4444-4444-8444-444444444444','2026-10-17 11:30:00','recent','private','payload',1)`);
      const preview = await retentionPreview(
        base.id,
        { retention_days: 30, rollup_retention_days: 365, sensitive_retention_hours: 24 },
        { rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 1 },
        fixtureClock,
        store,
      );
      expect(preview).toEqual([
        // Only the old non-empty field ("private", 7 bytes) is cleared; the empty one and the boundary row are not.
        { kind: "sensitive", retention: 1, cutoff: "2026-10-17T11:00:00.000Z", rows: 1, bytes: 7 },
      ]);
      expect(preview[0]!.bytes).toBeGreaterThan(0);
      const [count] = await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`);
      expect(Number(count?.n)).toBe(4);
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 60_000);
  for (const field of ["retention_days", "rollup_retention_days", "sensitive_retention_hours"] as const)
    test(`retention save refuses a concurrent ${field} change during preview without holding the row lock`, async () => {
      const base = await fixtureBase(),
        store = fixtureStore(),
        settings = settingsFixture();
      const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
      const [user] = await sql<
        { id: string }[]
      >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`preview-race-${base.id}`},'local','user','Preview fixture') RETURNING id`;
      let changed = false;
      const concurrent = {
        ...store,
        query: async (...args: Parameters<typeof store.query>) => {
          const result = await store.query(...args);
          if (!changed) {
            changed = true;
            await sql.begin(async (tx) => {
              // Old behavior holds FOR UPDATE during this call; fail promptly instead of deadlocking the suite.
              await tx`SET LOCAL lock_timeout='1s'`;
              await tx`UPDATE pulse.bases SET ${sql(field)}=2 WHERE id=${base.id}::uuid`;
            });
          }
          return result;
        },
      };
      try {
        await createBaseLifecycle(store)(base.id);
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
        const result = await updateBase({
          baseId: base.id,
          user: { id: user!.id },
          name: "Must not save",
          rawRetentionDays: 1,
          clock: fixtureClock,
          store: concurrent,
        });
        expect(changed).toBe(true);
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "PULSE_BASE_CHANGED",
            status: 409,
            message: "The base changed while the preview was computed. Review the preview again.",
          },
        });
        const [saved] =
          await sql`SELECT name,retention_days,rollup_retention_days,sensitive_retention_hours FROM pulse.bases WHERE id=${base.id}::uuid`;
        expect(saved).toMatchObject({
          name: "Store fixture",
          retention_days: 30,
          rollup_retention_days: 365,
          sensitive_retention_hours: 24,
          [field]: 2,
        });
        expect(submit).not.toHaveBeenCalled();
      } finally {
        submit.mockRestore();
        settings.restore();
        await cleanupFixtureBase(base);
        await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
      }
    }, 60_000);
  test("confirmed retention refuses a stale preview baseline without saving any settings", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      settings = settingsFixture();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`confirm-race-${base.id}`},'local','user','Confirmation fixture') RETURNING id`;
    const previewedFrom = { rawRetentionDays: 30, rollupRetentionDays: 365, sensitiveRetentionHours: 24 };
    try {
      await createBaseLifecycle(store)(base.id);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
      const intent = { baseId: base.id, user: { id: user!.id }, name: "Must not save", rawRetentionDays: 1 };
      expect(await updateBase({ ...intent, clock: fixtureClock, store })).toMatchObject({
        ok: false,
        error: { code: "PULSE_RETENTION_CONFIRMATION_REQUIRED", status: 409, previewedFrom },
      });
      // Each period matters, even when the confirmed update only changes raw retention.
      for (const field of ["retention_days", "rollup_retention_days", "sensitive_retention_hours"]) {
        await sql`UPDATE pulse.bases SET retention_days=30,rollup_retention_days=365,sensitive_retention_hours=24 WHERE id=${base.id}::uuid`;
        await sql`UPDATE pulse.bases SET ${sql(field)}=2 WHERE id=${base.id}::uuid`;
        const [before] = await sql`SELECT * FROM pulse.bases WHERE id=${base.id}::uuid`;
        expect(await updateBase({ ...intent, confirmShorterRetention: true, expectedRetention: previewedFrom })).toMatchObject({
          ok: false,
          error: { code: "PULSE_BASE_CHANGED", status: 409 },
        });
        const [after] = await sql`SELECT * FROM pulse.bases WHERE id=${base.id}::uuid`;
        expect(after).toEqual(before);
      }
      expect(submit).not.toHaveBeenCalled();
      await sql`UPDATE pulse.bases SET retention_days=30,rollup_retention_days=365,sensitive_retention_hours=24 WHERE id=${base.id}::uuid`;
      expect(await updateBase({ ...intent, confirmShorterRetention: true, expectedRetention: previewedFrom })).toMatchObject({
        ok: true,
        data: { name: "Must not save", rawRetentionDays: 1 },
      });
    } finally {
      submit.mockRestore();
      settings.restore();
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  }, 60_000);
  test("a lowered policy permits unchanged raw retention but refuses changes above the maximum", async () => {
    const base = await fixtureBase(),
      store = fixtureStore(),
      settings = settingsFixture();
    const submit = spyOn(lifecycle, "submitBaseLifecycleJob").mockResolvedValue(undefined);
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${`retention-policy-${base.id}`},'local','user','Policy fixture') RETURNING id`;
    try {
      await createBaseLifecycle(store)(base.id);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
      settings.values["pulse.max_raw_retention_days"] = 7;
      const intent = { baseId: base.id, user: { id: user!.id }, rollupRetentionDays: 365, sensitiveRetentionHours: 24 };
      expect(await updateBase({ ...intent, name: "Renamed", rawRetentionDays: 30 })).toMatchObject({
        ok: true,
        data: { name: "Renamed", rawRetentionDays: 30 },
      });
      for (const rawRetentionDays of [31, 29]) {
        expect(await updateBase({ ...intent, rawRetentionDays, confirmShorterRetention: true })).toMatchObject({
          ok: false,
          error: { status: 400, message: "Raw retention must be between 1 and 7 days" },
        });
      }
      const [saved] = await sql`SELECT name,retention_days FROM pulse.bases WHERE id=${base.id}::uuid`;
      expect(saved).toMatchObject({ name: "Renamed", retention_days: 30 });
      expect(await updateBase({ ...intent, rawRetentionDays: 7, confirmShorterRetention: true })).toMatchObject({
        ok: true,
        data: { rawRetentionDays: 7 },
      });
    } finally {
      submit.mockRestore();
      settings.restore();
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  }, 60_000);
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
