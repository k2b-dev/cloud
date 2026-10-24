import { describe, expect, test } from "bun:test";
import { toJSON } from "seroval";
import { help } from "../perf-baseline";
import {
  aggregate,
  aggregateMetrics,
  assetCacheState,
  assetPath,
  cacheGate,
  closure,
  cumulativeLayoutShift,
  decodeAttribute,
  defaultPageIds,
  failedRequestError,
  inspectHtml,
  interactive,
  longTaskMetrics,
  metricNames,
  metricsSchema,
  type PwaAsset,
  type PwaProfileResult,
  type PwaResult,
  type PwaStep,
  pageApps,
  parseArgs,
  pwaProfileResultSchema,
  pwaResultSchema,
  pwaStepSchema,
  renderSummary,
  resultSchema,
  sortedJson,
  summarizePwa,
  timeToInteractive,
  validatePage,
} from "./model";

describe("performance baseline contracts", () => {
  test("defaults and page selection are stable; malformed flags fail before side effects", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      panel: false,
      keep: false,
      skipBuild: false,
      runs: 3,
      pages: ["document", "faq", "mail-mailbox", "assistant-chat", "notebooks-editor", "files", "accounts", "spaces"],
    });
    expect(
      parseArgs(["--pages", "files,document", "--runs", "1", "--skip-build", "--keep", "--out", ".local/example", "--compare", "old.json"]),
    ).toMatchObject({ pages: ["files", "document"], runs: 1, keep: true, skipBuild: true, out: ".local/example", compare: "old.json" });
    for (const args of [
      ["--runs"],
      ["--runs", "0"],
      ["--runs", "1.5"],
      ["--runs", "2junk"],
      ["--pages", "unknown"],
      ["--pages", "files,files"],
      ["--pages", ""],
      ["--out", "--keep"],
      ["--wat"],
    ])
      expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("HTML counts instances, distinct entries, decoded UTF-8 props, inline and external modules", async () => {
    const props = JSON.stringify(toJSON({ text: "Grüße & <world>" }));
    const empty = JSON.stringify(toJSON({}));
    const encoded = props.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const html = `<base href="/app/faq/"><solid-island data-id="one" data-props="${encoded}"></solid-island><solid-client data-id="one" data-props="${Bun.escapeHTML(empty)}"></solid-client><script type="module">const p="/faq/_ssr/123";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script><script type="module" src="extra.js"></script><script type="module">import "./inline.js";</script><link rel="stylesheet" href="/public/faq/app.css"><link rel="preload" href="ignored.css">`;
    const info = await inspectHtml(html, "http://127.0.0.1:4100/faq");
    expect(info.islands).toBe(2);
    expect(info.islandEntries).toEqual(["/faq/_ssr/123/one.js"]);
    expect(info.modules).toEqual(["/app/faq/extra.js", "/app/faq/inline.js", "/faq/_ssr/123/one.js"]);
    expect(info.css).toEqual(["/public/faq/app.css"]);
    expect(info.propsBytes).toBe(Buffer.byteLength(props) + Buffer.byteLength(empty));
    expect(info.propsShare).toBeCloseTo(info.propsBytes / Buffer.byteLength(html), 6);
  });

  test("content-hashed SSR prefixes and modulepreload preserve the inspector module set", async () => {
    const html = `<solid-island data-id="one" data-props="{}"></solid-island><script type="module">const p="/faq/_ssr/0123456789abcdef";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script>`;
    const preload = `["chunk-abc.js","chunk-def.js"].forEach(f=>{const l=document.createElement('link');l.rel='modulepreload';l.href=p+'/'+f;document.head.append(l)});`;
    const withPreloads = html.replace(";document.querySelectorAll", ";" + preload + "document.querySelectorAll");
    const original = await inspectHtml(html, "http://127.0.0.1:4100/faq");
    const preloaded = await inspectHtml(withPreloads, "http://127.0.0.1:4100/faq");
    expect(preloaded.islandEntries).toEqual(original.islandEntries);
    expect(preloaded.modules).toEqual(original.modules);
    expect(original.islandEntries).toEqual(["/faq/_ssr/0123456789abcdef/one.js"]);
    expect(assetPath("/app/mail/_ssr/0123456789abcdef/x.js", ["mail"])).toEqual({ app: "mail", file: "_ssr/x.js" });
  });

  test("literal dynamic imports in other inline scripts remain lazy extras", async () => {
    const info = await inspectHtml(
      '<html><script type="module">import "/public/core/eager.js";const load=()=>import("/public/core/lazy.js");</script></html>',
      "http://127.0.0.1:4100/legal/privacy",
    );
    expect(info.modules).toEqual(["/public/core/eager.js"]);
    expect(info.lazyModules).toEqual(["/public/core/lazy.js"]);
    expect(
      closure(
        ["eager"],
        new Map([
          ["eager", { eager: [], lazy: [] }],
          ["lazy", { eager: ["eager"], lazy: [] }],
        ]),
        ["lazy"],
      ),
    ).toEqual({ eager: ["eager"], lazy: ["lazy"] });
  });

  test("attribute entities decode once, including numeric Unicode", () => {
    expect(decodeAttribute("&amp;quot; &#252; &#x1f642; &apos; &gt;")).toBe("&quot; ü 🙂 ' >");
  });

  test("eager and lazy closures deduplicate shared imports and cycles without counting unused modules", () => {
    const graph = new Map([
      ["a", { eager: ["shared", "b"], lazy: ["lazy"] }],
      ["b", { eager: ["shared", "a"], lazy: ["shared"] }],
      ["shared", { eager: [], lazy: [] }],
      ["lazy", { eager: ["shared", "helper"], lazy: ["nested"] }],
      ["helper", { eager: [], lazy: [] }],
      ["nested", { eager: [], lazy: [] }],
      ["unused", { eager: [], lazy: [] }],
    ]);
    expect(closure(["a", "b"], graph)).toEqual({ eager: ["a", "b", "shared"], lazy: ["helper", "lazy", "nested"] });
    expect(() => closure(["missing"], graph)).toThrow("missing");
  });

  test("versioned SSR URLs resolve flat build files, with traversal and external assets rejected", () => {
    expect(assetPath("/app/mail/_ssr/123/entry.js", ["mail"])).toEqual({ app: "mail", file: "_ssr/entry.js" });
    expect(assetPath("/public/core/app.css?v=1", ["core"])).toEqual({ app: "core", file: "public/core/app.css" });
    expect(assetPath("/_ssr/123/entry.js", ["core"])).toEqual({ app: "core", file: "_ssr/entry.js" });
    expect(assetPath("/public/global.css", ["core"])).toEqual({ app: "core", file: "public/global.css" });
    for (const path of [
      "https://other.invalid/a.js",
      "/app/mail/_ssr/123/%2e%2e",
      "/public/core/%2e%2e/a",
      "/public/core/%2fetc",
      "/unknown.js",
    ])
      expect(() => assetPath(path, ["mail", "core"])).toThrow();
  });

  test("median/min/max respect null metrics and CLS precision; failures never become timeout numbers", () => {
    expect(aggregate([100, 20, 60])).toEqual({ median: 60, min: 20, max: 100 });
    expect(aggregate([1, 2])).toEqual({ median: 2, min: 1, max: 2 });
    expect(aggregate([0.123456, 0.2], 4)).toEqual({ median: 0.1617, min: 0.1235, max: 0.2 });
    expect(aggregate([null, null])).toBeNull();
    expect(() => aggregate([1, null])).toThrow();
    expect(() => aggregate([])).toThrow();
    expect(() => aggregate([Number.NaN])).toThrow();
  });

  test("observation stops only after all initial wrappers, completed and timed scripts, and 500 ms of quiet", () => {
    expect(interactive({ initial: 2, mounted: 1, pendingScripts: 0, untimedScripts: 0, quietMs: 600 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 1, untimedScripts: 0, quietMs: 600 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, untimedScripts: 0, quietMs: 499 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, untimedScripts: 0, quietMs: 500 })).toBe(true);
    expect(interactive({ initial: 0, mounted: 0, pendingScripts: 0, untimedScripts: 0, quietMs: 500 })).toBe(true);
    // WebKit can deliver a finished script's resource entry late; TTI needs every script's entry.
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, untimedScripts: 1, quietMs: 5000 })).toBe(false);
  });

  test("TTI excludes the quiet window and host polling latency", () => {
    const timing = { fcp: 176, mountTimes: [200, 240], scriptUrls: [], resources: [], longtasks: [] };
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, untimedScripts: 0, quietMs: 762 })).toBe(true);
    expect(timeToInteractive(timing)).toBe(240);
  });

  test("TTI takes the latest mount, observed script response, or long-task end", () => {
    const timing = {
      fcp: 100,
      mountTimes: [200, 300],
      scriptUrls: ["https://localhost:4100/entry.js"],
      resources: [
        { name: "https://localhost:4100/entry.js", responseEnd: 400 },
        { name: "https://localhost:4100/font.woff2", responseEnd: 900 },
      ],
      longtasks: [{ start: 450, duration: 100 }],
    };
    expect(timeToInteractive(timing)).toBe(550);
    expect(timeToInteractive({ ...timing, longtasks: [] })).toBe(400);
    expect(timeToInteractive({ ...timing, longtasks: [], mountTimes: [600] })).toBe(600);
    expect(timeToInteractive({ ...timing, fcp: 800 })).toBe(800);
    expect(timeToInteractive({ ...timing, fcp: null, longtasks: [] })).toBe(400);
  });

  test("WebKit TTI works without long tasks, and missing script timing fails loudly", () => {
    const timing = { fcp: null, mountTimes: [220], scriptUrls: [], resources: [], longtasks: [] };
    expect(timeToInteractive(timing)).toBe(220);
    expect(timeToInteractive({ ...timing, mountTimes: [], fcp: 176 })).toBe(176);
    expect(() => timeToInteractive({ ...timing, scriptUrls: ["https://localhost:4100/missing.js"] })).toThrow(
      "Missing resource timing for observed script: https://localhost:4100/missing.js",
    );
  });

  test("CLS takes the largest session window and preserves unsupported entries", () => {
    expect(cumulativeLayoutShift(null)).toBeNull();
    expect(cumulativeLayoutShift([])).toBe(0);
    expect(
      cumulativeLayoutShift([
        { start: 0, value: 0.1 },
        { start: 2000, value: 0.2 },
      ]),
    ).toBe(0.2);
    expect(
      cumulativeLayoutShift([
        { start: 0, value: 0.1 },
        { start: 500, value: 0.2 },
      ]),
    ).toBeCloseTo(0.3);
    expect(
      cumulativeLayoutShift([
        { start: 900, value: 0.1 },
        { start: 1900, value: 0.2 },
      ]),
    ).toBeCloseTo(0.3);
  });

  test("CLS splits a continuous burst when its session would exceed five seconds", () => {
    const burst = Array.from({ length: 8 }, (_, i) => ({ start: 700 + i * 900, value: 0.1 }));
    expect(cumulativeLayoutShift(burst)).toBeCloseTo(0.6);
  });

  test("failed document, script and stylesheet requests include their path and network error", () => {
    for (const type of ["document", "script", "stylesheet"])
      expect(failedRequestError(type, "https://localhost:4100/public/app.css?v=1", "net::ERR_CONNECTION_RESET")).toBe(
        `${type} request failed: /public/app.css (net::ERR_CONNECTION_RESET)`,
      );
    expect(failedRequestError("script", "https://localhost:4100/entry.js", undefined)).toContain("unknown network error");
    for (const type of ["image", "fetch", "xhr", "font"])
      expect(failedRequestError(type, "https://localhost:4100/resource", "failed")).toBeNull();
  });

  test("blocking time clips long tasks to the FCP/TTI window and subtracts 50 ms per task", () => {
    expect(
      longTaskMetrics(
        [
          { start: 0, duration: 200 },
          { start: 230, duration: 100 },
          { start: 480, duration: 200 },
        ],
        100,
        550,
      ),
    ).toEqual({ lastLongTaskEndMs: 680, totalBlockingTimeMs: 120 });
    expect(longTaskMetrics([], 10, 100)).toEqual({ lastLongTaskEndMs: 0, totalBlockingTimeMs: 0 });
    expect(longTaskMetrics([], null, 100).totalBlockingTimeMs).toBeNull();
  });

  test("a successful HTTP response cannot disguise login, gateway errors, or a redirected target", () => {
    const url = "http://127.0.0.1:4100/app/mail/test";
    expect(() => validatePage(200, url, url, "<html><main>Mailbox</main></html>")).not.toThrow();
    for (const html of [
      "Bad Gateway — upstream unavailable",
      '<html><form action="/api/auth/login">Sign in</form></html>',
      '<html><script src="/core/_ssr/1/AdminLoginForm.js"></script></html>',
      "{}",
    ])
      expect(() => validatePage(200, url, url, html)).toThrow();
    expect(() => validatePage(200, url, "http://127.0.0.1:4100/auth", "<html></html>")).toThrow();
    expect(() => validatePage(503, url, url, "<html></html>")).toThrow();
  });

  test("stable JSON recursively sorts keys and rejects incompatible comparison results", () => {
    expect(sortedJson({ z: [{ b: 2, a: 1 }], a: null })).toBe(
      '{\n  "a": null,\n  "z": [\n    {\n      "a": 1,\n      "b": 2\n    }\n  ]\n}\n',
    );
    expect(() => resultSchema.parse({ schemaVersion: 2 })).toThrow();
  });

  test("summary renders failures and skips explicitly instead of claiming zero cost", () => {
    const run = resultSchema.parse({
      schemaVersion: 1,
      metadata: {
        commit: "abc",
        dirty: true,
        timestamp: "2026-10-09T00:00:00.000Z",
        bunVersion: "1.4.2",
        playwrightVersion: "1.63.0",
        browserVersions: {},
        cpuCount: 4,
        loadAverage: { start: 1.5, end: 2 },
        runs: 1,
        origin: "https://localhost:4100",
        transport: "https-h2-caddy",
        runtimeImage: "oven/bun:test",
        seedVersion: 1,
      },
      pages: [{ id: "files", path: "/app/filesv2", status: "failed", errors: ["fixture failed"], notes: [], static: null, browsers: [] }],
      errors: [],
    });
    expect(renderSummary(run)).toContain("fixture failed");
    expect(renderSummary(run)).toContain("abc (dirty)");
    expect(renderSummary(run)).toContain("Transport: https-h2-caddy");
    expect(renderSummary(run)).toContain("Session: throwaway administrator");
    expect(renderSummary(run)).not.toContain("| 0 |");
  });

  test("comparison matches stable page/profile IDs, uses medians, and keeps skip reasons outside the table", () => {
    const sample = metricsSchema.parse(Object.fromEntries(metricNames.map((name) => [name, name === "cls" ? 0.1 : 100])));
    const current = resultSchema.parse({
      schemaVersion: 1,
      metadata: {
        commit: "abc",
        dirty: false,
        timestamp: "2026-10-09T00:00:00.000Z",
        bunVersion: "1.4.2",
        playwrightVersion: "1.63.0",
        browserVersions: { chromium: "1" },
        transport: "https-h2-caddy",
        cpuCount: 4,
        loadAverage: { start: 1.5, end: 2 },
        runs: 3,
        origin: "https://localhost:4100",
        runtimeImage: "oven/bun:test",
        seedVersion: 1,
      },
      pages: [
        {
          id: "files",
          path: "/app/filesv2?base=new",
          status: "ok",
          errors: [],
          notes: [],
          static: null,
          browsers: [
            {
              browser: "chromium",
              profile: "phone",
              status: "ok",
              reason: null,
              cpuThrottle: 4,
              network: null,
              transferSource: "cdp.encodedDataLength",
              contentEncoding: { js: ["br"], css: ["br"] },
              samples: [
                { ...sample, ttiMs: 700 },
                { ...sample, ttiMs: 450 },
                { ...sample, ttiMs: 400 },
              ],
              metrics: aggregateMetrics([
                { ...sample, ttiMs: 700 },
                { ...sample, ttiMs: 450 },
                { ...sample, ttiMs: 400 },
              ]),
            },
            ...["desktop", "phone"].map((profile) => ({
              browser: "webkit",
              profile,
              status: "skipped",
              reason: "launch unavailable",
              cpuThrottle: null,
              network: null,
              transferSource: "playwright.request.sizes",
              contentEncoding: { js: [], css: [] },
              samples: [],
              metrics: null,
            })),
          ],
        },
      ],
      errors: [],
    });
    const old = resultSchema.parse(structuredClone(current));
    old.metadata.runs = 1;
    old.metadata.origin = "http://127.0.0.1:4100";
    const page = old.pages[0];
    const profile = page?.browsers[0];
    if (!page || !profile) throw new Error("Missing fixture profile");
    page.path = "/app/filesv2?base=old";
    profile.metrics = aggregateMetrics([
      { ...sample, ttiMs: 400 },
      { ...sample, ttiMs: 350 },
      { ...sample, ttiMs: 500 },
    ]);
    const summary = renderSummary(current, old);
    expect(summary).toContain("Origin: https://localhost:4100 · Transport: https-h2-caddy");
    expect(summary).toContain("or Playwright versions; interpret deltas with care");
    expect(summary).toContain("| 450 | 0.1000 | +50 |");
    expect(summary).toContain("| webkit / desktop: skipped | — | — | — | — | — | — | — |");
    expect(summary.indexOf("webkit / desktop: launch unavailable")).toBeGreaterThan(summary.indexOf("| webkit / phone: skipped |"));
    expect(profile.metrics.ttiMs).toEqual({ median: 400, min: 350, max: 500 });
  });
});

