/**
 * A workspace without a head (`head={false}`) whose application gives the sidebar and Details buttons itself: every
 * width keeps both reachable. In a column the sidebar button hides and shows a hideable sidebar, below a 64 rem app
 * host it opens the overlay, and the Details button opens, closes and, without room, slides in the waiting panel.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "workspace-app-toggles.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, appWorkspaceDetailElementId } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [hidden, setHidden] = createSignal(false);
const [open, setOpen] = createSignal(true);
const button = (label, attributes) => {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};
render(() => createComponent(AppWorkspace, {
  head: false,
  get children() { return [
    createComponent(AppWorkspace.Sidebar, {
      id: "navigation",
      label: "Navigation",
      get hidden() { return hidden(); },
      onHiddenChange: setHidden,
      get children() { return createComponent(AppWorkspace.SidebarItem, { href: "/notes", children: "Notes" }); },
    }),
    createComponent(AppWorkspace.Content, { get children() { return [
      createComponent(AppWorkspace.Main, { minWidth: 640, get children() { return [
        button("Navigation", { id: "app-sidebar", "aria-controls": "navigation", "data-app-workspace-sidebar-toggle": "" }),
        button("Detail panel", { id: "app-detail", "aria-controls": appWorkspaceDetailElementId("record"), "data-app-workspace-detail-toggle": "" }),
        "Note text",
      ]; } }),
      createComponent(AppWorkspace.Detail, {
        id: "record",
        toggle: false,
        get open() { return open(); },
        onOpen: () => setOpen(true),
        onClose: () => setOpen(false),
        children: "Details of the note",
      }),
    ]; } }),
  ]; },
}), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the workspace app toggles fixture.");
const script = await build.outputs[0]!.text();
setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 820 }, reducedMotion: "reduce" });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="height:100vh;display:flex"></div><script>${script}</script></body></html>`,
  );
  await page.locator("#app-sidebar").waitFor();
  await settled(page);
  return page;
};

const state = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".k2b-app-workspace")!;
    const detail = document.querySelector<HTMLElement>(".k2b-app-workspace__detail")!;
    return {
      head: document.querySelectorAll(".k2b-app-workspace__head").length,
      ownDetailButton: document.querySelectorAll(".k2b-app-workspace__detail-toggle").length,
      sidebarHidden: document.getElementById("navigation")!.hidden,
      overlay: root.dataset.sidebarOverlay ?? null,
      sidebarExpanded: document.getElementById("app-sidebar")!.getAttribute("aria-expanded"),
      detailHidden: detail.hidden,
      drawer: detail.dataset.workspaceDetailDrawer ?? null,
      detailExpanded: document.getElementById("app-detail")!.getAttribute("aria-expanded"),
      detailVisible: detail.getClientRects().length > 0 && getComputedStyle(detail).visibility !== "hidden",
    };
  });

test("in a wide workspace the app's buttons hide and show the sidebar and close and open Details", async () => {
  const page = await load(1400);
  try {
    expect(await state(page)).toMatchObject({ head: 0, ownDetailButton: 0, sidebarHidden: false, sidebarExpanded: "true" });
    expect(await state(page)).toMatchObject({ detailHidden: false, detailVisible: true, detailExpanded: "true" });
    await page.click("#app-sidebar");
    await settled(page);
    expect(await state(page)).toMatchObject({ sidebarHidden: true, sidebarExpanded: "false" });
    await page.click("#app-sidebar");
    await settled(page);
    expect(await state(page)).toMatchObject({ sidebarHidden: false, sidebarExpanded: "true", overlay: null });
    await page.click("#app-detail");
    await settled(page);
    expect(await state(page)).toMatchObject({ detailHidden: true, detailExpanded: "false" });
    await page.click("#app-detail");
    await settled(page);
    expect(await state(page)).toMatchObject({ detailHidden: false, detailVisible: true, detailExpanded: "true" });
  } finally {
    await page.close();
  }
});

test("below a 64 rem app host the app's buttons open the overlay sidebar and the waiting Details", async () => {
  const page = await load(900);
  try {
    expect(await state(page)).toMatchObject({ head: 0, ownDetailButton: 0, sidebarHidden: false, overlay: null, sidebarExpanded: "false" });
    await page.click("#app-sidebar");
    await settled(page);
    expect(await state(page)).toMatchObject({ overlay: "open", sidebarExpanded: "true" });
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await state(page)).toMatchObject({ overlay: null, sidebarExpanded: "false" });
    // Without room beside the text the open panel waits; its button slides it in and out.
    expect(await state(page)).toMatchObject({ detailHidden: false, detailVisible: false, detailExpanded: "false" });
    await page.click("#app-detail");
    await settled(page);
    expect(await state(page)).toMatchObject({ drawer: "open", detailVisible: true, detailExpanded: "true" });
    await page.click("#app-detail");
    await settled(page);
    expect(await state(page)).toMatchObject({ drawer: null, detailExpanded: "false" });
  } finally {
    await page.close();
  }
});

test("a sidebar hidden in a wide workspace comes back as the overlay below 64 rem", async () => {
  const page = await load(1400);
  try {
    await page.click("#app-sidebar");
    await settled(page);
    expect(await state(page)).toMatchObject({ sidebarHidden: true });
    await page.setViewportSize({ width: 900, height: 820 });
    await settled(page);
    expect(await state(page)).toMatchObject({ sidebarExpanded: "false" });
    await page.click("#app-sidebar");
    await settled(page);
    expect(await state(page)).toMatchObject({ sidebarHidden: false, overlay: "open", sidebarExpanded: "true" });
  } finally {
    await page.close();
  }
});
