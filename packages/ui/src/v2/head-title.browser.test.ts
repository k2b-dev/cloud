// The title of a workspace head beside its views and actions (W3, a Space's head: its name, four views, a search, its
// people, its "…" menu and the main action), in Cloud's shell (80 px of rail and gutters beside the workspace) at
// 1024, 1280, 1366 and 1440 px, and on the phone. Where the head has no room, its actions fold first (the search to its
// symbol while it holds no words, what has no `keep` into the "…", which lists it; the main action stays on a
// desktop), then its tabs give way, and its title is cut last; nothing leaves the head's row, and a short name is
// never cut. A head without a "…" keeps its actions.
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
import type {} from "../../test/v2-behavior/head-title.entry";

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-head-title-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { SpaceHead, longName } = await import("../../test/v2-head-title.fixture");
type Head = { name?: string; deeds?: boolean; more?: boolean };
const markup = (head: Head) =>
  renderToString(() => createComponent(SpaceHead, { name: head.name ?? longName, deeds: head.deeds, more: head.more }));
const bundle = await demoBundle("head-title");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
/** Cloud's shell: the rail and its gutters take 80 px beside the workspace (a Space's head is 693 px at 1024). */
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

/** The server's page of a Space's head, with its island mounted over it. */
const open = async (width: number, head: Head = {}): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss(width)}</style></head><body class="k2-ui"><div id="root">${markup(head)}</div></body></html>`,
  );
  await page.addScriptTag({
    content: `window.__spaceName = ${JSON.stringify(head.name ?? longName)}; window.__headDeeds = ${Boolean(head.deeds)}; window.__noMore = ${head.more === false};`,
  });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return page;
};

/** What the head shows: its width, the title's width and whole width, the tabs, the actions, and what leaves the row. */
const head = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 2 && box.height > 2 && getComputedStyle(element).visibility !== "hidden";
    };
    const bar = document.querySelector<HTMLElement>('.k2-ws-main > [data-slot="head"] > .k2-bar')!;
    const title = bar.querySelector<HTMLElement>(".k2-bar-start > .k2-text")!;
    const row = bar.getBoundingClientRect();
    const name = (part: Element) =>
      part.matches(".k2-input[data-search]")
        ? "search"
        : (part.getAttribute("aria-label") ??
          part.querySelector("[aria-label]")?.getAttribute("aria-label") ??
          part.textContent?.trim() ??
          "");
    return {
      head: Math.round(row.width),
      title: Math.round(title.getBoundingClientRect().width),
      whole: title.scrollWidth,
      tabs: [...bar.querySelectorAll(".k2-tab")]
        .filter((tab) => shown(tab) && tab.getBoundingClientRect().top < row.bottom)
        .map((tab) => tab.textContent?.trim()),
      actions: [...bar.querySelectorAll(".k2-bar-end > *")].filter(shown).map(name),
      search: Math.round(bar.querySelector(".k2-input[data-search]")!.getBoundingClientRect().width),
      outside: [...bar.querySelectorAll(".k2-bar-start > *, .k2-bar-end > *")]
        .filter(shown)
        .filter((part) => {
          const box = part.getBoundingClientRect();
          return box.left < row.left - 1 || box.right > row.right + 1;
        })
        .map(name),
    };
  });
const search = (page: Page) => page.locator('.k2-ws-main [data-slot="head"] .k2-input[data-search] input');

test("the server's markup already marks the head's title and its \"…\", so the first frame folds as the live page does", () => {
  const html = markup({ deeds: true });
  expect(html).toMatch(/class="k2-bar"[^>]*data-title=""/);
  expect(html).toMatch(/class="k2-bar-end"[^>]*data-more=""/);
  // a head without a "…" is not marked: it keeps its buttons
  expect(markup({ deeds: true, more: false })).not.toContain("data-more");
});

for (const width of [1024, 1280, 1366])
  test(`at ${width} px in the shell the actions fold first and the long name keeps its words`, async () => {
    const page = await open(width);
    try {
      const seen = await head(page);
      expect(seen.head).toBeLessThan(1100);
      // the search as its symbol, the "…" and the main action; the people give way
      expect(seen.actions).toEqual(["search", "Space-Menü", "Neue Aufgabe"]);
      expect(seen.search).toBe(36);
      expect(seen.outside).toEqual([]);
      // before, the actions kept their room: 171, 427 and 513 px of the 583 px name
      expect(seen.title).toBeGreaterThanOrEqual(Math.min(seen.whole - 2, 340));
      expect(seen.tabs).toContain("Liste");
    } finally {
      await page.close();
    }
  }, 30_000);

test("at 1440 px in the shell the head has room for its actions; the tabs gave way before the title", async () => {
  const page = await open(1440);
  try {
    const seen = await head(page);
    expect(seen.head).toBeGreaterThanOrEqual(1100);
    expect(seen.actions).toEqual(["search", "Ada Lovelace", "Space-Menü", "Neue Aufgabe"]);
    // the search is its symbol at every width (head block, Valentin 26.11.)
    expect(seen.search).toBe(36);
    expect(seen.outside).toEqual([]);
    // the name nearly whole (582 of 583 px in Chromium, 444 px with WebKit's wider letters)
    expect(seen.title).toBeGreaterThanOrEqual(420);
    // the title is cut only once the tabs are down to one
    if (seen.title < seen.whole - 2) expect(seen.tabs).toEqual(["Liste"]);
  } finally {
    await page.close();
  }
}, 30_000);

test("a short name is never cut, and the tabs it leaves room for show", async () => {
  const page = await open(1024, { name: "Büro" });
  try {
    const seen = await head(page);
    expect(seen.title).toBeGreaterThanOrEqual(seen.whole);
    expect(seen.tabs.length).toBeGreaterThan(1);
    expect(seen.outside).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("the folded search opens over the title and the views; with words it stays open, so the filtered list says so", async () => {
  const page = await open(1024);
  try {
    const list = page.getByText("Lieferanten anschreiben");
    const before = await list.boundingBox();
    await search(page).focus();
    await settled(page);
    expect((await page.locator('.k2-ws-main [data-slot="head"] .k2-input[data-search]').boundingBox())?.width ?? 0).toBeGreaterThan(550);
    // the title stands behind the open field
    const covered = await page.evaluate(() => {
      const title = document.querySelector('.k2-ws-main > [data-slot="head"] .k2-bar-start > .k2-text')!.getBoundingClientRect();
      return document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2)?.closest(".k2-input") !== null;
    });
    expect(covered).toBe(true);
    expect(await list.boundingBox()).toEqual(before);
    // Escape without words folds the field back to its symbol
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-input") ?? null)).toBeNull();
    expect((await head(page)).search).toBe(36);
    // with words the field stays open after Escape, its words kept
    await search(page).focus();
    await page.keyboard.type("Liefer");
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-input") ?? null)).toBeNull();
    expect(await search(page).inputValue()).toBe("Liefer");
    const seen = await head(page);
    expect(seen.search).toBeGreaterThan(36);
    expect(seen.outside).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

for (const width of [1024, 390])
  test(`at ${width} px the head's "…" lists the actions that gave way, with their names and deeds`, async () => {
    const page = await open(width, { deeds: true });
    try {
      const seen = await head(page);
      expect(seen.actions).not.toContain("Teilen");
      expect(seen.actions).toContain("Space-Menü");
      await page.getByRole("button", { name: "Space-Menü" }).click();
      const menu = page.locator('[data-k2-part="Menu"]:visible');
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
        "Teilen",
        "Exportieren",
        "Ansicht",
        "Mitglieder",
        "Einstellungen",
      ]);
      // on the phone the main action floats as the round button; on a desktop it stays in the head
      expect(await menu.getByRole("menuitem", { name: "Neue Aufgabe" }).count()).toBe(0);
      await menu.getByRole("menuitem", { name: "Teilen" }).click();
      await settled(page);
      expect(await page.evaluate(() => window.__shared)).toBe(1);
      // a link runs its own click, so it opens as the link does (its way of opening kept)
      await page.getByRole("button", { name: "Space-Menü" }).click();
      await page.locator('[data-k2-part="Menu"]:visible').getByRole("menuitem", { name: "Exportieren" }).click();
      await page.waitForFunction(() => location.hash === "#export");
    } finally {
      await page.close();
    }
  }, 30_000);

test('at 1600 px nothing gave way, so the "…" holds only its own entries', async () => {
  const page = await open(1600, { deeds: true });
  try {
    expect((await head(page)).actions).toContain("Teilen");
    await page.getByRole("button", { name: "Space-Menü" }).click();
    const menu = page.locator('[data-k2-part="Menu"]:visible');
    await menu.waitFor();
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Mitglieder", "Einstellungen"]);
  } finally {
    await page.close();
  }
}, 30_000);

for (const width of [1024, 390])
  test(`at ${width} px a head without a "…" keeps its actions: none vanishes unseen`, async () => {
    const page = await open(width, { deeds: true, more: false });
    try {
      const seen = await head(page);
      expect(seen.actions).toEqual(expect.arrayContaining(["Teilen", "Exportieren", "Ansicht"]));
    } finally {
      await page.close();
    }
  }, 30_000);
