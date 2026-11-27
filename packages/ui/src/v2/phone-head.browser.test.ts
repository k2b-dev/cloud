// The head of a v2 screen on the phone, measured over every recipe of the k2b-ui skill at 390 px inside a host whose
// bar holds a search (as Cloud's shell does; design review 26.11.): exactly one search place across the host's bar and
// the heads, no head row that takes room without showing something, and an open detail shows its way back and its
// title, never the views of the list.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-phone-head-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const recipes = readdirSync(recipesDir)
  .filter((name) => name.endsWith(".tsx"))
  .sort();
const markup = new Map<string, string>();
for (const name of recipes) {
  const screen = (await import(resolve(recipesDir, name))) as { default: Parameters<typeof createComponent>[0] };
  markup.set(
    name,
    renderToString(() => createComponent(screen.default, {})),
  );
}
const { DetailBack, longSpace, PathAndSearch } = await import("../../test/v2-phone-head.fixture");
const pathAndSearch = renderToString(() => createComponent(PathAndSearch, {}));
const detailBack = (back: string) => renderToString(() => createComponent(DetailBack, { back }));
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// a host as Cloud's shell on the phone: its bar with the app and the one search, the screen below it
const hostCss =
  "html, body { margin: 0; height: 100%; } .host { position: fixed; inset: 0; display: flex; flex-direction: column; }" +
  " .host-bar { height: 52px; flex: none; display: flex; align-items: center; justify-content: flex-end; padding: 0 16px; }" +
  " .frame { position: relative; flex: 1; min-height: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** What the phone shows of the heads: visible searches, head rows without anything visible, and open details. */
const look = (page: Page) =>
  page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 2 && box.height > 2 && getComputedStyle(element).visibility !== "hidden";
    };
    const describe = (element: Element) => `${element.getAttribute("data-k2-part") ?? element.className}`;
    const searches = [...document.querySelectorAll('.frame [data-slot="head"] .k2-input[data-search]')].filter(shown).map(describe);
    const emptyRows = [...document.querySelectorAll('.frame [data-slot="head"]')]
      .filter((head) => head.getBoundingClientRect().height > 0)
      .filter((head) => ![...head.querySelectorAll("*")].some((part) => shown(part) && part.children.length === 0))
      .map((head) => head.closest("[data-k2-part]")?.getAttribute("data-k2-part") ?? "head");
    const details = [...document.querySelectorAll(".frame .k2-pane[data-detail]")].filter(shown).map((detail) => ({
      back: [...detail.querySelectorAll(':scope > [data-k2-part="Back"]')].some(shown),
      title: [...detail.querySelectorAll(':scope > [data-slot="head"] .k2-bar-start')].some(shown),
      listViews: [...document.querySelectorAll('.frame .k2-ws-main > [data-slot="head"] .k2-tabs-nav')].some(shown),
    }));
    return { searches, emptyRows, details };
  });

const open = async (screen: string) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><style>${css}</style><style>${hostCss}</style></head><body>` +
      // the host marks the v2 scope (`data-k2-host-search`), as Cloud's shell does on a v2 page
      `<div class="host"><div class="host-bar"><button type="button" aria-label="Suche">S</button></div>` +
      `<div class="frame k2-ui" data-k2-host-search id="root">${screen}</div></div></body></html>`,
  );
  await settled(page);
  return page;
};

describe("the head of a v2 screen on the phone, in a host whose bar holds the search", () => {
  test("there are recipes", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(6);
  });
  for (const name of recipes)
    test(`${name} at 390 px`, async () => {
      const page = await open(markup.get(name) ?? "");
      try {
        const seen = await look(page);
        // the host's bar is the one search place
        expect(seen.searches, "a second search in a head").toEqual([]);
        expect(seen.emptyRows, "a head row that shows nothing").toEqual([]);
        for (const detail of seen.details) expect(detail, "an open detail").toEqual({ back: true, title: true, listViews: false });
      } finally {
        await page.close();
      }
    }, 30_000);

  test("a head of a path and a search takes no room, and its search opens over the top without moving the page", async () => {
    const page = await open(pathAndSearch);
    try {
      expect(await look(page)).toEqual({ searches: [], emptyRows: [], details: [] });
      const row = page.getByText("Mietvertrag Halle 3");
      const before = await row.boundingBox();
      // the host's search button gives the focus to the field of the head (Cloud: `openPageSearch`)
      await page.locator('[data-slot="head"] .k2-input[data-search] input').focus();
      await settled(page);
      expect(await page.evaluate(() => document.activeElement?.closest(".k2-input[data-search]") !== null)).toBe(true);
      const field = await page.locator('[data-slot="head"] .k2-input[data-search]').boundingBox();
      expect(field?.width ?? 0).toBeGreaterThan(300);
      expect(await row.boundingBox()).toEqual(before);
    } finally {
      await page.close();
    }
  }, 30_000);
});

test("a way back that names a Space of a hundred characters stays short, keeps its whole name, and never moves the title", async () => {
  const measure = async (back: string) => {
    const page = await open(detailBack(back));
    try {
      expect((await look(page)).details).toEqual([{ back: true, title: true, listViews: false }]);
      return await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('[data-k2-part="Back"]')!;
        const button = row.querySelector<HTMLElement>(".k2-btn")!;
        const label = button.querySelector<HTMLElement>(".k2-btn-label")!;
        const title = document.querySelector('.k2-pane[data-detail] > [data-slot="head"] .k2-bar-start')!.getBoundingClientRect();
        return {
          share: button.getBoundingClientRect().width / row.getBoundingClientRect().width,
          rowHeight: row.getBoundingClientRect().height,
          cut: label.scrollWidth > label.clientWidth,
          name: `${button.textContent?.trim()}|${button.getAttribute("title")}`,
          title: [title.left, title.top, title.width].map(Math.round).join(","),
        };
      });
    } finally {
      await page.close();
    }
  };
  const short = await measure("Protokolle");
  const long = await measure(longSpace);
  expect(short.cut).toBe(false);
  // short: at most 60 % of its row, one line, cut with "…", the whole name for assistive technology and as the hint
  expect(long.share).toBeLessThanOrEqual(0.6);
  expect(long.rowHeight).toBe(short.rowHeight);
  expect(long.cut).toBe(true);
  expect(long.name).toBe(`${longSpace}|${longSpace}`);
  expect(long.title).toBe(short.title);
}, 30_000);
