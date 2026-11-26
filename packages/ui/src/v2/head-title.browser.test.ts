// The title of a workspace head beside its views and actions (W3, a Space's head: its name, four views, a search, its
// people, its "…" menu and the main action), at 390, 1024 and 1440 px. Where the head has no room, its actions fold
// first (the search to its symbol, what has no `keep` into the "…" menu; the main action stays on a desktop), so the
// title keeps its words; nothing leaves the head's row, and a short name is never cut.
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
const markup = (name: string) => renderToString(() => createComponent(SpaceHead, { name }));
const bundle = await demoBundle("head-title");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The server's page of a Space's head, with its island mounted over it. */
const open = async (width: number, name = longName): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup(name)}</div></body></html>`,
  );
  await page.addScriptTag({ content: `window.__spaceName = ${JSON.stringify(name)};` });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return page;
};

/** What the head shows: the title's width and whole width, the tabs, the actions and their widths, and what leaves the row. */
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

test("at 1024 px beside the sidebar the actions fold first: the search keeps its symbol, the people go, the title keeps its words", async () => {
  const page = await open(1024);
  try {
    const seen = await head(page);
    // the search as its symbol, the "…" menu and the main action; the people go into the "…" menu (the Space menu)
    expect(seen.actions).toEqual(["search", "Space-Menü", "Neue Aufgabe"]);
    expect(seen.search).toBe(36);
    expect(seen.outside).toEqual([]);
    // before, the actions kept their room and the title had 160 px of 583
    expect(seen.title).toBeGreaterThanOrEqual(220);
    expect(seen.tabs).toContain("Liste");
  } finally {
    await page.close();
  }
}, 30_000);

test("at 1024 px the folded search opens over the title and the views and folds back on Escape, its words kept", async () => {
  const page = await open(1024);
  try {
    const list = page.getByText("Lieferanten anschreiben");
    const before = await list.boundingBox();
    await page.locator('.k2-ws-main [data-slot="head"] .k2-input[data-search] input').focus();
    await settled(page);
    const field = await page.locator('.k2-ws-main [data-slot="head"] .k2-input[data-search]').boundingBox();
    expect(field?.width ?? 0).toBeGreaterThan(600);
    // the title stands behind the open field
    const covered = await page.evaluate(() => {
      const title = document.querySelector('.k2-ws-main > [data-slot="head"] .k2-bar-start > .k2-text')!.getBoundingClientRect();
      return document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2)?.closest(".k2-input") !== null;
    });
    expect(covered).toBe(true);
    expect(await list.boundingBox()).toEqual(before);
    await page.keyboard.type("Liefer");
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await page.evaluate(() => document.activeElement?.closest(".k2-input") ?? null)).toBeNull();
    expect(await page.locator('.k2-ws-main [data-slot="head"] .k2-input[data-search] input').inputValue()).toBe("Liefer");
    expect((await head(page)).search).toBe(36);
  } finally {
    await page.close();
  }
}, 30_000);

test("at 1440 px the head has room: the search shows its field and the people stay", async () => {
  const page = await open(1440);
  try {
    const seen = await head(page);
    expect(seen.actions).toEqual(["search", "Ada Lovelace", "Space-Menü", "Neue Aufgabe"]);
    expect(seen.search).toBeGreaterThan(36);
    expect(seen.outside).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("at 390 px the phone keeps the search's symbol and the menu, the open view and the title's start", async () => {
  const page = await open(390);
  try {
    const seen = await head(page);
    expect(seen.actions).toEqual(["search", "Space-Menü"]);
    expect(seen.tabs).toContain("Liste");
    expect(seen.outside).toEqual([]);
    // the open view and "Mehr" stay whole beside it (the tabs' own rule); the title keeps its start
    expect(seen.title).toBeGreaterThanOrEqual(120);
  } finally {
    await page.close();
  }
}, 30_000);

test("a short name is never cut, at 1024 px too", async () => {
  const page = await open(1024, "Büro");
  try {
    const seen = await head(page);
    expect(seen.title).toBeGreaterThanOrEqual(seen.whole);
    expect(seen.outside).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
