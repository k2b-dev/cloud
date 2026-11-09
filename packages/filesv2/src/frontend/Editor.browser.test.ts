import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { editorBases, editorDirectory, editorFolder, editorLaunch, officeOrigin } from "./Editor.browser-fixtures";

// The office editor in the real workspace: nothing above Collabora's frame, and its close returns to the folder.
const ui = new URL("../../../ui/", import.meta.url).pathname;

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./Editor.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "solid-editor-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Editor harness build failed");
  return build.outputs[0]!.text();
};

const desktop: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const origin = "http://files-editor.test";
const folderUrl = `/app/filesv2?base=${encodeURIComponent(editorBases.items[0]!.id)}&path=${editorFolder}`;
const opened = `${editorFolder}/lieferant-30.ods`;

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

const page =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<link rel="stylesheet" href="/tabler.css"><style>${"${css}"}</style></head>` +
  `<body class="k2b-ui" data-theme="light" style="margin:0;height:100vh">` +
  `<div class="cloud-app-canvas" data-app-base="/app/filesv2" data-nav-shell="" style="height:100vh;display:flex">` +
  `<div id="root" style="flex:1;min-width:0;display:flex"></div></div><script src="/harness.js"></script></body></html>`;
/** Collabora's page as far as Cloud sees it: it reports the document loaded and posts UI_Close from its own close button. */
const office = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;font:14px sans-serif;background:#eef5ee">
<div style="display:flex;align-items:center;gap:8px;padding:8px;background:#1e6b1e;color:white">
<span style="flex:1">lieferant-30.ods</span><button id="close" aria-label="Close document">✕</button></div>
<script>
const post = (message) => parent.postMessage(JSON.stringify(message), "*");
post({ MessageId: "App_LoadingStatus", Values: { Status: "Frame_Ready" } });
post({ MessageId: "App_LoadingStatus", Values: { Status: "Document_Loaded" } });
document.getElementById("close").onclick = () => post({ MessageId: "UI_Close", Values: { EverModified: false } });
</script></body></html>`;

const open = async (options: BrowserContextOptions, path: string) => {
  const context = await browser.newContext({ ...options, reducedMotion: "reduce" });
  const tab = await context.newPage();
  const errors = pageErrors(tab);
  await context.route(`${officeOrigin}/**`, (route) => route.fulfill({ contentType: "text/html", body: office }));
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/app/filesv2") return route.fulfill({ contentType: "text/html", body: page.replace("${css}", css) });
    if (path === "/harness.js") return route.fulfill({ contentType: "text/javascript", body: harness });
    if (path === "/tabler.css") return route.fulfill({ contentType: "text/css", body: readFileSync(`${ui}dist/tabler.css`, "utf8") });
    if (path.endsWith(".woff2")) return route.fulfill({ contentType: "font/woff2", body: readFileSync(`${ui}dist${path}`) });
    if (path === "/api/filesv2/bases") return route.fulfill({ json: editorBases });
    if (path.endsWith("/entries")) return route.fulfill({ json: editorDirectory() });
    if (path.endsWith("/entry")) {
      const entry = editorDirectory().items.find((item) => item.path === url.searchParams.get("path"));
      return route.fulfill(entry ? { json: { base: editorBases.items[0], entry } } : { status: 404, json: {} });
    }
    if (path.endsWith("/trash")) return route.fulfill({ json: { entries: [], next: null } });
    if (path.endsWith("/editor")) return route.fulfill({ json: editorLaunch(route.request().postDataJSON().path) });
    return route.fulfill({ status: 404, json: {} });
  });
  await tab.goto(`${origin}${path}`);
  await tab.evaluate(() => document.fonts.ready);
  return { tab, errors };
};
const here = (tab: Page) => tab.evaluate(() => `${location.pathname}${location.search}`);
const listing = (tab: Page) => tab.locator("[data-scroll-preserve^='filesv2:']").first();
const row = (tab: Page, name: string) => tab.locator(".filesv2-list__row", { hasText: name });
/** The editor fills the workspace: no head, way up, or title row stands above Collabora's frame. */
const expectBareEditor = async (tab: Page) => {
  const frame = tab.locator("iframe");
  await frame.waitFor();
  await tab.frameLocator("iframe").locator("#close").waitFor();
  await settled(tab);
  for (const selector of ["[data-k2b-page-trail-up]", "[data-k2b-page-trail-link]", ".k2b-page-title__back", ".k2b-page-title__trail"])
    expect(await tab.locator(selector).count()).toBe(0);
  expect(await tab.locator(".k2b-app-workspace__head").evaluateAll((heads) => heads.filter((head) => head.checkVisibility()).length)).toBe(
    0,
  );
  const top = await frame.evaluate((element) => element.getBoundingClientRect().top);
  const workspaceTop = await tab
    .locator("[data-k2b-app-workspace]")
    .first()
    .evaluate((element) => element.getBoundingClientRect().top);
  expect(top - workspaceTop).toBeLessThanOrEqual(1);
};