const pwaStep = (input: Partial<PwaStep> = {}): PwaStep =>
  pwaStepSchema.parse({
    id: "tab-start-spaces",
    finalPath: "/pwa/spaces",
    run: 1,
    round: 1,
    serviceWorker: "allowed",
    pressedMs: 10,
    titleMs: 12,
    contentMs: 100,
    mountedMs: 120,
    selectedMs: null,
    doneMs: null,
    titleFrame: true,
    persisted: null,
    documents: [],
    assets: [],
    ...input,
  });
const pwaProfile = (input: Partial<PwaProfileResult> = {}): PwaProfileResult =>
  pwaProfileResultSchema.parse({
    profile: "iphone",
    browser: "webkit",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    cpuThrottle: null,
    network: null,
    status: "ok",
    reason: null,
    steps: [pwaStep()],
    summary: [],
    ...input,
  });
const pwaResult = (profiles = [pwaProfile()]): PwaResult => ({
  origin: "local",
  rttMs: null,
  deviceName: "perf-2026-10-14",
  notes: [],
  profiles,
});
const asset = (input: Partial<PwaAsset> = {}): PwaAsset => ({
  path: "/public/pwa/app.css",
  kind: "css",
  state: "cache",
  transferSize: 0,
  encodedBodySize: 10,
  status: 200,
  repeat: true,
  ...input,
});

