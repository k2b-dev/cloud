import { describe, expect, test } from "bun:test";
import {
  aggregate,
  aggregateMetrics,
  assetPath,
  closure,
  decodeAttribute,
  inspectHtml,
  interactive,
  longTaskMetrics,
  metricNames,
  metricsSchema,
  parseArgs,
  renderSummary,
  resultSchema,
  sortedJson,
  validatePage,
} from "./model";

describe("performance baseline contracts", () => {
  test("defaults and page selection are stable; malformed flags fail before side effects", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      keep: false,
      skipBuild: false,
      runs: 3,
      pages: ["document", "faq", "mail-mailbox", "assistant-chat", "notebooks-editor", "files", "accounts"],
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
    const props = '({text:"Grüße & <world>"})';
    const encoded = props.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
    const html = `<base href="/app/faq/"><solid-island data-id="one" data-props="${encoded}"></solid-island><solid-client data-id="one" data-props="{}"></solid-client><script type="module">const p="/faq/_ssr/123";document.querySelectorAll('solid-island,solid-client').forEach(e=>import(p+'/'+e.dataset.id+'.js'));</script><script type="module" src="extra.js"></script><script type="module">import "./inline.js";</script><link rel="stylesheet" href="/public/faq/app.css"><link rel="preload" href="ignored.css">`;
    const info = await inspectHtml(html, "http://127.0.0.1:4100/faq");
    expect(info.islands).toBe(2);
    expect(info.islandEntries).toEqual(["/faq/_ssr/123/one.js"]);
    expect(info.modules).toEqual(["/app/faq/extra.js", "/app/faq/inline.js", "/faq/_ssr/123/one.js"]);
    expect(info.css).toEqual(["/public/faq/app.css"]);
    expect(info.propsBytes).toBe(Buffer.byteLength(props) + 2);
    expect(info.propsShare).toBeCloseTo(info.propsBytes / Buffer.byteLength(html), 6);
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

  test("TTI requires all initial wrappers, completed scripts, and 500 ms of quiet", () => {
    expect(interactive({ initial: 2, mounted: 1, pendingScripts: 0, quietMs: 600 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 1, quietMs: 600 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, quietMs: 499 })).toBe(false);
    expect(interactive({ initial: 2, mounted: 2, pendingScripts: 0, quietMs: 500 })).toBe(true);
    expect(interactive({ initial: 0, mounted: 0, pendingScripts: 0, quietMs: 500 })).toBe(true);
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
