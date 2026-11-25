import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../../../ui/test/browser";

// The Help reader on v2: a person opens an article in place, goes back, searches, copies, and opens a link to another
// article; reload and Back show the same article. The test stands in for Core's Help API with invented articles.
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const shots = process.env.CLOUD_HELP_V2_SHOTS;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "HelpReader.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-help-v2-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Help v2 harness build failed");
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
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  const v2Css = readFileSync(fileURLToPath(import.meta.resolve("@k2b/ui/v2.css")), "utf8");
  css = ["@layer properties, theme, base, components, utilities;", await build.outputs[0]!.text(), v2Css].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const views: View[] = [
  { width: 1440, height: 900, touch: false, name: "1440" },
  { width: 1024, height: 768, touch: false, name: "1024" },
  { width: 390, height: 844, touch: true, name: "390" },
];

const articleHtml = (id: string) =>
  id === "roles"
    ? '<p>Who may do what.</p><h2 id="levels">Levels</h2><p>See <a href="/help/apps/spaces/share">Share a Space</a>.</p>'
    : '<p>Invite a person by name.</p><h2 id="invite">Invite</h2><div class="help-steps"><ol><li>Open the Space.</li><li>Choose Share.</li></ol></div>';

const open = async (view: View, address = "/panel", options: { searchFails?: boolean } = {}) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
    colorScheme: "light",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(10_000);
  const errors = pageErrors(tab);
  const reads: string[] = [];
  await tab.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/panel" || url.pathname.startsWith("/help/apps/spaces"))
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          '<!doctype html><html lang="en" class="light"><head><meta charset="utf-8">' +
          `<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/tabler-icons.css">` +
          `<style>${css}</style><style>html,body{height:100%;margin:0}#root{position:fixed;inset:0;display:flex}</style></head>` +
          '<body class="k2b-ui k2-ui"><div id="root"></div><script src="/harness.js"></script></body></html>',
      });
    const document = /^\/api\/help\/v1\/spaces\/documents\/([^/]+)$/.exec(url.pathname)?.[1];
    if (document) {
      reads.push(document);
      return route.fulfill({
        json: {
          id: document,
          title: document,
          locale: "en",
          html: articleHtml(document),
          markdown: `# ${document}`,
          kind: "task",
          related: [],
        },
      });
    }
    if (url.pathname === "/api/help/v1/spaces/search")
      return options.searchFails
        ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { ids: url.searchParams.get("q") === "who" ? ["roles"] : [] } });
    if (url.pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (url.pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (url.pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}${address}`);
  await tab.evaluate(() => document.fonts.ready);
  await settled(tab);
  return { context, tab, errors, reads };
};

const expectClean = async (tab: Page) => {
  await tab.mouse.move(0, 0);
  const outline = await describeV2Page(tab, "#root");
  expect(outline.includes("Problems (") ? outline : "").toBe("");
  const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
  expect(layout.problems).toEqual([]);
  expect(await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
};
const detail = (tab: Page) => tab.locator('[data-k2-part="Pane"][data-detail]');
const phone = views[2]!;
const wide = views[0]!;

describe("the Help reader on v2", () => {
  for (const view of views)
    test(`${view.name} px: the start and an open article are clean`, async () => {
      const { context, tab, errors } = await open(view);
      try {
        await tab.getByRole("region", { name: "For this view" }).waitFor();
        await expectClean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `01-help-v2-start-${view.name}.png`) });
        await tab
          .getByRole("link", { name: /Share a Space/ })
          .first()
          .click();
        await detail(tab).getByText("Choose Share.").waitFor();
        await expectClean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `02-help-v2-article-${view.name}.png`) });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });

  test("an article opens in place, its address survives a reload, and Back returns to the start", async () => {
    const { context, tab, reads } = await open(phone);
    try {
      await tab.getByRole("link", { name: /Plan tasks/ }).click();
      await detail(tab).getByText("Choose Share.").waitFor();
      expect(new URL(tab.url()).searchParams.get("topic")).toBe("tasks");
      expect(reads).toEqual(["tasks"]);
      await tab.reload();
      await settled(tab);
      await detail(tab).waitFor();
      await tab.goBack();
      await tab.getByRole("region", { name: "For this view" }).waitFor();
      expect(await detail(tab).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("the server's article shows at once, and a link to another article of the app opens in place", async () => {
    const { context, tab, reads } = await open(wide, "/panel?topic=share");
    try {
      await detail(tab).getByText("Choose Share.").waitFor();
      expect(reads).toEqual([]);
      await detail(tab).getByRole("link", { name: /Roles/ }).click();
      await detail(tab).getByText("Who may do what.").first().waitFor();
      expect(new URL(tab.url()).searchParams.get("topic")).toBe("roles");
      await detail(tab).getByRole("link", { name: "Share a Space" }).click();
      await detail(tab).getByText("Choose Share.").waitFor();
    } finally {
      await context.close();
    }
  });

  test("the search finds titles at once and full text after a pause; a failed full-text search says so", async () => {
    const { context, tab } = await open(wide);
    try {
      await tab.getByRole("searchbox").fill("who");
      await tab
        .getByRole("region", { name: /result/ })
        .getByRole("link", { name: /Roles/ })
        .waitFor();
      await tab.getByRole("searchbox").fill("zzz");
      await tab.getByText("No help topic matches this search.").waitFor();
      await tab.getByRole("searchbox").press("Escape");
      await tab.getByRole("region", { name: "For this view" }).waitFor();
    } finally {
      await context.close();
    }
    const failing = await open(wide, "/panel", { searchFails: true });
    try {
      await failing.tab.getByRole("searchbox").fill("share");
      await failing.tab.getByText("Titles only").waitFor();
      await failing.tab
        .getByRole("region", { name: /result/ })
        .getByRole("link", { name: /Share a Space/ })
        .waitFor();
    } finally {
      await failing.context.close();
    }
  });

  test("the menu copies the open article as Markdown and offers the full page", async () => {
    const { context, tab } = await open(wide, "/panel?topic=share");
    try {
      await tab.getByRole("button", { name: "More Help actions" }).click();
      expect(await tab.getByRole("menuitem", { name: "Open as page" }).getAttribute("href")).toBe("/help/apps/spaces/share");
      await tab.getByRole("menuitem", { name: "Copy as Markdown" }).click();
      await tab.getByText("Article copied as Markdown").waitFor();
      expect(await tab.evaluate(() => navigator.clipboard.readText())).toContain("Invite a person by name.");
    } finally {
      await context.close();
    }
  });

  test("on the app's Help route the article is in the path", async () => {
    const { context, tab } = await open(wide, "/help/apps/spaces");
    try {
      await tab.getByRole("link", { name: /Roles/ }).first().click();
      await detail(tab).getByText("Who may do what.").first().waitFor();
      expect(new URL(tab.url()).pathname).toBe("/help/apps/spaces/roles");
    } finally {
      await context.close();
    }
  });

  for (const view of [wide, phone])
    test(`${view.name} px: the worst case stays readable and nothing overflows`, async () => {
      const { context, tab, errors } = await open(view, "/panel?worst");
      try {
        await tab.getByRole("region", { name: "For this view" }).waitFor();
        await expectClean(tab);
        if (shots) await tab.screenshot({ path: join(shots, `03-help-v2-worst-${view.name}.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
});
