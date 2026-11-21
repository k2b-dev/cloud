import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/breadcrumbs.browser-harness";

// K15: a path stays on one line. When it does not fit, its front levels wait behind "…" and the current level
// stays; when the room grows back, the levels come back.
let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/breadcrumbs.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "breadcrumbs-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Breadcrumbs harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const state = (page: Page) =>
  page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".k2b-breadcrumbs__list")!;
    const shown = [...list.querySelectorAll<HTMLElement>(".k2b-breadcrumbs__item")]
      .filter((item) => !item.hidden && item.getClientRects().length > 0)
      // The "…" level holds its menu in the DOM; name it by its trigger.
      .map((item) => (item.classList.contains("k2b-breadcrumbs__more") ? "…" : (item.textContent?.trim() ?? "")));
    return { shown, fits: list.scrollWidth <= list.clientWidth + 0.5 };
  });

const resize = async (page: Page, width: number) => {
  await page.locator("#host").evaluate((host, width) => (host.style.width = `${width}px`), width);
  await page.waitForFunction(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))));
  await settled(page);
};

test("front levels wait behind “…” when the path is narrow and come back when it widens", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 400 } });
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`);
    await page.addScriptTag({ content: bundle });
    await settled(page);
    await resize(page, 1100);
    const wide = await state(page);
    expect(wide.fits).toBe(true);
    expect(wide.shown).toHaveLength(5);
    await resize(page, 300);
    const narrow = await state(page);
    expect(narrow.fits).toBe(true);
    expect(narrow.shown[0]).toBe("…");
    expect(narrow.shown.at(-1)).toContain("Stand plan and material");
    expect(narrow.shown.length).toBeLessThan(5);
    // The waiting levels are a menu behind "…".
    await page.getByRole("button", { name: "Levels above" }).click();
    await page.locator('[role="menu"]').waitFor({ state: "visible" });
    expect(await page.locator('[role="menuitem"]').first().textContent()).toContain("My files");
    await page.keyboard.press("Escape");
    await resize(page, 1100);
    expect(await state(page)).toEqual(wide);
  } finally {
    await page.close();
  }
});
