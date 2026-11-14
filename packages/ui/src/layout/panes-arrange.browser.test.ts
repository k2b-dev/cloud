import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, hoverInPlace, launchBrowser, settled } from "../../test/browser";

// Arranging panes: the Arrange menu and its presets, the same menu on a tab, keyboard moves, boundary resizing
// and reset, a narrow container's projection, and tabs that never change width.

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "panes-arrange.fixture.ts");
const source = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, Panes, applyPanesPreset, resizePanesSplit } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const ids = ["draft", "history", "preview"];
const stacked = applyPanesPreset("stacked", ids);
const defaultLayout = resizePanesSplit(resizePanesSplit(stacked, [], 0.54), ["second"], 0.58);
const [layout, setLayout] = createSignal(defaultLayout);
window.layout = layout;
window.changes = 0;
const pane = (id, title, icon) => ({ id, title, icon, render: () => { const el = document.createElement("div"); el.className = "pane-body"; el.textContent = title; return el; } });
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(Panes, {
    get layout() { return layout(); },
    onLayoutChange: (next) => { window.changes += 1; setLayout(next); },
    defaultLayout,
    items: [pane("draft", "Draft", "ti-pencil"), pane("history", "History", "ti-history"), pane("preview", "Preview", "ti-eye")],
  });
} }), document.getElementById("app"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: source },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Panes arrange fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Win = { layout: () => { root: unknown }; changes: number };

const open = async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 760 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style><style>
    body { margin: 0; } #app { width: 1200px; height: 760px; display: flex; } .pane-body { padding: 1rem; }
    </style></head><body class="k2b-ui"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-panes__arrange").waitFor();
  return { page, context };
};
const root = (page: Page) => page.evaluate(() => (window as unknown as Win).layout().root);
const changes = (page: Page) => page.evaluate(() => (window as unknown as Win).changes);
const tab = (page: Page, name: string) => page.locator(`.k2b-panes__tab-button[aria-label="${name}"]`);
const menu = (page: Page) => page.locator(".k2b-panes__menu:popover-open");
const focusedLabel = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const ratioAt = (page: Page, path: ("first" | "second")[]) =>
  page.evaluate((segments) => {
    let node = (window as unknown as { layout: () => { root: Record<string, unknown> } }).layout().root;
    for (const segment of segments) node = node[segment] as Record<string, unknown>;
    return node.ratio as number;
  }, path);

