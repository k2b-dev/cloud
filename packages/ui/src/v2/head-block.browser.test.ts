// The head of a v2 workspace as one block (Valentin 26.11.), at 1440, 1024 and 390 px in Cloud's shell (80 px of rail and
// gutters beside the workspace from 768 px): the head and the toolbar rows under it (a filter bar, a status row) draw
// one line, under the last row, and none between them; a filter bar in the head stands in its line while it has room
// and wraps as its second row below that; the search is its symbol at every width and "/" opens it; several main
// actions are one "+".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-behavior/head-block.entry";

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-head-block-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: FilteredOrders } = await import("../../skills/k2b-ui/recipes/filtered-table");
const { LongPath, longPhoto, NamedPlace, OpenItem, PaneWithTwoActions, SearchAndAction, SearchWithWords, ToolbarInHead, TwoCreates } =
  await import("../../test/v2-head-block.fixture");
type Head =
  | "list"
  | "toolbar"
  | "creates"
  | "named"
  | "named-drawer"
  | "search"
  | "path"
  | "item"
  | "item-alone"
  | "hollow"
  | "hollow-words"
  | "named-bare"
  | "pane-actions";
const screens = {
  list: () => createComponent(FilteredOrders, {}),
  toolbar: () => createComponent(ToolbarInHead, {}),
  creates: () => createComponent(TwoCreates, {}),
  named: () => createComponent(NamedPlace, {}),
  "named-drawer": () => createComponent(NamedPlace, { detail: 600 }),
  search: () => createComponent(SearchWithWords, {}),
  path: () => createComponent(LongPath, {}),
  item: () => createComponent(OpenItem, {}),
  "item-alone": () => createComponent(OpenItem, { path: false }),
  hollow: () => createComponent(SearchAndAction, {}),
  "hollow-words": () => createComponent(SearchAndAction, { words: "Kunden" }),
  "named-bare": () => createComponent(NamedPlace, { bare: true }),
  "pane-actions": () => createComponent(PaneWithTwoActions, {}),
};
const markup = (head: Head) => renderToString(screens[head]);
const bundle = await demoBundle("head-block");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const shell = (width: number) => (width < 768 ? 0 : 80);
const testCss = (width: number) =>
  `html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0 0 0 ${shell(width)}px; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }`;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, head: Head, options: { host?: boolean; island?: boolean } = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  // a host whose own bar holds the page's search (Cloud's shell on the phone) marks the v2 scope
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss(width)}</style></head><body class="k2-ui"${options.host ? " data-k2-host-search" : ""}><div id="root">${markup(head)}</div></body></html>`,
  );
  // the page is the folder "#fotos" (U3): its step in the path leads to the page itself
  await page.evaluate(() => {
    location.hash = "fotos";
  });
  if (options.island === false) {
    await settled(page);
    return page;
  }
  await page.addScriptTag({ content: `window.__head = ${JSON.stringify(head)};` });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return page;
};

/** The lines the head block draws (visible bottom edges of the head and its toolbar rows), top down, and the gaps. */
const block = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 2 && box.height > 2 && getComputedStyle(element).visibility !== "hidden";
    };
    const line = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.borderBottomStyle !== "none" &&
        Number.parseFloat(style.borderBottomWidth) > 0 &&
        style.borderBottomColor !== "rgba(0, 0, 0, 0)"
      );
    };
    const rows = [
      ...document.querySelectorAll(
        '.k2-ws-main > [data-slot="head"] .k2-bar, .k2-ws-main > .k2-pane > [data-slot="status"] :is(.k2-fbar, .k2-bar[data-status-row])',
      ),
    ].filter(shown);
    return rows.map((row) => ({
      row: row.matches(".k2-fbar") ? "filter" : row.hasAttribute("data-status-row") ? "status" : "head",
      line: line(row),
      top: Math.round(row.getBoundingClientRect().top),
      bottom: Math.round(row.getBoundingClientRect().bottom),
    }));
  });
const searchWidth = (page: Page) =>
  page.evaluate(() =>
    Math.round(document.querySelector('.k2-ws-main > [data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect().width),
  );

for (const width of [1440, 1024, 390])
  test(`${width} px: the head and the toolbar rows under it are one block with one line, under its last row`, async () => {
    const page = await open(width, "list");
    try {
      const rows = await block(page);
      expect(rows.map((row) => row.row)).toEqual(width < 768 ? expect.arrayContaining(["status"]) : ["head", "filter", "status"]);
      // one line, under the last row; none between the rows
      expect(rows.filter((row) => row.line).map((row) => row.row)).toEqual(["status"]);
      // the rows stand a small gap apart
      for (let at = 1; at < rows.length; at++) {
        const gap = rows[at]!.top - rows[at - 1]!.bottom;
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(8);
      }
    } finally {
      await page.close();
    }
  }, 30_000);

for (const width of [1440, 1024])
  test(`${width} px: the search is its symbol, and "/" opens it over the head`, async () => {
    const page = await open(width, "list");
    try {
      expect(await searchWidth(page)).toBe(36);
      await page.locator("body").click({ position: { x: 5, y: 790 } });
      await page.keyboard.press("/");
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.closest(".k2-input[data-search]") !== null)).toBe(true);
      expect(await searchWidth(page)).toBeGreaterThan(300);
      // in a field "/" is a letter
      await page.keyboard.type("A/1");
      expect(await page.locator('.k2-ws-main > [data-slot="head"] .k2-input[data-search] input').inputValue()).toBe("A/1");
      // while a modal dialog is open, "/" belongs to it (Cloud's help searches with it): the head's search stays shut
      await page.locator('.k2-ws-main > [data-slot="head"] .k2-input[data-search] input').fill("");
      await page.locator('.k2-ws-main > [data-slot="head"] .k2-input[data-search] input').blur();
      await page.evaluate(() => {
        const dialog = document.body.appendChild(document.createElement("dialog"));
        dialog.append(document.createElement("button"));
        dialog.showModal();
      });
      await page.keyboard.press("/");
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.closest(".k2-input[data-search]") ?? null)).toBeNull();
    } finally {
      await page.close();
    }
  }, 30_000);

test("1440 px: a filter bar in the head stands in the head line; at 1024 px it wraps as the head's second row, without a line between", async () => {
  const wide = await open(1440, "toolbar");
  try {
    const seen = await wide.evaluate(() => {
      const bar = document.querySelector('.k2-ws-main > [data-slot="head"] > .k2-bar')!.getBoundingClientRect();
      const filter = document.querySelector('.k2-ws-main > [data-slot="head"] .k2-fbar')!.getBoundingClientRect();
      return { bar: Math.round(bar.height), inLine: filter.top >= bar.top - 1 && filter.bottom <= bar.bottom + 1 };
    });
    expect(seen).toEqual({ bar: 56, inLine: true });
  } finally {
    await wide.close();
  }
  const narrow = await open(1024, "toolbar");
  try {
    const seen = await narrow.evaluate(() => {
      const bar = document.querySelector('.k2-ws-main > [data-slot="head"] > .k2-bar')!;
      const title = bar.querySelector(".k2-text")!.getBoundingClientRect();
      const filter = bar.querySelector(".k2-fbar")!;
      const line = (element: Element) =>
        getComputedStyle(element).borderBottomColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(element).borderBottomWidth !== "0px";
      return {
        below: filter.getBoundingClientRect().top >= title.bottom,
        wide: filter.getBoundingClientRect().width > bar.getBoundingClientRect().width - 60,
        lines: [line(filter), line(bar)],
      };
    });
    // one block: the filter row draws no line, the head's one line is under both rows
    expect(seen).toEqual({ below: true, wide: true, lines: [false, true] });
  } finally {
    await narrow.close();
  }
}, 60_000);

test('two main actions are one "+" with both, already in the server\'s markup; each runs its own deed', async () => {
  expect(markup("creates")).toContain("data-creates");
  const page = await open(1440, "creates");
  try {
    const end = page.locator('.k2-ws-main > [data-slot="head"] .k2-bar-end');
    expect(await end.getByRole("button", { name: "Hochladen" }).isVisible()).toBe(false);
    const plus = end.getByRole("button", { name: "Neu" });
    expect(await plus.isVisible()).toBe(true);
    await plus.click();
    const menu = page.locator('[data-k2-part="Menu"]:visible');
    await menu.waitFor();
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Hochladen", "Neuer Ordner"]);
    await menu.getByRole("menuitem", { name: "Neuer Ordner" }).click();
    await settled(page);
    expect(await page.evaluate(() => window.__created)).toEqual({ "Neuer Ordner": 1 });
  } finally {
    await page.close();
  }
}, 30_000);

test('390 px: the main action floats as the round button, so the head shows no "+"', async () => {
  const page = await open(390, "creates");
  try {
    expect(await page.locator('.k2-ws-main > [data-slot="head"] .k2-creates .k2-btn').isVisible()).toBe(false);
  } finally {
    await page.close();
  }
}, 30_000);

/** Whether the head shows its title, and whether the sidebar stands as a column. */
const named = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element | null) => !!element && element.getBoundingClientRect().width > 2;
    return {
      title: shown(document.querySelector('.k2-ws-main > [data-slot="head"] .k2-bar-start > .k2-text')),
      sidebar: shown(document.querySelector(".k2-ws-side")),
      action: shown(document.querySelector('.k2-ws-main > [data-slot="head"] .k2-bar-end .k2-btn')),
    };
  });

test("the server's markup marks a head title that repeats the sidebar's current entry", () => {
  expect(markup("named")).toMatch(/class="k2-text[^"]*"[^>]*data-names-place=""/);
});

for (const width of [1440, 1024])
  test(`${width} px: while the sidebar shows its current entry, the head does not repeat it as its title`, async () => {
    const page = await open(width, "named");
    try {
      expect(await named(page)).toEqual({ title: false, sidebar: true, action: true });
    } finally {
      await page.close();
    }
  }, 30_000);

test("1024 px with the sidebar as a drawer, and 390 px: the head names the page", async () => {
  const drawer = await open(1024, "named-drawer");
  try {
    expect(await named(drawer)).toEqual({ title: true, sidebar: false, action: true });
  } finally {
    await drawer.close();
  }
  const phone = await open(390, "named");
  try {
    expect((await named(phone)).title).toBe(true);
  } finally {
    await phone.close();
  }
}, 60_000);

/** The head's search on the phone: its width, its words, and whether a person sees them. */
const phoneSearch = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('.k2-ws-main > [data-slot="head"] .k2-input[data-search]')!;
    const input = box.querySelector("input")!;
    const rect = box.getBoundingClientRect();
    return { width: Math.round(rect.width), words: input.value, seen: rect.width > 2 && Number(getComputedStyle(input).opacity) > 0 };
  });

for (const host of [false, true])
  test(`390 px${host ? " in a host with its own search" : ""}: a search from the address stays open with its words, from the server's page on; emptied, it folds`, async () => {
    // the server's page alone, before any script: the words already show
    const first = await open(390, "search", { host, island: false });
    try {
      const seen = await phoneSearch(first);
      expect(seen.words).toBe("Zeppelin");
      expect(seen.seen).toBe(true);
      expect(seen.width).toBeGreaterThan(300);
    } finally {
      await first.close();
    }
    const page = await open(390, "search", { host });
    try {
      expect((await phoneSearch(page)).seen).toBe(true);
      const input = page.locator('.k2-ws-main > [data-slot="head"] .k2-input[data-search] input');
      await input.fill("");
      await input.blur();
      await settled(page);
      const folded = await phoneSearch(page);
      expect(folded.seen).toBe(false);
      expect(folded.width).toBeLessThanOrEqual(36);
    } finally {
      await page.close();
    }
  }, 60_000);

