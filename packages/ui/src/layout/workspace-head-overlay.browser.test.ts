import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { type HeadOverlayOptions, headOverlayTree } from "../../test/workspace-head-overlay-fixture";
import { uiDirectory, workspaceCss, workspaceDist } from "../../test/workspace-host-fixture";

declare global {
  interface Window {
    mountWorkspace: () => void;
  }
}

setDefaultTimeout(30_000);
const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-head-overlay-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { AppWorkspace, IconButton, PageTrailProvider, ViewTabs } = await import("../index");
const components = { AppWorkspace, IconButton, PageTrailProvider, ViewTabs, createComponent, Dynamic };
const css = workspaceCss();
const entry = resolve(uiDirectory, "src/layout/workspace-head-overlay.client-fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
    import { createComponent } from "solid-js";
    import { Dynamic, render } from "solid-js/web";
    import { AppWorkspace, IconButton, PageTrailProvider, ViewTabs } from ${JSON.stringify(resolve(workspaceDist, "browser/index.js"))};
    const tree = ${headOverlayTree.toString()};
    window.mountWorkspace = () => {
      const root = document.getElementById("app");
      root.replaceChildren();
      render(() => tree({ AppWorkspace, IconButton, PageTrailProvider, ViewTabs, createComponent, Dynamic },
        JSON.parse(document.body.dataset.options)), root);
    };`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the head overlay fixture");
const client = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The tablet host of the report (1,000 px window), a desktop host, and a phone. */
const TABLET = 1000;
const DESKTOP = 1440;
const PHONE = 390;

const load = async (options: HeadOverlayOptions, width: number, mount = false) => {
  const page = await browser.newPage({ viewport: { width, height: 800 }, isMobile: width < 768, reducedMotion: "reduce" });
  const markup = renderToString(() => headOverlayTree(components, options));
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
    <body class="k2b-ui" style="margin:0" data-options='${JSON.stringify(options)}'>
      <div id="app" style="container:k2b-app-area / inline-size;width:${width}px;height:800px">${markup}</div></body></html>`);
  await page.addScriptTag({ content: client });
  if (mount) await page.evaluate(() => window.mountWorkspace());
  await settled(page);
  return page;
};

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  expect(found, selector).not.toBeNull();
  return found!;
};
const shown = (page: Page, selector: string) => page.locator(selector).first().isVisible();
const headHeight = (page: Page) =>
  page.locator(".k2b-app-workspace__head").evaluate((head) => Math.round(head.getBoundingClientRect().height));
/** Geometry that must not move between the server's frame and the mounted page. */
const frame = (page: Page) =>
  page.evaluate(() =>
    [
      ".k2b-app-workspace__head",
      "[data-list-toolbar]",
      ".fixture-search",
      "[data-pill]",
      ".k2b-app-workspace__sidebar-toggle",
      ".k2b-view-tabs",
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { selector, x, y, width, height };
    }),
  );

