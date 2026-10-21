import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { clickhouseAdminQuery } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor, useFreshDatabase } from "../../../../scripts/fixtures/test-infra";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { baseStore } from "../store/base-store";
import { cleanupFixtureBase, fixtureBase, fixtureConnection, fixtureStore, installFixtureStore } from "../store/base-store.test-fixture";
import { settingsFixture } from "../store/settings.test-fixture";
import { sqlQueryId, sqlRunner } from "../store/sql-run";
import { waitUntil } from "../store/sql-run.test-fixture";
import { applyAlertEvaluation, claimDueAlert, evaluateDueAlerts } from "./alert-evaluator";
import { createOverviewQueries } from "./overview-queries";
import { sqlAdmission } from "./sql-admission";
import { runAlertSql } from "./sql-service";

suiteFor(
  "database",
  "clickhouse",
  "valkey",
)("scheduled alerts use real bounded SQL and durable state", () => {
  let createBaseLifecycle: typeof import("./base-lifecycle").createBaseLifecycle;
  let database: Awaited<ReturnType<typeof useFreshDatabase>> | undefined;
  let settings: ReturnType<typeof settingsFixture>;
  let credentials: ReturnType<typeof spyOn<typeof baseStore, "readUserCredentials">>;
  const store = fixtureStore();
  const start = new Date("2026-10-20T10:00:00.000Z");
  beforeAll(async () => {
    database = await useFreshDatabase("pulse_alert_execution");
    const { runCoreSetup } = await import("../../../core/src/runtime-helpers");
    await runCoreSetup();
    ({ createBaseLifecycle } = await import("./base-lifecycle"));
    settings = settingsFixture();
    settings.values["pulse.clickhouse_connection"] = JSON.stringify(fixtureConnection());
    await installFixtureStore();
    // Only fixture-prefix credential resolution differs; SQL, admission,
    // ClickHouse transport, KILL and PostgreSQL transitions remain real.
    credentials = spyOn(baseStore, "readUserCredentials").mockImplementation((id) => store.readUserCredentials(id));
  }, 30_000);
  afterAll(async () => {
    credentials?.mockRestore();
    settings?.restore();
    sqlAdmission.close();
    if (database) {
      await sql.close();
      await database.drop();
    }
  });
  const createRule = async (baseId: string, query: string, comparison = "above", duration = 0) => {
    const [rule] = await sql<{ id: string }[]>`INSERT INTO pulse.alert_rules
      (short_id,base_id,name,sql,comparison,warn,critical,min_duration_seconds,interval_seconds,next_check_at,since)
      VALUES('RunAl5',${baseId}::uuid,'Real alert',${query},${comparison},${comparison === "above" ? 80 : 20},
        ${comparison === "above" ? 95 : 5},${duration},300,${start},${start}) RETURNING id`;
    if (!rule) throw new Error("Missing alert fixture");
    return rule.id;
  };
  const execute = async (ruleId: string, at: Date) => {
    const claim = await claimDueAlert(at);
    expect(claim?.id).toBe(ruleId);
    if (!claim) throw new Error("Missing alert claim");
    const result = await runAlertSql({
      ruleId,
      revision: claim.revision,
      leaseId: claim.lease_id,
      resetGeneration: claim.reset_generation,
    });
    expect(await applyAlertEvaluation(claim, result, at, "en")).toBe(true);
    return result;
  };
  const state = async (id: string) => {
    const [row] = await sql<{ state: string; severity: string | null; last_error: string | null }[]>`
      SELECT state,severity,last_error FROM pulse.alert_rules WHERE id=${id}::uuid`;
    return row;
  };
  test("pinned overview queries use the real runner and cache without consuming the question quota", async () => {
    const base = await fixtureBase();
    const run = spyOn(sqlRunner, "run");
    const cached = spyOn(sqlAdmission, "cached");
    try {
      await createBaseLifecycle(store)(base.id);
      const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name)
        VALUES('pulse_overview_runner','local','user','Overview reader') RETURNING id`;
      const [grant] = await sql<{ id: string }[]>`INSERT INTO auth.access(user_id,permission)
        VALUES(${user!.id}::uuid,'read') RETURNING id`;
      await sql`INSERT INTO pulse.base_access(base_id,access_id) VALUES(${base.id}::uuid,${grant!.id}::uuid)`;
      const query =
        "SELECT toDateTime(:to) AS at, toFloat64(42) AS value, 'ms' AS unit, toString(:bucket) AS detail, 'success' AS detailTone WHERE toDateTime(:from) < toDateTime(:to)";
      await sql`INSERT INTO pulse.saved_queries(short_id,base_id,name,sql,params,pinned,created_at,updated_at)
        VALUES('RealO5',${base.id}::uuid,'Real overview',${query},'{}',true,${start},${start})`;
      const input = { ...adminFixtureIdentity(user!.id, false), baseId: base.id, scope: { id: user!.id } };
      const read = createOverviewQueries({ testOnly: { now: () => start } });
      const first = await read(input);
      expect(first).toMatchObject([
        {
          queryId: "RealO5",
          status: "ready",
          errorCode: null,
          lastGood: {
            evaluatedAt: start.toISOString(),
            windowFrom: "2026-10-19T10:00:00.000Z",
            windowTo: start.toISOString(),
            data: {
              value: 42,
              valueAt: start.toISOString(),
              unit: "ms",
              detail: "300",
              detailTone: "success",
              points: [{ x: start.getTime(), y: 42 }],
            },
          },
        },
      ]);
      expect(run).toHaveBeenCalledTimes(1);
      const second = await createOverviewQueries({ testOnly: { now: () => start } })(input);
      expect(second).toEqual(first);
      expect(run).toHaveBeenCalledTimes(1);
      expect(cached.mock.calls.length).toBeGreaterThan(0);
      expect(await sqlAdmission.cached(cached.mock.calls.at(-1)![0])).not.toBeNull();
      expect((await sqlAdmission.usage(base.id)).used).toBe(0);
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      expect(await read(input)).toEqual([]);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
      cached.mockRestore();
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("above/below, pending, escalation and recovery use actual rows; malformed or missing results never become ok", async () => {
    const base = await fixtureBase();
    try {
      await createBaseLifecycle(store)(base.id);
      for (const comparison of ["above", "below"]) {
        const ruleId = await createRule(base.id, "SELECT 'cpu' AS key, :load AS value", comparison, 300);
        const warning = comparison === "above" ? 85 : 15;
        let seconds = 0;
        const check = async (
          query: string,
          expected: { state: string; severity?: string | null; last_error?: string | null },
          load = warning,
        ) => {
          await sql`UPDATE pulse.alert_rules SET sql=${query},params=(${JSON.stringify({ load: String(load) })}::jsonb #>> '{}')::jsonb
            WHERE id=${ruleId}::uuid`;
          await execute(ruleId, new Date(start.getTime() + seconds * 1000));
          expect(await state(ruleId)).toMatchObject(expected);
          seconds += 300;
        };
        const query = "SELECT 'cpu' AS key, :load AS value";
        await check(query, { state: "pending", severity: "warn" });
        await check(query, { state: "firing", severity: "warn" });
        await check(query, { state: "firing", severity: "critical" }, comparison === "above" ? 99 : 1);
        await check(query, { state: "ok", severity: null }, 50);
        // Remove params when the replacement query has no bindings.
        const invalid = async (query: string, expected: { state: string; last_error?: string | null }) => {
          await sql`UPDATE pulse.alert_rules SET sql=${query},params='{}'::jsonb WHERE id=${ruleId}::uuid`;
          await execute(ruleId, new Date(start.getTime() + seconds * 1000));
          expect(await state(ruleId)).toMatchObject(expected);
          seconds += 300;
        };
        await invalid("SELECT 'cpu' AS key, 1 AS value WHERE 0", { state: "no_data", last_error: null });
        await invalid("SELECT 'cpu' AS key, 1 AS value FROM numbers(2)", { state: "error", last_error: "DUPLICATE_KEY" });
        await invalid("SELECT 'cpu' AS key, toFloat64('NaN') AS value", { state: "error", last_error: "INVALID_VALUE" });
        await invalid("SELECT toString(number) AS key, number AS value FROM numbers(101)", { state: "error", last_error: "TOO_MANY_KEYS" });
        await invalid("SELECT missing_column FROM samples", { state: "error", last_error: "SQL_ERROR" });
        await invalid("SELECT 'cpu' AS key, 50 AS value", { state: "ok", last_error: null });
        expect((await sqlAdmission.usage(base.id)).used).toBe(0);
        await sql`DELETE FROM pulse.alert_rules WHERE id=${ruleId}::uuid`;
      }
    } finally {
      await cleanupFixtureBase(base);
    }
  }, 45_000);
  test("occupied slots fail without queueing or quota; overdue checks do not start SQL", async () => {
    const base = await fixtureBase();
    const run = spyOn(sqlRunner, "run");
    let held: Awaited<ReturnType<typeof sqlAdmission.acquire>> | undefined;
    try {
      await createBaseLifecycle(store)(base.id);
      const ruleId = await createRule(base.id, "SELECT 'cpu' AS key, 1 AS value");
      held = await sqlAdmission.acquire({ baseId: base.id, runId: crypto.randomUUID(), quota: 600, countQuota: false });
      expect(await execute(ruleId, start)).toMatchObject({ ok: false, error: { code: "BUSY" } });
      expect(await state(ruleId)).toMatchObject({ state: "error", last_error: "BUSY" });
      expect(run).not.toHaveBeenCalled();
      await held.release();
      held = undefined;
      const overdue = new Date(start.getTime() + 900_000);
      expect(await evaluateDueAlerts("en", { now: () => overdue })).toEqual({ attempted: 1, applied: 1 });
      expect(await state(ruleId)).toMatchObject({ state: "error", last_error: "OVERDUE" });
      expect(run).not.toHaveBeenCalled();
      expect((await sqlAdmission.usage(base.id)).used).toBe(0);
    } finally {
      await held?.release();
      run.mockRestore();
      await cleanupFixtureBase(base);
    }
  }, 30_000);
  test("the Pulse ten-second deadline kills a large-profile query before its twenty-second store limit", async () => {
    const base = await fixtureBase();
    const run = spyOn(sqlRunner, "run");
    const kill = spyOn(sqlRunner, "kill");
    let pending: ReturnType<typeof execute> | undefined;
    try {
      await sql`UPDATE pulse.base_stores SET profile='large' WHERE base_id=${base.id}::uuid`;
      await createBaseLifecycle(store)(base.id);
      const sleeps = Array.from({ length: 7 }, (_, index) => `sleep(${(2 + index / 1000).toFixed(3)})`).join("+");
      const ruleId = await createRule(base.id, `SELECT 'slow' AS key, ${sleeps} AS value`);
      const started = performance.now();
      pending = execute(ruleId, start);
      await waitUntil(async () => run.mock.calls.length === 1);
      const runId = run.mock.calls[0]![0].runId;
      const queryId = sqlQueryId(base.id, runId);
      const processes = async () => {
        const rows = await clickhouseAdminQuery("SELECT count() AS n FROM system.processes WHERE query_id={q:String} AND user={u:String}", {
          params: { q: queryId, u: base.readUser },
        });
        return Number(rows[0]?.n);
      };
      await waitUntil(async () => (await processes()) === 1);
      expect(await pending).toMatchObject({ ok: false, error: { code: "TIME_LIMIT" } });
      expect(performance.now() - started).toBeLessThan(15_000);
      expect(kill).toHaveBeenCalledWith(base.id, runId);
      expect(await processes()).toBe(0);
      expect(await state(ruleId)).toMatchObject({ state: "error", last_error: "TIME_LIMIT" });
      expect((await sqlAdmission.usage(base.id)).used).toBe(0);
      await sql`UPDATE pulse.alert_rules SET sql='SELECT ''slow'' AS key, 1 AS value' WHERE id=${ruleId}::uuid`;
      expect(await execute(ruleId, new Date(start.getTime() + 300_000))).toMatchObject({ ok: true });
    } finally {
      await pending;
      run.mockRestore();
      kill.mockRestore();
      await cleanupFixtureBase(base);
    }
  }, 30_000);
});