for (const width of [1440, 1024])
  test(`${width} px: a long name in the path is cut in its middle where it has no room, and the head's actions stay whole`, async () => {
    const page = await open(width, "path");
    try {
      const seen = await page.evaluate(() => {
        const bar = document.querySelector('.k2-ws-main > [data-slot="head"] > .k2-bar')!;
        const row = bar.getBoundingClientRect();
        const name = bar.querySelector<HTMLElement>(".k2-path-name")!;
        const end = bar.querySelector<HTMLElement>(".k2-path-name-end")!;
        const actions = [...bar.querySelectorAll<HTMLElement>(".k2-bar-end .k2-btn")].map((button) => {
          const label = button.querySelector<HTMLElement>(".k2-btn-label")!;
          return { inside: button.getBoundingClientRect().right <= row.right + 1, whole: label.scrollWidth <= label.clientWidth };
        });
        const path = bar.querySelector(".k2-path")!.getBoundingClientRect();
        const firstAction = bar.querySelector(".k2-bar-end")!.getBoundingClientRect();
        return {
          cut: name.scrollWidth > name.clientWidth,
          apart: path.right <= firstAction.left,
          end: end.textContent,
          endWhole: end.scrollWidth <= end.clientWidth + 1,
          hint: bar.querySelector(".k2-path > b")!.getAttribute("title"),
          actions,
        };
      });
      expect(seen).toEqual({
        // at 1440 px the whole name has room; at 1024 px its middle gives way
        cut: width === 1024,
        apart: true,
        end: "Espresso.jpg",
        endWhole: true,
        hint: longPhoto,
        actions: [
          { inside: true, whole: true },
          { inside: true, whole: true },
        ],
      });
    } finally {
      await page.close();
    }
  }, 30_000);

