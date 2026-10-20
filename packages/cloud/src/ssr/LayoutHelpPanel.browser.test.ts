import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { panelIslandEntries } from "../../../../scripts/fixtures/help-panel";
import { buildIslandClosure } from "../../../../scripts/fixtures/island-closure";
import { islandIdFromFile } from "../../../ssr/src/island-id";
import { launchBrowser } from "../../../ui/test/browser";
import { serializePanelCookie } from "../_internal/panel-cookie";

const root = mkdtempSync(resolve(tmpdir(), "cloud-help-panel-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
setDefaultTimeout(30_000);
const { helpManifest, server, helpPanelGeometry, fixtureDocument } = await import("./LayoutHelpPanel.browser-harness");
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
  // The host and the Help page keep their plain client fixture; the provider document loads the real islands below.
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
import LayoutHelpTrigger from "./LayoutHelpTrigger";
import { LayoutHelpPage } from "./LayoutHelp";
import { readShellData } from "./shell-data";
const helpRoot = document.getElementById("help-fixture-root");
if (helpRoot) {
  const props = JSON.parse(document.getElementById("help-fixture-props").textContent);
  helpRoot.innerHTML = "";
  render(() => createComponent(LocaleProvider, { locale: "en", get children() { return createComponent(LayoutHelpPage, props); } }), helpRoot);
}
// Mount the actual Help trigger in each server-rendered shell position, as the shell island does.
const data = readShellData();
for (const button of document.querySelectorAll('button[aria-label="Open help"]')) {
  const rail = button.classList.contains("rail-item");
  const mount = document.createElement("span"); mount.style.display = "contents";
  button.replaceWith(mount);
  render(() => createComponent(LayoutHelpTrigger, { variant: rail ? "rail" : "header", panel: true, helpOpen: document.querySelector(".cloud-app-canvas")?.dataset.panel === "open" && data?.panel?.provider === "core" }), mount);
}
render(() => createComponent(ShellRuntime, { panel: true, commands: { searchResources: false }, help: ${JSON.stringify(helpManifest)} }), document.createElement("div"));
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
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle Help host runtime");
  const client = await built.outputs[0]!.text();
  // The provider document is Core's server component; its small islands mount with the production runtime and chunks.
  const projectRoot = resolve(import.meta.dir, "../../../..");
  const files: Record<string, string> = {};
  const islandEntries = panelIslandEntries.map((island) => {
    // Match the SSR plugin's root; its temporary directory keeps generated assets out of the checkout.
    const id = islandIdFromFile(island, root);
    const virtual = resolve(import.meta.dir, `${id}.ts`);
    files[virtual] =
      `import { mount } from ${JSON.stringify(resolve(projectRoot, "packages/ssr/src/mount.ts"))}; import C from ${JSON.stringify(island)}; const selector = 'solid-island[data-id="${id}"]'; if (!document.querySelector(selector)) throw new Error("Missing provider island ${id}"); mount(C, selector);`;
    return virtual;
  });
  const islands = await buildIslandClosure(islandEntries, files);
  if (!islands.metafile) throw new Error("Missing Help provider fixture metafile");
  const outputMeta = Object.entries(islands.metafile.outputs);
  const scripts = islandEntries.map((entry) => {
    const output = outputMeta.find(([, meta]) => meta.entryPoint && resolve(meta.entryPoint) === entry);
    if (!output) throw new Error(`Missing Help provider island ${entry}`);
    return basename(output[0]);
  });
  const outputs = new Map(await Promise.all(islands.outputs.map(async (output) => [basename(output.path), await output.text()] as const)));
  const served = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/help-fixture.js") return new Response(client, { headers: { "content-type": "text/javascript" } });
      // Split chunks import each other by relative paths from the build's output layout; serve every file by name.
      const chunk = outputs.get(basename(url.pathname));
      if (chunk !== undefined) return new Response(chunk, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/api/help/search") return Response.json({ ids: [] });
      if (url.pathname.startsWith("/api/help/")) return Response.json({ ...fixtureDocument, id: url.pathname.split("/").at(-1) });
      const response = await server.fetch(request);
      if (!response.headers.get("content-type")?.includes("text/html")) return response;
      const source = await response.text();
      const providerDocument = source.includes("data-cloud-panel-page");
      const html = source
        .replace(/<script type="module"[^>]*>[^<]*solid-island[^<]*<\/script>/g, "")
        .replace(
          "</head>",
          `<style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>`,
        )
        .replace(
          "</body>",
          `<script>document.documentElement.dataset.helpServerFrame=JSON.stringify((${helpPanelGeometry.toString()})());</script>${
            providerDocument
              ? // One module script imports every island at once, as @k2b/ssr's loader does; geometry is taken after all mounted.
                `<script type="module">await Promise.all(${JSON.stringify(scripts)}.map((file) => import("/assets/" + file)));document.documentElement.dataset.helpFirstFrame=JSON.stringify((${helpPanelGeometry.toString()})());document.documentElement.dataset.helpMounted="true";</script>`
              : '<script src="/help-fixture.js"></script>'
          }</body>`,
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
const frame = (page: Page) => page.frames().find((frame) => new URL(frame.url()).pathname === "/panel");
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
// 320 px is the narrowest panel column (20 rem); 1440 is a top-level provider document at desktop width.
for (const width of [1440, 320])
  test(`${width}: a panel opened on ?topic= keeps the server article frame and reuses the seeded article`, async () => {
    const { context, page } = await fixture(width, 900, false);
    try {
      const fetched: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/help/")) fetched.push(request.url());
      });
      await page.goto(`${origin}/panel?topic=spaces-share`);
      await page.waitForFunction(() => document.documentElement.dataset.helpMounted === "true");
      await page.locator(".help-document h2").waitFor();
      await settled(page);
      const server = await page.evaluate(() => document.documentElement.dataset.helpServerFrame ?? "");
      expect(JSON.parse(server)[2]).not.toBeNull();
      expect(await page.evaluate(() => document.documentElement.dataset.helpFirstFrame)).toBe(server);
      expect(JSON.stringify(await page.evaluate(helpPanelGeometry))).toBe(server);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(fetched).toEqual([]);
      // The title sits on the app gradient: a stronger app colour than 30 % light / 15 % dark stays at that cap.
      const tint = (strength: string, dark: boolean) =>
        page.evaluate(
          ([strength, dark]) => {
            const head = document.querySelector<HTMLElement>(".help-article-head")!;
            document.documentElement.classList.toggle("dark", dark);
            head.style.setProperty("--app-canvas-strength", strength);
            head.style.setProperty("--app-canvas-dark-strength", strength);
            return getComputedStyle(head).backgroundImage;
          },
          [strength, dark] as const,
        );
      for (const [dark, cap] of [
        [false, "30%"],
        [true, "15%"],
      ] as const) {
        expect(await tint(cap, dark)).not.toBe(await tint("0%", dark));
        expect(await tint("100%", dark)).toBe(await tint(cap, dark));
      }
    } finally {
      await context.close();
    }
  });
test("an article opened from the panel start grows its head only downwards once the article arrives", async () => {
  const { context, page } = await fixture(1440, 900);
  try {
    let release = () => {};
    const arrived = new Promise<void>((done) => {
      release = done;
    });
    await page.route("**/api/help/spaces-share", async (route) => {
      await arrived;
      await route.continue();
    });
    await ready(page);
    const provider = frame(page);
    if (!provider) throw new Error("Missing Help frame");
    await provider.waitForFunction(() => document.documentElement.dataset.helpMounted === "true");
    await provider.locator('[data-help-view] [data-help-topic="spaces-share"]').click();
    await provider.locator('.help-article [data-state="loading"]').waitFor();
    const box = () =>
      provider.evaluate(() =>
        [".help-article-head", ".help-article-title", ".help-article-icon"].map((selector) => {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          return rect && { x: rect.x, y: rect.y, width: rect.width };
        }),
      );
    const loading = await box();
    release();
    await provider.locator(".help-document h2").waitFor();
    await settled(page);
    // A person opened the article on purpose: the head may grow, but its place, title, and icon tile stay.
    expect(await box()).toEqual(loading);
    expect(await provider.locator(".help-article-lead").textContent()).toContain("Share a Space so other people");
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
