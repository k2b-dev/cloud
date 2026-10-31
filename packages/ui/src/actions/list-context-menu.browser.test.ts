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
import { createSignal } from "solid-js";
import { createComponent, insert, render } from "solid-js/web";
import { ContextMenu, ListContextMenu, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const [gone, setGone] = createSignal(new Set());
const row = (name) => {
  const element = document.createElement("li");
  element.dataset.row = name;
  element.title = name + " tooltip";
  element.innerHTML = '<a class="row-link" href="#' + name + '">' + name + "</a>";
  return element;
};
const nested = () => {
  const element = row("Nested");
  insert(
    element,
    createComponent(ContextMenu, {
      label: "Attachment actions",
      tabIndex: -1,
      items: [{ label: "Save attachment", action: () => {} }],
      get children() {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attachment";
        button.textContent = "Attachment";
        return button;
      },
    }),
  );
  return element;
};
const list = () => {
  const element = document.createElement("ul");
  const footer = document.createElement("li");
  footer.className = "footer";
  footer.textContent = "Four rows";
  element.append(row("Alpha"), row("Beta"), row("Locked"), nested(), footer);
  return element;
};
window.opened = [];
window.actions = [];
// As a keyed list does: the row leaves the DOM in the same update that drops its entries.
window.removeRow = (name) => {
  document.querySelector('[data-row="' + name + '"]').remove();
  setGone(new Set([...gone(), name]));
};
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ListContextMenu, {
          row: "[data-row]",
          label: "Row actions",
          items: (row) =>
            ["Locked", "Nested"].includes(row.dataset.row) || gone().has(row.dataset.row)
              ? []
              : [
                  { label: "Open " + row.dataset.row, action: () => window.actions.push("open " + row.dataset.row) },
                  { label: "Archive", action: () => window.actions.push("archive " + row.dataset.row) },
                ],
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

  test("a context menu nested in a row without entries keeps its own menu, by pointer and by keyboard", async () => {
    const page = await load();
    try {
      await page.locator(".attachment").click({ button: "right" });
      expect((await outcome(page)).items).toEqual(["Save attachment"]);
      await page.keyboard.press("Escape");
      await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
      await page.locator(".attachment").focus();
      await page.keyboard.press("Shift+F10");
      expect((await outcome(page)).items).toEqual(["Save attachment"]);
    } finally {
      await page.close();
    }
  });

  test("the menu closes when its row leaves the list, and focus stays in the list", async () => {
    const page = await load();
    try {
      await page.locator('[data-row="Beta"] .row-link').focus();
      await page.keyboard.press("Shift+F10");
      expect((await outcome(page)).items).toEqual(["Open Beta", "Archive"]);
      await page.evaluate(() => (window as unknown as { removeRow: (name: string) => void }).removeRow("Beta"));
      await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
      expect(await outcome(page)).toEqual({ items: null, open: [], prevented: null });
      expect(await page.evaluate(() => document.activeElement?.closest("[role='group']")?.getAttribute("aria-label"))).toBe("Row actions");
    } finally {
      await page.close();
    }
  });

  test("an entry chosen from the keyboard runs, and focus returns to its row", async () => {
    const page = await load();
    try {
      await page.locator('[data-row="Alpha"] .row-link').focus();
      await page.keyboard.press("Shift+F10");
      await page.locator(".k2b-context-menu").waitFor();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
      expect(await page.evaluate(() => (window as unknown as { actions: string[] }).actions)).toEqual(["archive Alpha"]);
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Alpha");
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
