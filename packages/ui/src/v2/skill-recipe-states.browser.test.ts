import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-recipes.entry";
import { describeV2Page, measureV2Layout } from "./testing";

// Every state of every k2b-ui recipe, mounted in the browser as Fibel's Example shows it: in the frame of a host. A
// state with `press` opens an overlay (a menu, a panel, a dialog, a toast) by pressing the buttons and menu entries it
// names, as a person would; then the page and each open surface keep the v2 rules at 1440, 1024, 390 and 320 px and at 200 % zoom of a 1440 px window (720 CSS px at twice the pixels), so a
// picture of an open menu never teaches a mistake either. Every thing a recipe lists carries its sign (a mark, a
// thumbnail or a person), because agents copy recipes: a bare row here becomes a bare screen in an app.
// The widths are where the worst-case states broke (break-ui, 25.11.): a record's main column at 1024, a table at
// 200 %, a deed at 320.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";
const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const files = readdirSync(recipesDir)
  .filter((name) => name.endsWith(".tsx"))
  .sort();
const surfaces = "[data-k2-part='Dialog'], [data-k2-part='Menu'], .k2-pop";

let browser: Browser;
let bundle: string;
let listed: Record<string, Record<string, readonly string[]>> = {};

/** A window: its CSS width and its zoom (200 % zoom lays a 1440 px window out at 720 CSS px with twice the pixels). */
type View = { name: string; width: number; zoom: number };
const views: readonly View[] = [
  { name: "1440 px", width: 1440, zoom: 1 },
  { name: "1024 px", width: 1024, zoom: 1 },
  { name: "390 px", width: 390, zoom: 1 },
  { name: "320 px", width: 320, zoom: 1 },
  { name: "200 % zoom", width: 720, zoom: 2 },
];

const open = async (view: View, recipe?: { name: string; state?: string }): Promise<{ page: Page; errors: string[] }> => {
  const phone = view.width < 768 && view.zoom === 1;
  const page = await browser.newPage({
    viewport: { width: view.width, height: view.zoom === 1 ? 900 : 450 },
    deviceScaleFactor: view.zoom,
    hasTouch: phone,
    isMobile: phone,
  });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: `window.__recipe = ${JSON.stringify(recipe ?? null)};` });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__mounted === true);
  await settled(page);
  return { page, errors };
};

/**
 * What runs out of the window sideways: the page never scrolls sideways, so a part beyond the window's edge is lost
 * (a table at 200 % zoom). What a scroller holds (a wide table in its place, a strip of filters) is reached by
 * scrolling and does not count.
 */
const beyondWindow = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    // held: a scroller around it reaches it, or a box of content that clips inside the window cuts it off (then that
    // box is what a person sees, and the v2 rules judge its cut). The frame (workspace, columns, panes) cutting a part
    // off is the loss this looks for, so it holds nothing.
    const frame = "[data-k2-workspace], [data-k2-column], .k2-split, .k2-pane, .k2-scroll";
    const held = (element: Element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
        if (
          (overflow === "hidden" || overflow === "clip") &&
          !node.matches(frame) &&
          node.getBoundingClientRect().right <= window.innerWidth + 1
        )
          return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll("[data-k2-workspace] *")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= window.innerWidth + 1 || held(element)) continue;
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      out.push(
        `<${element.tagName.toLowerCase()}.${element.classList[0] ?? ""}> ends at ${Math.round(box.right)} px, beyond ${window.innerWidth}`,
      );
      if (out.length === 5) break;
    }
    return out;
  });

/**
 * The things a page lists without their sign: rows of a list, rows of a table (desktop and phone) and tiles that carry
 * no `Mark` (symbol in its colour, or a thumbnail) and no `Avatar`. Places that wait for data (`Loading`) list nothing.
 */
const faceless = (page: Page) =>
  page.evaluate(() => {
    const face = "[data-k2-part='Mark'], [data-k2-part='Avatar'], [data-k2-part='Avatar.Stack']";
    const things = document.querySelectorAll(
      "[data-k2-part='Row'], [data-k2-part='Table'] tbody tr:not([data-group], [data-loading]), [data-k2-part='Tiles'] .k2-tile:not([data-create])",
    );
    return [...things]
      .filter((thing) => thing.getClientRects().length > 0 && !thing.closest("[data-k2-part='Loading'], [data-k2-part='Menu']"))
      .filter((thing) => !thing.querySelector(face))
      .map((thing) => (thing.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48));
  });

/** Presses the visible button, link or menu entry with exactly this name. */
const press = async (page: Page, name: string) => {
  const target = page
    .getByRole("button", { name, exact: true })
    .or(page.getByRole("menuitem", { name, exact: true }))
    .or(page.getByRole("menuitemradio", { name, exact: true }))
    .locator("visible=true")
    .first();
  await target.click();
  await settled(page);
};

