import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDomTestHarness } from "../../../ui/test/dom";
import { errorsKey, installInteractionProbe, watchKey } from "./browser";
import {
  type BrowserSection,
  interactionIds,
  interactionRequestSchema,
  interactionRequestSizes,
  interactionRequestTiming,
  interactionResultSchema,
  interactionSample,
  interactionSampleSchema,
  interactions,
  interactionTraceBreakdown,
  islandRenderMs,
  loadSampleSchema,
  rankBottlenecks,
  renderBottlenecks,
  summarizeInteraction,
  summarizeLoads,
  syncMark,
  timeMetrics,
  traceBreakdown,
  unionLength,
} from "./browser-model";
import { exampleResult } from "./example-result";
import { parseArgs, parsePrevious, renderSummary, resultSchema } from "./model";
import { rankFromFiles } from "./rank";

const repository = join(import.meta.dir, "../../../..");
afterEach(() => setSystemTime());

test("browser flags: engines, runs and the rank mode", () => {
  expect(parseArgs([])).toMatchObject({ browsers: [], browserRuns: 3, rank: undefined, bottlenecks: undefined });
  expect(parseArgs(["--browser", "chromium,webkit", "--browser-runs", "5"])).toMatchObject({
    browsers: ["chromium", "webkit"],
    browserRuns: 5,
  });
  expect(parseArgs(["--browser", "webkit"]).browsers).toEqual(["webkit"]);
  expect(parseArgs(["--browser-only", "--browser", "webkit"])).toMatchObject({ browserOnly: true, browsers: ["webkit"] });
  expect(() => parseArgs(["--browser-only"])).toThrow("--browser-only requires --browser");
  expect(() => parseArgs(["--browser", "firefox"])).toThrow();
  expect(() => parseArgs(["--browser", "chromium,chromium"])).toThrow("duplicates");
  expect(() => parseArgs(["--browser"])).toThrow("Missing value for --browser");
  expect(() => parseArgs(["--browser-runs", "0"])).toThrow("--browser-runs must be 1..20");
  expect(() => parseArgs(["--browser-runs", "21"])).toThrow("--browser-runs must be 1..20");
  expect(parseArgs(["--rank", "r.json", "--bottlenecks", "b.json"])).toMatchObject({ rank: "r.json", bottlenecks: "b.json" });
  expect(() => parseArgs(["--rank", "r.json"])).toThrow("--rank and --bottlenecks go together");
  expect(() => parseArgs(["--rank", "r.json", "--bottlenecks", "b.json", "--browser", "chromium"])).toThrow("starts nothing");
});

test("browser selection defaults to all, accepts focused runs, and rejects invalid or repeated ids", () => {
  expect(parseArgs([])).toMatchObject({ interactions: interactionIds, loads: ["mailbox", "compose"] });
  expect(parseArgs(["--interactions", "mailbox-switch,folder-switch", "--loads", "none"])).toMatchObject({
    interactions: ["mailbox-switch", "folder-switch"],
    loads: [],
  });
  expect(parseArgs(["--loads", "compose"]).loads).toEqual(["compose"]);
  expect(parseArgs(["--loads", "compose,mailbox"]).loads).toEqual(["compose", "mailbox"]);
  expect(parseArgs(["--interactions", "mailbox-switch,folder-switch,folder-switch-full", "--loads", "none"])).toMatchObject({
    interactions: ["mailbox-switch", "folder-switch", "folder-switch-full"],
    loads: [],
  });
  for (const args of [
    ["--interactions", "unknown"],
    ["--interactions", "folder-switch,folder-switch"],
    ["--interactions", ""],
    ["--interactions"],
    ["--loads", "none,mailbox"],
    ["--loads", "mailbox,mailbox"],
    ["--loads", "unknown"],
    ["--loads", ""],
    ["--loads"],
  ])
    expect(() => parseArgs(args)).toThrow();
  expect(interactions.filter((entry) => "trace" in entry && entry.trace).map((entry) => entry.id)).toEqual([
    "mailbox-switch",
    "folder-switch",
    "folder-switch-full",
  ]);
});

const request = (path: string, bytes: number) => ({
  method: "GET",
  path,
  type: "fetch",
  status: 200,
  encoding: "identity",
  bytes,
  failure: null,
});

test("interaction requests require an encoding string or null", () => {
  const entry = request("/api/mail/x", 1000);
  expect(interactionRequestSchema.parse(entry).encoding).toBe("identity");
  expect(interactionRequestSchema.parse({ ...entry, encoding: "gzip" }).encoding).toBe("gzip");
  expect(interactionRequestSchema.parse({ ...entry, status: null, encoding: null, bytes: 0, failure: "failed" }).encoding).toBeNull();
  const { encoding: _, ...missing } = entry;
  expect(interactionRequestSchema.safeParse(missing).success).toBe(false);
  expect(interactionRequestSchema.safeParse({ ...entry, encoding: 1 }).success).toBe(false);
});

