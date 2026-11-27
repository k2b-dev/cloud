import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page } from "@k2b/ui/v2/testing";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../../ui/test/browser";
import { measureSidebarGutter, SIDEBAR_GUTTER } from "../_components/sidebar/sidebar-gutter.test-fixture";

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

// `hostSearch` marks the v2 scope as the Cloud shell does on a signed-in page: its phone bar then owns the head's search.
const page = (sample: string, permission: string, hostSearch = false) =>
  `<!doctype html><html lang="de" class="light" data-sample="${sample}" data-permission="${permission}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
  `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
  `<body class="k2b-ui"><main class="k2-ui" id="root"${hostSearch ? " data-k2-host-search" : ""}></main><script src="/harness.js"></script></body></html>`;

const open = async (
  view: View,
  address: string,
  options: { sample?: string; permission?: "read" | "write"; hostSearch?: boolean } = {},
) => {
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
        body: page(options.sample ?? "normal", options.permission ?? "write", options.hostSearch),
      });
    }
    // the sidebar's filtered list (its quick filters); the guard below only needs the chips to answer
    if (/^\/api\/notebooks\/[^/]+\/tree\/list$/.test(url.pathname)) return route.fulfill({ json: { total: 0, offset: 0, items: [] } });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  // the list (or its empty state) stands; its size, not a wall-clock time, is what a large notebook must keep small
  // the table carries its phone rows too; one of the two is hidden at any width, so the page waits for it to stand
  await tab.locator('[data-k2-part="Table"], [data-k2-part="Empty"]').first().waitFor({ state: "attached" });
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, pages };
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
      // said once: unfiltered, the hero counts the notes and the filter bar does not
      expect(await tab.locator(".k2-fbar-results").count()).toBe(0);
      await tab.getByRole("button", { name: "Filter", exact: true }).click();
      await tab.getByRole("menuitem", { name: /Tag/ }).click();
      await tab.getByRole("option", { name: /#logistik/ }).click();
      await tab.keyboard.press("Escape");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("tag") === "logistik");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 2);
      expect(await titles(tab)).toEqual(["Tourenplanung KW 48", "Retouren Oktober"]);
      // a filter's result is counted in the bar
      expect(await tab.locator(".k2-fbar-results").textContent()).toBe("2 Notizen");
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
      // the name says what it searches; the placeholder stays short, so the head never cuts it
      expect(await search.getAttribute("placeholder")).toBe("Suchen");
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

  test("the sidebar's switcher, search, chips and rows start on the v2 gutter, and nothing touches its edge", async () => {
    const { context, tab, errors } = await open(wide, PATH);
    try {
      const { starts, touching } = await measureSidebarGutter(tab);
      expect(touching).toEqual([]);
      // one start for the whole sidebar: the top block on the rows' edge, the search field reaching as far as they do
      expect(starts.map(({ name, left }) => [name, left])).toEqual([
        ["switcher", SIDEBAR_GUTTER],
        ["search", SIDEBAR_GUTTER],
        ["chips", SIDEBAR_GUTTER],
        ["first row", SIDEBAR_GUTTER],
        ["foot row", SIDEBAR_GUTTER],
      ]);
      // the quick filters keep one line, and a chip that does not fit shortens its label instead of being cut
      const chips = await tab.evaluate(() => {
        const row = document.querySelector<HTMLElement>(".k2-ws-side .notebook-sidebar-chips")!;
        const end = row.getBoundingClientRect().right;
        const boxes = [...row.querySelectorAll<HTMLElement>(".notebook-sidebar-chip")].map((chip) => chip.getBoundingClientRect());
        return {
          overflow: row.scrollWidth - row.clientWidth,
          lines: new Set(boxes.map((box) => Math.round(box.top))).size,
          past: boxes.filter((box) => box.right > end + 0.5).length,
        };
      });
      expect(chips).toEqual({ overflow: 0, lines: 1, past: 0 });
      const right = Object.fromEntries(starts.map(({ name, right }) => [name, right]));
      expect([right.search, right["first row"], right["foot row"]]).toEqual([SIDEBAR_GUTTER, SIDEBAR_GUTTER, SIDEBAR_GUTTER]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("an order alone narrows nothing, so the bar shows no second count", async () => {
    const { context, tab, errors } = await open(wide, `${PATH}?sort=title.asc`);
    try {
      expect(await titles(tab)).toHaveLength(10);
      expect(await tab.locator(".k2-fbar-results").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("choosing a long tag in the sidebar shortens only the tag chip; Favoriten and Zuletzt keep their place and width", async () => {
    const { context, tab, errors } = await open(wide, PATH, { sample: "worst" });
    try {
      const fixed = () =>
        tab.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".k2-ws-side .notebook-sidebar-chips > .notebook-sidebar-chip")].map((chip) => {
            const box = chip.getBoundingClientRect();
            return [Math.round(box.left), Math.round(box.width)];
          }),
        );
      const before = await fixed();
      expect(before).toHaveLength(2);
      await tab.locator(".k2-ws-side .notebook-sidebar-chip-host .notebook-sidebar-chip").click();
      await tab.getByRole("menuitemradio", { name: /sehr-langer-tag-name-ohne-ende/ }).click();
      await tab.waitForFunction(
        () =>
          document.querySelector(".k2-ws-side .notebook-sidebar-chip-host .k2b-truncate-fade")?.textContent ===
          "sehr-langer-tag-name-ohne-ende",
      );
      await settled(tab);
      expect(await fixed()).toEqual(before);
      const row = await tab.evaluate(() => {
        const chips = document.querySelector<HTMLElement>(".k2-ws-side .notebook-sidebar-chips")!;
        return chips.scrollWidth - chips.clientWidth;
      });
      expect(row).toBe(0);
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
      expect(await titles(tab)).toHaveLength(14);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on a phone in the Cloud shell the head shows no search of its own; the shell's bar reaches the same field", async () => {
    const { context, tab, errors } = await open(phone, PATH, { hostSearch: true });
    try {
      const field = tab.locator('[data-slot="head"] [data-k2-part="Input"][data-search] input');
      // one search place: the folded field takes no room and draws nothing in the head
      const box = await field.boundingBox();
      expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
      // the shell's phone bar focuses this field (`openPageSearch`), and it opens over the head
      await field.focus();
      await tab.waitForFunction(
        () =>
          (document.querySelector('[data-slot="head"] [data-k2-part="Input"][data-search] input')?.getBoundingClientRect().width ?? 0) >
          100,
      );
      await field.fill("Stand 4B");
      await field.press("Enter");
      await tab.waitForFunction(() => new URL(location.href).searchParams.get("q") === "Stand 4B");
      await tab.waitForFunction(() => document.querySelectorAll('[data-k2-part="List"] [data-k2-part="Row"]').length === 1);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("on a wide screen the notebook's figures lead, and each row shows who changed the note; the worst case fits", async () => {
    const { context, tab, errors } = await open(wide, PATH, { sample: "worst" });
    try {
      await expectOutlineClean(tab);
      await shoot(tab, "worst-light-1440");
      // the hero: the changes of 30 days with their real trend, then the notes (the last change would only repeat
      // the first row)
      const cells = tab.locator('[data-k2-part="Cells.Cell"]');
      expect(await cells.count()).toBe(2);
      expect(await cells.first().locator('[data-k2-part="Spark"] i').count()).toBe(30);
      // the data column: a stack of faces with every name, also for eight people
      const stack = tab.locator('[data-k2-part="Table"] [data-k2-part="Avatar.Stack"]').first();
      expect(await stack.getAttribute("aria-label")).toMatch(/^Zuletzt geändert von Maximiliane Alexandra .*Person 8$/);
      expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("1,200 notes: one page of 50 rows, and the next page by its address", async () => {
    const { context, tab, errors } = await open(wide, PATH, { sample: "huge" });
    try {
      expect(await titles(tab)).toHaveLength(50);
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
