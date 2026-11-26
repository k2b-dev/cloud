import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-tree.demo";

// Trees in v2 (test/v2-tree.demo.tsx): the folder tree of a `Nav` group (core's tree through `useTree`) and the same
// folders as rows in levels of a `Table` (`tree`, a treegrid with focused rows). Runs in Chromium and in WebKit
// (TEST_BROWSER=webkit).

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

// a tree of twelve levels walked by key and a paged level; a busy runner needs more than the default five seconds
setDefaultTimeout(20_000);

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-tree"), serverMarkup("../v2-tree"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

const withPage = async (run: (page: Page) => Promise<void>, width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(3000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => window.__mounted === true);
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

const tree = (page: Page) => page.getByRole("tree", { name: "Ordner" });
const place = (page: Page, name: string) => tree(page).getByRole("treeitem", { name, exact: true });
/** The name of the focused tree item or table row. */
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active?.getAttribute("role") === "treeitem") return active.querySelector(":scope > .k2-nt-row > .k2-ni-name")?.textContent;
    return active?.querySelector(".k2-cell-line")?.textContent ?? active?.tagName;
  });
const grid = (page: Page) => page.getByRole("treegrid", { name: "Dateien als Baum" });
const row = (page: Page, name: string) => grid(page).locator("tr[data-tree-row]", { hasText: name }).first();

test("server markup: the open folder is marked, the way to it stands open, closed branches send no children", () => {
  const nav = markup.slice(markup.indexOf('role="tree"'), markup.indexOf('role="treegrid"'));
  expect(nav).toMatch(/role="treeitem"[^>]*aria-current="page"/);
  // Projekte › Website › Texte are open, so Entwürfe stands in the markup; Archiv (closed) sends nothing
  for (const name of ["Projekte", "Website", "Texte", "Entwürfe"]) expect(nav).toContain(name);
  expect(nav).not.toContain("Messe 2027 › ");
  expect(nav).not.toContain("IMG_00001");
  // the table: a treegrid whose rows say their level, and only the top level while nothing is open
  const table = markup.slice(markup.indexOf('role="treegrid"'));
  expect(table).toMatch(/<tr[^>]*aria-level="1"/);
  expect(table).not.toMatch(/aria-level="2"/);
});

test("nav tree: one Tab stop on the open folder; arrows, Right and Left fold, Enter follows the link", async () => {
  await withPage(async (page) => {
    await page.getByRole("link", { name: "Zuletzt" }).focus();
    await page.keyboard.press("Tab");
    expect(await focusedName(page)).toBe("Entwürfe");
    await page.keyboard.press("ArrowLeft");
    expect(await focusedName(page)).toBe("Texte");
    await page.keyboard.press("ArrowLeft");
    expect(await place(page, "Texte").getAttribute("aria-expanded")).toBe("false");
    await page.keyboard.press("ArrowRight");
    expect(await place(page, "Texte").getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("ArrowDown");
    expect(await focusedName(page)).toBe("Entwürfe");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#entwuerfe");
    // the "…" of a folder is not a Tab stop: Tab leaves the tree
    await place(page, "Entwürfe").focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="tree"]'))).toBeNull();
  });
});

test("nav tree: core's tree pattern check passes", async () => {
  await withPage(async (page) => {
    // The check presses Right on the first branch, then Left on its first child and expects the focus on the parent:
    // right for a closed child. "Website" stands open on the way to the open folder, and Left on an open branch
    // closes it first (APG), so it is closed before the check.
    await place(page, "Website").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => window.__checkPattern(document.querySelector('[role="tree"]')!, "tree").then(() => "ok"))).toBe("ok");
  });
});

test("nav tree: the arrow folds without leaving the page; a folder loads its children once, a failure says so and retries", async () => {
  await withPage(async (page) => {
    const archive = place(page, "Archiv");
    await archive.locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    expect(await page.evaluate(() => location.hash)).toBe("");
    await page.waitForFunction(() => document.querySelector('[role="treeitem"][aria-busy="true"]') !== null);
    await page.evaluate(() => window.__release?.());
    await place(page, "2025").waitFor();
    expect(await archive.getAttribute("aria-expanded")).toBe("true");
    // closed and opened again, nothing loads a second time
    await archive.locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    await archive.locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    expect(await page.evaluate(() => window.__loads?.filter((key) => key === "archiv").length)).toBe(1);

    const remote = place(page, "Fernablage");
    await remote.locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    await page.waitForFunction(() => document.querySelector('[role="treeitem"] [data-failed]') !== null);
    expect(await remote.getAttribute("aria-expanded")).toBe("false");
    // the red mark shows in place of the arrow, and the row keeps its height
    expect(await remote.locator(":scope > .k2-nt-row").evaluate((element) => element.getBoundingClientRect().height)).toBe(32);
    await remote.locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    await page.evaluate(() => window.__release?.());
    await page.waitForFunction(() => document.querySelector('[role="treeitem"] [data-failed]') === null);
  });
});

test("nav tree: 'Weitere laden' pages a level of 10 000 and hands the focus to the first new place", async () => {
  await withPage(async (page) => {
    const photos = place(page, "Fotos");
    await photos.focus();
    await page.keyboard.press("ArrowRight");
    const more = tree(page).getByRole("treeitem", { name: /^Weitere .* laden$/ });
    expect(await more.textContent()).toContain("Weitere 9.950 laden");
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("IMG_00051") === true);
    expect(await more.textContent()).toContain("Weitere 9.900 laden");
  });
});

