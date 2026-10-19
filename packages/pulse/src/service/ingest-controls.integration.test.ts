import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { requireInfra, requireInfraUrl, suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { installIngestControlsFixture } from "./ingest-controls.test-fixture";

if (testInfra.database && testInfra.valkey && testInfra.clickhouse) {
  await requireInfra("database", "valkey", "clickhouse");
  await installIngestControlsFixture();
}
const { createBaseStore } = await import("../store/base-store");
const { measureBaseUsage, measureInstanceDisk } = await import("../store/maintenance");
const { createIngestQuota } = await import("./ingest-quota");
const { createIngestWriter } = await import("./ingest-writer");
const { runMetricsSourceScrape } = await import("./metrics-scraper");
const { recordInstanceDisk, recordStorageThreshold, recordStoreOutage, notificationOutbox } = await import("./store-health");
const { assertWrite, writeFixture } = await import("./write.test-fixture");

suiteFor(
  "database",
  "valkey",
  "clickhouse",
)("Pulse quota and store protection", () => {
  test("write fixtures discard another suite's disk-low measurement", async () => {
    await sql`INSERT INTO pulse.store_instance(singleton,free_bytes,total_bytes,disk_low_at)
      VALUES(true,1,100,'2026-10-17T12:00:00Z') ON CONFLICT(singleton)
      DO UPDATE SET free_bytes=1,total_bytes=100,disk_low_at='2026-10-17T12:00:00Z'`;
    const f = await writeFixture("isolated-disk");
    try {
      expect(await sql`SELECT singleton FROM pulse.store_instance`).toHaveLength(0);
      assertWrite(await f.write({ events: [{ kind: "host-independent" }] }));
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("notification recipients resolve before a one-connection transaction is reserved", async () => {
    const { accounts } = await import("@k2b/cloud/services");
    const f = await writeFixture("notification-small-pool");
    const database = new SQL({ max: 1 });
    const userId = "10000000-0000-4000-8000-000000000007";
    const list = accounts.users.list;
    const lookup = spyOn(accounts.users, "list").mockImplementation(async (params) => {
      await database`SELECT 1`;
      return list(params);
    });
    let pending: Promise<unknown> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,${userId},'local','user',true)`;
      pending = (async () => {
        await recordStoreOutage(f.clock(), database, "en");
        await recordInstanceDisk(9, 100, f.clock(), database, "en");
      })();
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Notification lookups starved the SQL pool")), 5000);
        }),
      ]);
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.notification_outbox WHERE user_id=${userId}::uuid ORDER BY kind`).toEqual(
        [{ kind: "storeDiskLow" }, { kind: "storeUnavailable" }],
      );
    } finally {
      clearTimeout(timeout);
      await database.close({ timeout: 1 });
      await Promise.allSettled([pending]);
      lookup.mockRestore();
      await recordInstanceDisk(50, 100, f.clock());
      await sql`DELETE FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      await f.cleanup();
    }
  }, 30000);
  test("#6 two replicas share both buckets; done keys cost nothing; Valkey down fails closed", async () => {
    const f = await writeFixture("quota"),
      a = createIngestQuota(requireInfraUrl("valkey")),
      b = createIngestQuota(requireInfraUrl("valkey")),
      down = createIngestQuota("redis://127.0.0.1:1");
    try {
      await sql`UPDATE pulse.base_stores SET values_per_minute=2,bytes_per_minute=100 WHERE base_id=${f.base.id}::uuid`;
      const one = createIngestWriter({ store: f.store, clock: f.clock, quota: a }),
        two = createIngestWriter({ store: f.other, clock: f.clock, quota: b });
      const params = { baseId: f.base.id, sourceId: f.sourceId, batch: { metrics: [{ name: "quota", value: 1 }] }, requestBytes: 50 };
      assertWrite(await one({ ...params, idempotencyKey: "done" }));
      assertWrite(await two(params));
      expect(await one(params)).toMatchObject({
        ok: false,
        error: { code: "PULSE_BASE_THROTTLED", status: 429, retryAfter: expect.any(Number) },
      });
      assertWrite(await two({ ...params, idempotencyKey: "done" }));
      const [source] = await sql`SELECT throttled_at FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(source?.throttled_at.toISOString()).toBe(f.clock().toISOString());
      const failed = await createIngestWriter({ store: f.store, clock: f.clock, quota: down })(params);
      expect(failed).toMatchObject({ ok: false, error: { code: "PULSE_QUOTA_UNAVAILABLE", status: 503, retryAfter: 30 } });
      expect(await f.read("samples", "count() AS n")).toEqual([{ n: 2 }]);
      // A bytes refusal must not consume the remaining value, and vice versa.
      const key = { baseId: `${f.base.id}:atomic`, valuesPerMinute: 2, bytesPerMinute: 100 };
      expect(await a.consume({ ...key, values: 1, bytes: 100 })).toBeNull();
      expect(await b.consume({ ...key, values: 1, bytes: 100 })).toMatchObject({ code: "PULSE_BASE_THROTTLED" });
      expect(await a.consume({ ...key, values: 1, bytes: 0 })).toBeNull();
    } finally {
      a.close();
      b.close();
      down.close();
      await f.cleanup();
    }
  }, 60000);

  test("#6 storage crossings commit one outbox row per user admin; reads and caps remain available", async () => {
    const f = await writeFixture("storage-crossing");
    const adminIds = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    try {
      for (const id of adminIds) {
        await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${id},'local','user')`;
        const [access] = await sql`INSERT INTO auth.access(user_id,permission) VALUES(${id}::uuid,'admin') RETURNING id`;
        await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${f.base.id}::uuid,${access!.id}::uuid)`;
      }
      assertWrite(await f.write({ metrics: [{ name: "before", value: 1 }] }));
      await sql`UPDATE pulse.base_stores SET storage_bytes=1 WHERE base_id=${f.base.id}::uuid`;
      await measureBaseUsage(f.base.id, f.store);
      await measureBaseUsage(f.base.id, f.store);
      expect(await f.write({ metrics: [{ name: "refused", value: 2 }] })).toMatchObject({
        ok: false,
        error: { code: "PULSE_BASE_STORAGE_FULL", status: 409 },
      });
      expect(await f.read("samples", "value")).toEqual([{ value: 1 }]);
      const rows = await sql<
        { user_id: string; data: { baseName: string; threshold: number }; locale: string }[]
      >`SELECT user_id,data,locale FROM pulse.notification_outbox WHERE kind='storageThresholdReached' ORDER BY user_id`;
      expect(rows.map((r) => r.user_id)).toEqual(adminIds);
      expect(rows[0]?.data).toMatchObject({ baseName: "Store fixture", threshold: 1 });
      await sql.begin(async (tx) => recordStorageThreshold(f.base.id, 0, f.clock(), tx, "de"));
      await measureBaseUsage(f.base.id, f.store);
      expect(await sql`SELECT seq FROM pulse.notification_outbox WHERE kind='storageThresholdReached'`).toHaveLength(4);
    } finally {
      await f.cleanup();
      for (const id of adminIds) {
        await sql`DELETE FROM pulse.notification_outbox WHERE user_id=${id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
      }
    }
  }, 60000);

  test("#8 store outages deduplicate across write and measurement; scrape errors wait until the next tick; recovery closes the outage", async () => {
    const f = await writeFixture("store-outage");
    const userId = "10000000-0000-4000-8000-000000000003";
    const endpoint = Bun.serve({ port: 0, fetch: () => new Response("# TYPE up gauge\nup 1") });
    const down = createBaseStore({
      prefix: f.store.prefix,
      clock: f.clock,
      connection: async () => ({ url: "http://127.0.0.1:1", user: "fixture", password: "fixture" }),
    });
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,${userId},'local','user',true)`;
      await sql`UPDATE pulse.sources SET kind='metrics',endpoint_url=${`http://127.0.0.1:${endpoint.port}/metrics`},scrape_interval_seconds=60 WHERE id=${f.sourceId}::uuid`;
      await sql`INSERT INTO pulse.base_internal_targets(base_id,entry) VALUES(${f.base.id}::uuid,'127.0.0.1')`;
      const writer = createIngestWriter({ store: down, clock: f.clock });
      expect(await writer({ baseId: f.base.id, sourceId: f.sourceId, batch: { metrics: [{ name: "up", value: 1 }] } })).toMatchObject({
        ok: false,
        error: { code: "PULSE_STORE_UNAVAILABLE", status: 503, retryAfter: 30 },
      });
      await expect(measureInstanceDisk(down)).rejects.toThrow();
      expect((await runMetricsSourceScrape({ baseId: f.base.id, sourceId: f.sourceId }, { clock: f.clock, ingestBatch: writer })).ok).toBe(
        false,
      );
      const [source] = await sql`SELECT last_error,last_scrape_slot_at FROM pulse.sources WHERE id=${f.sourceId}::uuid`;
      expect(source?.last_error).toContain("unavailable");
      expect(source?.last_scrape_slot_at.toISOString()).toBe(f.clock().toISOString());
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`).toEqual([
        { kind: "storeUnavailable" },
      ]);
      const [outage] = await sql`SELECT outage_started_at FROM pulse.store_instance`;
      expect(outage?.outage_started_at.toISOString()).toBe(f.clock().toISOString());
      f.setTime("2026-10-17T12:05:00Z");
      await measureInstanceDisk({ ...f.store, query: async () => [{ free_space: 50, total_space: 100 }] });
      const [recovery] = await sql`SELECT outage_started_at,last_outage_ended_at FROM pulse.store_instance`;
      expect(recovery?.outage_started_at).toBeNull();
      expect(recovery?.last_outage_ended_at.toISOString()).toBe(f.clock().toISOString());
      await recordStoreOutage(f.clock());
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`).toHaveLength(2);
    } finally {
      endpoint.stop(true);
      await recordInstanceDisk(50, 100, f.clock());
      await sql`DELETE FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      await f.cleanup();
    }
  }, 60000);

  test("#6 disk-low crossings notify effective Cloud admins once and refuse every base", async () => {
    const f = await writeFixture("disk-low"),
      userId = "10000000-0000-4000-8000-000000000004";
    try {
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,${userId},'local','user',true)`;
      const measured = { ...f.store, query: async () => [{ free_space: 9, total_space: 100 }] };
      await measureInstanceDisk(measured);
      await measureInstanceDisk(measured);
      expect(await f.write({ events: [{ kind: "blocked" }] })).toMatchObject({
        ok: false,
        error: { code: "PULSE_STORE_DISK_LOW", status: 503, retryAfter: 300 },
      });
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`).toEqual([
        { kind: "storeDiskLow" },
      ]);
      await recordInstanceDisk(10, 100, f.clock());
      assertWrite(await f.write({ events: [{ kind: "allowed" }] }));
      await measureInstanceDisk(measured);
      expect(await sql<{ kind: string }[]>`SELECT kind FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`).toHaveLength(2);
    } finally {
      await recordInstanceDisk(50, 100, f.clock());
      await sql`DELETE FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      await f.cleanup();
    }
  }, 60000);
  test("G2 T2 service refusals preserve their own 409 after T1 commits", async () => {
    const f = await writeFixture("t2-refusal");
    const query = f.store.query;
    try {
      f.store.query = async (statement, params) => {
        if (statement.startsWith("INSERT INTO"))
          throw { code: "PULSE_BASE_WRITE_BLOCKED", status: 409, message: "Base became write-blocked" };
        return query(statement, params);
      };
      expect(await f.write({ metrics: [{ name: "up", value: 1 }] }, "reserved")).toMatchObject({
        ok: false,
        error: { code: "PULSE_BASE_WRITE_BLOCKED", status: 409 },
      });
      expect((await sql`SELECT state FROM pulse.ingest_idempotency WHERE source_id=${f.sourceId}::uuid`)[0]?.state).toBe("pending");
      expect(await f.read("samples", "count() AS n")).toEqual([{ n: 0 }]);
    } finally {
      await f.cleanup();
    }
  }, 60000);

  test("G1 late observations bound their single ASOF lookup to raw pairs, late series, and the retention window", async () => {
    const f = await writeFixture("late-lookup");
    const query = f.store.query;
    const lookups: { query: string; params?: Record<string, string | number> }[] = [];
    try {
      assertWrite(await f.write({ metrics: [{ name: "load", value: 2, ts: "2026-10-17T12:00:00Z" }] }));
      f.store.query = async (statement, params) => {
        if (statement.includes("ASOF LEFT JOIN")) lookups.push({ query: statement, params });
        return query(statement, params);
      };
      assertWrite(await f.write({ metrics: [{ name: "load", value: 1, ts: "2026-10-17T10:00:00Z" }] }));
      expect(lookups).toHaveLength(1);
      expect(lookups[0]?.query).toContain("SELECT DISTINCT series_id,ts");
      expect(lookups[0]?.query).toContain("._samples");
      expect(lookups[0]?.query).toContain("series_id IN {series:Array(UUID)}");
      expect(lookups[0]?.params?.minTime).toBe(Date.parse("2026-10-17T10:00:00Z"));
      expect(lookups[0]?.params?.cutoff).toBe(f.clock().getTime() - 30 * 86400000);
      const hours = await sql<{ hour: Date }[]>`SELECT hour FROM pulse.metric_hours WHERE base_id=${f.base.id}::uuid ORDER BY hour`;
      expect(hours.map((r) => r.hour.toISOString())).toEqual(["2026-10-17T10:00:00.000Z", "2026-10-17T12:00:00.000Z"]);
    } finally {
      await f.cleanup();
    }
  }, 60000);
  test("B committed outbox rows send with their stable ID and persisted locale", async () => {
    const { notifications } = await import("@k2b/cloud/services");
    const userId = "10000000-0000-4000-8000-000000000005";
    await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${userId}::uuid,${userId},'local','user',true)`;
    const send = spyOn(notifications, "send").mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000006",
      status: "pending",
    });
    try {
      const now = new Date("2026-10-17T12:00:00Z");
      await recordStoreOutage(now, sql, "de-CH");
      expect(send).not.toHaveBeenCalled();
      const [row] = await sql<{ id: string }[]>`SELECT id FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`;
      expect(row).toBeDefined();
      await notificationOutbox.notify();
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: "pulse.storeUnavailable" }), {
        recipient: { userId },
        data: {},
        idempotencyKey: row!.id,
        locale: "de-CH",
      });
      expect(await sql`SELECT id FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`).toHaveLength(0);
    } finally {
      send.mockRestore();
      await recordInstanceDisk(50, 100, new Date("2026-10-17T12:05:00Z"));
      await sql`DELETE FROM pulse.notification_outbox WHERE user_id=${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 60000);
});
