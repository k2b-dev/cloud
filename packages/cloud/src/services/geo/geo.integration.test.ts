import { afterAll, beforeAll, expect, test } from "bun:test";
import { RedisClient, SQL } from "bun";
import { createDisposableDatabase, suiteFor, testInfra } from "../../../../../scripts/fixtures/test-infra";
import { createGeoBucket } from "./bucket";
import { createGeoCache } from "./cache";
import autocomplete from "./fixtures/autocomplete.json";
import { GEO_TEST_KEY, GEO_TEST_NOW, geoTestConfig, geoTestContext } from "./geo.test-fixture";
import { GeoapifyAdapter } from "./geoapify";
import { createGeoLedger } from "./ledger";
import { createGeoMapService } from "./map";
import { migrate } from "./migrate";
import { createGeoService } from "./service";

suiteFor("database", "valkey")("Core geo durable admission and accounting", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let redis: RedisClient;
  let prefix: string;
  const ledger = () => createGeoLedger(db);
  const subject = { type: "user", userId: "11111111-1111-4111-8111-111111111111" } as const;
  beforeAll(async () => {
    database = await createDisposableDatabase("geo_core");
    db = new SQL(database.url);
    prefix = `geo:test:${database.name}`;
    redis = new RedisClient(testInfra.valkey!, { enableOfflineQueue: false });
    await redis.connect();
    await migrate(db);
    // Match the audit storage contract without depending on Core's auth schema migrations.
    await db`CREATE SCHEMA audit`.simple();
    await db`CREATE TABLE audit.events (
      id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), action text, outcome text,
      actor_user_id uuid, actor_uid text, actor_provider text, actor_roles text[],
      target_type text, target_id text, target_label text, target_provider text,
      reason text, error_code text, error_message text, request_id text, metadata jsonb
    )`.simple();
  });
  afterAll(async () => {
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
      redis.close();
    }
    await db?.close();
    await database?.drop();
  });
  test("tiles share durable budgets with geo Queries and use an independent provider bucket", async () => {
    const instant = new Date("2028-02-12T10:00:00.000Z");
    const settings = { ...geoTestConfig, monthlyCredits: 1, personDailyCredits: 1 };
    const bucket = createGeoBucket({ redis: async () => redis, prefix: `${prefix}:tiles` });
    let sent = 0;
    const map = createGeoMapService({
      config: async () => settings,
      now: () => instant,
      bucket,
      ledger: ledger(),
      fetch: async () => {
        sent++;
        return new Response(new Uint8Array([26, 0]), { headers: { "Content-Type": "application/x-protobuf" } });
      },
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => map.tile({ z: 0, x: 0, y: 0 }, geoTestContext)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(sent).toBe(4);
    const balances = await ledger().availability(geoTestContext.accessSubject!, settings, instant);
    expect(balances.person.exhausted).toBe(true);
    expect(balances.cloud.exhausted).toBe(true);
    const rows = await db<
      { used: number }[]
    >`SELECT used::int AS used FROM geo.shares WHERE period IN ('2028-02', '2028-02-12') AND function_group='tiles'`;
    expect(rows.map((row) => row.used)).toEqual([1000, 1000]);
  });
  test("parallel reservations admit exactly floor(budget/price) with no partial cloud debit", async () => {
    const settings = { ...geoTestConfig, monthlyCredits: 100, personDailyCredits: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () => ledger().reserve(subject, settings, 1000, "address", GEO_TEST_NOW)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const result of results)
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "GEO_BUDGET_EXHAUSTED", details: { scope: "person" } });
    const rows = await db<
      { scope: string; used: number }[]
    >`SELECT scope,used::int AS used FROM geo.usage WHERE period IN ('2026-10','2026-10-20') ORDER BY scope`;
    expect(rows.map((row) => row.used)).toEqual([3000, 3000]);
    const shares = await db<{ used: number }[]>`SELECT used::int AS used FROM geo.shares WHERE period IN ('2026-10','2026-10-20')`;
    expect(shares.map((row) => row.used)).toEqual([3000, 3000]);
  });
  test("Cloud scope is shared by different people and service accounts", async () => {
    const instant = new Date("2027-01-12T10:00:00.000Z"),
      settings = { ...geoTestConfig, monthlyCredits: 3, personDailyCredits: 3 };
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) =>
        ledger().reserve(
          i % 2 ? { type: "service_account", serviceAccountId: `service-${i}` } : { type: "user", userId: `person-${i}` },
          settings,
          1000,
          "places",
          instant,
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const result of results)
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ details: { scope: "cloud", resetsAt: "2027-01-31T23:00:00.000Z" } });
  });
  test("timezone midnight and month rollover renew the right counters", async () => {
    const settings = { ...geoTestConfig, monthlyCredits: 1, personDailyCredits: 1 };
    await ledger().reserve(subject, settings, 1000, "address", new Date("2027-03-31T21:59:59.999Z"));
    await expect(ledger().reserve(subject, settings, 1000, "address", new Date("2027-03-31T21:59:59.999Z"))).rejects.toMatchObject({
      details: { scope: "cloud", resetsAt: "2027-03-31T22:00:00.000Z" },
    });
    await ledger().reserve(subject, settings, 1000, "address", new Date("2027-03-31T22:00:00.000Z"));
    const daySettings = { ...settings, monthlyCredits: 10 };
    const service = { type: "service_account", serviceAccountId: "daily-rollover" } as const;
    await ledger().reserve(service, daySettings, 1000, "places", new Date("2027-04-15T21:59:59.999Z"));
    await expect(ledger().reserve(service, daySettings, 1000, "places", new Date("2027-04-15T21:59:59.999Z"))).rejects.toMatchObject({
      details: { scope: "person", resetsAt: "2027-04-15T22:00:00.000Z" },
    });
    await ledger().reserve(service, daySettings, 1000, "places", new Date("2027-04-15T22:00:00.000Z"));
  });
  test("settlement refunds only the surplus, availability does not write", async () => {
    const instant = new Date("2027-05-01T10:00:00.000Z"),
      settings = { ...geoTestConfig, monthlyCredits: 10, personDailyCredits: 10 };
    const reservation = await ledger().reserve(subject, settings, 3000, "address", instant);
    await ledger().settle(reservation, 1000);
    const before = await db`SELECT * FROM geo.usage ORDER BY scope,subject,period`;
    expect(await ledger().availability(subject, settings, instant)).toMatchObject({
      person: { exhausted: false },
      cloud: { exhausted: false },
    });
    expect(await db`SELECT * FROM geo.usage ORDER BY scope,subject,period`).toEqual(before);
    expect((await db<{ used: number }[]>`SELECT used::int AS used FROM geo.usage WHERE period='2027-05'`)[0]!.used).toBe(1000);
  });
  test("two service instances share the token bucket and cache", async () => {
    const keys = [`${prefix}:shared:bucket`, `${prefix}:shared:flight:autocomplete`];
    await redis.del(...keys);
    let fetches = 0;
    const adapter = new GeoapifyAdapter({
      now: () => GEO_TEST_NOW,
      fetch: async () => {
        fetches++;
        return Response.json(autocomplete);
      },
    });
    const bucket = () => createGeoBucket({ redis: async () => redis, prefix: `${prefix}:shared` });
    const cache = { get: async () => null, put: async () => {} };
    const config = async () => ({ ...geoTestConfig, plan: "custom" as const, customRps: 1 });
    const first = createGeoService({ config, now: () => GEO_TEST_NOW, adapter, ledger: ledger(), cache, bucket: bucket() });
    const second = createGeoService({ config, now: () => GEO_TEST_NOW, adapter, ledger: ledger(), cache, bucket: bucket() });
    const result = await Promise.allSettled([
      first.autocomplete({ text: "Orle" }, geoTestContext),
      second.autocomplete({ text: "Other" }, geoTestContext),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetches).toBe(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "GEO_BUSY" } });
  });
  test("shared cache hits across services preserve provenance and do not debit a service account", async () => {
    const keys: string[] = [];
    const storage = createGeoCache(async () => ({
      send: async (command, args) => {
        const key = `${prefix}:cache:${args[0]}`;
        keys.push(key);
        return redis.send(command, [key, ...args.slice(1)]);
      },
    }));
    const instant = new Date("2027-06-15T10:00:00.000Z");
    let fetches = 0;
    const adapter = new GeoapifyAdapter({
      now: () => instant,
      fetch: async () => {
        fetches++;
        return Response.json(autocomplete);
      },
    });
    const make = () =>
      createGeoService({
        config: async () => geoTestConfig,
        now: () => instant,
        adapter,
        ledger: ledger(),
        cache: storage,
        bucket: createGeoBucket({ redis: async () => redis, prefix: `${prefix}:cache-admission` }),
      });
    const first = await make().autocomplete({ text: "Orle" }, geoTestContext);
    const rows = await db`SELECT * FROM geo.usage ORDER BY scope,subject,period`;
    const second = await make().autocomplete({ text: "orle" }, geoTestContext);
    expect(second).toEqual(first);
    expect(second.provenance.computedAt).toBe(instant.toISOString());
    expect(fetches).toBe(1);
    expect(await db`SELECT * FROM geo.usage ORDER BY scope,subject,period`).toEqual(rows);
    const used = await db<
      { used: number }[]
    >`SELECT used::int AS used FROM geo.usage WHERE period='2027-06-15' AND subject=${`service_account:${geoTestContext.accessSubject!.type === "service_account" ? geoTestContext.accessSubject!.serviceAccountId : ""}`}`;
    expect(used[0]!.used).toBe(1000);
    for (const key of keys) expect(await redis.get(key)).not.toContain(GEO_TEST_KEY);
  });
  test("post-send abort leaves durable spend and reports unknown credits", async () => {
    const instant = new Date("2027-07-15T10:00:00.000Z"),
      controller = new AbortController();
    const adapter = new GeoapifyAdapter({
      now: () => instant,
      fetch: async () => {
        controller.abort();
        throw controller.signal.reason;
      },
    });
    const service = createGeoService({
      config: async () => geoTestConfig,
      now: () => instant,
      adapter,
      ledger: ledger(),
      cache: { get: async () => null, put: async () => {} },
      bucket: createGeoBucket({ redis: async () => redis, prefix: `${prefix}:abort-admission` }),
    });
    await expect(service.autocomplete({ text: "Orle" }, { ...geoTestContext, signal: controller.signal })).rejects.toMatchObject({
      code: "GEO_PROVIDER_FAILED",
      details: { costs: { settledCredits: 0, unknownCredits: 1 } },
    });
    const rows = await db<{ used: number }[]>`SELECT used::int AS used FROM geo.usage WHERE period IN ('2027-07','2027-07-15')`;
    expect(rows.map((row) => row.used)).toEqual([1000, 1000]);
  });
  test("in-flight bound is shared even with replenished tokens", async () => {
    const bucket = createGeoBucket({ redis: async () => redis, prefix: `${prefix}:flight` });
    const release = [];
    try {
      for (let i = 0; i < 3; i++) {
        await redis.del(`${prefix}:flight:bucket`);
        release.push(await bucket.acquire("autocomplete", 1));
      }
      await redis.del(`${prefix}:flight:bucket`);
      await expect(bucket.acquire("autocomplete", 1)).rejects.toMatchObject({
        code: "GEO_BUSY",
        details: { retryAfterSeconds: expect.any(Number) },
      });
    } finally {
      await Promise.all(release.map((fn) => fn()));
    }
  });
  test("audit transitions are durable, deduplicated by month, and contain no key", async () => {
    const context = { ...geoTestContext, actor: geoTestContext.actor! };
    await Promise.all(
      Array.from({ length: 8 }, () => ledger().recordTransition("provider_key_rejected", "Europe/Berlin", context, GEO_TEST_NOW)),
    );
    await ledger().recordTransition("monthly_budget_exhausted", "Europe/Berlin", context, GEO_TEST_NOW);
    const rows = await db<
      { action: string; metadata: unknown; actor_uid: string }[]
    >`SELECT action,metadata,actor_uid FROM audit.events ORDER BY action`;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(GEO_TEST_KEY);
    expect(rows.every((row) => row.actor_uid === "service-account:22222222-2222-4222-8222-222222222222")).toBeTrue();
  });
});