test("interaction samples count API requests and bytes and reject incomplete entries", () => {
  const sample = interactionSample(123.456, [request("/api/mail/x", 1000), request("/_ssr/a.js", 500), request("/api/mail/y", 24)]);
  expect(sample).toEqual({
    durationMs: 123.5,
    requests: expect.any(Array),
    apiRequests: 2,
    apiBytes: 1024,
    totalBytes: 1524,
  });
  expect(() => interactionSample(-1, [])).toThrow();
  expect(
    interactionSampleSchema.safeParse({ ...sample, requests: [{ method: "GET", path: "/api", type: "fetch", status: 200, failure: null }] })
      .success,
  ).toBe(false);
  expect(interactionSampleSchema.safeParse({ ...sample, durationMs: Number.NaN }).success).toBe(false);
  expect(interactionResultSchema.safeParse({ id: "unknown", profiles: [] }).success).toBe(false);
  expect(interactionIds).toEqual([
    "mailbox-switch",
    "folder-switch",
    "folder-switch-full",
    "conversation-open",
    "conversation-open-large",
    "list-scroll",
    "search-submit",
    "live-arrival",
    "compose-open",
  ]);
  const summary = summarizeInteraction([10, 40, 20, 30].map((ms) => interactionSample(ms, [request("/api/a", ms)])));
  expect(summary).toEqual({ durationMs: { median: 25, p95: 40, min: 10, max: 40 }, apiRequests: 1, apiBytes: 25 });
  expect(() => summarizeInteraction([])).toThrow();
});

test("cached request bodies with unavailable sizes do not discard an interaction or invent encoded bytes", () => {
  for (const [sizes, expected] of [
    [
      { responseBodySize: 1000, responseHeadersSize: 100 },
      { bytes: 1100, encodedBytes: 1000 },
    ],
    [{ responseBodySize: -1, responseHeadersSize: 100 }, { bytes: 100 }],
    [
      { responseBodySize: 0, responseHeadersSize: -1 },
      { bytes: 0, encodedBytes: 0 },
    ],
    [null, { bytes: 0 }],
  ] as const) {
    const measured = { ...request("/app/mail/Bbb002", 0), type: "document", ...interactionRequestSizes(sizes) };
    const sample = interactionSample(100, [measured], "/app/mail/Bbb002");
    expect(sample.mainRequest).toMatchObject(expected);
    expect(summarizeInteraction([sample]).encodedBytes).toBe("encodedBytes" in expected ? expected.encodedBytes : undefined);
  }
});

test("main requests and timing cover document and in-place mailbox switches without counting unrelated requests", () => {
  expect(interactionRequestTiming({ requestStart: 20, responseStart: 70, responseEnd: 90 })).toEqual({ serverMs: 50, transferMs: 20 });
  for (const timing of [
    { requestStart: -1, responseStart: 70, responseEnd: 90 },
    { requestStart: 20, responseStart: -1, responseEnd: -1 },
    { requestStart: 20, responseStart: 70, responseEnd: -1 },
  ])
    expect(interactionRequestTiming(timing)).toEqual({});
  for (const main of [
    { ...request("/app/mail/Bbb002", 1100), type: "document" },
    request("/api/mail/mailboxes/Bbb002/workspace-route?href=%2Fapp%2Fmail%2FBbb002", 1100),
    request("/api/mail/mailboxes/Bbb002/workspace-list?href=%2Fapp%2Fmail%2FBbb002", 1100),
  ]) {
    const measured = { ...main, encoding: "br", encodedBytes: 1000, serverMs: 50, transferMs: 20 };
    const sample = interactionSample(
      100,
      [
        request("/api/mail/mailboxes/Aaa001/workspace-route?href=x", 1),
        request("/api/mail/mailboxes/Bbb002/workspace-route-extra?href=x", 1),
        { ...measured, failure: "cancelled" },
        { ...measured, method: "POST" },
        measured,
      ],
      "/app/mail/Bbb002",
    );
    expect(sample.mainRequest).toEqual(measured);
    expect(summarizeInteraction([sample])).toMatchObject({ serverMs: 50, transferMs: 20, encodedBytes: 1000 });
  }
  expect(interactionSample(100, [request("/app/mail/Aaa001", 1)], "/app/mail/Bbb002").mainRequest).toBeUndefined();
  const legacy = interactionSample(100, [request("/api/mail/x", 1)]);
  expect(legacy.mainRequest).toBeUndefined();
  expect(summarizeInteraction([legacy]).serverMs).toBeUndefined();
});

