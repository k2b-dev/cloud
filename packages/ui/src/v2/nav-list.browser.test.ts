import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-nav-list.demo";
import { measureV2Layout } from "./testing";

// A sidebar that holds the app's own rows (`NavGroup` `list`) under its search and main action (`Nav` `search`,
// `primary`): the rows reach the column's edges and scroll on their own, the foot stays at the bottom, and a group array
// built again keeps the list. On the phone the list with its search is the page while no detail is open (`phone:
// "page"`); an open detail is the page in its place.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
// Cloud's shared stylesheet gives every scroller a fixed 0.5rem bar in WebKit and Chromium (index.css, "scrollbars:
// central rule"); the page carries it as Cloud does, so a list that would show its own bar takes room from its rows.
const cloudScrollbar = "#root *::-webkit-scrollbar { width: 0.5rem; height: 0.5rem; }";
const testCss = `html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; } ${cloudScrollbar}`;

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-nav-list"), serverMarkup("../v2-nav-list"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** What the sidebar shows: its parts in order and its rows, as text. */
const shown = (page: Page) =>
  page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>(".k2-ws-side .k2-nav");
    return {
      parts: [...(nav?.children ?? [])].map((child) => child.classList[0]),
      rows: nav?.querySelectorAll(".k2-nav-list .k2-row").length ?? 0,
      text: nav?.innerText ?? "",
    };
  });

const withPage = async (width: number, run: (page: Page) => Promise<void>, mount = true) => {
  const phone = width < 768;
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
    );
    if (mount) {
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
    }
    await settled(page);
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
};

const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, visible: rect.width > 0 && rect.height > 0 };
    });

test("server markup: the search, the main action, the list's rows and the foot are there before the island", () => {
  expect(markup).toContain('class="k2-nav-search"');
  expect(markup).toContain('class="k2-nav-primary"');
  expect(markup).toContain('data-phone="page"');
  expect(markup.match(/class="k2-row"/g)?.length).toBe(40);
  expect(markup).toContain("Archiv");
});

test("the server's sidebar and the live one show the same", async () => {
  let before: Awaited<ReturnType<typeof shown>> | undefined;
  await withPage(
    1440,
    async (page) => {
      before = await shown(page);
    },
    false,
  );
  await withPage(1440, async (page) => {
    expect(await shown(page)).toEqual(before!);
  });
});

for (const width of [1440, 1024])
  test(`at ${width} px the list stands under the filters, reaches the column's edges and scrolls on its own above the foot`, async () => {
    await withPage(width, async (page) => {
      const side = await box(page, ".k2-ws-side");
      expect(side.visible).toBe(true);
      // "Neuer Chat" as an icon button at the end of the name's row, named and with its tooltip; the search under it,
      // then the filters, the list and the foot
      expect((await shown(page)).parts).toEqual(["k2-nav-title", "k2-nav-search", "k2-nav-groups", "k2-nav-list", "k2-nav-foot"]);
      const button = page.locator(".k2-ws-side .k2-nav-title .k2-nav-primary button");
      expect(await button.getAttribute("aria-label")).toBe("Neuer Chat");
      expect(await button.getAttribute("title")).toBe("Neuer Chat");
      expect(await button.innerText()).toBe("");
      const [title, plus] = [await box(page, ".k2-ws-side .k2-nav-title"), await box(page, ".k2-ws-side .k2-nav-primary")];
      expect(plus.top >= title.top && plus.bottom <= title.bottom).toBe(true);
      expect(title.right - plus.right).toBeLessThanOrEqual(12);
      const list = await box(page, ".k2-ws-side .k2-nav-list");
      expect(list.left).toBe(side.left);
      expect(Math.abs(list.right - side.right)).toBeLessThanOrEqual(1);
      // the rows too: the list has no bar of its own that would take their end (a classic one in WebKit)
      const row = await box(page, ".k2-ws-side .k2-nav-list .k2-row");
      expect(Math.abs(row.right - side.right)).toBeLessThanOrEqual(1);
      const foot = await box(page, ".k2-ws-side .k2-nav-foot");
      expect(foot.bottom).toBeGreaterThan(side.bottom - 24);
      expect(list.bottom).toBeLessThanOrEqual(foot.top);
      const scroll = await page
        .locator(".k2-ws-side .k2-nav-list")
        .evaluate((element) => ({ own: element.scrollHeight > element.clientHeight, page: document.documentElement.scrollHeight }));
      expect(scroll.own).toBe(true);
      // the filters keep their height above the list: only the list gives way
      const filters = await page
        .locator(".k2-ws-side .k2-nav-groups")
        .evaluate((element) => ({ entries: element.querySelectorAll(".k2-ni").length, cut: element.scrollHeight - element.clientHeight }));
      expect(filters).toEqual({ entries: 3, cut: 0 });
      expect(scroll.page).toBeLessThanOrEqual(800);
      // the floating action is the phone's only
      expect((await box(page, ".k2-fab")).visible).toBe(false);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
    });
  }, 30_000);

