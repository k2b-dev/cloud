import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page, Route } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-states-navigation.client";
import type { FixtureState } from "../../test/v2-states-navigation.fixture";
import { measureV2Layout } from "./testing";
import { hairline, heights, textEdge } from "./tokens";

// The states every place with data has (loading, empty, failed) in a list and a table, the search field (keys, focus,
// its end place), and links that open their page in place (`href` + `onNavigate`), rendered on the server and hydrated
// in the browser (test/v2-states-navigation.fixture.tsx). The fixture starts loading, as a page does.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; padding: 8px; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-states-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-states-navigation.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  [client, browser] = await Promise.all([bundleV2Entry("v2-states-navigation.client.tsx", "dom"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The test page's own origin: links are same-origin, as in an app, and a new tab loads the same page. */
const origin = "http://k2.test";

/**
 * The page as the server sent it, inside a page-swap shell; with `live` (the default) hydrated, as an island would
 * be. `/app/…` answers only when the test lets it (`hold`).
 */
const withPage = async (run: (page: Page, hold: { requests: Route[] }) => Promise<void>, { width = 1440, live = true } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const hold = { requests: [] as Route[] };
  await context.route(`${origin}/**`, async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/app/")) {
      hold.requests.push(route);
      return;
    }
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div data-nav-shell="" data-nav-scope="/"><div data-nav-root=""><div id="root">${server.html}</div></div></div></body></html>`,
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  try {
    await page.goto(`${origin}/`);
    if (live) {
      await page.evaluate(() => {
        window.__k2Sent = document.getElementById("root")!.cloneNode(true);
      });
      await page.addScriptTag({ content: client });
      await page
        .waitForFunction(() => window.__k2Hydrated === true)
        .catch(() => {
          throw new Error(`the page did not hydrate: ${[...errors, ...consoleErrors].join(" | ")}`);
        });
    }
    await settled(page);
    await run(page, hold);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await context.close();
  }
};

/** Waits until the handlers have noted `count` entries (a link runs `onNavigate` in a view transition, a moment later). */
const seenCount = (page: Page, count: number) => page.waitForFunction((expected) => (window.__k2Seen?.length ?? 0) >= expected, count);

const setState = async (page: Page, state: FixtureState) => {
  await page.evaluate((next) => window.__k2SetState!(next), state);
  await settled(page);
};
const seen = (page: Page) => page.evaluate(() => window.__k2Seen ?? []);
const hash = (page: Page) => page.evaluate(() => location.hash);

/** Runs in the page: where the live page differs from what the server sent (elements, texts, attributes). */
const differencesInPage = () => {
  const found: string[] = [];
  const nodes = (parent: Node) =>
    Array.from(parent.childNodes).filter((node) => node.nodeType === 1 || (node.nodeType === 3 && node.textContent !== ""));
  const walk = (a: Node, b: Node, path: string) => {
    if (a.nodeType === 3 || b.nodeType === 3) {
      if (a.nodeType !== b.nodeType || a.textContent !== b.textContent) found.push(`${path}: "${a.textContent}" became "${b.textContent}"`);
      return;
    }
    if (!(a instanceof Element) || !(b instanceof Element)) return;
    if (a.tagName !== b.tagName) {
      found.push(`${path}: <${a.tagName}> became <${b.tagName}>`);
      return;
    }
    // core puts the Workspace's empty toast region in the top layer once it binds; it shows nothing either way
    const region = b.getAttribute("data-slot") === "toast-region";
    for (const name of new Set([...a.getAttributeNames(), ...b.getAttributeNames()]))
      if (name !== "data-hk" && name !== "style" && !(region && name === "popover") && a.getAttribute(name) !== b.getAttribute(name))
        found.push(`${path} [${name}]: "${a.getAttribute(name)}" became "${b.getAttribute(name)}"`);
    const [left, right] = [nodes(a), nodes(b)];
    if (left.length !== right.length) found.push(`${path}: ${left.length} children became ${right.length}`);
    left.forEach((child, index) => {
      const other = right[index];
      if (other) walk(child, other, `${path} > ${index}`);
    });
  };
  walk(window.__k2Sent!, document.getElementById("root")!, "root");
  return found;
};

/** Where the parts that must not move stand, and how high each row of the list and the table is. */
const places = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return [Math.round(rect.left * 100) / 100, Math.round(rect.top * 100) / 100, Math.round(rect.width * 100) / 100];
    };
    const heightsOf = (selector: string) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.getBoundingClientRect().height);
    return {
      status: box('[data-k2-part="StatusRow"]'),
      listRows: heightsOf('.k2-pane[aria-label="Liste"] .k2-scroll .k2-row'),
      firstListRow: box('.k2-pane[aria-label="Liste"] .k2-scroll .k2-row'),
      tableHead: box('.k2-pane[aria-label="Aufträge"] .k2-table thead'),
      tableRows: heightsOf('.k2-pane[aria-label="Aufträge"] .k2-table tbody tr'),
      firstTableRow: box('.k2-pane[aria-label="Aufträge"] .k2-table tbody tr'),
      phoneRows: heightsOf('.k2-pane[aria-label="Aufträge"] .k2-table-phone .k2-row'),
    };
  });

describe("states: loading, empty and failed stand where the data will stand", () => {
  test("hydration: the loading page in the browser is what the server sent", async () => {
    await withPage(async (page) => {
      expect(await page.evaluate(differencesInPage)).toEqual([]);
      // assistive technology hears "loading" once per place (the list and the table; the phone list is hidden on a
      // wide screen), from a status line outside anything busy; the placeholders themselves are hidden from it
      // (an empty status says nothing: the Workspace's toaster keeps one for its announcements)
      expect((await page.getByRole("status").allTextContents()).filter(Boolean)).toEqual(["Wird geladen...", "Wird geladen..."]);
      expect(await page.locator('.k2-table[aria-busy="true"]').count()).toBe(1);
      expect(await page.locator('[aria-busy="true"] [role="status"]').count()).toBe(0);
      expect(await page.locator(".k2-skel:not([aria-hidden] *)").count()).toBe(0);
      // the phone form of the loading table is placeholders, not an empty list
      expect(await page.locator('.k2-table-phone [role="list"]').count()).toBe(0);
      expect(await page.locator('.k2-table-phone [data-k2-part="Loading"] [role="status"]').textContent()).toBe("Wird geladen...");
    });
  });

  for (const width of [1440, 390])
    for (const state of ["loading", "loaded", "empty", "failed"] as const)
      test(`${width} px, ${state}: no layout rule broken`, async () => {
        await withPage(
          async (page) => {
            await setState(page, state);
            expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
          },
          { width },
        );
      });

  for (const width of [1440, 390])
    test(`${width} px: nothing moves when the rows arrive; a placeholder row is as high as its row`, async () => {
      await withPage(
        async (page) => {
          const loading = await places(page);
          await setState(page, "loaded");
          const loaded = await places(page);
          expect(loading.status).toEqual(loaded.status);
          expect(loading.firstListRow).toEqual(loaded.firstListRow);
          // three rows of three lines: 72 and the line
          expect(loading.listRows).toEqual(loaded.listRows);
          expect(loaded.listRows.length).toBe(3);
          expect(loaded.listRows[0]).toBe(heights.row3 + hairline.width);
          if (width >= textEdge.phoneBelow) {
            expect(loading.tableHead).toEqual(loaded.tableHead);
            expect(loading.firstTableRow).toEqual(loaded.firstTableRow);
            expect(loading.tableRows).toEqual(loaded.tableRows);
            expect(loaded.tableRows.length).toBe(3);
          } else {
            // on the phone the table is a list of rows of two lines; its placeholders are rows of two lines too
            expect(loading.phoneRows).toEqual(loaded.phoneRows);
            expect(loaded.phoneRows.length).toBe(3);
          }
        },
        { width },
      );
    });

  test("empty: a round sign, one sentence on the text edge, one way out; a table without rows shows its own", async () => {
    await withPage(async (page) => {
      await setState(page, "empty");
      const shape = await page.evaluate(() => {
        const state = document.querySelector('.k2-pane[aria-label="Liste"] [data-k2-part="Empty"]')!;
        const pane = state.closest(".k2-pane")!.getBoundingClientRect();
        const sign = state.querySelector(".k2-sign")!;
        const text = state.querySelector(".k2-state-text")!;
        const button = state.querySelector(".k2-btn")!;
        return {
          sign: [sign.getBoundingClientRect().width, sign.getBoundingClientRect().height, getComputedStyle(sign).borderRadius],
          signLeft: sign.getBoundingClientRect().left - pane.left,
          textLeft: text.getBoundingClientRect().left - pane.left,
          font: getComputedStyle(text).font,
          button: button.getBoundingClientRect().height,
          box: [getComputedStyle(state).borderTopWidth, getComputedStyle(state).backgroundColor],
        };
      });
      expect(shape.sign.slice(0, 2)).toEqual([40, 40]);
      expect(shape.sign[2]).toBe("999px");
      expect([shape.signLeft, shape.textLeft]).toEqual([textEdge.wide, textEdge.wide]);
      expect(shape.font).toContain("13px / 20px");
      expect(shape.button).toBe(heights.controlSmall);
      // no box: no edge, no surface of its own
      expect(shape.box).toEqual(["0px", "rgba(0, 0, 0, 0)"]);
      await page.getByRole("button", { name: "Filter zurücksetzen" }).click();
      expect(await seen(page)).toEqual(["reset"]);
      // the table without rows: its empty state stands in its place, no head above nothing
      expect(await page.locator('.k2-pane[aria-label="Aufträge"] .k2-table').count()).toBe(0);
      expect(await page.locator('.k2-pane[aria-label="Aufträge"] [data-k2-part="Empty"]').textContent()).toBe(
        "Keine Aufträge mit diesem Filter.",
      );
    });
  });

  test("failed: the sentence and „Erneut versuchen“, which loads again; the place and the status row stay", async () => {
    await withPage(async (page) => {
      const before = await places(page);
      await setState(page, "failed");
      const failed = page.locator('.k2-pane[aria-label="Liste"] [data-k2-part="Failed"]');
      expect(await failed.getAttribute("role")).toBe("alert");
      expect(await failed.locator(".k2-sign").getAttribute("data-tone")).toBe("bad");
      expect((await places(page)).status).toEqual(before.status);
      await failed.getByRole("button", { name: "Erneut versuchen" }).focus();
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await seen(page)).toEqual(["retry"]);
      // it loads again: placeholders stand in the place, then the rows come
      expect(await page.locator('.k2-pane[aria-label="Liste"] [data-k2-part="Loading"]').count()).toBe(1);
      await setState(page, "loaded");
      expect(await page.locator('.k2-pane[aria-label="Liste"] .k2-list .k2-row').count()).toBe(3);
      // the button left with the state: the focus goes on to the first row that came in its place, not to the page
      expect(
        await page.evaluate(() => document.activeElement?.closest(".k2-row")?.textContent ?? document.activeElement?.tagName),
      ).toContain("Holzwerk Brandt");
    });
  });
});

describe("input: keys, focus and a place at the end", () => {
  test("Enter reaches onKeyDown, the ref focuses the field, the filter button sits inside it", async () => {
    await withPage(async (page) => {
      const search = page.getByRole("searchbox", { name: "Suchen" });
      await page.getByRole("button", { name: "Suche fokussieren" }).click();
      expect(await search.evaluate((input) => document.activeElement === input)).toBe(true);
      await page.keyboard.type("Brandt");
      await page.keyboard.press("Enter");
      expect(await seen(page)).toEqual(["search:Brandt"]);
      await settled(page);
      const geometry = await page.evaluate(() => {
        const field = document.querySelector('[data-k2-part="Input"]:has(> .k2-input-end)')!.getBoundingClientRect();
        const button = document.querySelector(".k2-input-end > .k2-btn")!.getBoundingClientRect();
        return {
          field: field.height,
          button: [button.width, button.height],
          above: button.top - field.top,
          below: field.bottom - button.bottom,
        };
      });
      expect(geometry.field).toBe(heights.control);
      expect(geometry.button).toEqual([heights.controlSmall, heights.controlSmall]);
      expect(geometry.above).toBe(geometry.below);
      await page.getByRole("button", { name: "Filter" }).click();
      expect(await seen(page)).toEqual(["search:Brandt", "filter"]);
    });
  });
});

describe("navigation: real links that may open their page in place", () => {
  test("before the page is live every one is a link that works on its own", async () => {
    await withPage(
      async (page) => {
        for (const [role, name, href] of [
          ["link", "Posteingang", "#nav-inbox"],
          ["link", "Ungelesen", "#tab-unread"],
          ["link", "1 verknüpft", "#chip"],
        ] as const)
          expect(await page.getByRole(role, { name, exact: false }).first().getAttribute("href")).toBe(href);
        await page.getByRole("link", { name: "Ungelesen" }).click();
        expect(await hash(page)).toBe("#tab-unread");
      },
      { live: false },
    );
  });

  test("a plain click and Enter open in place through the link of @k2b/ssr/nav; a link without a handler goes to its page", async () => {
    await withPage(async (page) => {
      await setState(page, "loaded");
      await page.getByRole("link", { name: "Holzwerk Brandt" }).click();
      await page.getByRole("link", { name: "Ungelesen" }).click();
      await page.getByRole("link", { name: "Posteingang" }).click();
      await page.getByRole("link", { name: "1 verknüpft" }).click();
      // anywhere on a table row: the row hands the click on to its link
      await page.locator(".k2-table td", { hasText: "617,00 €" }).click();
      await page.getByRole("link", { name: "Alle" }).focus();
      await page.keyboard.press("Enter");
      await seenCount(page, 6);
      expect(await seen(page)).toEqual([
        "row-m1:#m1",
        "tab:#tab-unread",
        "nav:#nav-inbox",
        "chip:#chip",
        "order-AU-2:#AU-2",
        "tab:#tab-all",
      ]);
      // the link took each click: the page stayed where it was
      expect(await hash(page)).toBe("");
      // a disabled link button is an anchor without an address: it leads nowhere and calls nothing
      await page.getByText("Gesperrt").click();
      await settled(page);
      expect(await seen(page)).toHaveLength(6);
      expect(await hash(page)).toBe("");
      await page.getByRole("link", { name: "Gesendet" }).click();
      expect(await hash(page)).toBe("#nav-sent");
    });
  });

  for (const modifier of ["Control", "Shift"] as const)
    test(`${modifier} and a click open a new tab or window, on the link and anywhere on a table row; the handler never sees it`, async () => {
      await withPage(async (page) => {
        await setState(page, "loaded");
        for (const [target, address, browserOwn] of [
          [page.getByRole("link", { name: "Holzwerk Brandt" }), "#m1", true],
          // anywhere on a table row: WebKit would follow a click handed on to the link in this tab, so the row opens it
          [page.locator(".k2-table td", { hasText: "617,00 €" }), "#AU-2", false],
        ] as const) {
          const [opened] = await Promise.all([page.context().waitForEvent("page"), target.click({ modifiers: [modifier] })]);
          // Playwright's WebKit on Linux opens the new page of a modifier click on a link but never loads it (measured
          // 23.11. on a bare anchor): there the new page itself is the proof; everywhere else also its address
          if (browserName === "chromium" || !browserOwn) await opened.waitForURL(`${origin}/${address}`);
          await opened.close();
        }
        await settled(page);
        expect(await seen(page)).toEqual([]);
        expect(page.url()).toBe(`${origin}/`);
      });
    });

  test("opening in place cancels a pending page swap, which then never replaces the page", async () => {
    await withPage(async (page, hold) => {
      await setState(page, "loaded");
      await Promise.all([
        page.waitForRequest(`${origin}/app/A`),
        page.evaluate(() => {
          window.__k2Swap!.install();
          void window.__k2Swap!.swap("/app/A");
        }),
      ]);
      await page.getByRole("link", { name: "Holzwerk Brandt" }).click();
      await seenCount(page, 1);
      // the server answers late; the swap was cancelled when the link took the click, so nothing of it lands
      await hold.requests[0]!.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html><head></head><body><div data-nav-shell="" data-nav-scope="/"><div data-nav-root="">Neu</div></div></body></html>',
      }).catch(() => undefined);
      await settled(page);
      expect(page.url()).toBe(`${origin}/`);
      expect(await page.locator("[data-k2-workspace]").count()).toBe(1);
      expect(await seen(page)).toEqual(["row-m1:#m1"]);
    });
  });

  test("390 px: the main action is a link that opens in place", async () => {
    await withPage(
      async (page) => {
        await page.getByRole("link", { name: "Verfassen" }).click();
        await seenCount(page, 1);
        expect(await seen(page)).toEqual(["primary:#compose"]);
        expect(await hash(page)).toBe("");
      },
      { width: 390 },
    );
  });
});
