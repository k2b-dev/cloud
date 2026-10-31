import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Which row a right-click lands on, focus, and whether the browser keeps its own menu show only in a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "list-context-menu.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { ListContextMenu, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const list = () => {
  const element = document.createElement("ul");
  element.innerHTML = ["Alpha", "Beta", "Locked"]
    .map((name) => '<li data-row="' + name + '" title="' + name + ' tooltip"><a class="row-link" href="#' + name + '">' + name + '</a></li>')
    .join("") + '<li class="footer">Three rows</li>';
  return element;
};
window.opened = [];
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ListContextMenu, {
          row: "[data-row]",
          label: "Row actions",
          items: (row) => (row.dataset.row === "Locked" ? [] : [{ label: "Open " + row.dataset.row, action: () => {} }, { label: "Archive", action: () => {} }]),
          onOpen: (row) => window.opened.push(row.dataset.row),
          onClose: () => window.opened.push("closed"),
          get children() {
            return list();
          },
        });
      },
    }),
  document.getElementById("app"),
);
window.events = [];
window.addEventListener("contextmenu", (event) => window.events.push(event), true);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the list context menu fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><main id="app" style="padding:16px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator('[data-row="Alpha"]').waitFor();
  return page;
};

/** The open menu's entries or null, the rows marked open, and whether the last contextmenu event was cancelled. */
const outcome = async (page: Page) => {
  await settled(page);
  const menu = page.locator(".k2b-context-menu");
  const items = (await menu.count()) ? await menu.getByRole("menuitem").allTextContents() : null;
  return page.evaluate((items) => {
    const state = window as unknown as { events: Event[] };
    return {
      items: items?.map((item) => item.trim()) ?? null,
      open: [...document.querySelectorAll<HTMLElement>("[data-context-menu-open]")].map((row) => row.dataset.row),
      prevented: state.events.at(-1)?.defaultPrevented ?? null,
    };
  }, items);
};

describe("ListContextMenu", () => {
  test("right-click opens the menu of the row under the pointer and marks it until the menu closes", async () => {
    const page = await load();
    try {
      await page.locator('[data-row="Beta"] .row-link').click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: ["Open Beta", "Archive"], open: ["Beta"], prevented: true });
      await page.locator('[data-row="Alpha"] .row-link').click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: ["Open Alpha", "Archive"], open: ["Alpha"], prevented: true });
      await page.keyboard.press("Escape");
      expect(await outcome(page)).toEqual({ items: null, open: [], prevented: true });
      expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["Beta", "closed", "Alpha", "closed"]);
    } finally {
      await page.close();
    }
  });

  test("outside a row and on a row without entries the browser keeps its own menu", async () => {
    const page = await load();
    try {
      await page.locator(".footer").click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: null, open: [], prevented: false });
      await page.locator('[data-row="Locked"] .row-link').click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: null, open: [], prevented: false });
    } finally {
      await page.close();
    }
  });

  for (const key of ["Shift+F10", "ContextMenu"])
    test(`${key} opens the focused row's menu beside it, and Escape returns focus to the row`, async () => {
      const page = await load();
      try {
        await page.locator('[data-row="Beta"] .row-link').focus();
        await page.keyboard.press(key);
        expect(await outcome(page)).toEqual({ items: ["Open Beta", "Archive"], open: ["Beta"], prevented: null });
        const placement = await page.evaluate(() => {
          const row = document.querySelector('[data-row="Beta"] .row-link')!.getBoundingClientRect();
          const menu = document.querySelector(".k2b-context-menu")!.getBoundingClientRect();
          return { left: menu.left - row.left, top: menu.top - row.top, focused: document.activeElement?.textContent?.trim() };
        });
        expect(placement).toEqual({ left: 12, top: 12, focused: "Open Beta" });
        await page.keyboard.press("Escape");
        await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
        expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Beta");
      } finally {
        await page.close();
      }
    });
});
