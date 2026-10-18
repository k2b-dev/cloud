import { expect, spyOn, test } from "bun:test";
import * as zlib from "node:zlib";
import { toJSON } from "seroval";
import { Api } from "../../../../scripts/perf-baseline/seed";
import type { MailDetailErrors } from "../../src/service/workspace";
import {
  assertRunUrl,
  capturePlan,
  combineDatabase,
  emptySample,
  finalizeSample,
  monotonicMs,
  parseServerTiming,
  postgresArgs,
  postgresLog,
  propsBytes,
  request,
  slowestPlan,
} from "./measure";
import { type DatabaseMeasurement, scenarioSchema } from "./model";

const island = (props: unknown, tag = "solid-island") =>
  `<${tag} data-id="built-entry" data-props="${Bun.escapeHTML(JSON.stringify(toJSON(props)))}"></${tag}>`;
function pageResponse(html: string) {
  const response = new Response(`<html><body>${html}</body></html>`, { headers: { "server-timing": "ssr_data;dur=3.5" } });
  Object.defineProperty(response, "url", { value: "https://localhost:4100/app/mail/mailbox" });
  return response;
}

test("request records timings and raw bytes; finalization alone compresses and inspects props, once", async () => {
  const api = new Api("https://localhost:4100", new AbortController().signal);
  const props = { data: { listError: null, detailErrors: { comments: null } }, text: "ä & <text>" };
  const html = `<html><body>${island(props)}</body></html>`;
  const json = '{"listError":null}';
  const expectedBrotli = [html, json].map((body) => zlib.brotliCompressSync(body).length);
  const response = spyOn(api, "response")
    .mockResolvedValueOnce(pageResponse(island(props)))
    .mockResolvedValueOnce(new Response(json));
  const compression = spyOn(zlib, "brotliCompressSync");
  const inspection = spyOn(HTMLRewriter.prototype, "transform");
  const clock = spyOn(performance, "now");
  for (const time of [10, 15, 30, 40, 47, 60]) clock.mockReturnValueOnce(time);
  const sample = emptySample();
  try {
    await request(api, sample, "/app/mail/mailbox", undefined, true);
    await request(api, sample, "/workspace");
    expect(compression).not.toHaveBeenCalled();
    expect(inspection).not.toHaveBeenCalled();
    expect(sample.requests).toMatchObject([
      {
        status: 200,
        totalMs: 20,
        ttfbMs: 5,
        rawBytes: Buffer.byteLength(html),
        brotliBytes: 0,
        propsBytes: 0,
        serverTiming: { ssr_data: 3.5 },
      },
      { status: 200, totalMs: 20, ttfbMs: 7, rawBytes: Buffer.byteLength(json), brotliBytes: 0, propsBytes: 0 },
    ]);
    await finalizeSample(sample);
    expect(compression).toHaveBeenCalledTimes(2);
    expect(inspection).toHaveBeenCalledTimes(1);
    expect(sample.requests.map((r) => r.brotliBytes)).toEqual(expectedBrotli);
    expect(sample.requests.map((r) => r.propsBytes)).toEqual([Buffer.byteLength(JSON.stringify(toJSON(props))), 0]);
    for (const key of ["totalMs", "ttfbMs", "rawBytes", "brotliBytes", "propsBytes"] as const)
      expect(sample[key]).toBe(sample.requests.reduce((sum, r) => sum + r[key], 0));
    await finalizeSample(sample);
    expect(compression).toHaveBeenCalledTimes(2);
    expect(inspection).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
    inspection.mockRestore();
    compression.mockRestore();
    response.mockRestore();
  }
});

test("SSR finalization rejects partial failures in MailWorkspace.data and MailOverview.initialDetail on every island", async () => {
  const api = new Api("https://localhost:4100", new AbortController().signal);
  let html = "";
  const response = spyOn(api, "response").mockImplementation(async () => pageResponse(html));
  try {
    for (const tag of ["solid-island", "solid-client"]) {
      for (const prop of ["data", "initialDetail"]) {
        for (const error of [
          { listError: "List unavailable" },
          { detailError: "Detail unavailable" },
          { collaborationError: "Collaboration unavailable" },
          { detailErrors: { comments: null, summary: "Summary unavailable" } },
          { detailErrors: { comments: "" } },
        ]) {
          // A healthy first island must not hide the next one's failure.
          html = island({ unrelated: true }) + island({ [prop]: error }, tag);
          const sample = emptySample();
          await request(api, sample, "/app/mail/mailbox", undefined, true);
          await expect(finalizeSample(sample)).rejects.toThrow("partial read failure");
          // Even a failed inspection releases its retained body.
          const before = structuredClone(sample);
          await finalizeSample(sample);
          expect(sample).toEqual(before);
        }
      }
    }
    html = island({ data: { listError: null, detailErrors: { summary: null } } }) + island({ initialDetail: null });
    const sample = emptySample();
    await request(api, sample, "/app/mail/mailbox", undefined, true);
    await finalizeSample(sample);
    expect(sample.propsBytes).toBeGreaterThan(0);
    html = '<solid-island data-props="globalThis.mailPerfEvaluated=true"></solid-island>';
    const malformed = emptySample();
    await request(api, malformed, "/app/mail/mailbox", undefined, true);
    await expect(finalizeSample(malformed)).rejects.toThrow();
    expect(Reflect.get(globalThis, "mailPerfEvaluated")).toBeUndefined();
  } finally {
    response.mockRestore();
  }
});