test("nav tree: Shift+F10 and a right-click open a folder's deeds; a deed never opens the folder", async () => {
  await withPage(async (page) => {
    await place(page, "Projekte").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Umbenennen" }).click();
    expect(await page.evaluate(() => window.__treeDeeds)).toEqual(["rename:projekte"]);
    expect(await page.evaluate(() => location.hash)).toBe("");
    // a nested place opens its own deeds, not those of the place around it
    await place(page, "Website").locator(":scope > .k2-nt-row").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Löschen" }).click();
    expect(await page.evaluate(() => window.__treeDeeds)).toEqual(["rename:projekte", "delete:website"]);
    expect(await page.evaluate(() => location.hash)).toBe("");
  });
});

test("nav tree: a place that becomes the open one later opens the way to it", async () => {
  await withPage(async (page) => {
    await place(page, "Projekte").locator(":scope > .k2-nt-row > .k2-nt-chev").click();
    expect(await place(page, "Projekte").getAttribute("aria-expanded")).toBe("false");
    await page.evaluate(() => window.__open?.("bilder"));
    await page.waitForFunction(() => document.querySelector('[role="treeitem"][aria-current="page"]')?.textContent?.startsWith("Bilder"));
    expect(await place(page, "Projekte").getAttribute("aria-expanded")).toBe("true");
  });
});

test("nav tree, worst case: twelve levels and long names stay in the sidebar, cut with '…', at most six steps in", async () => {
  await withPage(async (page) => {
    await place(page, "Tief").focus();
    for (let level = 0; level < 11; level += 1) {
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
    }
    const nav = await page.locator(".k2-nav").evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(nav.scroll).toBeLessThanOrEqual(nav.client);
    const indents = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>('.k2-nt-item[aria-level="9"] > .k2-nt-row, .k2-nt-item[aria-level="12"] > .k2-nt-row'),
      ].map((element) => getComputedStyle(element).paddingLeft),
    );
    expect(indents.length).toBe(2);
    expect(indents[0]).toBe(indents[1]);
    const name = page.locator('.k2-nt-item[aria-level="6"] > .k2-nt-row > .k2-ni-name');
    expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  });
});

test("table tree: rows say level, place and state; Right loads and opens, Left goes back, Enter opens the row", async () => {
  await withPage(async (page) => {
    const projects = row(page, "Projekte");
    expect(await projects.getAttribute("aria-level")).toBe("1");
    expect(await projects.getAttribute("aria-expanded")).toBe("false");
    expect(await projects.getAttribute("aria-setsize")).toBe("6");
    // one Tab stop: the first row
    expect(await grid(page).locator('tr[tabindex="0"]').count()).toBe(1);
    await projects.focus();
    await page.keyboard.press("ArrowRight");
    expect(await projects.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("ArrowRight");
    expect(await focusedName(page)).toBe("Website");
    expect(await row(page, "Website").getAttribute("aria-level")).toBe("2");
    await page.keyboard.press("ArrowLeft");
    expect(await focusedName(page)).toBe("Projekte");
    await page.keyboard.press("End");
    expect(await focusedName(page)).toBe("Notiz.txt");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('tr[aria-current="true"]')?.textContent?.includes("Notiz.txt"));

    // a lazy row: the arrow turns while it loads, the children come one level further in
    const archive = row(page, "Archiv");
    await archive.locator(".k2-tree-chev").click();
    expect(await archive.getAttribute("aria-busy")).toBe("true");
    await page.evaluate(() => window.__release?.());
    await page.waitForFunction(() => [...document.querySelectorAll("tr[aria-level='2']")].some((tr) => tr.textContent?.includes("2025")));
    expect(await archive.getAttribute("aria-expanded")).toBe("true");
    // Left on an open row closes it
    await archive.focus();
    await page.keyboard.press("ArrowLeft");
    expect(await archive.getAttribute("aria-expanded")).toBe("false");
  });
});

test("table tree: a failure shows a red mark and retries; 'Weitere laden' pages 10 000 rows", async () => {
  await withPage(async (page) => {
    const remote = row(page, "Fernablage");
    await remote.locator(".k2-tree-chev").click();
    await page.waitForFunction(() => document.querySelector("tr[data-tree-row] .k2-tree-chev[data-failed]") !== null);
    expect(await remote.getAttribute("aria-expanded")).toBe("false");
    await remote.locator(".k2-tree-chev").click();
    await page.evaluate(() => window.__release?.());
    await page.waitForFunction(() => document.querySelector("tr[data-tree-row] .k2-tree-chev[data-failed]") === null);

    const photos = row(page, "Fotos");
    await photos.focus();
    await page.keyboard.press("ArrowRight");
    const more = grid(page).locator("tr[data-more]");
    expect(await more.textContent()).toContain("Weitere 9.950 laden");
    await more.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("IMG_00051") === true);
    expect(await grid(page).locator("tr[aria-level='2']").count()).toBeGreaterThanOrEqual(100);
    // a row's cells stay the same nodes while rows come around it
    expect(await row(page, "IMG_00001.jpg").getAttribute("aria-posinset")).toBe("1");
  });
});

test("table tree on the phone: the top level as rows of the list, also while rows stand open on the desktop", async () => {
  await withPage(async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await row(page, "Projekte").locator(".k2-tree-chev").click();
    await page.setViewportSize({ width: 390, height: 800 });
    const names = await page
      .locator(".k2-table-phone .k2-row")
      .evaluateAll((rows) => rows.map((element) => element.textContent?.trim() ?? ""));
    expect(names.length).toBe(6);
    expect(names.some((name) => name.includes("Website"))).toBe(false);
  });
});
