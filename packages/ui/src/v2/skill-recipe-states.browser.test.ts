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
// then the page and each open surface keep the v2 rules at 1440 and 390 px, so a picture of an open menu never teaches
// a mistake either.

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

const open = async (width: number, recipe?: { name: string; state?: string }): Promise<{ page: Page; errors: string[] }> => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 768, isMobile: width < 768 });
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
  const { page } = await open(1440);
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
        for (const width of [1440, 390]) {
          const { page, errors } = await open(width, { name, state });
          try {
            const where = `${name} ${state} at ${width} px`;
            for (const step of listed[name]?.[state] ?? [])
              await press(page, step).catch((error: unknown) => {
                throw new Error(`${where}: could not press \"${step}\"`, { cause: error });
              });

            const outline = await describeV2Page(page, "body");
            expect(`${where}\n${outline}`).not.toContain("Problems");
            const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
            expect([where, layout.problems]).toEqual([where, []]);
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
    }, 120_000);
  }
});
