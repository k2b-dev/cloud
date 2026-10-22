import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { seedActiveBaseStore } from "./base-store.test-fixture";
import { createOverviewQueries, OVERVIEW_WORK_MS } from "./overview-queries";
import type { runBaseSql } from "./sql-service";

const result = (value = 42): Awaited<ReturnType<typeof runBaseSql>> => ({
  ok: true,
  data: {
    columns: [{ name: "value", type: "Float64" }],
    rows: [[value]],
    rowCount: 1,
    truncated: false,
    stats: { elapsedMs: 1, readRows: 1, readBytes: 8 },
    runId: "447f31ac-d628-4505-bfd4-b5ff86ec8a98",
    limits: {
      profile: "normal",
      memoryBytes: 2_000_000_000,
      timeSeconds: 10,
      maxRows: 10000,
      maxResultBytes: 4194304,
      queriesUsed: 0,
      queriesPerHour: 600,
      resetAt: "2026-10-20T13:00:00Z",
      baseSlots: 1,
      cloudSlots: 3,
      maxWaiting: 20,
      waitMs: 5000,
    },
  },
});
suiteFor("database")("overview execution persists the base budget and last good values", () => {
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  beforeAll(async () => {
    database = await useFreshDatabase("pulse_overview");
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    await migrate();
  }, 30_000);
  afterAll(async () => {
    if (database) {
      await sql.close();
      await database.drop();
    }
  });
  const fixture = async (baseId: string, count = 4) => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${baseId},'local','user','Overview reader') RETURNING id`;
    await sql`INSERT INTO pulse.bases(id,short_id,name) VALUES(${baseId}::uuid,${baseId.slice(0, 6)},'Overview')`;
    await seedActiveBaseStore(baseId);
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${baseId}::uuid,${grant!.id}::uuid)`;
    for (let index = 0; index < count; index++)
      await sql`INSERT INTO pulse.saved_queries(short_id,base_id,name,sql,pinned,created_at)
      VALUES(${`${baseId.slice(0, 5)}${index}`},${baseId}::uuid,${`Query ${index}`},'SELECT 42',true,'2026-10-20T10:00:00Z')`;
    return { ...adminFixtureIdentity(user!.id, false), baseId, scope: { id: user!.id } };
  };
  test("read model orders attention, counts source freshness and paginates microsecond timestamps without losing rows", async () => {
    const input = await fixture("a47f31ac-d628-4505-bfd4-b5ff86ec8a98", 0);
    const { readOverview } = await import("./overview");
    const { settingsFixture } = await import("../store/settings.test-fixture");
    const settings = settingsFixture(); // Unconfigured store still permits authorized metadata reads.
    try {
      for (const [index, state, severity] of [
        [0, "firing", "warn"],
        [1, "error", null],
        [2, "firing", "critical"],
        [3, "no_data", null],
        [4, "ok", null],
      ] as const) {
        await sql`INSERT INTO pulse.alert_rules(short_id,base_id,name,sql,comparison,warn,critical,min_duration_seconds,interval_seconds,state,severity,since)
          VALUES(${`Atten${index}`},${input.baseId}::uuid,${`Rule ${index}`},'SELECT 1','above',80,95,0,300,${state},${severity},'2026-10-20T10:00:00Z')`;
      }
      await sql`INSERT INTO pulse.sources(short_id,base_id,kind,name,last_data_at,stale_since,expect_every_seconds)
        VALUES('Stale5',${input.baseId}::uuid,'http_ingest','Old','2026-10-20T09:00:00Z','2026-10-20T10:00:00Z',3600),
          ('Fresh5',${input.baseId}::uuid,'http_ingest','Fresh','2026-10-20T10:00:00Z',NULL,NULL)`;
      const ids = [];
      for (let index = 0; index < 4; index++) {
        const [row] = await sql<{ id: string }[]>`INSERT INTO pulse.base_activity(base_id,at,kind,data)
          VALUES(${input.baseId}::uuid,${`2026-10-20T10:00:00.12345${index}Z`}::timestamptz,'source_created','{}') RETURNING id`;
        ids.unshift(row!.id);
      }
      const first = await readOverview({ ...input, activityLimit: 2, attentionLimit: 3 });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("Missing overview");
      expect(first.data.storeUnavailable).toBe(true);
      expect(first.data.sources).toEqual({ total: 2, current: 1 });
      expect(first.data.attention.items.map((item) => item.reference)).toEqual(["Atten2", "Atten0", "Atten1"]);
      expect(first.data.attention).toMatchObject({ total: 5, nextOffset: 3 });
      expect(first.data.activity.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
      expect(first.data.activity.nextCursor).toContain(".123452Z");
      const next = await readOverview({ ...input, attentionOffset: 3, activityLimit: 2, activityCursor: first.data.activity.nextCursor! });
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error("Missing second page");
      expect(next.data.activity.items.map((item) => item.id)).toEqual(ids.slice(2));
      expect(next.data.activity.nextCursor).toBeNull();
      expect(next.data.attention.items.map((item) => item.reference)).toEqual(["Atten3", "Stale5"]);
      expect(await readOverview({ ...input, ...adminFixtureIdentity("247f31ac-d628-4505-bfd4-b5ff86ec8a98", false) })).toMatchObject({
        ok: false,
        error: { status: 403 },
      });
    } finally {
      settings.restore();
    }
  });
  test("HTTP overview requires the same read grant for a person and an agent and restores the request timeout", async () => {
    const input = await fixture("c47f31ac-d628-4505-bfd4-b5ff86ec8a98", 0);
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind,status) VALUES('Overview agent','agent','active') RETURNING id`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${account!.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${input.baseId}::uuid,${grant!.id}::uuid)`;
    const agent: { actor: RequestActor; accessSubject: AccessSubject } = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: account!.id,
          name: "Overview agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-21T10:00:00Z",
        },
        scopes: ["read"],
        delegatedUser: null,
      },
      accessSubject: { type: "service_account", serviceAccountId: account!.id },
    };
    const { default: routes } = await import("../api/routes/overview");
    const { settingsFixture } = await import("../store/settings.test-fixture");
    const settings = settingsFixture();
    const calls: number[] = [];
    let identity: { actor: RequestActor; accessSubject: AccessSubject } = input;
    const app = new Hono<AuthContext>()
      .use("*", async (c, next) => {
        c.set("actor", identity.actor);
        c.set("accessSubject", identity.accessSubject);
        await next();
      })
      .route("/api/pulse", routes);
    const request = () =>
      app.request(`/api/pulse/bases/${input.baseId}/overview`, undefined, {
        timeout: (_request: Request, seconds: number) => calls.push(seconds),
      });
    try {
      for (const current of [input, agent]) {
        identity = current;
        const response = await request();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          name: "Overview",
          sources: { total: 0, current: 0 },
          numbers: [],
          storeUnavailable: true,
        });
        expect(calls.splice(0)).toEqual([60, 10]);
      }
      await sql`DELETE FROM pulse.base_access WHERE base_id=${input.baseId}::uuid`;
      for (const current of [input, agent]) {
        identity = current;
        const response = await request();
        expect(response.status).toBe(403);
        expect(await response.json()).not.toHaveProperty("sources");
        expect(calls.splice(0)).toEqual([60, 10]);
      }
    } finally {
      settings.restore();
    }
  });
  test("replicas, edits, replacements and cache eviction cannot exceed four attempts in one aligned slot", async () => {
    const input = await fixture("847f31ac-d628-4505-bfd4-b5ff86ec8a98");
    let at = new Date("2026-10-20T12:00:00Z"),
      calls = 0,
      concurrent = 0,
      maximum = 0,
      cacheReads = 0;
    const cacheValues = new Map<string, string>();
    const cache = {
      cached: async (key: string) => {
        cacheReads++;
        return cacheValues.get(key) ?? null;
      },
      cache: async (key: string, value: string) => {
        cacheValues.set(key, value);
      },
    };
    const run: typeof runBaseSql = async (request) => {
      expect(request.actor).toEqual(input.actor);
      expect(request.via).toBe("overview");
      expect(request.params).toEqual({});
      calls++;
      concurrent++;
      maximum = Math.max(maximum, concurrent);
      await sql`SELECT 1`;
      concurrent--;
      return result();
    };
    const a = createOverviewQueries({ run, cache, testOnly: { now: () => at } });
    const b = createOverviewQueries({ run, cache, testOnly: { now: () => at } });
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b)(input)));
    const first = await a(input);
    expect(calls).toBe(4);
    expect(maximum).toBe(1);
    expect(first.every((tile) => tile.status === "ready")).toBe(true);
    expect(cacheReads).toBeGreaterThan(0);
    cacheValues.clear();
    expect(await b(input)).toEqual(first);
    expect(calls).toBe(4);
    await sql`UPDATE pulse.saved_queries SET revision=revision+1 WHERE base_id=${input.baseId}::uuid`;
    expect((await a(input)).every((tile) => tile.lastGood === null)).toBe(true);
    expect(calls).toBe(4);
    await sql`DELETE FROM pulse.saved_queries WHERE base_id=${input.baseId}::uuid`;
    await sql`INSERT INTO pulse.saved_queries(short_id,base_id,name,sql,pinned) VALUES('NewPin',${input.baseId}::uuid,'Replacement','SELECT 42',true)`;
    expect((await b(input))[0]?.status).toBe("deferred");
    expect(calls).toBe(4);
    await sql`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${input.baseId}::uuid`;
    await a(input);
    expect(calls).toBe(4);
    at = new Date("2026-10-20T12:05:00Z");
    expect((await b(input))[0]?.status).toBe("ready");
    expect(calls).toBe(5);
  });
  test("finalization lock contention uses only the remaining request budget and returns the durable fallback", async () => {
    const input = await fixture("b47f31ac-d628-4505-bfd4-b5ff86ec8a98", 1);
    const at = new Date("2026-10-20T12:00:00Z");
    let elapsed = 0;
    const acquired = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    let lock: Promise<unknown> | undefined;
    const read = createOverviewQueries({
      testOnly: { now: () => at, monotonicNow: () => elapsed },
      cache: { cached: async () => null, cache: async () => {} },
      run: async () => {
        lock = sql.begin(async (tx) => {
          await tx`SELECT id FROM pulse.bases WHERE id=${input.baseId}::uuid FOR UPDATE`;
          acquired.resolve();
          await released.promise;
        });
        await acquired.promise;
        elapsed = OVERVIEW_WORK_MS - 50;
        return result();
      },
    });
    try {
      const started = performance.now();
      const tiles = await read(input);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(tiles[0]?.lastGood).toBeNull();
      expect(tiles[0]?.status).toBe("refreshing");
      const [ledger] = await sql<{ attempts: unknown[] }[]>`SELECT attempts FROM pulse.overview_state WHERE base_id=${input.baseId}::uuid`;
      expect(ledger?.attempts).toHaveLength(1);
    } finally {
      released.resolve();
      await lock;
    }
  });
  test("store/cache failures keep original timestamps; reset fencing rejects in-flight values; denied reads touch no cache or runner", async () => {
    const input = await fixture("947f31ac-d628-4505-bfd4-b5ff86ec8a98", 1);
    let at = new Date("2026-10-20T12:00:00Z"),
      calls = 0,
      cacheCalls = 0,
      failRun = false;
    let during: (() => Promise<void>) | undefined;
    const read = createOverviewQueries({
      testOnly: { now: () => at },
      run: async () => {
        calls++;
        await during?.();
        return failRun ? { ok: false, error: { code: "STORE_UNAVAILABLE", message: "Unavailable", status: 503 } } : result();
      },
      cache: {
        cached: async () => {
          cacheCalls++;
          throw new Error("offline");
        },
        cache: async () => {
          cacheCalls++;
          throw new Error("offline");
        },
      },
    });
    const first = (await read(input))[0]!;
    expect(first.status).toBe("ready");
    expect(first.lastGood?.evaluatedAt).toBe(at.toISOString());
    at = new Date("2026-10-20T12:05:00Z");
    failRun = true;
    const failed = (await read(input))[0]!;
    expect(failed.status).toBe("error");
    expect(failed.errorCode).toBe("STORE_UNAVAILABLE");
    expect(failed.lastGood).toEqual(first.lastGood);
    expect(calls).toBe(2);
    const before = cacheCalls;
    expect(await read({ ...input, scope: { id: "247f31ac-d628-4505-bfd4-b5ff86ec8a98" } })).toEqual([]);
    expect(cacheCalls).toBe(before);
    expect(calls).toBe(2);
    at = new Date("2026-10-20T12:10:00Z");
    failRun = false;
    during = async () => {
      await sql`UPDATE pulse.base_stores SET reset_generation=reset_generation+1 WHERE base_id=${input.baseId}::uuid`;
    };
    const reset = (await read(input))[0]!;
    expect(reset.lastGood).toBeNull();
    expect(reset.status).toBe("deferred");
    expect(calls).toBe(3);
    during = undefined;
    await read(input);
    expect(calls).toBe(3);
  });
});