test("pwa is opt-in; existing origins are HTTPS and restricted to the mobile flows", () => {
  expect(parseArgs([]).pages).toEqual([...defaultPageIds]);
  expect(parseArgs(["--pages", "pwa,faq"]).pages).toEqual(["pwa", "faq"]);
  expect(pageApps.pwa).toEqual(["pwa", "spaces"]);
  expect(parseArgs(["--pages", "pwa", "--origin", "https://example.test:443/"])).toMatchObject({ origin: "https://example.test" });
  for (const origin of [
    "http://example.test",
    "https://example.test/path",
    "https://example.test/?a=1",
    "https://example.test/#a",
    "https://user:pass@example.test",
    "invalid",
  ])
    expect(() => parseArgs(["--pages", "pwa", "--origin", origin])).toThrow();
  for (const extra of [["--pages", "faq"], ["--pages", "pwa,faq"], ["--pages", "pwa", "--skip-build"], ["--pages", "pwa", "--keep"], []])
    expect(() => parseArgs(["--origin", "https://example.test", ...extra])).toThrow();
  for (const value of ["1", "2", "1000"]) expect(parseArgs(["--rtt", value]).rttMs).toBe(Number(value));
  for (const value of ["0", "-1", "1001", "2.5", "NaN", "1ms"]) expect(() => parseArgs(["--rtt", value])).toThrow();
  expect(() => parseArgs(["--rtt"])).toThrow();
});