test("interaction traces follow frame renderer changes and partition nested tasks only inside the action window", () => {
  const event = (name: string, start: number, duration: number, pid = 1, tid = 7) => ({
    name,
    ph: "X",
    pid,
    tid,
    ts: 1_000_000 + start * 1000,
    dur: duration * 1000,
  });
  const thread = (pid: number, tid = 7) => ({ name: "thread_name", ph: "M", ts: 0, pid, tid, args: { name: "CrRendererMain" } });
  const data = {
    traceEvents: [
      { name: syncMark, cat: "blink.user_timing", ph: "R", pid: 1, tid: 7, ts: 1_000_000 },
      thread(1),
      thread(2, 9),
      thread(3),
      thread(2, 10),
      {
        name: "TracingStartedInBrowser",
        ph: "I",
        ts: 0,
        pid: 0,
        tid: 0,
        args: {
          data: {
            frames: [
              { frame: "page", processId: 1 },
              { frame: "other", processId: 3 },
            ],
          },
        },
      },
      { name: "FrameCommittedInBrowser", ph: "I", ts: 1_050_000, pid: 0, tid: 0, args: { data: { frame: "page", processId: 2 } } },
      event("RunTask", 0, 50),
      event("FunctionCall", 10, 30),
      event("v8.compile", 15, 5),
      event("RecalcStyle", 20, 10),
      event("RunTask", 60, 80, 2, 9),
      event("EvaluateScript", 60, 80, 2, 9),
      event("Layout", 80, 10, 2, 9),
      event("v8.parse", 90, 10, 2, 9),
      event("RunTask", 0, 200, 3),
      event("Layout", 0, 200, 3),
      event("RunTask", 150, 10, 2, 10),
    ],
  };
  const timing: Parameters<typeof interactionTraceBreakdown>[1] = {
    markTimeMs: 0,
    actionAt: 10,
    hitAt: 130,
    mountWindows: [
      [65, 75],
      [70, 80],
    ],
    frameIds: ["page"],
  };
  const trace = interactionTraceBreakdown(data, timing);
  expect(trace).toMatchObject({
    totalMs: 120,
    busyMs: 110,
    scriptMs: 50,
    parseCompileMs: 15,
    styleLayoutMs: 20,
    islandRenderMs: 15,
    otherMs: 10,
  });
  expect(trace.scriptShare + trace.parseCompileShare + trace.styleLayoutShare + trace.islandRenderShare + trace.otherShare).toBeCloseTo(
    1,
    3,
  );
  const concurrent = { traceEvents: [...data.traceEvents, event("RunTask", 70, 5)] };
  expect(interactionTraceBreakdown(concurrent, timing)).toEqual(trace);
  const epoch = 1_800_000_000_000;
  expect(
    interactionTraceBreakdown(data, {
      ...timing,
      markTimeMs: epoch,
      actionAt: epoch + 10,
      hitAt: epoch + 130,
      mountWindows: [
        [epoch + 65, epoch + 75],
        [epoch + 70, epoch + 80],
      ],
    }),
  ).toEqual(trace);
  expect(interactionTraceBreakdown(data, { ...timing, mountWindows: [] })).toMatchObject({ islandRenderMs: 0, scriptMs: 65 });
  const child = {
    name: "FrameCommittedInBrowser",
    ph: "I",
    ts: 1_050_000,
    pid: 0,
    tid: 0,
    args: { data: { frame: "child", parent: "page", processId: 4 } },
  };
  const withChild = { traceEvents: [...data.traceEvents, child, thread(4), event("RunTask", 50, 10, 4)] };
  expect(interactionTraceBreakdown(withChild, timing)).toMatchObject({ busyMs: 120, otherMs: 20 });
  expect(() => interactionTraceBreakdown({ traceEvents: [] }, timing)).toThrow(syncMark);
  expect(() => interactionTraceBreakdown(data, { ...timing, actionAt: 200, hitAt: 210 })).toThrow("no page main-thread tasks");
});

test("unions clip and merge intervals; island render time counts overlapping mounts once", () => {
  expect(
    unionLength(
      [
        [0, 10],
        [5, 15],
        [20, 30],
        [-5, 2],
      ],
      0,
      25,
    ),
  ).toBe(20);
  expect(islandRenderMs({ mountStarts: [10, 12, 50], mountTimes: [20, 18, 60], tti: 55 })).toBe(15);
  expect(() => islandRenderMs({ mountStarts: [1], mountTimes: [], tti: 5 })).toThrow();
});