test("a step of the path to the page itself is no link, so a press there never loads the page again", async () => {
  const page = await open(1440, "path");
  try {
    const steps = await page.evaluate(() =>
      [...document.querySelectorAll(".k2-path > .k2-path-step")].map((step) => ({
        name: step.textContent,
        href: step.getAttribute("href"),
        current: step.getAttribute("aria-current"),
      })),
    );
    expect(steps).toEqual([
      { name: "Ablage", href: "#ablage", current: null },
      // no link, and no "page" either: the open item is the page; this step is where it stands
      { name: "Fotos 2026", href: null, current: null },
    ]);
  } finally {
    await page.close();
  }
}, 30_000);

/** The detail's head: the size of its title, and where its way back and its title stand. */
const detail = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector(".k2-pane[data-detail]")!;
    const title = pane.querySelector<HTMLElement>(':scope > [data-slot="head"] .k2-bar-start > .k2-text')!;
    const back = pane.querySelector(':scope > [data-k2-part="Back"] .k2-btn');
    const head = pane.querySelector(':scope > [data-slot="head"] > .k2-bar')!.getBoundingClientRect();
    const box = (element: Element | null) => (element ? element.getBoundingClientRect() : undefined);
    const backBox = box(back);
    const titleBox = title.getBoundingClientRect();
    return {
      size: getComputedStyle(title).fontSize,
      backShown: !!backBox && backBox.width > 2,
      oneRow: !!backBox && backBox.top >= head.top - 1 && backBox.bottom <= head.bottom + 1,
      titleAfterBack: !!backBox && titleBox.left >= backBox.right,
      backName: back?.getAttribute("aria-label") ?? back?.textContent?.trim() ?? "",
    };
  });