test("the PWA schema accepts complete steps and rejects invalid timing, step and cache states", () => {
  const valid = pwaResult();
  expect(pwaResultSchema.parse(valid)).toEqual(valid);
  const step = pwaStep();
  expect(() => pwaStepSchema.parse({ ...step, contentMs: -1 })).toThrow();
  expect(() => pwaStepSchema.parse({ ...step, mountedMs: Number.POSITIVE_INFINITY })).toThrow();
  expect(() => pwaStepSchema.parse({ ...step, id: "tab-unknown" })).toThrow();
  expect(() => pwaStepSchema.parse({ ...step, assets: [asset({}), { ...asset(), state: "cached" }] })).toThrow();
});

const legacyResult = () => ({
  schemaVersion: 1,
  metadata: {
    commit: "old",
    dirty: false,
    timestamp: "2026-10-09T00:00:00.000Z",
    bunVersion: "1.4.2",
    playwrightVersion: "1.63.0",
    browserVersions: {},
    cpuCount: 4,
    loadAverage: { start: 0, end: 0 },
    runs: 3,
    origin: "https://localhost:4100",
    transport: "https-h2-caddy",
    runtimeImage: "oven/bun:test",
    seedVersion: 1,
  },
  pages: [{ id: "document", path: "/legal/privacy", status: "ok", errors: [], notes: [], static: null, browsers: [] }],
  errors: [],
});

