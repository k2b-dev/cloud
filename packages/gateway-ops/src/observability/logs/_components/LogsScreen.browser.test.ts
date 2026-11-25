import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import { LOGS_PER_PAGE, logSearchOf, logsApiParams, logsQuery, parseLogsAddress } from "../query";
import { FIXTURE_NOW, fixtureEntries, fixtureSearch } from "./logs-fixture-data";

// An operator filters the log list, the address keeps the state, and a reload shows the same entries. The test answers
// the list API from invented entries; the screen renders the address as the page does.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_LOGS_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "LogsScreen.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-logs-screen-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Logs screen harness build failed");
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

/** The list API as the server answers it: the same declaration reads the query, the invented entries stand in for the store. */
const answerList = (url: URL) => {
  const params = logsApiParams(url.searchParams, FIXTURE_NOW);
  const address = parseLogsAddress(logsQuery("en"), params, FIXTURE_NOW);
  if (address.issues.length > 0) return { status: 400, json: { message: "Invalid log filter" } };
  const perPage = Number(url.searchParams.get("per_page") ?? LOGS_PER_PAGE);
  const data = fixtureSearch(logSearchOf(address.state, FIXTURE_NOW), address.page);
  return {
    status: 200,
    json: {
      entries: data.entries,
      levels: data.levels,
      pagination: {
        page: address.page,
        per_page: perPage,
        total: data.total,
        total_pages: Math.ceil(data.total / perPage),
        has_next: false,
      },
    },
  };
};

type View = { width: number; height: number; touch: boolean };
const desktop: View = { width: 1440, height: 900, touch: false };

const open = async (view: View, address: string, options: { locale?: string; state?: string } = {}) => {
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
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/admin/observability/logs")
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: document(options.locale ?? "en", options.state ?? "normal") });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (url.pathname === "/api/logging/sources")
      return route.fulfill({ json: { sources: [...new Set(fixtureEntries.map((entry) => entry.source))].sort() } });
    if (url.pathname === "/api/logging" || url.pathname === "/api/logging/") {
      calls.push(url.search);
      const answer = answerList(url);
      return route.fulfill({ status: answer.status, json: answer.json });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.waitForSelector('body[data-ready="true"]');
  await tab.evaluate(() => window.document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, calls };
};

