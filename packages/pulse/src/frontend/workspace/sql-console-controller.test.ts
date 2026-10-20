import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createSqlConsoleController, type SqlConsoleControllerOptions, consoleSqlParameterNames } from "./sql-console-controller";
import { SqlClientError, type SqlClient, type SqlResult, type SavedQuery } from "./sql-client";
import { SQL_TEST_NOW, SQL_TEST_RUN_ID, sqlTestLimits, sqlTestQuery, sqlTestResult } from "./sql-test-fixtures";
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const harness = (overrides: Partial<SqlConsoleControllerOptions> = {}, api: Partial<SqlClient> = {}) => {
  let now = SQL_TEST_NOW;
  const timers = new Set<{ at: number; run: () => void }>();
  const requests: Array<{ kind: string; input?: unknown; signal?: AbortSignal }> = [];
  const client: SqlClient = {
    run: async (_base, input, signal) => {
      requests.push({ kind: "run", input, signal });
      return sqlTestResult;
    },
    cancel: async (_base, runId, signal) => {
      requests.push({ kind: "cancel", input: runId, signal });
      return { cancelled: true };
    },
    limits: async () => {
      requests.push({ kind: "limits" });
      return sqlTestLimits;
    },
    list: async () => ({ items: [], total: 0, nextOffset: null }),
    get: async () => sqlTestQuery,
    create: async (_base, input) => {
      requests.push({ kind: "create", input });
      return { ...sqlTestQuery, ...input, params: input.params ?? {} };
    },
    update: async (_base, _id, input) => {
      requests.push({ kind: "update", input });
      return { ...sqlTestQuery, ...input, params: input.params ?? {}, revision: input.expectedRevision + 1 };
    },
    delete: async () => {
      requests.push({ kind: "delete" });
      return { deleted: true };
    },
    ...api,
  };
  const controller = createRoot((dispose) => {
    disposals.push(dispose);
    return createSqlConsoleController({
      base: { id: "Base01", name: "Betrieb" },
      initial: { limits: sqlTestLimits },
      locale: () => "de",
      newRunId: () => SQL_TEST_RUN_ID,
      clock: {
        now: () => now,
        schedule: (run, delay) => {
          const timer = { at: now + delay, run };
          timers.add(timer);
          return () => {
            timers.delete(timer);
          };
        },
      },
      ...overrides,
      client,
    });
  });
  disposals.push(controller.dispose);
  return {
    controller,
    requests,
    timers,
    advance: (ms: number) => {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
};
test("empty/ready state and parameter values survive disappearing names; scanner errors tolerate typing", () => {
  const { controller: c } = harness();
  expect(c.state()).toEqual({ kind: "empty" });
  c.setSql("SELECT :host, :base_tz, ':ignored' -- :comment");
  expect(c.parameterNames()).toEqual(["host"]);
  c.setParameter("host", "web-01");
  c.setSql("SELECT 1");
  c.setSql("SELECT :host");
  expect(c.parameterValues().host).toBe("web-01");
  expect(c.state()).toEqual({ kind: "ready" });
  c.setSql("SELECT :host, 'unfinished");
  expect(c.parameterNames()).toEqual(["host"]);
  expect(() => c.setSql("SELECT (:host")).not.toThrow();
  expect(c.parameterNames()).toEqual(["host"]);
  c.setSql('SELECT (:host, :second, "unfinished');
  expect(c.parameterNames()).toEqual(["host", "second"]);
  expect(consoleSqlParameterNames("SELECT /* unfinished")).toEqual([]);
});
test("input checks run before all transport and missing parameter exposes a focus action", async () => {
  let focused = "";
  const { controller: c, requests } = harness({
    focusParameter: (name) => {
      focused = name;
    },
  });
  c.setSql("SELECT :first, :second");
  await c.run();
  expect(c.state()).toMatchObject({ kind: "error", code: "PARAMETER_MISSING", details: { parameterName: "first" } });
  expect(c.statusBand().action?.kind).toBe("focus-parameter");
  await c.statusBand().action?.run();
  expect(focused).toBe("first");
  c.setSql("SELECT '" + "x".repeat(22_717) + "'");
  await c.run();
  expect(c.state()).toMatchObject({ code: "INPUT_TOO_LARGE" });
  expect(c.inputBytes()).toBe("22,2 von 16 KiB");
  expect(c.statusBand().message).toContain("22,2 von 16 KiB");
  c.setSql("DELETE FROM samples");
  await c.run();
  expect(c.state()).toMatchObject({ code: "SQL_ERROR" });
  expect(requests).toEqual([]);
});
test("run snapshots active params and refreshes result limits; obsolete values are never sent", async () => {
  const { controller: c, requests } = harness(
    {},
    {
      run: async (_base, input) => {
        requests.push({ kind: "run", input });
        return { ...sqlTestResult, limits: { ...sqlTestLimits, queriesUsed: 13 } };
      },
    },
  );
  c.setSql("SELECT :old");
  c.setParameter("old", "old");
  c.setSql("SELECT :host");
  c.setParameter("host", "web-01");
  await c.run();
  expect(requests[0]?.input).toEqual({ sql: "SELECT :host", params: { host: "web-01" }, runId: SQL_TEST_RUN_ID });
  expect(c.state()).toEqual({ kind: "ok" });
  expect(c.limits()?.queriesUsed).toBe(13);
  expect(c.lastResult()).toEqual({ ...sqlTestResult, limits: { ...sqlTestLimits, queriesUsed: 13 } });
});
test("cancel starts endpoint call before aborting fetch, and ignores a late successful run", async () => {
  const result = deferred<SqlResult>();
  let signal: AbortSignal | undefined;
  let cancelledId = "";
  const { controller: c } = harness(
    {},
    {
      run: async (_base, _input, abort) => {
        signal = abort;
        return result.promise;
      },
      cancel: async (_base, runId, abort) => {
        expect(signal?.aborted).toBe(false);
        expect(abort?.aborted).toBe(false);
        cancelledId = runId;
        return { cancelled: true };
      },
    },
  );
  c.setSql("SELECT 1");
  const running = c.run();
  expect(c.state()).toEqual({ kind: "running", runId: SQL_TEST_RUN_ID });
  expect(c.statusBand().action?.kind).toBe("cancel");
  await c.cancel();
  expect(cancelledId).toBe(SQL_TEST_RUN_ID);
  expect(signal?.aborted).toBe(true);
  result.resolve(sqlTestResult);
  await running;
  expect(c.state()).toMatchObject({ code: "CANCELLED" });
  expect(c.lastResult()).toBeNull();
});
test("quota blocks run until exact reset time, survives edits and leaves saving enabled", async () => {
  let runs = 0;
  const {
    controller: c,
    advance,
    requests,
  } = harness(
    {},
    {
      run: async () => {
        runs++;
        throw new SqlClientError("QUOTA", "quota", 429, { resetAt: "2026-10-20T14:32:10Z", retryAfter: 10 });
      },
    },
  );
  c.setSql("SELECT 1");
  await c.run();
  c.setSql("SELECT 2");
  expect(c.quotaBlocked()).toBe(true);
  expect(c.canRun()).toBe(false);
  expect(c.canSave()).toBe(true);
  await c.run();
  expect(runs).toBe(1);
  await c.saveAs("Query");
  expect(requests.some((request) => request.kind === "create")).toBe(true);
  advance(9999);
  expect(c.canRun()).toBe(false);
  advance(1);
  expect(c.canRun()).toBe(true);
});
test("limits GET and last permitted successful run can also activate quota; timers are cleaned", async () => {
  const {
    controller: c,
    advance,
    timers,
  } = harness({}, { limits: async () => ({ ...sqlTestLimits, queriesUsed: 600, resetAt: "2026-10-20T14:32:01Z" }) });
  await c.refreshLimits();
  expect(c.quotaBlocked()).toBe(true);
  advance(1000);
  expect(c.quotaBlocked()).toBe(false);
  c.setSql("SELECT 1");
  await c.run();
  c.dispose();
  expect(timers.size).toBe(0);
});
test("failed limits fetch offers retry, and a stale GET cannot replace run limits", async () => {
  let fails = true;
  const pending = deferred<typeof sqlTestLimits>();
  const { controller: c } = harness(
    {},
    {
      limits: async () => {
        if (fails) throw new Error("offline");
        return pending.promise;
      },
    },
  );
  await c.refreshLimits();
  expect(c.statusBand().action?.kind).toBe("retry-limits");
  fails = false;
  const loading = c.refreshLimits();
  c.setSql("SELECT 1");
  await c.run();
  pending.resolve({ ...sqlTestLimits, queriesUsed: 1 });
  await loading;
  expect(c.limits()?.queriesUsed).toBe(12);
  expect(c.limitsError()).toBeNull();
});
test("load/save/revision conflict preserve edits, with explicit reload and save-as recovery", async () => {
  let conflict = false;
  const updates: unknown[] = [];
  const { controller: c } = harness(
    {},
    {
      update: async (_base, _id, input) => {
        updates.push(input);
        if (conflict) throw new SqlClientError("CONFLICT", "stale", 409);
        return { ...sqlTestQuery, ...input, params: input.params ?? {}, revision: 3 };
      },
    },
  );
  c.loadSaved(sqlTestQuery);
  expect(c.chosenQuery()).toEqual({ id: "Qry001", name: "CPU", revision: 2, dirty: false });
  c.setParameter("host", "db-01");
  expect(c.chosenQuery()?.dirty).toBe(true);
  await c.save();
  expect(updates[0]).toMatchObject({ expectedRevision: 2, params: { host: "db-01" } });
  expect(c.chosenQuery()?.revision).toBe(3);
  expect(c.chosenQuery()?.dirty).toBe(false);
  conflict = true;
  c.setSql("SELECT 42");
  await c.save();
  expect(c.saveError()?.code).toBe("CONFLICT");
  expect(c.sql()).toBe("SELECT 42");
  expect(c.chosenQuery()?.revision).toBe(3);
  expect(c.statusBand().action?.kind).toBe("reload-saved");
  await c.saveAs("Copy");
  expect(c.chosenQuery()?.name).toBe("Copy");
  expect(c.sql()).toBe("SELECT 42");
  await c.delete();
  expect(c.chosenQuery()).toBeNull();
  expect(c.sql()).toBe("SELECT 42");
});
test("edits and selection changes during saves are preserved", async () => {
  const saving = deferred<SavedQuery>();
  const { controller: c } = harness({}, { update: () => saving.promise });
  c.loadSaved(sqlTestQuery);
  const pending = c.save();
  c.setSql("SELECT 2");
  saving.resolve({ ...sqlTestQuery, revision: 3 });
  await pending;
  expect(c.sql()).toBe("SELECT 2");
  expect(c.chosenQuery()?.dirty).toBe(true);
});
test("assistant failure/retry uses the current SQL and values without ever changing them", async () => {
  const launches: unknown[] = [];
  const { controller: c } = harness({
    launchAssistant: async (input) => {
      launches.push(input);
      throw new Error("offline");
    },
  });
  c.loadSaved(sqlTestQuery);
  await c.launchAssistant();
  expect(c.assistantState()).toBe("failed");
  expect(c.statusBand().action?.kind).toBe("retry-assistant");
  c.setParameter("host", "db-01");
  await c.retryAssistant();
  expect(launches[1]).toMatchObject({ sql: sqlTestQuery.sql, params: { host: "db-01" }, queryName: "CPU", locale: "de" });
  expect(c.sql()).toBe(sqlTestQuery.sql);
});
test("limits text uses locale grouping and retains all queue budgets", () => {
  const { controller: c } = harness();
  expect(c.limitsLine()).toBe(
    "Profil normal: 2 GB, 10 s · 10.000 Zeilen oder 4 MiB · 12 von 600 Abfragen diese Stunde · Warteschlange 1 pro Base, 3 pro Cloud, 20 wartend, 5 s",
  );
});

test("every run error code has a localized band and retry keeps SQL intact", async () => {
  const codes = [
    "SQL_ERROR",
    "TIME_LIMIT",
    "MEMORY_LIMIT",
    "RESULT_TOO_LARGE",
    "BUSY",
    "QUEUE_FULL",
    "STORE_UNAVAILABLE",
    "NO_READ_ACCESS",
    "CANCELLED",
  ];
  for (const code of codes) {
    let attempts = 0;
    const { controller: c } = harness(
      {},
      {
        run: async () => {
          attempts++;
          if (attempts === 1) throw new SqlClientError(code, "diagnostic", 400, { line: 3, column: 2 });
          return sqlTestResult;
        },
      },
    );
    c.setSql("SELECT 1");
    await c.run();
    expect(c.state()).toMatchObject({ code, message: "diagnostic", details: { line: 3, column: 2 } });
    expect(c.statusBand().message).not.toBe("REQUEST_FAILED");
    await c.retry();
    expect(c.state()).toEqual({ kind: "ok" });
    expect(c.sql()).toBe("SELECT 1");
  }
});
test("quota fallback uses Retry-After and expired quota never blocks", async () => {
  const { controller: c, advance } = harness(
    {},
    {
      run: async () => {
        throw new SqlClientError("QUOTA", "quota", 429, { retryAfter: 2 });
      },
    },
  );
  c.setSql("SELECT 1");
  await c.run();
  expect(c.quotaResetAt()).toBe("2026-10-20T14:32:02.000Z");
  advance(2000);
  expect(c.canRun()).toBe(true);
});
test("failed cancel surfaces recovery and late run rejection cannot erase it", async () => {
  const pending = deferred<SqlResult>();
  const { controller: c } = harness(
    {},
    {
      run: () => pending.promise,
      cancel: async () => {
        throw new Error("offline");
      },
    },
  );
  c.setSql("SELECT 1");
  const run = c.run();
  await c.cancel();
  expect(c.state()).toMatchObject({ code: "REQUEST_FAILED" });
  pending.reject(new DOMException("abort", "AbortError"));
  await run;
  expect(c.state()).toMatchObject({ code: "REQUEST_FAILED" });
});
test("successful last-budget run blocks the next run and preserves the result", async () => {
  const { controller: c, advance } = harness(
    {},
    { run: async () => ({ ...sqlTestResult, limits: { ...sqlTestLimits, queriesUsed: 600, resetAt: "2026-10-20T14:32:01Z" } }) },
  );
  c.setSql("SELECT 1");
  await c.run();
  expect(c.canRun()).toBe(false);
  expect(c.lastResult()?.rowCount).toBe(1);
  advance(1000);
  expect(c.canRun()).toBe(true);
});

import { sqlConsoleInitialState } from "./sql-console-controller";
import { readWorkspacePathState, buildPulseWorkspaceHref } from "./routes";
test("SSR and browser derive identical initial SQL/query/values from a reloadable URL", () => {
  const route = readWorkspacePathState(
    buildPulseWorkspaceHref({ baseId: "Base01", state: { view: "sql", queryId: "Qry001", params: { host: "db-01" }, settings: "usage" } }),
    "Base01",
  );
  const initial = sqlConsoleInitialState(route, { query: sqlTestQuery, limits: sqlTestLimits, error: null });
  const { controller: c } = harness({ initial });
  expect(c.sql()).toBe(sqlTestQuery.sql);
  expect(c.parameterValues()).toEqual({ host: "db-01" });
  expect(c.chosenQuery()).toMatchObject({ id: "Qry001", revision: 2, dirty: true });
  const empty = sqlConsoleInitialState(readWorkspacePathState("/app/pulse/Base01/sql", "Base01"));
  expect(empty).toMatchObject({ sql: "", params: {}, query: null });
});

test("SSR limits failures can be retried without running SQL", async () => {
  const { controller: c, requests } = harness({ initial: { sql: "SELECT 1", error: { code: "STORE_UNAVAILABLE", details: {} } } });
  expect(c.statusBand().message).toBe("Pulse erreicht den Datenspeicher nicht");
  expect(c.statusBand().action?.kind).toBe("retry-limits");
  await c.statusBand().action?.run();
  expect(requests.map((request) => request.kind)).toEqual(["limits"]);
  expect(c.statusBand()).toEqual({ kind: "neutral", message: "Bereit" });
});

test("a GET started during a run cannot overwrite its newer limits snapshot", async () => {
  const runResult = deferred<SqlResult>();
  const getResult = deferred<typeof sqlTestLimits>();
  const { controller: c } = harness({}, { run: () => runResult.promise, limits: () => getResult.promise });
  c.setSql("SELECT 1");
  const running = c.run();
  const refreshing = c.refreshLimits();
  runResult.resolve({ ...sqlTestResult, limits: { ...sqlTestLimits, queriesUsed: 13 } });
  await running;
  getResult.resolve({ ...sqlTestLimits, queriesUsed: 12 });
  await refreshing;
  expect(c.limits()?.queriesUsed).toBe(13);
  expect(c.limitsLoading()).toBe(false);
});