test("pre-change schemaVersion 1 results still parse for comparison", () => {
  const parsed = resultSchema.parse(legacyResult());
  expect(parsed.metadata.rttMs).toBeNull();
  expect(parsed.metadata.seedVersion).toBe(1);
  expect(parsed.pages[0]?.pwa).toBeUndefined();
  expect(
    resultSchema.parse({
      ...legacyResult(),
      metadata: { ...legacyResult().metadata, transport: "remote", runtimeImage: "none", seedVersion: 2, rttMs: 120 },
    }).metadata.transport,
  ).toBe("remote");
});

test("asset cache classification gives 304 priority over missing or zero transfer size", () => {
  expect(assetCacheState({ status: 304, transferSize: undefined })).toBe("revalidated");
  expect(assetCacheState({ status: 304, transferSize: 0 })).toBe("revalidated");
  expect(assetCacheState({ status: 200, transferSize: undefined })).toBe("unknown");
  expect(assetCacheState({ status: null, transferSize: 0 })).toBe("cache");
  expect(assetCacheState({ status: 200, transferSize: 123 })).toBe("network");
});

test("PWA summaries group by step, round and worker, preserve nulls, and aggregate mixed samples", () => {
  const document = {
    path: "/pwa/spaces",
    status: 200,
    requestStartMs: 10,
    responseStartMs: 30,
    responseEndMs: 60,
    workerStartMs: 5,
    transferSize: 100,
    serverTiming: [
      { name: "db", durationMs: 5 },
      { name: "ssr", durationMs: 10 },
    ],
  };
  const steps = [
    pwaStep({ round: 2, contentMs: 400 }),
    pwaStep({
      run: 3,
      contentMs: 200,
      documents: [document],
      assets: [asset({ state: "revalidated" }), asset({ state: "network" })],
      persisted: true,
    }),
    pwaStep({ contentMs: null, selectedMs: 20, persisted: false }),
    pwaStep({ run: 2, contentMs: 100 }),
    pwaStep({ serviceWorker: "blocked" }),
    pwaStep({ id: "launch-first" }),
  ];
  const rows = summarizePwa(steps);
  expect(rows.map((row) => [row.id, row.round, row.serviceWorker])).toEqual([
    ["launch-first", 1, "allowed"],
    ["tab-start-spaces", 1, "allowed"],
    ["tab-start-spaces", 1, "blocked"],
    ["tab-start-spaces", 2, "allowed"],
  ]);
  expect(rows[1]).toMatchObject({
    samples: 3,
    contentMs: { median: 150, min: 100, max: 200 },
    doneMs: null,
    selectedMs: { median: 20, min: 20, max: 20 },
    responseEndMs: { median: 60, min: 60, max: 60 },
    serverMs: { median: 15, min: 15, max: 15 },
    persisted: 0.5,
    documents: { median: 0, min: 0, max: 1 },
    repeatedRequests: { median: 0, min: 0, max: 2 },
  });
});

