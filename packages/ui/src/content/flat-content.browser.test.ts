import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { layoutProblems } from "../layout-check";

let browser: Browser, bundle: string, css: string;
const pages: Page[] = [];
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/flat-content.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "flat-content-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Transform failed: ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Flat content harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30000);
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
});
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  pages.push(page);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body{margin:0} .column{margin-bottom:32px} .column[data-probe^="path"]{padding:0 var(--k2b-gutter)} .narrow{width:340px;box-sizing:border-box}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await settled(page);
  return page;
};

const box = (page: Page, selector: string, index = 0) =>
  page
    .locator(selector)
    .nth(index)
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height, width: rect.width };
    });
const gutter = (page: Page) =>
  page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--k2b-gutter")) || 20);

for (const width of [390, 768, 1440, 1920])
  test(`${width} px: task rows and paths do not overlap, spill, or cut`, async () => {
    const page = await open(width);
    expect((await page.evaluate(layoutProblems, { root: "#app" })).problems).toEqual([]);
  });

for (const width of [390, 1440])
  test(`task row at ${width} px: fixed heights, symbol on the text edge, action word whole`, async () => {
    const page = await open(width);
    const edge = await gutter(page);
    const phone = width < 768;
    const heights = await page.locator(".k2b-task-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    // 52 with a quiet line, 40 without; at least 60 on a phone (K1). The line between rows is inside the height.
    expect(heights).toEqual(phone ? [60, 60, 60, 60, 60] : [52, 40, 40, 52, 40]);
    for (let index = 0; index < heights.length; index++) {
      const row = await box(page, ".k2b-task-row", index);
      const icon = await box(page, ".k2b-task-row__icon", index);
      const action = await box(page, ".k2b-task-row__action", index);
      expect(Math.abs(icon.left - row.left - edge - (20 - icon.width) / 2)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(row.right - edge - action.right)).toBeLessThanOrEqual(0.5);
    }
    // The long sentence ends in an ellipsis; the action word keeps its whole width.
    const long = page.locator(".k2b-task-row").nth(2);
    const cut = await long
      .locator(".k2b-task-row__text")
      .evaluate((text) => ({ cut: text.scrollWidth > text.clientWidth, ellipsis: getComputedStyle(text).textOverflow }));
    expect(cut).toEqual({ cut: true, ellipsis: "ellipsis" });
    expect(await long.locator(".k2b-task-row__action").evaluate((action) => action.scrollWidth <= action.clientWidth)).toBe(true);
  });

test("task row: one target with a name, a tooltip only while cut, focus without movement, and disabled states", async () => {
  const page = await open(1440);
  expect(await page.getByRole("link", { name: /Nicht verkaufte Artikel sind abholbereit/ }).getAttribute("href")).toBe("#herausgabe");
  expect(await page.getByRole("button", { name: /Abrechnung Oktober senden/ }).count()).toBe(1);
  // No control inside a row: the row is the only target.
  expect(await page.locator(".k2b-task-row :is(a, button)").count()).toBe(0);

  const tooltip = page.locator('[role="tooltip"]:popover-open');
  await page.locator(".k2b-task-row").nth(1).hover();
  await page.waitForTimeout(400);
  expect(await tooltip.count()).toBe(0);
  await page.locator(".k2b-task-row").nth(2).hover();
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent?.includes("Entsorgung"));
  await page.mouse.move(0, 890);

  const before = await box(page, ".k2b-task-row", 2);
  await page.locator("body").evaluate((body) => (body as HTMLElement).focus());
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.textContent)).toContain("Retouren");
  await page.waitForFunction(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent?.includes("Entsorgung"));
  expect(await box(page, ".k2b-task-row", 2)).toEqual(before);
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).toBe("solid");

  // A disabled button and a disabled link stay in place and take no focus.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-task-row"))).toBe(false);
  expect(await page.getByRole("button", { name: /Vertrag gegenzeichnen/ }).isDisabled()).toBe(true);
  const link = page.locator(".k2b-task-row").nth(4);
  expect(await link.evaluate((row) => [row.tagName, row.getAttribute("href"), row.getAttribute("aria-disabled")])).toEqual([
    "A",
    null,
    "true",
  ]);
});

test("progress path: dots on one line on the text edge, side by side when wide, one below the other under 360 px", async () => {
  const page = await open(1440);
  const edge = await gutter(page);
  const column = await box(page, '[data-probe="path"]');
  const markers = await page
    .locator('[data-probe="path"] .k2b-progress-path__marker')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, size: r.width })));
  expect(markers.map((marker) => marker.size)).toEqual([20, 20, 20, 20]);
  expect(Math.abs(markers[0]!.left - column.left - edge)).toBeLessThanOrEqual(0.5);
  expect(new Set(markers.map((marker) => marker.top)).size).toBe(1);

  const narrow = await page
    .locator('[data-probe="path-narrow"] .k2b-progress-path__marker')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top })));
  expect(new Set(narrow.map((marker) => marker.left)).size).toBe(1);
  expect(narrow.every((marker, index) => index === 0 || marker.top > narrow[index - 1]!.top)).toBe(true);

  // The state is a word for screen readers, and the current stage is marked as such.
  const current = page.locator('[data-probe="path"] [aria-current="step"]');
  expect(await current.locator(".k2b-progress-path__label").textContent()).toBe("Versendet, aktueller Schritt");
  expect(await page.locator('[data-probe="path"] .k2b-progress-path__step').first().textContent()).toContain("erledigt");
  expect(await page.locator('[data-probe="path"] .k2b-progress-path__step').last().textContent()).toContain("noch offen");
  expect(await current.locator(".k2b-progress-path__label").evaluate((label) => getComputedStyle(label).fontWeight)).toBe("600");
});
