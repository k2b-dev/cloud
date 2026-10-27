import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";

// The real Browser in its search states, with fictional data; marks, chips and row geometry need a layout engine.
const ui = new URL("../../../ui/", import.meta.url).pathname;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./Search.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "solid-search-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Search harness build failed");
  return build.outputs[0]!.text();
};

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
let harness: string;
let css: string;
beforeAll(async () => {
  [harness, css] = await Promise.all([buildHarness(), appHostCss(resolve(import.meta.dir, "../styles/app.css"))]);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const page = (lang: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><style>${css}</style></head>` +
  `<body class="k2b-ui" data-theme="light" style="margin:0;height:100vh"><div id="root" style="height:100vh;display:flex"></div>` +
  `<script src="/harness.js"></script></body></html>`;

const open = async (options: BrowserContextOptions, hash: string, lang = "en") => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.route("http://files-search.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/app/filesv2") return route.fulfill({ contentType: "text/html", body: page(lang) });
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: readFileSync(`${ui}dist/tabler.css`, "utf8") });
    if (path.endsWith(".woff2")) return route.fulfill({ contentType: "font/woff2", body: readFileSync(`${ui}dist${path}`) });
    return route.fulfill({ status: 404, body: "{}" });
  });
  await tab.goto(`http://files-search.test/app/filesv2#${hash}`);
  await tab.waitForSelector(".filesv2-browser__header");
  await tab.evaluate(() => document.fonts.ready);
  return { tab, errors };
};
/** Another state of the same page: the harness follows the hash without loading again. */
const show = (tab: Page, hash: string) => tab.evaluate((next) => (window.location.hash = next), hash);
const requested = async (tab: Page) => JSON.parse((await tab.getAttribute("#root", "data-search")) ?? "undefined");
const box = (tab: Page, selector: string) =>
  tab.$eval(selector, (element) => {
    const { top, height } = element.getBoundingClientRect();
    return { top, height };
  });

describe("Files search in a browser", () => {
  for (const [device, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${device}: results mark the match in name and folder and count all hits; loading keeps the geometry`, async () => {
      const { tab, errors } = await open(options, "results");
      try {
        const row = tab.locator(".filesv2-list__row", { hasText: "Rechnung Oktober.pdf" });
        expect(await row.locator(".filesv2-list__name mark").allTextContents()).toEqual(["Rechnung"]);
        expect(await row.locator(".filesv2-list__detail").textContent()).toBe("Kunden/Bäckerei Sonnenschein");
        // A folder segment that matched is marked too; a hit directly in the folder names that folder.
        const nested = tab.locator(".filesv2-list__row", { hasText: "Rechnung-2026-031.pdf" });
        expect(await nested.locator(".filesv2-list__detail mark").allTextContents()).toEqual(["Rechnung"]);
        expect(await tab.locator(".filesv2-list__row", { hasText: "Team Nordlicht" }).locator(".filesv2-list__name").textContent()).toBe(
          "Rechnungen",
        );
        expect(await tab.locator(".filesv2-toolbar").textContent()).toContain("7 results");
        expect(await tab.getByRole("group", { name: "Search filters" }).getByRole("button").count()).toBe(3);
        // The list, grid and tree switch has no meaning for results.
        expect(await tab.getByRole("radiogroup", { name: "View" }).isVisible()).toBe(false);
        await settled(tab);
        const heights = await tab.$$eval(".filesv2-list__row", (rows) => rows.map((item) => item.getBoundingClientRect().height));
        expect(new Set(heights)).toEqual(new Set([40]));
        const mark = await row.locator(".filesv2-list__name mark").evaluate((element) => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, padding: style.paddingLeft };
        });
        expect(mark.background).not.toBe("rgba(0, 0, 0, 0)");
        expect(mark.padding).toBe("0px");
        expect(await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

        const toolbar = await box(tab, ".filesv2-toolbar");
        const firstHit = await box(tab, ".filesv2-list__row");
        await show(tab, "loading");
        await tab.waitForSelector(".filesv2-search-loading");
        await settled(tab);
        // Nothing above the results moves, and the placeholder rows sit where the hits were.
        expect(await box(tab, ".filesv2-toolbar")).toEqual(toolbar);
        expect(await tab.locator(".filesv2-toolbar").textContent()).toContain("Searching…");
        const rows = await tab.$$eval(".filesv2-search-loading__row", (items) => items.map((item) => item.getBoundingClientRect()));
        expect(new Set(rows.map((item) => item.height))).toEqual(new Set([40]));
        expect(rows[0]!.top).toBe(firstHit.top);
        expect(await tab.locator(".filesv2-list__row").count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await tab.context().close();
      }
    });
  }

  test("filter chips ask for the next search and keep the query; an empty filtered search offers Reset filters", async () => {
    const { tab } = await open(desktop, "results");
    try {
      await tab.getByRole("button", { name: "Type" }).click();
      await tab.getByRole("menuitemradio", { name: "PDFs" }).click();
      expect(await requested(tab)).toMatchObject({ q: "rechnung", kind: "pdf" });
      await show(tab, "empty?kind=pdf&modified=week");
      const message = tab.getByText("Nothing below this folder matches the search and its filters.");
      await message.waitFor();
      await tab.getByRole("button", { name: "Reset filters" }).last().click();
      const next = await requested(tab);
      expect(next).toMatchObject({ q: "rechnung" });
      expect(next.kind).toBeUndefined();
      expect(next.modified).toBeUndefined();
    } finally {
      await tab.context().close();
    }
  });

  test("a spent search budget explains itself and offers exact names or the folder; other failures offer a retry", async () => {
    const { tab } = await open(phone, "limited");
    try {
      expect(await tab.getByText("This search takes too long").isVisible()).toBe(true);
      // A failure shows no count of zero results.
      expect(await tab.locator(".filesv2-toolbar").textContent()).not.toContain("result");
      await tab.getByRole("button", { name: "Search exact names" }).click();
      expect(await requested(tab)).toMatchObject({ q: "rechnung", exact: true });
      await tab.getByRole("button", { name: "Show folder" }).click();
      expect(await requested(tab)).toBeNull();
      expect(await tab.getByRole("searchbox").inputValue()).toBe("rechnung");
      await show(tab, "error");
      await tab.getByText("The search failed").waitFor();
      await tab.getByRole("button", { name: "Try again" }).click();
      expect(await tab.getAttribute("#root", "data-retried")).toBe("true");
    } finally {
      await tab.context().close();
    }
  });

  test("German: an unknown total says how many hits this page holds", async () => {
    const { tab } = await open(desktop, "unknown", "de");
    try {
      expect(await tab.locator(".filesv2-toolbar").textContent()).toContain("7 Treffer auf dieser Seite");
      expect(await tab.getByRole("button", { name: "Typ" }).isVisible()).toBe(true);
    } finally {
      await tab.context().close();
    }
  });
});