test("the cache gate counts only repeated public/SSR non-cache assets on WebKit tab switches and warm launch", () => {
  const counted = [
    asset({ state: "revalidated" }),
    asset({ state: "network", path: "/app/spaces/_ssr/123/a.js" }),
    asset({ state: "unknown", path: "/public/font.woff2" }),
  ];
  const steps = [
    pwaStep({ assets: [...counted, asset(), asset({ repeat: false, state: "network" }), asset({ path: "/api/me", state: "network" })] }),
    pwaStep({ id: "launch-warm", assets: counted }),
    pwaStep({ id: "relaunch-start-url", assets: counted }),
    pwaStep({ id: "launch-first", assets: counted }),
    pwaStep({ id: "rename", assets: counted }),
  ];
  expect(cacheGate(pwaResult([pwaProfile({ steps }), pwaProfile({ browser: "chromium", profile: "phone", steps })]))).toEqual([
    { profile: "iphone", revalidated: 3, downloaded: 3, unknown: 3, examples: counted.map((entry) => entry.path) },
  ]);
  const many = pwaResult([
    pwaProfile({ steps: [pwaStep({ assets: Array.from({ length: 8 }, (_, i) => asset({ path: `/public/${i}.js`, state: "network" })) })] }),
  ]);
  expect(cacheGate(many)[0]?.examples).toHaveLength(5);
});