describe(`Panes arrangement in ${browserName}`, () => {
  test("the Arrange menu offers the presets, names each place by its neighbour, and resets to the default", async () => {
    const { page, context } = await open();
    try {
      await page.locator(".k2b-panes__arrange").click();
      await menu(page).waitFor();
      const tiles = menu(page).locator(".k2b-dropdown__tiles [role='menuitemradio']");
      expect(await tiles.allTextContents()).toEqual(["Two", "Three", "Stacked", "Tabs"]);
      expect(await menu(page).locator("[role='menuitemradio'][aria-checked='true']").textContent()).toBe("Stacked");
      // The menu acts on the trailing group's tab and names every neighbour.
      expect(await menu(page).getByText("Move “History”").count()).toBe(1);
      const entries = await menu(page).locator(".k2b-dropdown__section [role='menuitem']").allTextContents();
      expect(entries).toContain("Below “Preview”");
      expect(entries).toContain("Left of “Draft”");
      expect(entries).toContain("As a tab with “Preview”");
      expect(entries).not.toContain("Above “Preview”");
      expect(await menu(page).locator("[role='menuitem'][aria-disabled='true']").textContent()).toContain("Reset arrangement");
      expect(await menu(page).locator(".k2b-dropdown__note").textContent()).toBe("The same menu opens with a right click on any tab.");

      await tiles.filter({ hasText: "Tabs" }).click();
      expect(await root(page)).toEqual({ type: "group", items: ["draft", "history", "preview"], active: "history" });
      expect(await focusedLabel(page)).toBe("History");

      await page.locator(".k2b-panes__arrange").click();
      await menu(page).getByText("Reset arrangement").click();
      expect(await ratioAt(page, [])).toBe(0.54);
      expect(await ratioAt(page, ["second"])).toBe(0.58);

      // A moved boundary is a change too: Reset brings the sizes back.
      await page.locator('.k2b-panes__separator[data-direction="vertical"]').focus();
      await page.keyboard.press("ArrowDown");
      await page.locator(".k2b-panes__arrange").click();
      await menu(page).getByText("Reset arrangement").click();
      expect(await ratioAt(page, ["second"])).toBe(0.58);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a right click, Shift+F10 and Ctrl+Shift+Arrow move the tab they are on", async () => {
    const { page, context } = await open();
    try {
      await tab(page, "Preview").click({ button: "right" });
      await menu(page).waitFor();
      expect(await menu(page).getByText("Move “Preview”").count()).toBe(1);
      await menu(page).getByText("As a tab with “History”").click();
      expect(await root(page)).toMatchObject({ second: { type: "group", items: ["history", "preview"], active: "preview" } });
      expect(await focusedLabel(page)).toBe("Preview");

      await page.keyboard.press("Control+Shift+ArrowLeft");
      expect(await root(page)).toMatchObject({ second: { items: ["preview", "history"] } });
      expect(await focusedLabel(page)).toBe("Preview");

      // At the first place the reorder keys do nothing, and never select another tab.
      await page.keyboard.press("Control+Shift+ArrowLeft");
      expect(await root(page)).toMatchObject({ second: { items: ["preview", "history"], active: "preview" } });
      expect(await focusedLabel(page)).toBe("Preview");

      await page.keyboard.press("Shift+F10");
      await menu(page).waitFor();
      expect(await menu(page).getByText("Move “Preview”").count()).toBe(1);
      await page.keyboard.press("Escape");
      await menu(page).waitFor({ state: "hidden" });
      expect(await focusedLabel(page)).toBe("Preview");
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a boundary resizes by pointer and keys, darkens its shade while held, and a double click or Enter resets it", async () => {
    const { page, context } = await open();
    try {
      const separator = page.locator('.k2b-panes__separator[data-direction="vertical"]');
      const shade = () =>
        page.evaluate(() =>
          getComputedStyle(
            document.querySelector('.k2b-panes__split[data-direction="vertical"] > .k2b-panes__split-child')!,
            "::after",
          ).getPropertyValue("--k2b-panes-shade-edge"),
        );
      await settled(page);
      const restShade = await shade();
      const box = (await separator.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 4 });
      expect(await separator.getAttribute("data-active")).toBe("true");
      await settled(page);
      expect(await shade()).not.toBe(restShade);
      await page.mouse.up();
      expect(await ratioAt(page, ["second"])).toBeGreaterThan(0.58);

      await separator.dblclick();
      expect(await ratioAt(page, ["second"])).toBe(0.58);

      await separator.focus();
      await page.keyboard.press("ArrowUp");
      expect(await ratioAt(page, ["second"])).toBeCloseTo(0.56, 5);
      await page.keyboard.press("Enter");
      expect(await ratioAt(page, ["second"])).toBe(0.58);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("tabs keep their width at rest, on hover, and selected", async () => {
    const { page, context } = await open();
    try {
      await page.locator(".k2b-panes__arrange").click();
      await menu(page).getByText("Tabs", { exact: true }).click();
      await page.mouse.move(1, 1);
      await settled(page);
      const widths = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll(".k2b-panes__tab")).map((element) => element.getBoundingClientRect().width),
        );
      const rest = await widths();
      await hoverInPlace(tab(page, "Draft"));
      await settled(page);
      expect(await widths()).toEqual(rest);
      await tab(page, "Draft").click();
      await page.mouse.move(1, 1);
      await settled(page);
      expect(await widths()).toEqual(rest);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("a narrow container shows one row of tabs and never stores it", async () => {
    const { page, context } = await open();
    try {
      const before = await root(page);
      const count = await changes(page);
      await page.evaluate(() => {
        document.getElementById("app")!.style.width = "480px";
      });
      await page.locator('.k2b-panes[data-narrow="true"]').waitFor();
      expect(await page.locator(".k2b-panes__tab-button").allTextContents()).toEqual(["Draft", "History", "Preview"]);
      expect(await page.locator(".k2b-panes__arrange, .k2b-panes__grip, .k2b-panes__separator").count()).toBe(0);
      expect(await page.locator('.k2b-panes__tab-button[aria-selected="true"]').textContent()).toBe("Draft");
      await tab(page, "Preview").click();
      expect(await page.locator('.k2b-panes__tab-button[aria-selected="true"]').textContent()).toBe("Preview");
      expect(await changes(page)).toBe(count);

      await page.evaluate(() => {
        document.getElementById("app")!.style.width = "1200px";
      });
      await page.locator('.k2b-panes:not([data-narrow="true"])').waitFor();
      expect(await root(page)).toEqual(before);
      expect(await page.locator(".k2b-panes__arrange").count()).toBe(1);
    } finally {
      await context.close();
    }
  }, 30_000);
});