test("1440 px: after a path the open item's name is small; alone it is the detail's lead title", async () => {
  const withPath = await open(1440, "item");
  const alone = await open(1440, "item-alone");
  try {
    const small = (await detail(withPath)).size;
    const lead = (await detail(alone)).size;
    expect(small).toBe(await withPath.evaluate(() => getComputedStyle(document.querySelector(".k2-path > b")!).fontSize));
    expect(Number.parseFloat(lead)).toBeGreaterThan(Number.parseFloat(small));
  } finally {
    await withPath.close();
    await alone.close();
  }
}, 30_000);

test("390 px: the open item's way back and its title stand in one row, the list's name its accessible name", async () => {
  const page = await open(390, "item-alone");
  try {
    const seen = await detail(page);
    expect({ backShown: seen.backShown, oneRow: seen.oneRow, titleAfterBack: seen.titleAfterBack }).toEqual({
      backShown: true,
      oneRow: true,
      titleAfterBack: true,
    });
    expect(seen.backName).toContain("Beschaffung");
  } finally {
    await page.close();
  }
}, 30_000);

/** The phone's head of a search and the main action: its height, where the list starts, and the search. */
const hollowHead = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.k2-ws-main > [data-slot="head"] > .k2-bar')!.getBoundingClientRect();
    const main = document.querySelector(".k2-ws-main")!.getBoundingClientRect();
    const row = document.querySelector('[data-k2-part="Row"]')!.getBoundingClientRect();
    const field = document.querySelector('.k2-ws-main > [data-slot="head"] .k2-input[data-search]')!.getBoundingClientRect();
    return { head: Math.round(bar.height), row: Math.round(row.top - main.top), field: Math.round(field.width) };
  });

