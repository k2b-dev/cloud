import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { serializePanelCookie } from "../_internal/panel-cookie";

const root = mkdtempSync(resolve(tmpdir(), "cloud-help-panel-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const { documents, helpManifest, server, helpPanelGeometry } = await import("./LayoutHelpPanel.browser-harness");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const spies: { mockRestore(): void }[] = [];
let browser: Browser;
let origin: string;
let stop: (() => void) | undefined;

beforeAll(async () => {
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(helpManifest),
    spyOn(help, "getLayoutHelp").mockReturnValue(helpManifest),
  );
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile Help panel styles");
  const css = await styles.outputs[0]!.text();
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const entry = resolve(import.meta.dir, "LayoutHelpPanel.client-fixture.ts");
  const built = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import ShellRuntime from "./ShellRuntime.island";
import PanelRuntime from "./PanelRuntime.island";
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import { LayoutHelpPanel, LayoutHelpPage } from "./LayoutHelp";
import { readShellData } from "./shell-data";
const provider = !!document.querySelector("[data-cloud-panel-page]");
const helpRoot = document.getElementById("help-fixture-root");
const documents = ${JSON.stringify(documents)};
if (helpRoot) {
  const props = provider ? JSON.parse(document.getElementById("help-fixture-props").textContent) : { documents, initialTopic: "spaces-share", pageBase: "/help/apps/spaces" };
  helpRoot.innerHTML = "";
  render(() => createComponent(LocaleProvider, { locale: "en", get children() { return createComponent(provider ? LayoutHelpPanel : LayoutHelpPage, props); } }), helpRoot);
}
if (provider) render(() => createComponent(PanelRuntime, { provider: "core", scope: "/help/panel" }), document.createElement("div"));
else {
  // Mount the actual Help trigger in each server-rendered shell position, as the shell island does.
  const data = readShellData();
  for (const button of document.querySelectorAll('button[aria-label="Open help"]')) {
    const rail = button.classList.contains("rail-item");
    const mount = document.createElement("span"); mount.style.display = "contents";
    button.replaceWith(mount);
    render(() => createComponent(LayoutHelpTrigger, { variant: rail ? "rail" : "header", panel: true, helpOpen: document.querySelector(".cloud-app-canvas")?.dataset.panel === "open" && data?.panel?.provider === "core" }), mount);
  }
  render(() => createComponent(ShellRuntime, { panel: true, commands: { searchResources: false }, help: ${JSON.stringify(helpManifest)} }), document.createElement("div"));
}
document.documentElement.dataset.helpFirstFrame = JSON.stringify((${helpPanelGeometry.toString()})());
document.documentElement.dataset.helpMounted = "true";
`,
    },
    plugins: [
      {
        name: "solid-help-panel",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!transformed?.code) throw new Error(`Could not compile ${path}`);
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle Help panel runtime");
  const client = await built.outputs[0]!.text();
  const served = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/help-fixture.js") return new Response(client, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/help/search") return Response.json({ ids: [] });
      if (url.pathname.startsWith("/api/help/"))
        return Response.json({
          id: url.pathname.split("/").at(-1),
          title: "Share a Space",
          locale: "en",
          markdown: "Share",
          kind: "task",
          related: [],
          html: '<h2 id="share">Share</h2><p>Open Space settings.</p>',
        });
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const html = (await response.text())
        .replace(/<script type="module">[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace(
          "</body>",
          `<script>document.documentElement.dataset.helpServerFrame=JSON.stringify((${helpPanelGeometry.toString()})());</script><script src="/help-fixture.js"></script></body>`,
        );
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "Referrer-Policy": "same-origin" } });
    },
  });
  origin = `http://localhost:${served.port}`;
  stop = () => served.stop(true);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  stop?.();
  for (const spy of spies) spy.mockRestore();
});

const ready = (page: Page) =>
  page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "ready", undefined, { timeout: 10_000 });