describe("Files office editor", () => {
  for (const [name, options] of [
    ["desktop", desktop],
    ["phone", phone],
  ] as const) {
    test(`${name}: opened from a folder, Collabora's close returns to its scroll position and selected row`, async () => {
      const { tab, errors } = await open(options, folderUrl);
      await row(tab, "lieferant-30.ods").waitFor();
      await listing(tab).evaluate((element) => {
        element.scrollTop = 600;
      });
      await row(tab, "lieferant-30.ods").click();
      await settled(tab);
      const selected = await here(tab);
      expect(new URL(selected, origin).searchParams.get("file")).toBe(opened);
      const scrolled = await listing(tab).evaluate((element) => element.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      // A phone opens the selected file from its details, a desktop from its row.
      if (name === "phone") await tab.locator(".k2b-app-workspace__detail").getByRole("button", { name: "Edit", exact: true }).click();
      else await row(tab, "lieferant-30.ods").dblclick();
      await expectBareEditor(tab);
      expect(new URL(await here(tab), origin).searchParams.get("view")).toBe("edit");
      const entries = await tab.evaluate(() => history.length);

      await tab.frameLocator("iframe").locator("#close").click();
      await tab.locator("iframe").waitFor({ state: "detached" });
      await row(tab, "lieferant-30.ods").waitFor();
      await settled(tab);
      expect(await here(tab)).toBe(selected);
      expect(await tab.evaluate(() => history.length)).toBe(entries);
      expect(await row(tab, "lieferant-30.ods").getAttribute("aria-selected")).toBe("true");
      expect(Math.abs((await listing(tab).evaluate((element) => element.scrollTop)) - scrolled)).toBeLessThanOrEqual(2);

      // Browser Forward reopens the document, and Back leaves it the same way.
      await tab.goForward();
      await expectBareEditor(tab);
      await tab.goBack();
      await row(tab, "lieferant-30.ods").waitFor();
      expect(await here(tab)).toBe(selected);
      expect(errors).toEqual([]);
      await tab.context().close();
    }, 60_000);
  }

  test("opened by its address, the editor closes in its place to the folder with the document's row selected", async () => {
    const { tab, errors } = await open(phone, `${folderUrl}&file=${encodeURIComponent(opened)}&view=edit`);
    await expectBareEditor(tab);
    const entries = await tab.evaluate(() => history.length);
    await tab.frameLocator("iframe").locator("#close").click();
    await row(tab, "lieferant-30.ods").waitFor();
    expect(await here(tab)).toBe(`${folderUrl}&file=${encodeURIComponent(opened)}`);
    expect(await tab.evaluate(() => history.length)).toBe(entries);
    expect(await row(tab, "lieferant-30.ods").getAttribute("aria-selected")).toBe("true");
    expect(errors).toEqual([]);
    await tab.context().close();
  }, 60_000);

  test("Trash offers its own way back only where the sidebar is not beside it", async () => {
    const trash = `/app/filesv2?base=${encodeURIComponent(editorBases.items[0]!.id)}&view=trash`;
    for (const [options, visible] of [
      [desktop, false],
      [phone, true],
    ] as const) {
      const { tab, errors } = await open(options, trash);
      const back = tab.locator("a.filesv2-compact-back");
      await back.waitFor({ state: "attached" });
      expect(await back.isVisible()).toBe(visible);
      if (visible) {
        await back.click();
        await row(tab, "lieferant-01.ods").waitFor();
        expect(await here(tab)).toBe(`/app/filesv2?base=${encodeURIComponent(editorBases.items[0]!.id)}`);
      }
      expect(errors).toEqual([]);
      await tab.context().close();
    }
  }, 60_000);
});