test("database attribution sums action windows and weights statement means across cold and warm runs", () => {
  const window = (calls: number, totalMs: number, windowMs: number): DatabaseMeasurement => ({
    windowMs,
    calls,
    totalMs,
    callsPerRun: calls,
    msPerRun: totalMs,
    statements: [{ query: "SELECT 1", queryid: "1", calls, totalMs, meanMs: totalMs / calls, rows: calls, hits: calls, reads: 0 }],
  });
  const windows = [window(1, 10, 20), window(3, 60, 80)];
  const before = structuredClone(windows);
  expect(combineDatabase(windows, 2)).toEqual({
    windowMs: 100,
    calls: 4,
    totalMs: 70,
    callsPerRun: 2,
    msPerRun: 35,
    statements: [{ query: "SELECT 1", queryid: "1", calls: 4, totalMs: 70, meanMs: 17.5, rows: 4, hits: 4, reads: 0 }],
  });
  expect(windows).toEqual(before);
});

test("host clients refuse other ports, hosts and databases", () => {
  expect(assertRunUrl("postgresql://ipa:ipa@127.0.0.1:4211/cloud_perf_test", 4211, "postgresql:", "cloud_perf_test")).toContain(":4211/");
  for (const url of [
    "postgresql://127.0.0.1:3000/cloud_perf_test",
    "postgresql://localhost:4211/cloud_perf_test",
    "postgresql://127.0.0.1:4212/cloud_perf_test",
    "postgresql://127.0.0.1:4211/cloud_dev",
    "postgresql://db:4211/cloud_perf_test",
  ])
    expect(() => assertRunUrl(url, 4211, "postgresql:", "cloud_perf_test")).toThrow();
});
test("SSR counts decoded props bytes and Server-Timing phases", async () => {
  expect(
    await propsBytes(
      '<solid-island data-props="{&quot;x&quot;:&quot;ä&quot;}"></solid-island><solid-client data-props="abc"></solid-client>',
    ),
  ).toBe(Buffer.byteLength('{"x":"ä"}') + 3);
  expect(parseServerTiming("auth;dur=1.25, ssr_data;dur=3.5")).toEqual({ auth: 1.25, ssr_data: 3.5 });
});
test("jsonlog parser prefers matched plans, drops the observer role, and counts corrupt entries", async () => {
  const log = await Bun.file(new URL("../../test/fixtures/auto-explain.jsonlog", import.meta.url)).text();
  const query = "SELECT * FROM mail.conversations WHERE id = $1 AND work_status = 'needs_action'";
  // The statement normalizes the literal to $2; attribution uses its bigint ID.
  const statement = { query: "SELECT * FROM mail.conversations WHERE id = $1 AND work_status = $2", queryid: "-9007199254740993" };
  const result = slowestPlan(log, [statement]);
  expect(result).toMatchObject({
    plan: { query, matched: true, durationMs: 20, node: "Index Scan", hits: 12, reads: 2 },
    unparsedPlans: 1,
  });
  expect(slowestPlan(log, [])).toMatchObject({
    plan: { query: "SELECT * FROM auth.users", matched: false, durationMs: 90 },
    unparsedPlans: 1,
  });
  expect(slowestPlan(JSON.stringify({ message: "database system is ready to accept connections" }), [])).toEqual({
    plan: null,
    unparsedPlans: 0,
  });
  expect(slowestPlan(JSON.stringify({ user_name: "ipa", message: "duration: 4 ms plan: {broken" }), [])).toEqual({
    plan: null,
    unparsedPlans: 1,
  });
});

test("plan matching distinguishes adjacent bigint IDs and uses statements beyond the displayed top 20", () => {
  const record = (queryid: string, duration: number) =>
    JSON.stringify({
      user_name: "ipa",
      message: `duration: ${duration} ms plan:\n{"Query Text":"SELECT 1", "Query Identifier":${queryid}, "Plan":{"Node Type":"Result","Actual Total Time":${duration}}}`,
    }) + "\n";
  const statements = Array.from({ length: 20 }, (_, i) => ({ queryid: String(i + 1) }));
  statements.push({ queryid: "9007199254740993" });
  expect(slowestPlan(record("9007199254740992", 90) + record("9007199254740993", 12), statements).plan).toMatchObject({
    query: "SELECT 1",
    durationMs: 12,
    matched: true,
  });
  const withoutId = JSON.stringify({
    message: 'duration: 10 ms plan: {"Query Text":"SELECT 1","Plan":{"Node Type":"Result","Actual Total Time":10}}',
  });
  expect(slowestPlan(withoutId, statements)).toMatchObject({ plan: { matched: false }, unparsedPlans: 0 });
});

