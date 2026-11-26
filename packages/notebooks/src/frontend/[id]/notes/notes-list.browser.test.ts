import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";

// The notes list in a real browser: a tag filter and the search write the address and the list follows it, favorites
// are a tab, a reader stays in Book, the phone shows the worst case without sideways scrolling, and 1,200 notes keep
// the page at 50 rows. The test stands in for the server: the page renders the sample for its address.
const ui = resolve(import.meta.dir, "../../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_NOTEBOOKS_NOTES_SHOTS;
const PATH = "/app/notebooks/Lager1/notes";

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notes-list.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-notes-list-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Notes list harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", `${resolve(import.meta.dir, "../../../../../cloud")}/`))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
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
  // the sidebar body is still v1 (k2b-ui gap: Nav tree), so the page loads Cloud's and the app's stylesheets beside v2
  const [globalCss, appCss] = await Promise.all([
    buildCss(resolve(import.meta.dir, "../../../../../../styles.css")),
    buildCss(resolve(import.meta.dir, "../../../styles/app.css")),
  ]);
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", globalCss, appCss, v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean };
const wide: View = { width: 1440, height: 900, touch: false };
const phone: View = { width: 390, height: 844, touch: true };

const page = (sample: string, permission: string) =>
  `<!doctype html><html lang="de" class="light" data-sample="${sample}" data-permission="${permission}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui"><main class="k2-ui" id="root"></main><script src="/harness.js"></script></body></html>`;

const open = async (view: View, address: string, options: { sample?: string; permission?: "read" | "write" } = {}) => {
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
  const pages: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === PATH) {
      pages.push(url.search);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: page(options.sample ?? "normal", options.permission ?? "write"),
      });
    }
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  // time from the start of the navigation until the list stands, measured in the page
  const ready = await tab.evaluate(
    () =>
      new Promise<number>((done) => {
        const check = () =>
          document.querySelector('[data-k2-part="List"], [data-k2-part="Empty"]') ? done(performance.now()) : requestAnimationFrame(check);
        check();
      }),
  );
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, pages, ready };
};

const titles = (tab: Page) => tab.locator('[data-k2-part="List"] [data-k2-part="Row"] .k2-row-title').allTextContents();
const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `notebooks-notes-v2-${name}.png`) });
};
const expectOutlineClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
};

describe("the notes list on v2", () => {
  test("a tag filter writes the address, the list follows it, and a reload shows the same notes", async () => {
    const { context, tab, errors, pages } = await open(wide, PATH);
    try {
      expect(await titles(tab)).toHaveLength(10);
      await expectOutlineClean(tab);
      await shoot(tab, "light-1440");
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: /Tag/ }).click();
      await tab.getByRole("option", { name: /#logistik/ }).click();
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("tag") === "logistik");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 2);
      expect(await titles(tab)).toEqual(["Tourenplanung KW 48", "Retouren Oktober"]);
      await tab.reload();
      await settled(tab);
      expect(await titles(tab)).toEqual(["Tourenplanung KW 48", "Retouren Oktober"]);
      expect(pages.at(-1)).toBe("?tag=logistik");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the search in the head finds a note by its text; favorites are a tab", async () => {
    const { context, tab, errors } = await open(wide, PATH);
    try {
      const search = tab.getByRole("searchbox", { name: "Notizen durchsuchen" });
      await search.fill("Stand 4B");
      await search.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Stand 4B");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 1);
      expect(await titles(tab)).toEqual(["Messe Leipzig"]);
      await tab.getByRole("link", { name: "Favoriten" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("view") === "favorites");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 5);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("a reader in Book opens notes in Book and cannot create one", async () => {
    const { context, tab, errors } = await open(wide, `${PATH}?mode=book`, { permission: "read" });
    try {
      const first = tab.locator('[data-k2-part="List"] [data-k2-part="Row"] a').first();
      expect(await first.getAttribute("href")).toMatch(/\/app\/notebooks\/Lager1\/notes\/N\d{5}\?mode=book$/);
      expect(await tab.getByRole("button", { name: "Neue Notiz" }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("open on phone: the worst case stays within the phone's width", async () => {
    const { context, tab, errors } = await open(phone, PATH, { sample: "worst" });
    try {
      await expectOutlineClean(tab);
      await shoot(tab, "worst-light-390");
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(await titles(tab)).toHaveLength(12);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("1,200 notes: one page of 50 rows, ready quickly, the next page by its address", async () => {
    const { context, tab, errors, ready } = await open(wide, PATH, { sample: "huge" });
    try {
      expect(await titles(tab)).toHaveLength(50);
      expect(ready).toBeLessThan(1500);
      expect(await tab.getByText("Seite 1 von 24").count()).toBe(1);
      // the DOM stays bounded by the page, not by the notebook
      expect(await tab.evaluate(() => document.querySelectorAll("*").length)).toBeLessThan(4000);
      await tab.getByRole("link", { name: "Weiter" }).click();
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("page") === "2");
      await tab.getByText("Seite 2 von 24").waitFor();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