test("beside the overlay, the list's toolbar takes the sidebar button and the head takes no row", async () => {
  for (const up of [false, true]) {
    const page = await load({ up, marked: true, toolbarToggle: true }, TABLET);
    try {
      expect(await headHeight(page)).toBeLessThanOrEqual(1);
      expect(await shown(page, ".k2b-app-workspace__head-toggle")).toBe(false);
      expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(false);
      const toggle = await box(page, ".k2b-app-workspace__sidebar-toggle");
      const search = await box(page, ".fixture-search");
      const list = await box(page, '[data-workspace-main-region="list"]');
      // The button opens the toolbar row, on the search's centre line, at the top of the list.
      expect(toggle.x).toBeLessThan(search.x);
      expect(Math.abs(toggle.y + toggle.height / 2 - (search.y + search.height / 2))).toBeLessThanOrEqual(1);
      expect(toggle.y - list.y).toBeLessThan(24);
      // The page keeps its name for assistive technology.
      expect(await page.getByRole("heading", { level: 1, name: "Inbox" }).count()).toBe(1);
      expect(await page.getByRole("button", { name: "Show navigation" }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }
});

test("the toolbar's sidebar button opens the overlay and nothing moves", async () => {
  const page = await load({ marked: true, toolbarToggle: true }, TABLET, true);
  try {
    const before = await frame(page);
    const toggle = page.locator(".k2b-app-workspace__sidebar-toggle");
    expect(await toggle.getAttribute("aria-controls")).toBe("places");
    await toggle.click();
    await settled(page);
    expect(await page.locator(".k2b-app-workspace").getAttribute("data-sidebar-overlay")).toBe("open");
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await frame(page)).toEqual(before);
  } finally {
    await page.close();
  }
});

test("without a toolbar button, the head is a compact row with only the sidebar button", async () => {
  const page = await load({ marked: true }, TABLET);
  try {
    expect(await shown(page, ".k2b-app-workspace__head-toggle")).toBe(true);
    expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(false);
    expect(await headHeight(page)).toBeLessThanOrEqual(46);
    expect(await page.getByRole("heading", { level: 1, name: "Inbox" }).count()).toBe(1);
  } finally {
    await page.close();
  }
});

test("a page the sidebar does not mark keeps its title and way up beside the overlay", async () => {
  const page = await load({ up: true, marked: false, toolbarToggle: true }, TABLET);
  try {
    expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(true);
    expect(await shown(page, ".k2b-app-workspace__head-toggle")).toBe(false);
    expect(await shown(page, ".k2b-app-workspace__sidebar-toggle")).toBe(true);
  } finally {
    await page.close();
  }
});

test("a head row keeps its views beside the sidebar button, without a title", async () => {
  for (const up of [false, true]) {
    const page = await load({ up, marked: true, headRow: true }, TABLET);
    try {
      expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(false);
      const toggle = await box(page, ".k2b-app-workspace__head-toggle");
      const tabs = await box(page, ".k2b-view-tabs");
      expect(tabs.x).toBeGreaterThan(toggle.x + toggle.width);
      expect(tabs.x - (toggle.x + toggle.width)).toBeLessThanOrEqual(16);
      expect(await page.getByRole("heading", { level: 1, name: "Inbox" }).count()).toBe(1);
    } finally {
      await page.close();
    }
  }
});

test("a page with its own h1 keeps the head's heading out of the accessibility tree", async () => {
  const page = await load({ marked: true, toolbarToggle: true, mainHeading: true }, TABLET);
  try {
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await page.locator(".k2b-app-workspace__head-heading").evaluate((heading) => getComputedStyle(heading).display)).toBe("none");
  } finally {
    await page.close();
  }
});

test("from 64 rem the sidebar is a column and the toolbar starts with search", async () => {
  const page = await load({ up: true, marked: true, toolbarToggle: true }, DESKTOP);
  try {
    expect(await shown(page, ".k2b-app-workspace__sidebar-toggle")).toBe(false);
    expect(await headHeight(page)).toBeLessThanOrEqual(1);
    const search = await box(page, ".fixture-search");
    const list = await box(page, '[data-workspace-main-region="list"]');
    expect(search.x - list.x).toBeLessThanOrEqual(16);
  } finally {
    await page.close();
  }
});

test("on a phone the toolbar button stays hidden and a deeper page keeps its title row", async () => {
  const page = await load({ up: true, marked: true, toolbarToggle: true }, PHONE);
  try {
    expect(await shown(page, ".k2b-app-workspace__sidebar-toggle")).toBe(false);
    expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(true);
  } finally {
    await page.close();
  }
});

test("a page with its own title and a toolbar button leaves no empty head row", async () => {
  const page = await load({ up: true, marked: false, toolbarToggle: true }, TABLET);
  try {
    await page.evaluate(() => document.body.setAttribute("data-k2b-own-title", ""));
    await settled(page);
    expect(await headHeight(page)).toBeLessThanOrEqual(1);
    expect(await shown(page, ".k2b-app-workspace__sidebar-toggle")).toBe(true);
  } finally {
    await page.close();
  }
});

test("a nested workspace's toolbar button leaves the outer head its own", async () => {
  const page = await load({ marked: true, nested: true }, TABLET);
  try {
    const outerHead = page.locator(".k2b-app-workspace__head").first();
    expect(await outerHead.locator(".k2b-app-workspace__head-toggle").isVisible()).toBe(true);
    expect(await outerHead.evaluate((head) => head.getBoundingClientRect().height)).toBeGreaterThan(40);
    expect(await shown(page, "[data-nested-toolbar] .k2b-app-workspace__sidebar-toggle")).toBe(false);
  } finally {
    await page.close();
  }
});

test("from 64 rem, a sidebar without room becomes the overlay and keeps a way to open it", async () => {
  for (const toolbarToggle of [false, true]) {
    const page = await load({ up: true, marked: true, toolbarToggle, mainMin: 1000 }, 1100);
    try {
      expect(await page.locator(".k2b-app-workspace__sidebar").evaluate((sidebar) => getComputedStyle(sidebar).position)).toBe("absolute");
      expect(await shown(page, ".k2b-app-workspace__head .k2b-page-title")).toBe(false);
      expect(await shown(page, ".k2b-app-workspace__head-toggle")).toBe(!toolbarToggle);
      expect(await shown(page, ".k2b-app-workspace__sidebar-toggle")).toBe(toolbarToggle);
      if (toolbarToggle) expect(await headHeight(page)).toBeLessThanOrEqual(1);
      else expect(await headHeight(page)).toBeGreaterThan(40);
    } finally {
      await page.close();
    }
  }
});

for (const width of [PHONE, TABLET, DESKTOP]) {
  test(`server and mounted frames agree at ${width}px`, async () => {
    for (const options of [
      { marked: true, toolbarToggle: true },
      { up: true, marked: true },
      { marked: true, headRow: true },
    ]) {
      const page = await load(options, width);
      try {
        const server = await frame(page);
        await page.evaluate(() => window.mountWorkspace());
        await settled(page);
        expect(await frame(page), JSON.stringify(options)).toEqual(server);
      } finally {
        await page.close();
      }
    }
  });
}