test("a missing or failed plan capture preserves successful timings and attribution", async () => {
  for (const fail of [false, true]) {
    const scenario = scenarioSchema.parse({
      id: "detail-small",
      group: "Details",
      status: "ok",
      errors: [],
      notes: [],
      samples: [emptySample()],
      metrics: { totalMs: { cold: 10, median: 20, p95: 30 } },
      database: { windowMs: 100, calls: 2, callsPerRun: 1, totalMs: 10, msPerRun: 5, statements: [] },
      plan: null,
    });
    const before = structuredClone(scenario);
    await capturePlan(scenario, async () => {
      if (fail) throw new Error("jsonlog read failed");
      return { plan: null, unparsedPlans: 1 };
    });
    expect(scenario).toMatchObject({
      status: "ok",
      metrics: before.metrics,
      samples: before.samples,
      database: before.database,
      errors: [],
    });
    expect(scenario.planError).toContain(fail ? "jsonlog read failed" : "no request plan");
    expect(scenario.unparsedPlans).toBe(fail ? 0 : 1);
  }
});

test("host performance clock is comparable between parent and short-lived child processes", async () => {
  const before = monotonicMs();
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", 'import { monotonicMs } from "./measure.ts"; console.log(monotonicMs())'],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const after = monotonicMs();
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const reading = Number(stdout.trim());
  expect(reading).toBeGreaterThanOrEqual(before);
  expect(reading).toBeLessThanOrEqual(after);
});

test("request rejects HTTP 200 workspace list and detail partial failures, including empty errors", async () => {
  const api = new Api("https://localhost:4100", new AbortController().signal);
  const detailErrors: MailDetailErrors = {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
    keep: null,
    reference: null,
    summary: null,
    drafts: null,
  };
  const healthy = { listError: null, draftsError: null, scheduledError: null, detailError: null, collaborationError: null, detailErrors };
  let body: unknown = healthy;
  const response = spyOn(api, "response").mockImplementation(async () => new Response(JSON.stringify(body)));
  try {
    expect(await request(api, emptySample(), "/workspace-detail/thread")).toEqual(healthy);
    for (const key of ["listError", "draftsError", "scheduledError", "detailError", "collaborationError"]) {
      body = { ...healthy, [key]: "partial failure" };
      await expect(request(api, emptySample(), "/workspace-detail/thread")).rejects.toThrow("partial read failure");
    }
    for (const key of Object.keys(detailErrors)) {
      body = { ...healthy, detailErrors: { ...detailErrors, [key]: "partial failure" } };
      await expect(request(api, emptySample(), "/workspace-detail/thread")).rejects.toThrow("partial read failure");
    }
    body = { ...healthy, detailErrors: { ...detailErrors, summary: "" } };
    await expect(request(api, emptySample(), "/workspace-detail/thread")).rejects.toThrow("partial read failure");
  } finally {
    response.mockRestore();
  }
});

test("explain threshold remains reloadable while other requested server instrumentation is enabled", () => {
  expect(postgresArgs).toContain("shared_preload_libraries=pg_stat_statements,auto_explain");
  expect(postgresArgs).toContain("pg_stat_statements.track=all");
  expect(postgresArgs).toContain("compute_query_id=on");
  expect(postgresArgs).toContain("auto_explain.log_analyze=on");
  expect(postgresArgs).toContain("auto_explain.log_buffers=on");
  expect(postgresArgs).toContain("auto_explain.log_verbose=on");
  expect(postgresArgs).not.toContain("auto_explain.log_min_duration=-1");
  for (const setting of [
    "logging_collector=on",
    "log_destination=jsonlog",
    "log_directory=/var/lib/postgresql/data/perf-logs",
    "log_filename=mail-perf.log",
    "log_rotation_age=0",
    "log_rotation_size=0",
  ])
    expect(postgresArgs).toContain(setting);
  expect(postgresLog).toBe("/var/lib/postgresql/data/perf-logs/mail-perf.json");
});

test("combined windows merge one statement by query id even when its recorded text differs", () => {
  const statement = (query: string, totalMs: number) => ({
    queryid: "42",
    query,
    calls: 1,
    totalMs,
    meanMs: totalMs,
    rows: 1,
    hits: 1,
    reads: 0,
  });
  const window = (query: string, totalMs: number) => ({
    windowMs: 10,
    calls: 1,
    totalMs,
    callsPerRun: 1,
    msPerRun: totalMs,
    statements: [statement(query, totalMs)],
  });
  const combined = combineDatabase([window("SELECT $1 FROM t", 30), window("SELECT 1 FROM t", 10)], 2);
  expect(combined.statements).toHaveLength(1);
  expect(combined.statements[0]).toMatchObject({ queryid: "42", calls: 2, totalMs: 40, meanMs: 20 });
});