const rowTexts = (tab: Page) => tab.locator('[data-k2-part="Table"] tbody tr, [data-k2-part="Table"] [role="row"]').allInnerTexts();
const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("the log list on v2", () => {
  test("a filter writes the address, loads the list, and a reload shows the same entries", async () => {
    const { context, tab, errors, calls } = await open(desktop, "/admin/observability/logs?time=last-15m");
    try {
      expect(await tab.getByRole("group", { name: "Filters" }).innerText()).toContain("Time range last 15 minutes");
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Level" }).click();
      await tab.getByRole("option", { name: "Error" }).click();
      await tab.waitForURL(/level=error/);
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => window.document.body.innerText.includes("6 of 6 entries"));
      expect(calls.at(-1)).toContain("level=error");
      const filtered = await rowTexts(tab);
      expect(new URL(tab.url()).searchParams.get("level")).toBe("error");

      await tab.reload();
      await tab.waitForSelector('body[data-ready="true"]');
      await settled(tab);
      expect(await tab.getByRole("group", { name: "Filters" }).innerText()).toContain("Level is Error");
      expect(await rowTexts(tab)).toEqual(filtered);
      expect(await tab.getByText("6 of 6 entries").isVisible()).toBe(true);

      // back returns to the list before the filter
      await tab.goBack();
      await tab.waitForFunction(() => !location.search.includes("level="));
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("grouping by minute stays in the address; no match offers to reset", async () => {
    const { context, tab, errors } = await open(desktop, "/admin/observability/logs?time=last-15m&group=minute");
    try {
      expect(await tab.getByText("10:43", { exact: true }).first().isVisible()).toBe(true);
      await tab.reload();
      await tab.waitForSelector('body[data-ready="true"]');
      expect(new URL(tab.url()).searchParams.get("group")).toBe("minute");
      const empty = await open(desktop, "/admin/observability/logs?time=last-15m&q=nothing-here");
      try {
        expect(await empty.tab.getByText("No entries match these filters.").isVisible()).toBe(true);
        await empty.tab.getByRole("link", { name: "Reset filters" }).click();
        await empty.tab.waitForURL((url) => !url.search.includes("q="));
      } finally {
        await empty.context.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on the phone the search stays reachable through the menu, and an open entry keeps its copy button", async () => {
    const { context, tab, errors, calls } = await open({ width: 390, height: 844, touch: true }, "/admin/observability/logs?time=last-15m");
    try {
      await tab.getByRole("button", { name: "More log actions" }).click();
      await tab.getByRole("menuitem", { name: "Search messages …" }).click();
      await tab.getByRole("dialog").getByRole("searchbox").fill("Greylisting");
      await tab.keyboard.press("Enter");
      await tab.waitForURL(/q=Greylisting/);
      await tab.waitForFunction(() => window.document.body.innerText.includes("3 of 3 entries"));
      expect(calls.at(-1)).toContain("q=Greylisting");
      const entry = await open({ width: 390, height: 844, touch: true }, "/admin/observability/logs?time=last-15m&entry=9001");
      try {
        expect(await entry.tab.getByRole("button", { name: "Copy", exact: true }).isVisible()).toBe(true);
        expect(entry.errors).toEqual([]);
      } finally {
        await entry.context.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the screen keeps the v2 rules at 1440, 1024 and 390 px", async () => {
    const cases: [string, string, View][] = [
      ["logs-live-1440", "time=last-15m&level=error,warn&source=mail,gateway&group=minute", desktop],
      ["logs-live-1024", "time=last-15m&level=error,warn&source=mail,gateway&group=minute", { width: 1024, height: 800, touch: false }],
      ["logs-live-390", "time=last-15m&level=error,warn&source=mail,gateway&group=minute", { width: 390, height: 844, touch: true }],
      ["logs-zeitraum-vergangen-1440", "time=2026-11-24T09:30Z..2026-11-24T09:41Z&level=error,warn", desktop],
      ["logs-keine-treffer-1440", "time=last-15m&q=Zertifikat", desktop],
      ["logs-keine-treffer-390", "time=last-15m&q=Zertifikat", { width: 390, height: 844, touch: true }],
      ["logs-eintrag-1440", "time=last-15m&level=error&entry=9001", desktop],
      ["logs-eintrag-390", "time=last-15m&level=error&entry=9001", { width: 390, height: 844, touch: true }],
      ["logs-speicher-fehlt-1440", "time=last-15m", desktop],
    ];
    for (const [name, search, view] of cases) {
      const { context, tab, errors } = await open(view, `/admin/observability/logs?${search}`, {
        locale: "de",
        state: name.includes("speicher-fehlt") ? "loadfail" : "normal",
      });
      try {
        const outline = await describeV2Page(tab, "#root");
        expect(outline).not.toContain("Problems (");
        const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
        // k2b-ui gap: 1 – the filter statement's 12/28 text is not one of the v2 type roles yet; only these two findings.
        const problems = layout.problems.filter(
          (problem) => !/^text outside the type roles: 12px\/28px (400 in button\.k2-stmt-b|600 in b)( |$)/.test(problem),
        );
        expect({ name, problems }).toEqual({ name, problems: [] });
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
    // the editors of the time range and the level, open over the list
    for (const [name, statement] of [
      ["logs-zeitraum-editor-1440", 0],
      ["logs-stufe-editor-1440", 1],
    ] as const) {
      const { context, tab, errors } = await open(desktop, "/admin/observability/logs?time=last-15m&level=error,warn", { locale: "de" });
      try {
        await tab.locator('[data-k2-part="Statement"] button.k2-stmt-b').nth(statement).click();
        await tab.locator('[data-k2-part="FilterEditor"]').waitFor();
        await settled(tab);
        await shoot(tab, name);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 180_000);
});
