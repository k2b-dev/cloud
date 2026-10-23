import { afterAll, beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor, testInfra, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { sendWebsiteDelivery, WebsiteDeliverySchema } from "../../examples/website-tracking";

let pulseCapabilities: typeof import("../capabilities")["pulseCapabilities"];
let pulseService: typeof import("../service")["pulseService"];
let createBaseLifecycle: typeof import("../service/base-lifecycle")["createBaseLifecycle"];
let ingestQuota: typeof import("../service/ingest-quota")["ingestQuota"];
let createIngestWriter: typeof import("../service/ingest-writer")["createIngestWriter"];
let createOverviewQueries: typeof import("../service/overview-queries")["createOverviewQueries"];
let savedQueries: typeof import("../service/saved-queries")["savedQueries"];
let createSourceApiKey: typeof import("../service/source-management")["createSourceApiKey"];
let sqlAdmission: typeof import("../service/sql-admission")["sqlAdmission"];
let adminFixtureIdentity: typeof import("../store/admin-identity.test-fixture")["adminFixtureIdentity"];
let baseStore: typeof import("../store/base-store")["baseStore"];
let cleanupFixtureBase: typeof import("../store/base-store.test-fixture")["cleanupFixtureBase"];
let fixtureBase: typeof import("../store/base-store.test-fixture")["fixtureBase"];
let fixtureConnection: typeof import("../store/base-store.test-fixture")["fixtureConnection"];
let fixtureStore: typeof import("../store/base-store.test-fixture")["fixtureStore"];
let installFixtureStore: typeof import("../store/base-store.test-fixture")["installFixtureStore"];
let settingsFixture: typeof import("../store/settings.test-fixture")["settingsFixture"];
let createSqlRunner: typeof import("../store/sql-run")["createSqlRunner"];
let q: typeof import("../store/validation")["quoteIdentifier"];

let pulseApi: typeof import(".")["default"];

// Bind the disposable database before domain imports. Modules that register cleanup
// hooks must load at file scope: Bun runs hooks registered inside beforeAll as that
// hook finishes, which would stop the authority and drop the ClickHouse fixture.
const database =
  testInfra.database && testInfra.clickhouse && testInfra.valkey && testInfra.nats ? await useFreshDatabase("pulse_website") : undefined;
if (database) {
  await import("../../../../scripts/fixtures/test-clickhouse");
  await (await import("../../../core/src/runtime-helpers")).runCoreSetup();
  await import("../../../../scripts/fixtures/authorization-preload");
}

suiteFor(
  "database",
  "clickhouse",
  "valkey",
  "nats",
)("website backend to stored telemetry and Assistant SQL", () => {
  let settings: ReturnType<typeof settingsFixture>;
  beforeAll(async () => {
    ({ default: pulseApi } = await import("."));
    // Domain singletons may capture Bun.sql during import; bind the disposable database first.
    ({ pulseCapabilities } = await import("../capabilities"));
    ({ pulseService } = await import("../service"));
    ({ createBaseLifecycle } = await import("../service/base-lifecycle"));
    ({ ingestQuota } = await import("../service/ingest-quota"));
    ({ createIngestWriter } = await import("../service/ingest-writer"));
    ({ createOverviewQueries } = await import("../service/overview-queries"));
    ({ savedQueries } = await import("../service/saved-queries"));
    ({ createSourceApiKey } = await import("../service/source-management"));
    ({ sqlAdmission } = await import("../service/sql-admission"));
    ({ adminFixtureIdentity } = await import("../store/admin-identity.test-fixture"));
    ({ baseStore } = await import("../store/base-store"));
    ({ cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } = await import(
      "../store/base-store.test-fixture"
    ));
    ({ settingsFixture } = await import("../store/settings.test-fixture"));
    ({ createSqlRunner } = await import("../store/sql-run"));
    ({ quoteIdentifier: q } = await import("../store/validation"));
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify(fixtureConnection());
    await installFixtureStore();
  }, 30_000);
  afterAll(async () => {
    setSystemTime();
    settings?.restore();
    sqlAdmission?.close();
    ingestQuota?.close();
    await sql.close();
    await database?.drop();
  });

  test("backend source token, replay, Berlin days, paths, sessions, overview and sql.run agree", async () => {
    setSystemTime(new Date("2026-10-20T12:00:00Z"));
    const base = await fixtureBase("b2111111-1111-4111-8111-111111111111");
    const store = fixtureStore(() => new Date("2026-10-20T12:00:00Z"));
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(id,uid,provider,profile,display_name)
      VALUES('b2222222-2222-4222-8222-222222222222','willow-backend','local','user','Willow operator') RETURNING id`;
    const identity = adminFixtureIdentity(user!.id, false);
    if (identity.actor.kind !== "user") throw new Error("USER_FIXTURE");
    const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission) VALUES(${user!.id}::uuid,'admin') RETURNING id`;
    await sql`INSERT INTO pulse.base_access VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
    await sql`UPDATE pulse.bases SET timezone='Europe/Berlin' WHERE id=${base.id}::uuid`;
    const context: CapabilityExecutionContext = {
      ...identity,
      user: identity.actor.user,
      locale: "en",
      requestId: "website-proof",
      origin: "assistant",
      signal: new AbortController().signal,
      idempotencyKey: "create-website-source",
    };
    let ingestServer: ReturnType<typeof Bun.serve> | undefined;
    // The HTTP writer uses the process store. Keep its identifier guard aligned
    // with the disposable ClickHouse namespace, without replacing the writer.
    const originalPrefix = baseStore.prefix;
    baseStore.prefix = store.prefix;
    const credentials = spyOn(baseStore, "readUserCredentials").mockImplementation((id) => store.readUserCredentials(id));
    try {
      await createBaseLifecycle(store)(base.id);
      await store.query(`ALTER TABLE ${q(base.database)}._events REMOVE TTL`);
      const source = await pulseCapabilities.actions["source.create"].run(
        { baseId: base.shortId, kind: "http_ingest", name: "Willow website" },
        context,
      );
      if (!source.ok) throw new Error(source.error.message);
      const [internalSource] = await sql<{ id: string }[]>`SELECT id FROM pulse.sources WHERE short_id=${source.data.data.id}`;
      const token = await createSourceApiKey({
        baseId: base.id,
        sourceId: internalSource!.id,
        user: identity.actor.user,
        name: "website backend",
        permission: "write",
      });
      if (!token.ok) throw new Error(token.error.message);
      const app = new Hono().route("/api/pulse", pulseApi);
      ingestServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
      // Exercise the executable example against the real authenticated HTTP route.
      const delivery = WebsiteDeliverySchema.parse(await Bun.file(`${import.meta.dir}/../../examples/website-delivery.json`).json());
      const config = { endpoint: `${ingestServer.url.origin}/api/pulse/ingest`, token: token.data.token };
      // Existing tokens distinguish a temporary pause from a deleted source, before any writes.
      const refused = async (status: number, code: string) => {
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ events: [{ kind: "paused-probe" }] }),
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      };
      await sql`UPDATE pulse.sources SET enabled=FALSE WHERE id=${internalSource!.id}::uuid`;
      await refused(409, "PULSE_SOURCE_DISABLED");
      await sql`UPDATE pulse.sources SET enabled=TRUE WHERE id=${internalSource!.id}::uuid`;
      for (const state of ["provisioning", "clearing", "failed"] as const) {
        await sql`UPDATE pulse.base_stores SET state=${state} WHERE base_id=${base.id}::uuid`;
        await refused(409, "PULSE_BASE_NOT_WRITABLE");
      }
      await sql`UPDATE pulse.base_stores SET state='active' WHERE base_id=${base.id}::uuid`;
      await sql`UPDATE pulse.bases SET data_clear_started_at='2026-10-20T11:00:00Z',data_clear_completed_at=NULL WHERE id=${base.id}::uuid`;
      await refused(409, "PULSE_BASE_NOT_WRITABLE");
      await sql`UPDATE pulse.bases SET data_clear_completed_at='2026-10-20T11:01:00Z' WHERE id=${base.id}::uuid`;
      // Exercise the lookup boundary while the token is still valid; normal deletion revocation is checked below.
      await sql`UPDATE pulse.sources SET deleted=TRUE WHERE id=${internalSource!.id}::uuid`;
      await refused(404, "NOT_FOUND");
      await sql`UPDATE pulse.sources SET deleted=FALSE WHERE id=${internalSource!.id}::uuid`;
      expect(await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`)).toEqual([{ n: 0 }]);
      expect(await (await sendWebsiteDelivery(delivery, config)).json()).toEqual({ metrics: 0, events: 5, states: 0 });
      expect(await (await sendWebsiteDelivery(delivery, config)).json()).toEqual({ metrics: 0, events: 5, states: 0 });
      const conflict = await fetch(config.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "idempotency-key": delivery.key },
        body: JSON.stringify({ events: [{ kind: "different-batch" }] }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ code: "CONFLICT", message: "Idempotency key was already used for a different ingest batch" });
      for (const batch of [{ events: [{ kind: "invalid", unknown: true }] }, { metrics: [{ name: "invalid", value: "text" }] }]) {
        const response = await fetch(config.endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify(batch),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: "BAD_INPUT" });
      }
      expect(await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`)).toEqual([{ n: 5 }]);
      const sqlText = await Bun.file(`${import.meta.dir}/../../examples/website.sql`).text();
      const result = await pulseCapabilities.queries["sql.run"].run(
        { baseId: base.shortId, sql: sqlText, params: { bucket: "1d" } },
        context,
      );
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      expect(result.ok).toBe(true);
      expect(result.data.data.rows.map((row) => row.map((value, index) => (index > 1 ? Number(value) : value)))).toEqual([
        ["2026-10-19 00:00:00", "/", 1, 1, 0],
        ["2026-10-20 00:00:00", "/contact", 1, 1, 1],
        ["2026-10-20 00:00:00", "/services", 2, 2, 0],
      ]);
      const totals = await pulseCapabilities.queries["sql.run"].run(
        {
          baseId: base.shortId,
          sql: "SELECT countIf(kind='page_view'),uniqExactIf(session_id,kind='page_view'),countIf(kind='contact_form_sent') FROM events",
        },
        context,
      );
      expect(totals.ok && totals.data.data.rows.map((row) => row.map(Number))).toEqual([[4, 2, 1]]);
      const pin = await savedQueries.save({
        ...identity,
        baseId: base.shortId,
        name: "Website page views",
        sql: "SELECT countIf(kind='page_view') AS value FROM events",
        pinned: true,
        idempotencyKey: "website-pin",
      });
      expect(pin.ok).toBe(true);
      const overview = createOverviewQueries({ testOnly: { now: () => new Date("2026-10-20T12:00:00Z") } });
      const tiles = await overview({ ...identity, baseId: base.id, scope: { id: user!.id } });
      expect(tiles).toMatchObject([{ name: "Website page views", status: "ready", lastGood: { data: { value: 4 } } }]);
      // The capability's own-source path reuses the writer's durable reservation.
      const writer = createIngestWriter({ store });
      const writing = spyOn(pulseService.ingest, "batch").mockImplementation(writer);
      try {
        const input = {
          baseId: base.shortId,
          sourceId: source.data.data.id,
          expectedRevision: 1,
          batch: {
            events: [{ kind: "page_view", ts: "2026-10-20T11:00:00Z", sessionId: "fictional-session-c", dimensions: { path: "/" } }],
          },
        };
        const call = { ...context, idempotencyKey: "agent-website-event" };
        expect(await pulseCapabilities.actions["ingest.write"].review(input, call)).toMatchObject({
          ok: true,
          data: { approvalScope: `pulse:source:${internalSource!.id}:ingest` },
        });
        expect(await pulseCapabilities.actions["ingest.write"].run(input, call)).toMatchObject({ ok: true, data: { data: { events: 1 } } });
        expect(await pulseCapabilities.actions["ingest.write"].run(input, call)).toMatchObject({ ok: true, data: { data: { events: 1 } } });
        expect(await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`)).toEqual([{ n: 6 }]);
        await sql`UPDATE pulse.sources SET revision=2 WHERE id=${internalSource!.id}::uuid`;
        expect(await pulseCapabilities.actions["ingest.write"].review(input, call)).toMatchObject({ ok: false, error: { status: 409 } });
        expect(
          await writer({
            baseId: base.id,
            sourceId: internalSource!.id,
            batch: input.batch,
            idempotencyKey: "stale-at-writer",
            ownedSource: { ...identity, expectedRevision: 1 },
          }),
        ).toMatchObject({ ok: false, error: { status: 409 } });
        await sql`UPDATE pulse.sources SET created_by_subject='user:other' WHERE id=${internalSource!.id}::uuid`;
        expect(
          await writer({
            baseId: base.id,
            sourceId: internalSource!.id,
            batch: input.batch,
            idempotencyKey: "foreign-at-writer",
            ownedSource: { ...identity, expectedRevision: 2 },
          }),
        ).toMatchObject({ ok: false, error: { status: 403 } });
        expect(await pulseCapabilities.actions["ingest.write"].run({ ...input, expectedRevision: 2 }, call)).toMatchObject({
          ok: false,
          error: { status: 403 },
        });
      } finally {
        writing.mockRestore();
      }
      const agentId = "b2333333-3333-4333-8333-333333333333";
      await sql`INSERT INTO auth.service_accounts(id,name,kind) VALUES(${agentId}::uuid,'Willow collector agent','agent')`;
      const [agentGrant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(service_account_id,permission) VALUES(${agentId}::uuid,'write') RETURNING id`;
      await sql`INSERT INTO pulse.base_access VALUES(${base.id}::uuid,${agentGrant!.id}::uuid)`;
      const agentContext: CapabilityExecutionContext = {
        ...context,
        user: null,
        actor: {
          kind: "service_account",
          serviceAccount: {
            id: agentId,
            name: "Willow collector agent",
            kind: "agent",
            status: "active",
            delegatedUserId: null,
            appId: null,
            resourceType: null,
            resourceId: null,
            createdBy: null,
            createdAt: "2026-10-20T12:00:00Z",
          },
          scopes: ["write"],
          delegatedUser: null,
        },
        accessSubject: { type: "service_account", serviceAccountId: agentId },
        idempotencyKey: "agent-source-create",
      };
      const agentSource = await pulseCapabilities.actions["source.create"].run(
        { baseId: base.shortId, name: "Agent collector", kind: "http_ingest" },
        agentContext,
      );
      if (!agentSource.ok) throw new Error(agentSource.error.message);
      const agentInput = {
        baseId: base.shortId,
        sourceId: agentSource.data.data.id,
        expectedRevision: 1,
        batch: { events: [{ kind: "agent_proof", ts: "2026-10-20T11:00:00Z" }] },
      };
      const agentCall = { ...agentContext, idempotencyKey: "agent-ingest" };
      const written = await pulseCapabilities.actions["ingest.write"].run(agentInput, agentCall);
      expect(written).toMatchObject({ ok: true, data: { data: { events: 1 } } });
      expect(await pulseCapabilities.actions["ingest.write"].run(agentInput, agentCall)).toEqual(written);
      expect(await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`)).toEqual([{ n: 7 }]);
      expect(
        await pulseCapabilities.actions["ingest.write"].review(
          { ...agentInput, sourceId: source.data.data.id, expectedRevision: 2 },
          agentCall,
        ),
      ).toMatchObject({ ok: false, error: { status: 403 } });
      await sql`UPDATE auth.access SET permission='read' WHERE id=${agentGrant!.id}::uuid`;
      expect(
        await pulseCapabilities.actions["ingest.write"].run(agentInput, { ...agentCall, idempotencyKey: "revoked-agent-ingest" }),
      ).toMatchObject({ ok: false, error: { status: 403 } });
      const runner = createSqlRunner({ store, connection: async () => fixtureConnection() });
      const dst = await runner.run({
        baseId: base.id,
        database: base.database,
        profile: "normal",
        timezone: "Europe/Berlin",
        runId: "bucket-dst",
        sql: "SELECT dateDiff('second',bucket(:a,:bucket),bucket(:b,:bucket)) AS seconds, toString(bucket(:a,:bucket)) AS day",
        params: { a: "2026-10-25T12:00:00Z", b: "2026-10-26T12:00:00Z", bucket: "1d" },
      });
      expect(dst.rows).toEqual([[90000, "2026-10-25 00:00:00"]]);
      const spring = await runner.run({
        baseId: base.id,
        database: base.database,
        profile: "normal",
        timezone: "Europe/Berlin",
        runId: "bucket-spring",
        sql: "SELECT dateDiff('second',bucket(:a,:bucket),bucket(:b,:bucket)) AS seconds",
        params: { a: "2026-03-29T12:00:00Z", b: "2026-03-30T12:00:00Z", bucket: "1d" },
      });
      expect(spring.rows).toEqual([[82800]]);
      const intervals = await runner.run({
        baseId: base.id,
        database: base.database,
        profile: "normal",
        timezone: "Europe/Berlin",
        runId: "bucket-intervals",
        sql: "SELECT toString(bucket(:at,:minute)),toString(bucket(:sunday,:week))",
        params: { at: "2026-10-20T10:02:30Z", minute: "5m", sunday: "2026-10-25T12:00:00Z", week: "1w" },
      });
      // ClickHouse returns a Date for calendar weeks and a DateTime for minute buckets.
      expect(intervals.rows).toEqual([["2026-10-20 12:00:00", "2026-10-19"]]);
      expect(await pulseService.source.remove({ baseId: base.id, sourceId: internalSource!.id, user: identity.actor.user })).toMatchObject({
        ok: true,
      });
      const revoked = await fetch(config.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [{ kind: "revoked" }] }),
      });
      expect(revoked.status).toBe(401);
      expect(await store.query(`SELECT count() AS n FROM ${q(base.database)}._events`)).toEqual([{ n: 7 }]);
    } finally {
      await ingestServer?.stop(true);
      credentials.mockRestore();
      baseStore.prefix = originalPrefix;
      await sql`DELETE FROM auth.service_accounts WHERE app_id='pulse' AND created_by=${user!.id}::uuid`;
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id='b2333333-3333-4333-8333-333333333333'::uuid`;
      setSystemTime();
    }
  }, 60_000);
});