test("the server's markup marks a head of a search and the main action alone", () => {
  expect(markup("hollow")).toMatch(/class="k2-bar"[^>]*data-hollow="search"/);
  // a head with a title or views is no such head
  expect(markup("list")).not.toContain("data-hollow");
});

test("390 px in a host: a head of a search and the main action takes no room, from the server's page on", async () => {
  const first = await open(390, "hollow", { host: true, island: false });
  try {
    expect(await hollowHead(first)).toMatchObject({ head: 0, row: 0 });
  } finally {
    await first.close();
  }
  const page = await open(390, "hollow", { host: true });
  try {
    expect(await hollowHead(page)).toMatchObject({ head: 0, row: 0 });
    // the host opens the search: its field lies over the first row, and nothing below moves
    await page.locator('.k2-ws-main > [data-slot="head"] .k2-input[data-search] input').focus();
    await settled(page);
    expect(await hollowHead(page)).toEqual({ head: 0, row: 0, field: 390 - 32 });
  } finally {
    await page.close();
  }
}, 60_000);

test("390 px in a host: with words from the address the head shows them", async () => {
  const page = await open(390, "hollow-words", { host: true, island: false });
  try {
    const seen = await hollowHead(page);
    expect(seen.head).toBeGreaterThan(40);
    expect(seen.field).toBe(390 - 32);
  } finally {
    await page.close();
  }
}, 30_000);

test("390 px without a host: the head keeps its search's symbol", async () => {
  const page = await open(390, "hollow");
  try {
    const seen = await hollowHead(page);
    expect(seen.head).toBeGreaterThan(40);
    expect(seen.field).toBe(36);
  } finally {
    await page.close();
  }
}, 30_000);

test('390 px: several main actions are the round button\'s "+", and each of them runs from it', async () => {
  const page = await open(390, "creates");
  try {
    const fab = page.locator(".k2-fab-menu > .k2-btn");
    expect(await fab.isVisible()).toBe(true);
    expect(await page.locator(".k2-fab").count()).toBe(0);
    for (const action of ["Hochladen", "Neuer Ordner"]) {
      await fab.click();
      const menu = page.locator('[data-k2-part="Menu"]:visible');
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Hochladen", "Neuer Ordner"]);
      await menu.getByRole("menuitem", { name: action }).click();
      await settled(page);
    }
    expect(await page.evaluate(() => window.__created)).toEqual({ Hochladen: 1, "Neuer Ordner": 1 });
  } finally {
    await page.close();
  }
}, 30_000);

test("a pane's own head keeps its two main actions: only the workspace's head makes them one \"+\"", async () => {
  expect(markup("pane-actions")).not.toContain("data-creates");
  const page = await open(1440, "pane-actions");
  try {
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('.k2-pane > [data-slot="head"] .k2-bar-end .k2-btn')]
        .filter((button) => button.getBoundingClientRect().width > 2)
        .map((button) => button.textContent?.trim()),
    );
    expect(shown).toEqual(["Speichern", "Veröffentlichen"]);
  } finally {
    await page.close();
  }
}, 30_000);

test("1440 px: a head that holds nothing but the repeated title gives way whole; on the phone it names the page", async () => {
  expect(markup("named-bare")).toMatch(/class="k2-bar"[^>]*data-names-place=""/);
  const wide = await open(1440, "named-bare");
  try {
    const height = await wide.evaluate(
      () => document.querySelector('.k2-ws-main > [data-slot="head"] > .k2-bar')!.getBoundingClientRect().height,
    );
    expect(height).toBeLessThanOrEqual(1);
    // still read: the page keeps its name for assistive technology
    expect(await wide.getByText("Einstellungen", { exact: true }).first().count()).toBe(1);
  } finally {
    await wide.close();
  }
  const phone = await open(390, "named-bare");
  try {
    expect((await named(phone)).title).toBe(true);
  } finally {
    await phone.close();
  }
}, 60_000);