// Valentin, v8: a pinned chat wears a pin on its face's corner; the lines between the chats start right of the face;
// the "…" of a row shows on hover, not on each row; a long name keeps the row's shape.
for (const width of [1440, 390])
  test(`at ${width} px a row wears its badge on its face, parts from the next from its text on, keeps its "…" for the pointer and cuts long text`, async () => {
    await withPage(width, async (page) => {
      const rows = page.locator(".k2-ws-side .k2-nav-list .k2-row");
      // the pin on the first face's bottom right corner, named for assistive technology
      const badge = rows.first().locator(".k2-row-lead > .k2-row-badge");
      expect(await badge.locator('[role="img"]').getAttribute("aria-label")).toBe("Angeheftet");
      const [face, pin] = [
        await box(page, ".k2-ws-side .k2-nav-list .k2-row .k2-av"),
        await box(page, ".k2-ws-side .k2-nav-list .k2-row-badge"),
      ];
      expect(pin.right).toBeGreaterThan(face.right - 4);
      expect(pin.bottom).toBeGreaterThan(face.bottom - 4);
      // the line between rows is drawn from the text column on, to the row's end; the last row draws none
      const line = await rows.nth(1).evaluate((row) => {
        const after = getComputedStyle(row, "::after");
        return { own: getComputedStyle(row).borderBottomWidth, width: after.borderBottomWidth, column: after.gridColumnStart };
      });
      expect(line).toEqual({ own: "0px", width: "1px", column: "2" });
      expect(await rows.last().evaluate((row) => getComputedStyle(row, "::after").display)).toBe("none");
      // the "…": unseen in its place until the pointer is over the row (a pointer screen), not drawn on a touch screen
      const end = rows.nth(1).locator(".k2-row-end");
      if (width >= 768) {
        expect(await end.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
        await hoverInPlace(rows.nth(1));
        await page.waitForFunction(() => getComputedStyle(document.querySelectorAll(".k2-nav-list .k2-row-end")[1]!).opacity === "1");
      } else expect(await end.isVisible()).toBe(false);
      // a long name stays on one line, its last message on at most two
      const long = rows.nth(5);
      const title = await long.locator(".k2-row-title").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(title.height).toBeLessThanOrEqual(title.line + 1);
      const second = await long.locator(".k2-row-l2").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(element).lineHeight),
      }));
      expect(second.height).toBeLessThanOrEqual(2 * second.line + 1);
      const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
      expect({ width, problems: layout.problems }).toEqual({ width, problems: [] });
    });
  }, 30_000);

test("groups built again, a new count and a group put before the others, keep the list, its rows and its scroll; the search writes back", async () => {
  await withPage(1440, async (page) => {
    const list = page.locator(".k2-ws-side .k2-nav-list");
    await list.evaluate((element) => {
      element.scrollTop = 300;
      element.firstElementChild?.setAttribute("data-kept", "");
    });
    const made = await page.evaluate(() => window.__navListMade);
    const kept = () => list.evaluate((element) => [element.scrollTop, element.firstElementChild?.hasAttribute("data-kept")]);
    await page.evaluate(() => window.__navListUnread?.());
    await settled(page);
    expect(await page.locator(".k2-ws-side .k2-ni", { hasText: "Ungelesen" }).innerText()).toContain("4");
    expect(await page.evaluate(() => window.__navListMade)).toBe(made!);
    expect(await kept()).toEqual([300, true]);
    // a group before the others (a pinned place that comes live): the list is the same list, at the same place
    await page.evaluate(() => window.__navListAddGroup?.());
    await settled(page);
    expect(await page.locator(".k2-ws-side .k2-nav-label", { hasText: "Angeheftet" }).count()).toBe(1);
    expect(await page.evaluate(() => window.__navListMade)).toBe(made!);
    expect(await kept()).toEqual([300, true]);
    await page.getByRole("searchbox", { name: "Chats durchsuchen" }).fill("Nora");
    expect(await page.evaluate(() => window.__navListSearch)).toBe("Nora");
  });
}, 30_000);