test("trace breakdown aligns trace time with page time and reads only the page's main thread", () => {
  const mark = { name: syncMark, cat: "blink.user_timing", ph: "R", pid: 1, tid: 7, ts: 1_000_000 + 500_000 };
  // Page time 0 is trace 1_000_000 µs because the mark at page 500 ms sits at 1_500_000 µs.
  const x = (name: string, startMs: number, durMs: number, tid = 7) => ({
    name,
    cat: "devtools.timeline",
    ph: "X",
    pid: 1,
    tid,
    ts: 1_000_000 + startMs * 1000,
    dur: durMs * 1000,
  });
  const trace = {
    traceEvents: [
      mark,
      x("RunTask", 0, 100),
      x("RunTask", 150, 100),
      x("RunTask", 260, 100),
      x("v8.compile", 10, 20),
      x("v8.compileModule", 15, 10),
      x("UpdateLayoutTree", 160, 10),
      x("Layout", 170, 30),
      x("Layout", 290, 50),
      x("RunTask", 0, 500, 9),
      x("Layout", 0, 500, 9),
      { name: "metadata", ph: "M", pid: 1, tid: 7, ts: 0 },
    ],
  };
  expect(traceBreakdown(trace, { markTimeMs: 500, tti: 300, mountStarts: [150], mountTimes: [200] })).toEqual({
    busyMs: 240,
    islandRenderMs: 50,
    styleLayoutMs: 50,
    parseCompileMs: 20,
    islandRenderShare: 0.2083,
    styleLayoutShare: 0.2083,
    parseCompileShare: 0.0833,
  });
  expect(() => traceBreakdown({ traceEvents: [] }, { markTimeMs: 0, tti: 1, mountStarts: [], mountTimes: [] })).toThrow(syncMark);
  expect(() => traceBreakdown([mark], { markTimeMs: 500, tti: 300, mountStarts: [], mountTimes: [] })).toThrow("no main-thread tasks");
});

function browserSection(): BrowserSection {
  const loadSample = {
    documentBytes: 1000,
    documentTransferMs: 120,
    jsBytes: 300_000,
    cssBytes: 1000,
    otherBytes: 0,
    documentRequests: 1,
    jsRequests: 20,
    cssRequests: 1,
    otherRequests: 0,
    requests: 22,
    fcpMs: 400,
    lcpMs: 500,
    cls: 0,
    ttiMs: 1800,
    lastLongTaskEndMs: 1700,
    totalBlockingTimeMs: 300,
    islandMountEndMs: 1600,
    islandRenderMs: 250,
    longTaskCount: 3,
    longTaskMs: 420,
  };
  return {
    engines: ["chromium", "webkit"],
    versions: { chromium: "140", webkit: "26" },
    playwrightVersion: "1.63.0",
    runs: 1,
    pages: [
      {
        id: "mailbox",
        path: "/app/mail/Mbx001",
        errors: [],
        static: null,
        profiles: [
          {
            browser: "chromium",
            profile: "phone",
            status: "ok",
            reason: null,
            documentEncoding: ["identity"],
            samples: [loadSample],
            metrics: summarizeLoads([loadSample]),
            trace: {
              busyMs: 1000,
              islandRenderMs: 250,
              styleLayoutMs: 100,
              parseCompileMs: 80,
              islandRenderShare: 0.25,
              styleLayoutShare: 0.1,
              parseCompileShare: 0.08,
            },
            traceError: null,
          },
          {
            browser: "webkit",
            profile: "desktop",
            status: "skipped",
            reason: "connect ECONNREFUSED",
            documentEncoding: [],
            samples: [],
            metrics: null,
            trace: null,
            traceError: null,
          },
        ],
      },
    ],
    interactions: [
      {
        id: "folder-switch",
        profiles: [
          {
            browser: "chromium",
            profile: "phone",
            status: "ok",
            reason: null,
            samples: [interactionSample(640, [request("/api/mail/mailboxes/Mbx001/workspace-route?href=x", 48_000)])],
            metrics: { durationMs: { median: 640, p95: 640, min: 640, max: 640 }, apiRequests: 1, apiBytes: 48_000 },
          },
        ],
      },
    ],
    errors: [],
  };
}

