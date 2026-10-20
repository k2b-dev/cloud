import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { createTestAppSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { clickhouseAdminQuery as admin } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { pulseCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { createBaseLifecycle } from "../service/base-lifecycle";
import { listSources } from "../service/source-management";
import { sqlAdmission } from "../service/sql-admission";
import { READ_VIEWS } from "../store/base-schema";
import { baseStore } from "../store/base-store";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "../store/base-store.test-fixture";
import { clickhouseQuery } from "../store/client";
import { deniedReadQueries, readViewArguments } from "../store/read-attacks.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import { sqlQueryId } from "../store/sql-run";
import { waitUntil } from "../store/sql-run.test-fixture";
import { quoteIdentifier as q } from "../store/validation";
import pulseApi from ".";

const app = new Hono().route("/api/pulse", pulseApi);
const expensive = "SELECT sum(cityHash64(a.number,b.number)) FROM numbers(1000000) a CROSS JOIN numbers(1000000) b";
const suite = suiteFor("database", "clickhouse", "valkey", "nats");
type Base = Awaited<ReturnType<typeof fixtureBase>>;

suite("SQL HTTP and agent capability share the base read boundary", () => {
  let settings: ReturnType<typeof settingsFixture>;
  let credentials: ReturnType<typeof spyOn<typeof baseStore, "readUserCredentials">>;
  const store = fixtureStore();
  beforeAll(async () => {
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify(fixtureConnection());
    await installFixtureStore();
    // Only adapt fixture identifier validation: credentials still come from the
    // real encrypted PG record. Runner, ClickHouse transport, admission and grants are real.
    credentials = spyOn(baseStore, "readUserCredentials").mockImplementation((baseId) => store.readUserCredentials(baseId));
  }, 30_000);
  afterAll(() => {
    credentials?.mockRestore();
    settings?.restore();
    sqlAdmission.close();
  });

  const createActor = async (name: string) => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
      VALUES(${`pulse-sql-api-${crypto.randomUUID()}`},'local','user',${name}) RETURNING id`;
    if (!user) throw new Error("USER_FIXTURE_FAILED");
    const { token } = await createTestAppSession(user.id);
    const headers = () => ({
      cookie: `pwa_session=${token}`,
      "content-type": "application/json",
      "x-forwarded-for": uniqueCallerAddress(),
    });
    const request = (base: Base, suffix: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}) =>
      app.request(`/api/pulse/bases/${base.shortId}${suffix}`, {
        method: options.method ?? "POST",
        headers: headers(),
        signal: options.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    return { id: user.id, headers, request };
  };
  const grantUser = async (base: Base, userId: string, permission: "read" | "write" | "admin") => {
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(user_id,permission) VALUES(${userId}::uuid,${permission}::auth.permission_level) RETURNING id`;
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${access!.id}::uuid)`;
    return access!.id;
  };
  const hasProcess = async (id: string, user?: string) => {
    const rows = await admin(
      "SELECT count() AS n FROM system.processes WHERE query_id={id:String} AND ({user:String}='' OR user={user:String})",
      { params: { id, user: user ?? "" } },
    );
    return Number(rows[0]?.n) > 0;
  };

  test("the complete denied matrix fails for a person and an agent with equal read grants", async () => {
    const bases = [await fixtureBase(), await fixtureBase()],
      base = bases[0]!,
      other = bases[1]!;
    const person = await createActor("SQL reader");
    const [account] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES('SQL reader agent','agent') RETURNING id`;
    if (!account) throw new Error("AGENT_FIXTURE_FAILED");
    const [access] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${account.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${access!.id}::uuid)`;
    await grantUser(base, person.id, "read");
    const context: CapabilityExecutionContext = {
      actor: {
        kind: "service_account",
        scopes: ["read"],
        delegatedUser: null,
        serviceAccount: {
          id: account.id,
          name: "SQL reader agent",
          kind: "agent",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-20T10:00:00.000Z",
        },
      },
      accessSubject: { type: "service_account", serviceAccountId: account.id },
      user: null,
      locale: "en",
      requestId: "pulse-sql-api-attack-fixture",
      origin: "http",
      signal: new AbortController().signal,
    };
    const scrubbed = (value: unknown) => {
      const text = JSON.stringify(value);
      for (const secret of [base.database, base.readUser, other.database, other.readUser, fixtureConnection().password])
        expect(text).not.toContain(secret);
    };
    try {
      for (const item of bases) await createBaseLifecycle(store)(item.id);
      const grants = await admin("SELECT table FROM system.grants WHERE user_name={user:String} AND access_type='SELECT' ORDER BY table", {
        params: { user: base.readUser },
      });
      expect(grants.map((row) => row.table)).toEqual([...READ_VIEWS].sort());
      // Every permitted view (including the parameterized helpers) works through both seams.
      for (const view of READ_VIEWS) {
        const query = `SELECT * FROM ${q(base.database)}.${q(view)}${readViewArguments(view)} LIMIT 1`;
        const response = await person.request(base, "/sql", { body: { sql: query } });
        expect(response.status).toBe(200);
        expect(await pulseCapabilities.queries["sql.run"].run({ baseId: base.shortId, sql: query }, context)).toMatchObject({ ok: true });
      }
      for (const query of deniedReadQueries(base, other)) {
        const response = await person.request(base, "/sql", { body: { sql: query } });
        const body: unknown = await response.json();
        if (response.status !== 400) throw new Error(`HTTP attack was not refused as SQL_ERROR (${response.status}): ${query}`);
        expect(body).toMatchObject({ code: "SQL_ERROR" });
        scrubbed(body);
        const result = await pulseCapabilities.queries["sql.run"].run({ baseId: base.shortId, sql: query }, context);
        if (result.ok) throw new Error(`Agent attack was not refused: ${query}`);
        expect(result.error.code).toBe("SQL_ERROR");
        scrubbed(result);
      }
      const hostile = "'); DROP TABLE x; --";
      const query = { sql: "SELECT :message AS message", params: { message: hostile } };
      const response = await person.request(base, "/sql", { body: query });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rows: [[hostile]], rowCount: 1 });
      expect(await pulseCapabilities.queries["sql.run"].run({ baseId: base.shortId, ...query }, context)).toMatchObject({
        ok: true,
        data: { data: { rows: [[hostile]] } },
      });
      expect(await pulseCapabilities.queries["sql.run"].run({ baseId: other.shortId, sql: "SELECT 1" }, context)).toMatchObject({
        ok: false,
        error: { code: "NO_READ_ACCESS", status: 403 },
      });
      const denied = await person.request(other, "/sql", { body: { sql: "SELECT 1" } });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "NO_READ_ACCESS" });
    } finally {
      for (const item of bases) await cleanupFixtureBase(item);
      await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${person.id}::uuid`;
    }
  }, 120_000);

  test("HTTP read lists and runs; saved changes need write; base settings need admin", async () => {
    const base = await fixtureBase(),
      person = await createActor("SQL permission fixture");
    const grant = await grantUser(base, person.id, "read");
    try {
      await createBaseLifecycle(store)(base.id);
      expect((await person.request(base, "/sql", { body: { sql: "SELECT 1" } })).status).toBe(200);
      expect((await person.request(base, "/queries", { method: "GET" })).status).toBe(200);
      const saved = { name: "Fixture", sql: "SELECT 1" };
      expect((await person.request(base, "/queries", { body: saved })).status).toBe(403);
      await sql`UPDATE auth.access SET permission='write' WHERE id=${grant}::uuid`;
      const created = await person.request(base, "/queries", { body: saved });
      expect(created.status).toBe(201);
      const row = (await created.json()) as { id: string; revision: number };
      expect((await person.request(base, "", { method: "PATCH", body: { timezone: "Europe/Berlin" } })).status).toBe(403);
      await sql`UPDATE auth.access SET permission='read' WHERE id=${grant}::uuid`;
      expect(
        (await person.request(base, `/queries/${row.id}`, { method: "DELETE", body: { expectedRevision: row.revision } })).status,
      ).toBe(403);
      expect(
        (
          await person.request(base, `/queries/${row.id}`, {
            method: "PATCH",
            body: { expectedRevision: row.revision, name: "Changed", sql: "SELECT 1" },
          })
        ).status,
      ).toBe(403);
      await sql`UPDATE auth.access SET permission='admin' WHERE id=${grant}::uuid`;
      const updated = await person.request(base, "", { method: "PATCH", body: { timezone: "Europe/Berlin" } });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ timezone: "Europe/Berlin", shortId: base.shortId });
      expect(
        (await person.request(base, `/queries/${row.id}`, { method: "DELETE", body: { expectedRevision: row.revision } })).status,
      ).toBe(200);
    } finally {
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${person.id}::uuid`;
    }
  }, 30_000);

  test("source counts use registry series and base-local midnight; a busy aggregate stays unavailable", async () => {
    const base = await fixtureBase(),
      person = await createActor("SQL source-count fixture");
    await grantUser(base, person.id, "read");
    const sourceId = crypto.randomUUID(),
      emptySource = crypto.randomUUID(),
      metricId = crypto.randomUUID(),
      seriesId = crypto.randomUUID();
    const sourceRef = newShortId(),
      emptyRef = newShortId();
    let held: Awaited<ReturnType<typeof sqlAdmission.acquire>> | undefined;
    try {
      await createBaseLifecycle(store)(base.id);
      await sql`UPDATE pulse.bases SET timezone='Europe/Berlin' WHERE id=${base.id}::uuid`;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name) VALUES
        (${sourceId}::uuid,${sourceRef},${base.id}::uuid,'http_ingest','Counted source'),
        (${emptySource}::uuid,${emptyRef},${base.id}::uuid,'http_ingest','Empty source')`;
      await sql`INSERT INTO pulse.metric_defs(id,base_id,name,type) VALUES(${metricId}::uuid,${base.id}::uuid,'counted','gauge')`;
      await sql`INSERT INTO pulse.metric_series(id,base_id,metric_id,source_id,series_key) VALUES(${seriesId}::uuid,${base.id}::uuid,${metricId}::uuid,${sourceId}::uuid,'counted')`;
      held = await sqlAdmission.acquire({ baseId: base.id, runId: crypto.randomUUID(), quota: 600, countQuota: false });
      const busy = await person.request(base, "/sources", { method: "GET" });
      expect(busy.status).toBe(200);
      expect(await busy.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: sourceRef, seriesCount: 1, todayCount: null }),
          expect.objectContaining({ id: emptyRef, seriesCount: 0, todayCount: null }),
        ]),
      );
      await held.release();
      held = undefined;
      const db = q(base.database);
      // Fixed future dates keep server TTL merges independent of the day this suite runs.
      // In Berlin on June 1, local midnight is May 31 at 22:00 UTC.
      const before = "2099-05-31 21:59:59.999",
        midnight = "2099-05-31 22:00:00.000";
      await store.query(
        `INSERT INTO ${db}._series(series_id,metric,type,source_id,version) VALUES({series:UUID},'counted','gauge',{source:UUID},1)`,
        { series: seriesId, source: sourceId },
      );
      for (const ts of [before, midnight]) {
        await store.query(
          `INSERT INTO ${db}._samples(row_id,series_id,ts,value,version) VALUES(generateUUIDv4(),{series:UUID},{ts:DateTime64(3)},1,1)`,
          { series: seriesId, ts },
        );
        await store.query(
          `INSERT INTO ${db}._events(id,ts,kind,source_id,version) VALUES(generateUUIDv4(),{ts:DateTime64(3)},'counted',{source:UUID},1)`,
          { source: sourceId, ts },
        );
      }
      await store.query(
        `INSERT INTO ${db}._states_current(state_key,variant_key,value,source_id,updated_at,version) VALUES
        ('before','v','1',{source:UUID},{before:DateTime64(3)},1),('today','v','1',{source:UUID},{midnight:DateTime64(3)},1)`,
        { source: sourceId, before, midnight },
      );
      const usage = await sqlAdmission.usage(base.id);
      const counted = await listSources(base.id, { id: person.id }, { now: new Date("2099-06-01T12:00:00.000Z") });
      expect(counted).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ id: sourceId, seriesCount: 1, todayCount: 3 }),
          expect.objectContaining({ id: emptySource, seriesCount: 0, todayCount: 0 }),
        ]),
      });
      expect(await sqlAdmission.usage(base.id)).toEqual(usage);
      // A same-slot read uses the cached aggregate even while SQL is busy.
      held = await sqlAdmission.acquire({ baseId: base.id, runId: crypto.randomUUID(), quota: 600, countQuota: false });
      expect(await listSources(base.id, { id: person.id }, { now: new Date("2099-06-01T12:01:00.000Z") })).toEqual(counted);
    } finally {
      await held?.release();
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${person.id}::uuid`;
    }
  }, 30_000);

  test("only the run actor cancels; endpoint and real client close remove the process", async () => {
    const base = await fixtureBase(),
      owner = await createActor("SQL cancellation owner"),
      reader = await createActor("SQL other reader");
    await grantUser(base, owner.id, "read");
    await grantUser(base, reader.id, "read");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const active: { controller: AbortController; response: Promise<Response | Error> }[] = [];
    const start = (runId: string) => {
      const controller = new AbortController();
      const response = fetch(new URL(`/api/pulse/bases/${base.shortId}/sql`, server.url), {
        method: "POST",
        headers: owner.headers(),
        body: JSON.stringify({ sql: expensive, runId }),
        signal: controller.signal,
      }).catch((error: unknown) => (error instanceof Error ? error : new Error("CLIENT_CLOSED")));
      const running = { controller, response };
      active.push(running);
      return running;
    };
    try {
      await createBaseLifecycle(store)(base.id);
      const runId = crypto.randomUUID(),
        running = start(runId),
        id = sqlQueryId(base.id, runId);
      await waitUntil(() => hasProcess(id));
      const denied = await reader.request(base, "/sql/cancel", { body: { runId } });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "NO_READ_ACCESS" });
      expect(await hasProcess(id)).toBe(true);
      const cancelled = await owner.request(base, "/sql/cancel", { body: { runId } });
      expect(cancelled.status).toBe(200);
      const result = await running.response;
      if (result instanceof Error) throw result;
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({ code: "CANCELLED" });
      await waitUntil(async () => !(await hasProcess(id)));
      const closeId = crypto.randomUUID(),
        closed = start(closeId);
      await waitUntil(() => hasProcess(sqlQueryId(base.id, closeId)));
      closed.controller.abort();
      expect(await closed.response).toBeInstanceOf(Error);
      await waitUntil(async () => !(await hasProcess(sqlQueryId(base.id, closeId))));
    } finally {
      for (const running of active) running.controller.abort();
      await Promise.all(active.map((running) => running.response));
      await server.stop(true);
      await cleanupFixtureBase(base);
      await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid OR id=${reader.id}::uuid`;
    }
  }, 45_000);

  test("cancelling a registered queued run cannot kill another base reader with a crafted query id", async () => {
    const base = await fixtureBase(),
      other = await fixtureBase(),
      owner = await createActor("SQL crafted cancel owner");
    await grantUser(base, owner.id, "read");
    let held: Awaited<ReturnType<typeof sqlAdmission.acquire>> | undefined;
    const controller = new AbortController();
    const runId = crypto.randomUUID();
    let foreign: Promise<unknown> | undefined;
    try {
      await createBaseLifecycle(store)(base.id);
      await createBaseLifecycle(store)(other.id);
      held = await sqlAdmission.acquire({ baseId: base.id, runId: crypto.randomUUID(), quota: 600, countQuota: false });
      const id = sqlQueryId(base.id, runId);
      // Register before the HTTP call, with the same owning actor. The cancel endpoint
      // reaches the genuine KILL path even if this replica has no local controller.
      expect(await sqlAdmission.register(base.id, runId, `user:${owner.id}`)).toBe(true);
      foreign = clickhouseQuery({
        ...fixtureConnection(),
        ...(await store.readUserCredentials(other.id)),
        query: expensive,
        queryId: id,
        timeoutMs: 12_000,
        signal: controller.signal,
      }).catch(() => []);
      await waitUntil(() => hasProcess(id, other.readUser));
      const response = await owner.request(base, "/sql/cancel", { body: { runId } });
      expect(response.status).toBe(200);
      expect(await hasProcess(id, other.readUser)).toBe(true);
      await sqlAdmission.forget(base.id, runId);
    } finally {
      controller.abort();
      await foreign;
      await sqlAdmission.forget(base.id, runId);
      await held?.release();
      await cleanupFixtureBase(base);
      await cleanupFixtureBase(other);
      await sql`DELETE FROM auth.users WHERE id=${owner.id}::uuid`;
    }
  }, 30_000);
});
