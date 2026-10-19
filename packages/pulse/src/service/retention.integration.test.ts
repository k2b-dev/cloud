import { beforeAll, expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { installFixtureStore } from "../store/base-store.test-fixture";
import { CLICKHOUSE_UUID_CHUNK_SIZE } from "../store/client";
import { listAdminBases } from "./base-admin";
import { createRetention } from "./retention";
import { assertWrite, writeFixture } from "./write.test-fixture";

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse sealed raw partition retention", () => {
  beforeAll(installFixtureStore, 30000);
  test("expired series are tombstoned before their registry budget is freed, with failed inserts retried", async () => {
    const f = await writeFixture("series-tombstone");
    try {
      await f.stopMerges();
      await sql`UPDATE pulse.base_stores SET max_series=1 WHERE base_id=${f.base.id}::uuid`;
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, dimensions: { host: "old" } }] }));
      const replacement = { metrics: [{ name: "load", value: 2, dimensions: { host: "new" } }] };
      expect(await f.write(replacement)).toMatchObject({ ok: false, error: { status: 400 } });
      await sql`UPDATE pulse.metric_series SET last_seen_at=${new Date("2025-01-01T00:00:00Z")},last_sample_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      const run = createRetention({ store: f.store });
      f.failInsert(1);
      await expect(run(f.base.id)).rejects.toThrow();
      expect(await sql`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toHaveLength(1);
      expect(await f.read("series")).toHaveLength(1);
      f.recover();
      expect((await run(f.base.id)).registryRecords).toBe(2);
      expect(await f.read("series")).toHaveLength(0);
      expect(await sql`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
      // Same frozen acceptance time: the tombstone must still outrank the original mirror.
      expect(await f.read("_series", "deleted", "FINAL")).toEqual([{ deleted: 1 }]);
      assertWrite(await f.write(replacement));
      expect(await f.read("series", "dimensions")).toEqual([{ dimensions: JSON.stringify({ host: "new" }) }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("an applied tombstone survives a SQL delete failure, and the next write revives the series", async () => {
    const f = await writeFixture("retirement-rollback");
    try {
      await f.stopMerges();
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1 }] }));
      const [series] = await sql<{ id: string }[]>`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.metric_series SET last_seen_at='2025-01-01',last_sample_at='2025-01-01' WHERE id=${series!.id}::uuid`;
      // A real later SQL error, after the external tombstone has succeeded.
      await sql`CREATE TABLE pulse.retirement_delete_guard (series_id uuid REFERENCES pulse.metric_series(id))`.simple();
      await sql`INSERT INTO pulse.retirement_delete_guard VALUES(${series!.id}::uuid)`;
      await expect(createRetention({ store: f.store })(f.base.id)).rejects.toThrow("foreign key constraint");
      expect(await f.read("series")).toEqual([]);
      expect(await f.read("_series", "deleted", "FINAL")).toEqual([{ deleted: 1 }]);
      expect(await sql<{ id: string }[]>`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toEqual([
        { id: series!.id },
      ]);
      // The same frozen clock is sufficient: acceptance is monotonic per source.
      assertWrite(await f.write({ metrics: [{ name: "load", value: 2 }] }));
      expect(await f.read("series", "series_id")).toEqual([{ series_id: series!.id }]);
      expect(await f.read("_series", "deleted", "FINAL")).toEqual([{ deleted: 0 }]);
      expect(await f.read("samples", "value", "ORDER BY value")).toEqual([{ value: 1 }, { value: 2 }]);
      expect((await sql`SELECT mirrored FROM pulse.metric_series WHERE id=${series!.id}::uuid`)[0]?.mirrored).toBe(true);
    } finally {
      await sql`DROP TABLE IF EXISTS pulse.retirement_delete_guard`.simple();
      await f.cleanup();
    }
  }, 60000);
  test("ingest between retirement intent and tombstone revives the victim without deleting it", async () => {
    const f = await writeFixture("retirement-revival");
    const database = new SQL({ max: 2 });
    const begin = database.begin.bind(database);
    let transactions = 0;
    const boundary = spyOn(database, "begin").mockImplementation(async (run) => {
      if (++transactions === 2) assertWrite(await f.write({ metrics: [{ name: "load", value: 2 }] }));
      if (typeof run === "string") throw new Error("Unexpected transaction options in retention fixture");
      return begin(run);
    });
    try {
      await f.stopMerges();
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1 }] }));
      await sql`UPDATE pulse.metric_series SET last_seen_at='2025-01-01',last_sample_at='2025-01-01' WHERE base_id=${f.base.id}::uuid`;
      expect((await createRetention({ store: f.store, database })(f.base.id)).registryRecords).toBe(0);
      expect(await f.read("series")).toHaveLength(1);
      expect(await f.read("_series", "deleted", "FINAL")).toEqual([{ deleted: 0 }]);
      expect((await sql`SELECT mirrored FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`)[0]?.mirrored).toBe(true);
    } finally {
      boundary.mockRestore();
      await database.close();
      await f.cleanup();
    }
  }, 60000);
  test.each([30, 1])(
    "seals and watermark survive failure immediately after raw drop (rollup retention %i)",
    async (rollupDays) => {
      const f = await writeFixture(`partition-rollback-${rollupDays}`);
      const query = f.store.query;
      const ts = "2026-10-14T10:05:00Z";
      let dropped = false;
      try {
        await f.stopMerges();
        assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts }] }));
        await sql`UPDATE pulse.bases SET retention_days=1,rollup_retention_days=${rollupDays} WHERE id=${f.base.id}::uuid`;
        await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
        f.store.query = async (statement, params) => {
          const rows = await query(statement, params);
          if (statement.includes("DROP PARTITION")) {
            dropped = true;
            throw new Error("Injected failure after partition drop");
          }
          return rows;
        };
        await expect(createRetention({ store: f.store })(f.base.id)).rejects.toThrow("Injected failure after partition drop");
        expect(dropped).toBe(true);
        expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
        expect(await sql<{ state: string }[]>`SELECT state FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`).toEqual([
          { state: "sealed" },
        ]);
        const [row] = await sql<
          { sealed_before: Date | null }[]
        >`SELECT sealed_before FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid`;
        expect(row?.sealed_before?.toISOString() ?? null).toBe(rollupDays === 1 ? "2026-10-14T11:00:00.000Z" : null);
        await sql`UPDATE pulse.bases SET retention_days=30 WHERE id=${f.base.id}::uuid`;
        expect(await f.write({ metrics: [{ name: "load", value: 2, ts }] })).toMatchObject({
          ok: false,
          error: { status: 400, message: "Metric hour is sealed after raw retention" },
        });
      } finally {
        f.store.query = query;
        await f.cleanup();
      }
    },
    60000,
  );
  test("retirement tombstones every series across multiple URL-bounded chunks", async () => {
    const f = await writeFixture("retirement-chunks");
    const query = f.store.query;
    const chunks: number[] = [];
    const count = CLICKHOUSE_UUID_CHUNK_SIZE + 1;
    try {
      await f.stopMerges();
      await sql`UPDATE pulse.base_stores SET max_series=${count},values_per_minute=${count * 3},bytes_per_minute=${count * 1024} WHERE base_id=${f.base.id}::uuid`;
      assertWrite(
        await f.write({ metrics: Array.from({ length: count }, (_, i) => ({ name: "load", value: i, dimensions: { host: String(i) } })) }),
      );
      expect(await f.read("series", "count() AS n")).toEqual([{ n: count }]);
      await sql`UPDATE pulse.metric_series SET last_seen_at='2025-01-01',last_sample_at='2025-01-01' WHERE base_id=${f.base.id}::uuid`;
      f.store.query = async (statement, params) => {
        if (statement.includes("version+1,toUInt8(1)")) chunks.push(String(params?.series).split(",").length);
        return query(statement, params);
      };
      expect((await createRetention({ store: f.store })(f.base.id)).registryRecords).toBe(count + 1);
      expect(chunks).toEqual([CLICKHOUSE_UUID_CHUNK_SIZE, 1]);
      expect(await f.read("series", "count() AS n")).toEqual([{ n: 0 }]);
      expect(await sql<{ id: string }[]>`SELECT id FROM pulse.metric_series WHERE base_id=${f.base.id}::uuid`).toEqual([]);
    } finally {
      f.store.query = query;
      await f.cleanup();
    }
  }, 60000);
  test("#7 sealed hours reject writes, whole days require sealing, and lag reaches the admin contract", async () => {
    const f = await writeFixture("retention"),
      run = createRetention({ store: f.store });
    const ts = "2026-10-14T10:05:00Z";
    try {
      await f.stopMerges();
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts }] }));
      await sql`UPDATE pulse.bases SET retention_days=1 WHERE id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date("2026-10-14T12:00:00Z")},updated_at=${new Date("2026-10-14T10:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      const blocked = await run(f.base.id);
      expect(blocked.rawPartitions).toBe(0);
      expect(Number((await f.read("samples", "count() AS n"))[0]?.n)).toBe(1);
      const admin = await listAdminBases(adminFixtureIdentity(), { q: f.base.shortId }, f.clock);
      expect(admin.items[0]?.rollupLag).toBe(true);
      // Rollup completion alone is insufficient until the writer lease has expired.
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=${new Date(f.clock().getTime() + 60000)} WHERE base_id=${f.base.id}::uuid`;
      expect((await run(f.base.id)).rawPartitions).toBe(0);
      await sql`UPDATE pulse.metric_hours SET lease_until=${new Date(f.clock().getTime() - 1)} WHERE base_id=${f.base.id}::uuid`;
      const dropped = await run(f.base.id);
      expect(dropped.sealedHours).toBe(1);
      expect(dropped.rawPartitions).toBe(1);
      expect(Number((await f.read("samples", "count() AS n"))[0]?.n)).toBe(0);
      // Widen retention again: the persisted seal still refuses a write even though the timestamp is now in range.
      await sql`UPDATE pulse.bases SET retention_days=30 WHERE id=${f.base.id}::uuid`;
      expect(await f.write({ metrics: [{ name: "load", value: 2, ts }] })).toMatchObject({
        ok: false,
        error: { status: 400, message: expect.stringContaining("sealed") },
      });
      expect((await listAdminBases(adminFixtureIdentity(), { q: f.base.shortId }, f.clock)).items[0]?.rollupLag).toBe(false);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("pruning seals survives retention extensions, and clear resets the watermark", async () => {
    const f = await writeFixture("pruned-seal"),
      run = createRetention({ store: f.store });
    const ts = "2026-10-14T10:05:00Z";
    try {
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts }] }));
      await sql`UPDATE pulse.bases SET retention_days=1,rollup_retention_days=1 WHERE id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.metric_hours SET state='clean',lease_until=NULL WHERE base_id=${f.base.id}::uuid`;
      const pruned = await run(f.base.id);
      expect(pruned).toMatchObject({ sealedHours: 1, rawPartitions: 1, hourRecords: 1 });
      expect(await sql`SELECT hour FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid`).toHaveLength(0);
      expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
      await sql`UPDATE pulse.bases SET retention_days=30 WHERE id=${f.base.id}::uuid`;
      expect(await f.write({ metrics: [{ name: "load", value: 2, ts }] })).toMatchObject({
        ok: false,
        error: { status: 400, message: "Metric hour is sealed after raw retention" },
      });
      expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
      const { createBaseLifecycle } = await import("./base-lifecycle");
      await sql`UPDATE pulse.base_stores SET state='clearing',operation='clear' WHERE base_id=${f.base.id}::uuid`;
      const clear = createBaseLifecycle(f.store);
      for (let i = 0; i < 20; i++) if ((await clear(f.base.id)).done) break;
      expect((await sql`SELECT state,sealed_before FROM pulse.base_stores WHERE base_id=${f.base.id}::uuid`)[0]).toMatchObject({
        state: "active",
        sealed_before: null,
      });
      assertWrite(await f.write({ metrics: [{ name: "load", value: 3, ts }] }));
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("registries and scrape history expire but current state keys remain", async () => {
    const f = await writeFixture("registry-retention");
    try {
      assertWrite(
        await f.write({ metrics: [{ name: "load", value: 1 }], events: [{ kind: "opened" }], states: [{ key: "door", value: true }] }),
      );
      await sql`UPDATE pulse.metric_series SET last_seen_at=${new Date("2025-01-01T00:00:00Z")},last_sample_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.event_kinds SET last_seen_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      await sql`UPDATE pulse.state_keys SET first_seen_at=${new Date("2025-01-01T00:00:00Z")} WHERE base_id=${f.base.id}::uuid`;
      const result = await createRetention({ store: f.store })(f.base.id);
      expect(result.registryRecords).toBe(3); // series, definition, event kind
      const [key] = await sql`SELECT state_key FROM pulse.state_keys WHERE base_id=${f.base.id}::uuid`;
      expect(key?.state_key).toBe("door");
    } finally {
      await f.cleanup();
    }
  }, 60000);
});
