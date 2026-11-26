import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import { fixtureParts } from "./runs-fixture-data";

// An operator narrows the runs list, the address keeps the state, and a reload shows the same runs. The test answers the
// runs API from invented runs; the screen renders the address as the page does.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_RUNS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "RunsScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-runs-screen-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Runs screen harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const styles = [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const document = (locale: string, state: string) =>
  `<!doctype html><html lang="${locale}" class="light" data-state="${state}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>`;

/** The runs API as the server answers it: the invented runs for the address's filters. */
const answerList = (url: URL, state = "normal") => ({
  status: 200,
  json: {
    parts: fixtureParts(
      url.search.slice(1),
      Number(url.searchParams.get("page") ?? 1),
      state === "worst" || state === "huge" ? state : "normal",
    ),
  },
});

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };

/** How the list API answers one call: `delay` holds the answer back, `status` fails it. */
type Answer = { delay?: number; status?: number };

const open = async (view: View, address: string, options: { locale?: string; state?: string; answer?: (call: number) => Answer } = {}) => {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const calls: string[] = [];
  const times: number[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/observability/runs")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(options.locale ?? "en", options.state ?? "normal") });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname === "/api/gateway/runs" || url.pathname === "/api/gateway/runs/") {
      calls.push(url.search);
      times.push(performance.now());
      const how = options.answer?.(calls.length) ?? {};
      if (how.delay) await new Promise((done) => setTimeout(done, how.delay));
      if (how.status) return route.fulfill({ status: how.status, json: { message: "Unavailable" } });
      const answer = answerList(url, options.state);
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls, times };
};

const listRequest = (request: { url(): string }) => new URL(request.url()).pathname.replace(/\/$/, "") === "/api/gateway/runs";
const rowTexts = (tab: Page) => tab.locator('[data-k2-part="Table"] tbody tr, [data-k2-part="Table"] [role="row"]').allInnerTexts();
const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the runs list on v2", () => {
  test("a kind filter writes the address, loads the list in place, and a reload shows the same runs", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/observability/runs");
    try {
      expect(await tab.getByText("Show all 48 Jobs").isVisible()).toBe(true);
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Kind" }).click();
      await tab.getByRole("option", { name: "Jobs" }).click();
      await tab.waitForURL(/kind=job/);
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => window.document.body.innerText.includes("48 of 48 runs"));
      expect(new URLSearchParams(calls.at(-1)).get("kind")).toBe("job");
      const shown = await rowTexts(tab);
      await tab.reload();
      await tab.waitForSelector('body[data-ready="true"]');
      await settled(tab);
      expect(await tab.getByRole("group", { name: "Filters" }).innerText()).toContain("Kind is Jobs");
      expect(await rowTexts(tab)).toEqual(shown);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("show all narrows to one kind; a job run opens its record beside the list and closes back", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/observability/runs");
    try {
      await tab.getByRole("link", { name: "Show all 30 Deliveries" }).click();
      await tab.waitForURL(/kind=delivery/);
      await tab.waitForSelector('body[data-ready="true"]');
      expect(await tab.getByText("30 of 30 runs").isVisible()).toBe(true);

      const jobs = await open(desktop, "/admin/observability/runs?kind=job");
      try {
        await jobs.tab
          .getByRole("link", { name: /Postfach abgleichen/ })
          .first()
          .click();
        await jobs.tab.waitForURL(/run=job%3A|run=job:/);
        await jobs.tab.waitForSelector('body[data-ready="true"]');
        expect(await jobs.tab.getByText("index.timeout").isVisible()).toBe(true);
        await jobs.tab.getByRole("link", { name: "Close" }).click();
        await jobs.tab.waitForURL((url) => !url.search.includes("run="));
        expect(jobs.errors).toEqual([]);
      } finally {
        await jobs.context.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the screen keeps the v2 rules at 1440, 1024 and 390 px", async () => {
    const cases: [string, string, View][] = [
      ["runs-all-1440", "", desktop],
      ["runs-all-1024", "", { width: 1024, height: 800, touch: false }],
      ["runs-all-390", "", { width: 390, height: 844, touch: true }],
      ["runs-jobs-failed-1440", "kind=job&status=failed", desktop],
      ["runs-job-record-1440", `kind=job&run=job:${"0".repeat(32)}:${"3".repeat(16)}`, desktop],
      ["runs-job-record-390", `kind=job&run=job:${"0".repeat(32)}:${"3".repeat(16)}`, { width: 390, height: 844, touch: true }],
      ["runs-empty-1440", "q=gibtesnicht", desktop],
      ["runs-schedules-1440", "tab=schedules", desktop],
      ["runs-schedules-390", "tab=schedules", { width: 390, height: 844, touch: true }],
    ];
    for (const [name, search, view] of cases) {
      const { context, tab, errors } = await open(view, `/admin/observability/runs${search ? `?${search}` : ""}`, { locale: "de" });
      try {
        const outline = await describeV2Page(tab, "#root");
        expect({ name, problems: outline.includes("Problems (") ? outline : "" }).toEqual({ name, problems: "" });
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ name, problems: layout.problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);

  test("the worst real data keeps the v2 rules and reads right at 1440 and 390 px", async () => {
    for (const view of [desktop, { width: 390, height: 844, touch: true }]) {
      const { context, tab, errors } = await open(view, "/admin/observability/runs", { locale: "de", state: "worst" });
      try {
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        expect({ width: view.width, problems: layout.problems }).toEqual({ width: view.width, problems: [] });
        const text = await tab.locator("#root").innerText();
        expect(text).not.toContain("1 Läufe");
        if (view === desktop) {
          expect(text).toContain("Alle 12.345 Jobs zeigen");
          expect(text).toContain("1 Tg. 3 Std.");
          expect(text).toContain("legacy-crm");
          expect(text).toContain("Kunden & Aufträge (Werkstatt Nord)");
        }
        await shoot(tab, `runs-worst-${view.width}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("1,000 job runs: the page holds one page of 100 rows, pages through all, and is ready fast", async () => {
    const started = performance.now();
    const { context, tab, errors } = await open(desktop, "/admin/observability/runs?kind=job", { locale: "de", state: "huge" });
    try {
      const ready = performance.now() - started;
      expect(await tab.getByText("100 von 1.000 Läufen").isVisible()).toBe(true);
      expect(await tab.getByText("Seite 1 von 10").isVisible()).toBe(true);
      expect(await tab.locator('[data-k2-part="Table"] tbody tr').count()).toBeLessThanOrEqual(101);
      expect(await tab.locator("#root *").count()).toBeLessThan(6000);
      // from a fresh browser context to a settled page, including the harness's own setup
      expect(ready).toBeLessThan(4500);
      await shoot(tab, "runs-huge-1440");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