const settled = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const frame = (page: Page) => page.frames().find((frame) => new URL(frame.url()).pathname === "/help/panel");
const railTrigger = (page: Page) => page.locator('.rail-item[aria-label="Open help"]');
const headerTrigger = (page: Page) => page.locator('.layout-header button[aria-label="Open help"]');
async function fixture(width: number, height: number, open = true, widthRem?: number) {
  const context = await browser.newContext({ viewport: { width, height }, locale: "en", timezoneId: "UTC", reducedMotion: "reduce" });
  context.setDefaultTimeout(10_000);
  await context.addInitScript(() =>
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: navigator.userAgent.includes("WebKit") && !navigator.userAgent.includes("Chrome") ? "MacIntel" : "Win32",
    }),
  );
  const cookie = serializePanelCookie({ open, provider: "core", widthRem }, false).split(";", 1)[0]!.slice("cloud_panel=".length);
  await context.addCookies([
    { name: "cloud_panel", value: cookie, url: origin },
    { name: "cloud.timezone", value: "UTC", url: origin },
  ]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/app/spaces`);
    await page.waitForFunction(() => document.documentElement.dataset.helpMounted === "true");
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}
for (const [width, height] of [
  [1440, 900],
  [1194, 834],
])
  test(`${width}: Help view and app area keep server geometry through mount and reload`, async () => {
    const { context, page } = await fixture(width!, height!);
    try {
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await page.reload();
        await ready(page);
        const provider = frame(page);
        if (!provider) throw new Error("Missing Help frame");
        await provider.waitForFunction(() => document.documentElement.dataset.helpMounted === "true");
        await settled(page);
        for (const targetPage of [page, provider]) {
          const server = await targetPage.evaluate(() => document.documentElement.dataset.helpServerFrame ?? "");
          expect(await targetPage.evaluate(() => document.documentElement.dataset.helpFirstFrame)).toBe(server);
          expect(JSON.stringify(await targetPage.evaluate(helpPanelGeometry))).toBe(server);
        }
        expect(await provider.locator("[data-help-view]").textContent()).toContain("Share a Space");
      }
    } finally {
      await context.close();
    }
  });

test("Escape and the platform panel shortcut close from the Help document and return to the rail trigger", async () => {
  const { context, page } = await fixture(1440, 900, false);
  try {
    const apple = await page.evaluate(() => navigator.platform === "MacIntel");
    for (const key of ["Escape", apple ? "Meta+j" : "Control+j"]) {
      await railTrigger(page).click();
      await ready(page);
      const provider = frame(page);
      if (!provider) throw new Error("Missing Help frame");
      await provider.locator("[data-help-search]").focus();
      await page.keyboard.press(key);
      await page.waitForFunction(() => document.getElementById("cloud-panel")?.dataset.state === "closed");
      expect(await railTrigger(page).evaluate((element) => element === document.activeElement)).toBe(true);
    }
  } finally {
    await context.close();
  }
});
for (const [width, height, form] of [
  [834, 1112, "drawer"],
  [390, 844, "sheet"],
] as const)
  test(`${form}: the visible Help button opens the existing slot`, async () => {
    const { context, page } = await fixture(width, height, false);
    try {
      await (width >= 768 ? railTrigger(page) : headerTrigger(page)).click();
      await ready(page);
      expect(await (width >= 768 ? railTrigger(page) : headerTrigger(page)).getAttribute("aria-expanded")).toBe("true");
      const rect = await page.locator("#cloud-panel").boundingBox();
      expect(rect).not.toBeNull();
      expect(rect!.x).toBeGreaterThanOrEqual(0);
      expect(rect!.y).toBeGreaterThanOrEqual(0);
      expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(height);
      expect(await frame(page)?.locator("[data-help-view]").isVisible()).toBe(true);
    } finally {
      await context.close();
    }
  });
for (const width of [1440, 390])
  test(`${width}: article head and TOC keep server geometry on the page without overflow`, async () => {
    const { context, page } = await fixture(width, 900, false);
    try {
      await page.goto(`${origin}/help/apps/spaces/spaces-share`);
      await page.locator(".help-document h2").waitFor();
      await settled(page);
      const server = await page.evaluate(() => document.documentElement.dataset.helpServerFrame ?? "");
      expect(await page.evaluate(() => document.documentElement.dataset.helpFirstFrame)).toBe(server);
      expect(JSON.stringify(await page.evaluate(helpPanelGeometry))).toBe(server);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
test("an article fits a 20rem panel column and leaves the panel URL unchanged", async () => {
  const { context, page } = await fixture(1440, 900, true, 20);
  try {
    await ready(page);
    const provider = frame(page);
    if (!provider) throw new Error("Missing Help frame");
    const url = provider.url();
    await provider.locator('[data-help-view] [data-help-topic="spaces-share"]').click();
    await provider.locator(".help-document h2").waitFor();
    expect(provider.url()).toBe(url);
    expect(await provider.locator(".help-article-head").count()).toBe(1);
    expect(await provider.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