test("PWA Markdown includes the step medians, device and cache gate without the cold-load table", () => {
  const profile = pwaProfile();
  profile.summary = summarizePwa(profile.steps);
  const result = resultSchema.parse({
    ...legacyResult(),
    pages: [{ id: "pwa", path: "/pwa/", status: "ok", errors: [], notes: [], static: null, browsers: [], pwa: pwaResult([profile]) }],
  });
  const summary = renderSummary(result);
  expect(summary).toContain("Device: perf-2026-10-14");
  expect(summary).toContain(
    "| Step | Round | SW | Docs | Pressed | Title | Content | Mounted | Selected | Done | Doc end | Server | 304 | Downloads | Re-requests | bfcache |",
  );
  expect(summary).toContain("| tab-start-spaces | 1 | allowed | 0 | 10 | 12 | 100 | 120 | — | — |");
  expect(summary).toContain("WebKit iphone: 0 re-requested /public or /_ssr assets on tab switches and relaunches");
  expect(summary).not.toContain("| Browser / profile |");
});

test("help lists the opt-in mobile flows, remote token and added RTT", () => {
  for (const term of ["pwa", "--origin", "--rtt", "PERF_BASELINE_ADMIN_TOKEN", "ipad-landscape", "check-off"]) expect(help).toContain(term);
});

test("start_url relaunch keeps its visible arrival and final path in JSON and Markdown", () => {
  const step = pwaStep({ id: "relaunch-start-url", round: 2, finalPath: "/pwa/spaces?view=mine", doneMs: 84, titleMs: 84 });
  const profile = pwaProfile({ steps: [step], summary: summarizePwa([step]) });
  const result = resultSchema.parse({
    ...legacyResult(),
    pages: [{ id: "pwa", path: "/pwa/", status: "ok", errors: [], notes: [], static: null, browsers: [], pwa: pwaResult([profile]) }],
  });
  expect(result.pages[0]?.pwa?.profiles[0]?.steps[0]).toMatchObject({ finalPath: "/pwa/spaces?view=mine", doneMs: 84 });
  expect(renderSummary(result)).toContain("Relaunch through start_url (run 1, SW allowed): /pwa/spaces?view=mine; visible after 84 ms.");
  expect(() => pwaStep({ finalPath: "/auth/login" })).toThrow();
});