beforeAll(async () => {
  [bundle, browser] = await Promise.all([demoBundle("../v2-recipes"), launchBrowser()]);
  const { page } = await open(views[0]!);
  listed = await page.evaluate(() => window.__recipes);
  await page.close();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

describe("k2b-ui recipe states keep the v2 rules in the browser", () => {
  test("the bundle knows every recipe", () => {
    expect(Object.keys(listed).sort()).toEqual(files);
  });
  for (const name of files) {
    // The states come from the bundle, which imports every recipe compiled for the browser; the test process never
    // imports a recipe's .tsx itself (its own JSX transform is not the browser's). A file that exports `states` while
    // the bundle lists none still fails.
    test(`${name}: states`, async () => {
      const states = Object.keys(listed[name] ?? {});
      const exportsStates = /^export const states\b/m.test(readFileSync(resolve(recipesDir, name), "utf8"));
      expect(states.length > 0).toBe(exportsStates);
      for (const state of states)
        for (const view of views) {
          const { page, errors } = await open(view, { name, state });
          try {
            const where = `${name} ${state} at ${view.name}`;
            for (const step of listed[name]?.[state] ?? [])
              await press(page, step).catch((error: unknown) => {
                throw new Error(`${where}: could not press \"${step}\"`, { cause: error });
              });

            // the screen stands in the frame of a host (tinted page, rail), never on a bare white page
            expect([where, await page.locator("[data-k2-frame] > .k2-sf-card > [data-k2-workspace]").count()]).toEqual([where, 1]);
            expect([where, await faceless(page)]).toEqual([where, []]);

            const outline = await describeV2Page(page, "body");
            expect(`${where}\n${outline}`).not.toContain("Problems");
            // under an open dialog the page's grips lie behind its backdrop, so no pill shows; the dialog is measured below
            const modal = await page.locator("[data-k2-part='Dialog']").locator("visible=true").count();
            const layout = await measureV2Layout(page, { root: "[data-k2-workspace]", ...(modal ? { grips: "[data-k2-no-grip]" } : {}) });
            expect([where, layout.problems]).toEqual([where, []]);
            expect([where, await beyondWindow(page)]).toEqual([where, []]);
            if ((listed[name]?.[state] ?? []).length > 0) {
              // what the presses opened stands above the page: a surface, or a toast
              const opened = page.locator(`${surfaces}, [data-slot='toast']`).locator("visible=true");
              expect([where, await opened.count()]).not.toEqual([where, 0]);
              for (const surface of await page.locator(surfaces).locator("visible=true").all()) {
                const id = await surface.evaluate((element) => {
                  element.setAttribute("data-k2-measured", "");
                  return element.getAttribute("data-k2-part") ?? element.className;
                });
                const found = await measureV2Layout(page, { root: "[data-k2-measured]" });
                expect([where, id, found.problems]).toEqual([where, id, []]);
                await surface.evaluate((element) => element.removeAttribute("data-k2-measured"));
              }
            }
            expect([where, errors]).toEqual([where, []]);
          } finally {
            await page.close();
          }
        }
    }, 300_000);
  }

  // A job name of 120 signs made a phone row of seven lines (gateway-ops runs, lane C, 26.11.): on the phone a row of a
  // table keeps its title to two lines and the line under it to one, each cut with "…" and whole on hover.
  for (const view of views.filter((each) => each.width < 768 && each.zoom === 1))
    test(`table.tsx worst at ${view.name}: a phone row keeps two lines of title and one under it`, async () => {
      const { page } = await open(view, { name: "table.tsx", state: "worst" });
      try {
        const rows = await page.$$eval(".k2-table-phone .k2-row", (elements) =>
          elements.map((row) => {
            const lines = (selector: string) => {
              const element = row.querySelector<HTMLElement>(selector)!;
              return Math.round(element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight));
            };
            return {
              title: lines(".k2-row-title"),
              second: lines(".k2-row-l2"),
              tips: [...row.querySelectorAll(".k2-row-title [title], .k2-row-l2 [title]")].length,
            };
          }),
        );
        expect(rows.length).toBeGreaterThan(4);
        // the long name and its number are cut, not wrapped: two lines and one
        expect(Math.max(...rows.map((row) => row.title))).toBe(2);
        expect(Math.max(...rows.map((row) => row.second))).toBe(1);
        expect(rows.every((row) => row.tips === 2)).toBe(true);
      } finally {
        await page.close();
      }
    });

  // The search of the filter recipe lived only in the island (Codex review of #4209): Enter filtered, a reload lost it.
  // On a page with a real address the recipe mounts as the server would render it from that address.
  test("filtered-table.tsx: a search is written to the address on Enter, kept on reload, undone by back", async () => {
    const origin = "http://recipes.test";
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(2000);
    const errors = pageErrors(page);
    await page.route(`${origin}/**`, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root"></div></body></html>`,
      }),
    );
    const mount = async () => {
      await page.addScriptTag({ content: `window.__recipe = ${JSON.stringify({ name: "filtered-table.tsx", state: "address" })};` });
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
      await settled(page);
    };
    const field = page.getByRole("searchbox", { name: "Auftrag oder Kunde" });
    try {
      await page.goto(`${origin}/auftraege?status=open`);
      await mount();
      await field.fill("Regal");
      await field.press("Enter");
      await settled(page);
      expect(new URL(page.url()).searchParams.get("q")).toBe("Regal");
      expect(new URL(page.url()).searchParams.get("status")).toBe("open");
      // back leaves the search, forward brings it again: the bar follows the address
      await page.goBack();
      await settled(page);
      expect(new URL(page.url()).searchParams.get("q")).toBeNull();
      expect(await field.inputValue()).toBe("");
      await page.goForward();
      await settled(page);
      expect(await field.inputValue()).toBe("Regal");
      // a reload renders from the address: the search stands in its field
      await page.reload();
      await mount();
      expect(await field.inputValue()).toBe("Regal");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
