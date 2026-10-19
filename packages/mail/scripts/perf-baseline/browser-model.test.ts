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
  interactionResultSchema,
  interactionSample,
  interactionSampleSchema,
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
  expect(() => parseArgs(["--browser", "firefox"])).toThrow();
  expect(() => parseArgs(["--browser", "chromium,chromium"])).toThrow("duplicates");
  expect(() => parseArgs(["--browser"])).toThrow("Missing value for --browser");
  expect(() => parseArgs(["--browser-runs", "0"])).toThrow("--browser-runs must be 1..20");
  expect(() => parseArgs(["--browser-runs", "21"])).toThrow("--browser-runs must be 1..20");
  expect(parseArgs(["--rank", "r.json", "--bottlenecks", "b.json"])).toMatchObject({ rank: "r.json", bottlenecks: "b.json" });
  expect(() => parseArgs(["--rank", "r.json"])).toThrow("--rank and --bottlenecks go together");
  expect(() => parseArgs(["--rank", "r.json", "--bottlenecks", "b.json", "--browser", "chromium"])).toThrow("starts nothing");
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
    "folder-switch",
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

const candidate = (title: string, metric: string, location = "packages/mail/scripts/perf-baseline/browser-model.ts:1") => ({
  title,
  location,
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

test("the interaction probe refuses an end state that already holds and times a marked action to the painting frame", async () => {
  setSystemTime(new Date("2026-10-01T00:00:00Z"));
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
  try {
    document.body.innerHTML =
      '<h1 data-mail-list-heading>Inbox</h1><div data-mail-conversation-list><div data-conversation-id="A"></div></div>';
    installInteractionProbe(watchKey);
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
    for (const [name, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    Reflect.deleteProperty(window, "__mailPerfArm");
    dom.cleanup();
  }
});
