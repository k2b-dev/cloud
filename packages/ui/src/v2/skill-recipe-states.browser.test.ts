import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-recipes.entry";
import { describeV2Page, measureV2Layout } from "./testing";

// Every state of every k2b-ui recipe, mounted in the browser as Fibel's Example shows it. A state with `press` opens an
// overlay (a menu, a panel, a dialog, a toast) by pressing the buttons and menu entries it names, as a person would;
// then the page and each open surface keep the v2 rules at 1440, 1024, 390 and 320 px and at 200 % zoom of a 1440 px
// window (720 CSS px at twice the pixels), so a picture of an open menu never teaches a mistake either. The widths are
// where the worst-case states broke (break-ui, 25.11.): a record's main column at 1024, a table at 200 %, a deed at 320.

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

            const outline = await describeV2Page(page, "body");
            expect(`${where}\n${outline}`).not.toContain("Problems");
            const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
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
});