test("on the phone the list with its search is the page; an open detail is the page in its place, and back returns", async () => {
  await withPage(390, async (page) => {
    // the list is the page: search and rows show, the name, the filters, "Neuer Chat" and the foot are in the menu
    const search = await box(page, ".k2-ws-side .k2-nav-search");
    expect(search.visible).toBe(true);
    expect(search.left).toBe(0);
    for (const part of [".k2-nav-title", ".k2-nav-primary", ".k2-ws-side .k2-ni", ".k2-nav-foot"])
      expect((await box(page, `.k2-ws-side ${part.replace(".k2-ws-side ", "")}`)).visible).toBe(false);
    const row = await box(page, ".k2-ws-side .k2-nav-list .k2-row");
    expect(row.left).toBe(0);
    expect(row.right).toBe(390);
    expect((await box(page, ".k2-fab")).visible).toBe(true);
    let layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    // a chat opens: the detail is the page, the list gives way
    await page.locator(".k2-ws-side .k2-nav-list .k2-row").nth(2).locator("button, a").first().click();
    await settled(page);
    expect((await box(page, ".k2-ws-side")).visible).toBe(false);
    expect(await page.locator(".k2-pane[data-detail]").innerText()).toContain("Nora Weber");
    layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await page.evaluate(() => window.__navListClose?.());
    await settled(page);
    expect((await box(page, ".k2-ws-side .k2-nav-list")).visible).toBe(true);
  });
}, 30_000);

test("on the phone a pane of its own (no detail) is the page in the list's place, and its way back returns to the list", async () => {
  await withPage(390, async (page) => {
    await page.evaluate(() => window.__navListPage?.());
    await settled(page);
    expect((await box(page, ".k2-ws-side")).visible).toBe(false);
    const pane = page.locator(".k2-pane", { hasText: "Ankündigungen" });
    expect(await pane.isVisible()).toBe(true);
    const shown = await box(page, ".k2-pane:not([data-detail-empty])");
    expect(shown.top).toBeLessThan(800);
    const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
    expect(layout.problems).toEqual([]);
    await page
      .getByRole("link", { name: "Chats" })
      .or(page.getByRole("button", { name: "Chats" }))
      .first()
      .click();
    await settled(page);
    expect((await box(page, ".k2-ws-side .k2-nav-list")).visible).toBe(true);
  });
}, 30_000);

test("on the phone the way back from a chat returns to the list where it was, the focus on the chat that was open", async () => {
  await withPage(390, async (page) => {
    const list = page.locator(".k2-ws-side .k2-nav-list");
    // the phone's page scrolls the list on its own, as in the sidebar
    await list.evaluate((element) => {
      element.scrollTop = 600;
    });
    const opener = page.locator(".k2-ws-side .k2-nav-list .k2-row").nth(14).locator("button, a").first();
    await opener.scrollIntoViewIfNeeded();
    const scrolled = await list.evaluate((element) => element.scrollTop);
    await opener.click();
    await settled(page);
    expect(await page.locator(".k2-pane[data-detail]").isVisible()).toBe(true);
    await page
      .getByRole("button", { name: "Chats" })
      .or(page.getByRole("link", { name: "Chats" }))
      .first()
      .click();
    await settled(page);
    expect(await list.evaluate((element) => element.scrollTop)).toBe(scrolled);
    expect(await opener.evaluate((element) => element === document.activeElement)).toBe(true);
  });
}, 30_000);