test("load samples require document transfer time and summarize its distribution", () => {
  const sample = browserSection().pages[0]!.profiles[0]!.samples[0]!;
  expect(loadSampleSchema.parse(sample).documentTransferMs).toBe(120);
  const { documentTransferMs: _, ...missing } = sample;
  expect(loadSampleSchema.safeParse(missing).success).toBe(false);
  for (const documentTransferMs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(loadSampleSchema.safeParse({ ...sample, documentTransferMs }).success).toBe(false);
  expect(summarizeLoads([sample, { ...sample, documentTransferMs: 240 }]).documentTransferMs).toEqual({
    median: 180,
    min: 120,
    max: 240,
  });
});

test("results without a browser part still parse; browser sections render in the summary", () => {
  const { browser: _, ...old } = exampleResult();
  expect(resultSchema.parse(old).browser).toBeNull();
  const result = { ...exampleResult(), browser: browserSection() };
  expect(parsePrevious(JSON.parse(JSON.stringify(result))).browser?.interactions[0]?.id).toBe("folder-switch");
  const summary = renderSummary(result);
  expect(summary).toContain("## Browser: page loads");
  expect(summary).toContain("| chromium phone | 400 | 500 | 1,800 |");
  expect(summary).toContain("| Document transfer |");
  expect(summary).toContain("| 120 ms, 1.0 KB identity |");
  expect(summary).toContain("| — ms, — — |");
  const pageRows = summary
    .split("## Browser: page loads")[1]!
    .split("## Browser: interactions")[0]!
    .split("\n")
    .filter((line) => line.startsWith("|"));
  expect(pageRows).toHaveLength(5);
  expect(new Set(pageRows.map((line) => line.split("|").length))).toEqual(new Set([13]));
  expect(summary).toContain("25.0%");
  expect(summary).toContain("webkit desktop **SKIPPED**");
  expect(summary).toContain("connect ECONNREFUSED");
  expect(summary).toContain("### folder-switch");
  expect(summary).toContain("| chromium phone | 640 | 640 | 640 / 640 | 1 | 46.9 KB |");
  expect(summary).toContain("GET /api/mail/mailboxes/Mbx001/workspace-route 46.9 KB identity");
});

test("older results without conversation-open-large still parse and compare", () => {
  const previous = parsePrevious(JSON.parse(JSON.stringify({ ...exampleResult(), browser: browserSection() })));
  const current = { ...exampleResult(), browser: browserSection() };
  current.browser.interactions.push({
    id: "conversation-open-large",
    profiles: structuredClone(current.browser.interactions[0]!.profiles),
  });
  const parsed = resultSchema.parse(current);
  expect(previous.browser?.interactions.some(({ id }) => id === "conversation-open-large")).toBe(false);
  expect(timeMetrics(previous).has("interaction.conversation-open-large.chromium.phone.median")).toBe(false);
  expect(timeMetrics(parsed).get("interaction.conversation-open-large.chromium.phone.median")).toBe(640);
  const summary = renderSummary(parsed, previous);
  expect(summary).toContain("| detail-small | totalMs | 0.0 |");
  expect(summary).toContain("### conversation-open-large");
  expect(summary.split("### conversation-open-large")[1]!.split("### list-scroll")[0]).toContain(
    "| chromium phone | 640 | 640 | 640 / 640 | 1 | 46.9 KB |",
  );
  // Browser interactions have no delta columns; an absent previous entry must not
  // manufacture a zero or prevent the current measurements from rendering.
  expect(summary.split("## Median deltas")[1]!.split("## detail-small: attribution")[0]).not.toContain("conversation-open-large");
});

test("time metrics index server, load, trace and interaction numbers by stable ids", () => {
  const result = { ...exampleResult(), browser: browserSection() };
  result.scenarios[0]!.metrics = { totalMs: { cold: 10, median: 30, p95: 40 } };
  result.scenarios[0]!.database = { windowMs: 1, calls: 1, callsPerRun: 1, totalMs: 2, msPerRun: 2, statements: [] };
  const metrics = timeMetrics(result);
  expect(metrics.get("server.detail-small.totalMs.median")).toBe(30);
  expect(metrics.get("server.detail-small.dbMsPerRun")).toBe(2);
  expect(metrics.get("load.mailbox.chromium.phone.ttiMs")).toBe(1800);
  expect(metrics.get("load.mailbox.chromium.phone.documentTransferMs")).toBe(120);
  expect(metrics.get("trace.mailbox.chromium.phone.islandRenderMs")).toBe(250);
  expect(metrics.get("interaction.folder-switch.chromium.phone.median")).toBe(640);
  expect(metrics.has("load.mailbox.webkit.desktop.ttiMs")).toBe(false);
});

test("interaction traces and main requests survive result parsing, render once and expose rank metrics", () => {
  const browser = browserSection();
  browser.pages = [];
  const profile = browser.interactions[0]!.profiles[0]!;
  profile.samples = [
    interactionSample(
      100,
      [{ ...request("/app/mail/Bbb002", 1200), type: "document", encodedBytes: 1000, serverMs: 40, transferMs: 20 }],
      "/app/mail/Bbb002",
    ),
  ];
  profile.metrics = summarizeInteraction(profile.samples);
  profile.trace = {
    totalMs: 120,
    busyMs: 70,
    scriptMs: 20,
    parseCompileMs: 10,
    islandRenderMs: 15,
    styleLayoutMs: 5,
    otherMs: 20,
    scriptShare: 20 / 70,
    parseCompileShare: 10 / 70,
    islandRenderShare: 15 / 70,
    styleLayoutShare: 5 / 70,
    otherShare: 20 / 70,
    mainRequest: profile.samples[0]!.mainRequest,
  };
  const result = resultSchema.parse({ ...exampleResult(), browser });
  const summary = renderSummary(result);
  expect(summary.match(/## Interaction breakdown/g)).toHaveLength(1);
  expect(summary).toContain("| folder-switch | chromium phone | 120 | 40 | 20 | 20 (28.6%) |");
  expect(summary).toContain("| chromium phone | 40 | 20 | 1.0 KB | identity |");
  expect(summary).not.toContain("### mailbox-switch");
  const index = timeMetrics(result);
  expect(index.get("interactionTrace.folder-switch.chromium.phone.scriptMs")).toBe(20);
  expect(index.get("interactionTrace.folder-switch.chromium.phone.styleLayoutMs")).toBe(5);
  expect(index.get("interactionTrace.folder-switch.chromium.phone.islandRenderMs")).toBe(15);
  expect(index.get("interaction.folder-switch.chromium.phone.serverMs")).toBe(40);
  expect(parsePrevious({ ...exampleResult(), browser: browserSection() }).browser?.interactions[0]!.profiles[0]!.trace).toBeUndefined();
});

const candidate = (title: string, metric: string, location = "packages/mail/scripts/perf-baseline/browser-model.ts:1") => ({
  title,
  location,
  anchor: 'import { existsSync, readFileSync } from "node:fs";',
  metric,
  evidence: "measured",
  slice: "mail-perf-fix",
});

test("bottlenecks rank by the measured number and refuse entries without file:line, a measured number or one metric family", () => {
  const metrics = new Map([
    ["a", 100],
    ["b", 900],
    ["c", 300],
    ["d", 50],
    ["e", 700],
    ["f", 10],
  ]);
  const ranked = rankBottlenecks(
    metrics,
    ["a", "b", "c", "d", "e", "f"].map((id) => candidate(id.toUpperCase(), id)),
    repository,
  );
  expect(ranked.map((entry) => [entry.title, entry.value])).toEqual([
    ["B", 900],
    ["E", 700],
    ["C", 300],
    ["A", 100],
    ["D", 50],
  ]);
  const markdown = renderBottlenecks(ranked);
  expect(markdown).toContain("## Top 5 bottlenecks");
  expect(markdown).toContain(
    "| 1 | B | 900 ms | `b` | `packages/mail/scripts/perf-baseline/browser-model.ts:1` | measured | mail-perf-fix |",
  );
  const four = ["a", "b", "c", "d"].map((id) => candidate(id, id));
  expect(() => rankBottlenecks(metrics, [...four, candidate("no line", "e", "packages/mail/src/index.ts")], repository)).toThrow(
    "needs a file:line location",
  );
  expect(() => rankBottlenecks(metrics, [...four, candidate("missing", "e", "packages/mail/nope.ts:3")], repository)).toThrow(
    "does not exist",
  );
  expect(() =>
    rankBottlenecks(metrics, [...four, candidate("too far", "e", "packages/mail/scripts/perf-baseline.ts:100000")], repository),
  ).toThrow("outside");
  expect(() => rankBottlenecks(metrics, [...four, candidate("outside", "e", "../etc/passwd:1")], repository)).toThrow(
    "repository-relative",
  );
  expect(() => rankBottlenecks(metrics, [...four, candidate("unmeasured", "load.mailbox.webkit.phone.ttiMs")], repository)).toThrow(
    "no measured number",
  );
  expect(() => rankBottlenecks(metrics, four, repository)).toThrow("at least 5");
  const mixed = new Map([...metrics, ["server.detail-large.totalMs.median", 140]]);
  expect(() => rankBottlenecks(mixed, [...four, candidate("server", "server.detail-large.totalMs.median")], repository)).toThrow(
    "mix server and browser metrics",
  );
  expect(() => rankBottlenecks(metrics, [{ title: "x" }], repository)).toThrow();
});

test("--rank reads a result and candidates from files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-perf-rank-"));
  try {
    const result = { ...exampleResult(), browser: browserSection() };
    await writeFile(join(directory, "result.json"), JSON.stringify(result));
    const metrics = [
      "interaction.folder-switch.chromium.phone.median",
      "load.mailbox.chromium.phone.ttiMs",
      "load.mailbox.chromium.phone.islandRenderMs",
      "trace.mailbox.chromium.phone.styleLayoutMs",
      "trace.mailbox.chromium.phone.parseCompileMs",
    ];
    await writeFile(join(directory, "candidates.json"), JSON.stringify(metrics.map((metric) => candidate(metric, metric))));
    const markdown = await rankFromFiles(join(directory, "result.json"), join(directory, "candidates.json"));
    expect(
      markdown
        .split("\n")
        .filter((line) => /^\| \d/.test(line))
        .map((line) => line.split(" | ")[1]),
    ).toEqual([
      "load.mailbox.chromium.phone.ttiMs",
      "interaction.folder-switch.chromium.phone.median",
      "load.mailbox.chromium.phone.islandRenderMs",
      "trace.mailbox.chromium.phone.styleLayoutMs",
      "trace.mailbox.chromium.phone.parseCompileMs",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function interactionDom() {
  const dom = createDomTestHarness();
  const names = [
    "sessionStorage",
    "addEventListener",
    "innerHeight",
    "innerWidth",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "ErrorEvent",
  ] as const;
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const page = dom.window as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = page[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: typeof value === "function" && name === "addEventListener" ? value.bind(dom.window) : value,
    });
  }
  return {
    dom,
    cleanup: () => {
      for (const [name, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      Reflect.deleteProperty(window, "__mailPerfArm");
      dom.cleanup();
    },
  };
}

test("the interaction probe refuses an end state that already holds and times a marked action to the painting frame", async () => {
  setSystemTime(new Date("2026-10-01T00:00:00Z"));
  const { dom, cleanup } = interactionDom();
  try {
    document.body.innerHTML =
      '<h1 data-mail-list-heading>Inbox</h1><div data-mail-conversation-list><div data-conversation-id="A"></div></div>';
    installInteractionProbe({ key: watchKey, trace: true });
    expect(window.__mailPerfArm?.({ id: "x", action: "mark", conditions: [{ selector: '[data-conversation-id="A"]' }] })).toBe(false);
    expect(
      window.__mailPerfArm?.({
        id: "x",
        action: "mark",
        conditions: [{ selector: "[data-mail-list-heading]", text: "Archive" }, { selector: '[data-conversation-id="B"]' }],
      }),
    ).toBe(true);
    window.__mailPerfMark?.();
    const marked = JSON.parse(sessionStorage.getItem(watchKey) ?? "null");
    expect(marked.actionAt).toBeNumber();
    expect(marked.hitAt).toBeNull();
    document.querySelector("[data-mail-conversation-list]")?.insertAdjacentHTML("beforeend", '<div data-conversation-id="B"></div>');
    // Heading still says Inbox: one condition alone is not the end state.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(JSON.parse(sessionStorage.getItem(watchKey) ?? "null").hitAt).toBeNull();
    document.querySelector("[data-mail-list-heading]")!.textContent = "Archive";
    for (let frame = 0; frame < 5 && JSON.parse(sessionStorage.getItem(watchKey) ?? "null").hitAt === null; frame++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const hit = JSON.parse(sessionStorage.getItem(watchKey) ?? "null");
    expect(hit.hitAt).toBeGreaterThanOrEqual(hit.actionAt);
    expect(window.__mailPerfArm?.({ id: "search-submit", action: "enter", conditions: [{ selector: '[data-conversation-id="C"]' }] })).toBe(
      true,
    );
    const keydown = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    const input = new dom.window.Event("input", { bubbles: true });
    // Events constructed by happy-dom are untrusted and must not start either clock.
    dom.window.dispatchEvent(keydown);
    dom.window.dispatchEvent(input);
    const untouched = JSON.parse(sessionStorage.getItem(watchKey) ?? "null");
    expect(untouched.actionAt).toBeNull();
    expect(untouched.inputAt).toBeNull();
    expect(untouched.hitAt).toBeNull();
    // Uncaught errors and island errors of the app's document fail the sample, also after it navigated.
    dom.window.dispatchEvent(new dom.window.ErrorEvent("error", { message: "boom" }));
    dom.window.document.dispatchEvent(new dom.window.Event("ssr:island-error"));
    expect(JSON.parse(sessionStorage.getItem(errorsKey) ?? "[]")).toEqual(["boom", "ssr:island-error"]);
    // A plain-text body holds at once; an HTML body only after its frame reported a height.
    document.body.insertAdjacentHTML("beforeend", '<div data-plain-body></div><div data-html-body><iframe title="Message"></iframe></div>');
    expect(window.__mailPerfArm?.({ id: "x", action: "mark", conditions: [{ selector: "[data-plain-body]", framesReported: true }] })).toBe(
      false,
    );
    expect(window.__mailPerfArm?.({ id: "x", action: "mark", conditions: [{ selector: "[data-html-body]", framesReported: true }] })).toBe(
      true,
    );
  } finally {
    cleanup();
  }
});

test("mailbox-switch waits for the destination path, viewport row, mounted workspace and an idle list, including after a document replacement", async () => {
  setSystemTime(new Date("2026-10-01T00:00:00Z"));
  for (const navigation of ["document", "in-place"]) {
    let env = interactionDom();
    try {
      window.history.replaceState(null, "", "/app/mail/Aaa001");
      installInteractionProbe({ key: watchKey, trace: true });
      const watch = {
        id: "mailbox-switch",
        action: "mark" as const,
        conditions: [{ selector: '[data-conversation-id="B"]', path: "/app/mail/Bbb002", visible: true, interactive: true }],
      };
      expect(window.__mailPerfArm?.(watch)).toBe(true);
      window.__mailPerfMark?.();
      const armed = sessionStorage.getItem(watchKey)!;
      if (navigation === "document") {
        env.cleanup();
        env = interactionDom();
        sessionStorage.setItem(watchKey, armed);
        installInteractionProbe({ key: watchKey, trace: true });
      }
      document.body.innerHTML =
        '<solid-island><main aria-busy="true"><div data-mail-conversation-list><div data-conversation-id="B"></div></div></main></solid-island>';
      const island = document.querySelector("solid-island")!;
      const row = document.querySelector('[data-conversation-id="B"]')!;
      let onScreen = false;
      Object.defineProperty(row, "getBoundingClientRect", {
        value: () => ({ width: 100, height: 40, top: onScreen ? 0 : 2000, left: 0, bottom: onScreen ? 40 : 2040, right: 100 }),
      });
      const mounted = new Map<Element, number>();
      const started = new Map<Element, number>();
      Object.defineProperty(window, "__cloudPerf", { configurable: true, value: { mounted, started } });
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const state = () => JSON.parse(sessionStorage.getItem(watchKey) ?? "null");
      await frame();
      expect(state().hitAt).toBeNull();
      window.history.replaceState(null, "", "/app/mail/Bbb002");
      onScreen = true;
      document.querySelector("main")!.removeAttribute("aria-busy");
      await frame();
      // SSR rows alone are insufficient, even with the right URL and an idle list.
      expect(state().hitAt).toBeNull();
      started.set(island, 1);
      mounted.set(island, 2);
      document.querySelector("main")!.setAttribute("aria-busy", "true");
      await frame();
      expect(state().hitAt).toBeNull();
      document.querySelector("main")!.setAttribute("aria-busy", "false");
      onScreen = false;
      await frame();
      expect(state().hitAt).toBeNull();
      onScreen = true;
      window.history.replaceState(null, "", "/app/mail/Aaa001");
      await frame();
      expect(state().hitAt).toBeNull();
      window.history.replaceState(null, "", "/app/mail/Bbb002");
      await frame();
      expect(state().hitAt).toBeGreaterThanOrEqual(state().actionAt);
      expect(state().mountWindows).toEqual([[performance.timeOrigin + 1, performance.timeOrigin + 2]]);
      expect(window.__mailPerfArm?.(watch)).toBe(false);
      if (navigation === "in-place") {
        const reused = {
          ...watch,
          conditions: [{ ...watch.conditions[0]!, path: "/app/mail/Ccc003", selector: '[data-conversation-id="C"]' }],
        };
        expect(window.__mailPerfArm?.(reused)).toBe(true);
        window.__mailPerfMark?.();
        row.setAttribute("data-conversation-id", "C");
        window.history.replaceState(null, "", "/app/mail/Ccc003");
        await frame();
        // The island remains mounted: an in-place switch must not wait for another mount.
        expect(state().hitAt).toBeGreaterThanOrEqual(state().actionAt);
        expect(mounted.size).toBe(1);
      }
    } finally {
      env.cleanup();
    }
  }
});

test("ranking refuses blank and stale source rows (#1472)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mail-perf-source-"));
  try {
    await writeFile(join(directory, "source.ts"), "export const current = 1;\n  \t\nexport const unrelated = 2;\n");
    const metrics = new Map([["measured", 42]]);
    const entry = { ...candidate("Current cost", "measured", "source.ts:1"), anchor: "export const current = 1;" };
    expect(rankBottlenecks(metrics, [entry], directory, 1)[0]?.value).toBe(42);
    expect(() => rankBottlenecks(metrics, [{ ...entry, location: "source.ts:2" }], directory, 1)).toThrow("blank");
    expect(() => rankBottlenecks(metrics, [{ ...entry, location: "source.ts:3" }], directory, 1)).toThrow("anchor");
    for (const anchor of [
      undefined,
      "",
      "   ",
      "export const current = 1;\nexport const unrelated = 2;",
      `\n${entry.anchor}`,
      `${entry.anchor}\r\n`,
    ]) {
      expect(() => rankBottlenecks(metrics, [{ ...entry, anchor }], directory, 1)).toThrow();
    }
    expect(rankBottlenecks(metrics, [{ ...entry, anchor: `  ${entry.anchor}  ` }], directory, 1)[0]?.value).toBe(42);
    // The same line number becomes stale when the named code changes or moves.
    await writeFile(join(directory, "source.ts"), "export const replacement = 3;\nexport const current = 1;\n");
    expect(() => rankBottlenecks(metrics, [entry], directory, 1)).toThrow("anchor");
    expect(rankBottlenecks(metrics, [{ ...entry, location: "source.ts:2" }], directory, 1)[0]?.value).toBe(42);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
