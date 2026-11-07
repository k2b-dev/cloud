import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chart-frame-states.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chart-frame-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Chart frame harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors = pageErrors(page);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".frame-bar .stdlib-chart-bar");
  await settled(page);
  return { page, errors };
};

/** Boxes of the frame, title, subtitle line and viewport, relative to the page. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    [
      ".frame",
      ".k2b-chart-explorer__title",
      ".k2b-chart-explorer__description",
      ".k2b-chart-explorer__viewport",
      ".k2b-chart-explorer__actions",
    ].map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    }),
  );

for (const width of [1280, 390]) {
  test(`no state moves the frame, its title, subtitle or viewport at ${width} px`, async () => {
    const { page, errors } = await open(width);
    const reference = await boxes(page);
    for (const state of ["loading", "empty", "error", "stale", "data"]) {
      await page.evaluate((next) => (window as unknown as { setFrameState(s: string): void }).setFrameState(next), state);
      await settled(page);
      expect({ state, boxes: await boxes(page) }).toEqual({ state, boxes: reference });
    }
    // The table view reaches the frame's left, right and bottom edges and keeps the frame's height.
    await page.evaluate(() => (window as unknown as { setFrameView(v: string): void }).setFrameView("table"));
    await settled(page);
    const frame = reference[0]!;
    const table = await page.evaluate(() => {
      const rect = document.querySelector(".k2b-chart-explorer__viewport")!.getBoundingClientRect();
      return { x: Math.round(rect.x), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
    });
    expect(table.x).toBe(frame.x + 1);
    expect(table.right).toBe(frame.x + frame.width - 1);
    expect(table.bottom).toBe(frame.y + frame.height - 1);
    expect((await boxes(page))[0]).toEqual(frame);
    expect(await page.locator(".k2b-chart-explorer__viewport th").first().textContent()).toContain("Month");
    expect(errors).toEqual([]);
    await page.close();
  });
}

test("the stale line offers Try again in one line, and a failure without rows has its own button", async () => {
  const { page } = await open(1280);
  await page.evaluate(() => (window as unknown as { setFrameState(s: string): void }).setFrameState("stale"));
  await settled(page);
  expect(await page.locator(".k2b-chart-explorer__status-line").textContent()).toContain("As of 09:12 · Refresh failed");
  await page.evaluate(() => (window as unknown as { setFrameState(s: string): void }).setFrameState("error"));
  await page.getByRole("button", { name: "Try again" }).click();
  await page.waitForSelector(".frame-bar .stdlib-chart-bar");
  await page.close();
});

test("calm hover: a light band behind the column, no outline, and a tooltip that stays within the column", async () => {
  const { page } = await open(1280);
  const bar = page.locator(".frame-bar .stdlib-chart-bar").nth(1);
  const rect = (await bar.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 4);
  await page.waitForSelector('.frame-bar [data-inspected="hover"]');
  await settled(page);
  const first = await page.evaluate(() => {
    const chart = document.querySelector(".frame-bar")!;
    const tip = chart.querySelector<HTMLElement>('[role="tooltip"]')!;
    const inspected = chart.querySelector("[data-inspected] .stdlib-chart-bar")!;
    return {
      band: getComputedStyle(chart.querySelector("[data-inspected] .k2b-chart-category-band")!).fill,
      overlay: getComputedStyle(chart, "::before").content,
      stroke: [getComputedStyle(inspected).stroke, getComputedStyle(inspected).strokeWidth],
      restingStroke: [
        getComputedStyle(chart.querySelectorAll(".stdlib-chart-bar")[0]!).stroke,
        getComputedStyle(chart.querySelectorAll(".stdlib-chart-bar")[0]!).strokeWidth,
      ],
      dimmed: Array.from(chart.querySelectorAll(".stdlib-chart-bar")).map((node) => getComputedStyle(node).opacity),
      tip: tip.textContent,
      top: Math.round(tip.getBoundingClientRect().top),
    };
  });
  expect(first.band).not.toBe("none");
  expect(first.overlay).toBe("none");
  // The inspected bar is painted exactly like a resting one: no outline.
  expect(first.stroke[0]).toBe("none");
  expect(first.restingStroke[0]).toBe("none");
  expect(new Set(first.dimmed)).toEqual(new Set(["1"]));
  expect(first.tip).toContain("February");
  // Moving inside the same column, even into the empty space above the bar, changes nothing.
  await page.mouse.move(rect.x + 2, rect.y - 30);
  await settled(page);
  const second = await page.evaluate(() => {
    const tip = document.querySelector<HTMLElement>('.frame-bar [role="tooltip"]')!;
    return { tip: tip.textContent, top: Math.round(tip.getBoundingClientRect().top) };
  });
  expect(second).toEqual({ tip: first.tip, top: first.top });
  await page.close();
});

test("calm hover: rows get a band from the baseline to the longest bar", async () => {
  const { page } = await open(1280);
  const bar = page.locator(".rows-bar .stdlib-chart-bar").nth(1);
  const rect = (await bar.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.waitForSelector('.rows-bar [data-inspected="hover"]');
  await settled(page);
  const band = await page.evaluate(() => {
    const chart = document.querySelector<HTMLElement>(".rows-bar")!;
    const rect = chart.querySelector("[data-inspected] .k2b-chart-category-band")!.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(band.width).toBeGreaterThan(rect.width);
  expect(band.height).toBeGreaterThan(rect.height);
  await page.close();
});

test("calm hover keeps a 2 px ring on points, so a tiny point stays the pointer's target", async () => {
  const { page } = await open(1280);
  const point = page.locator(".trend-spark [data-chart-datum] circle").last();
  await point.hover();
  await page.waitForSelector(".trend-spark [data-inspected]");
  await settled(page);
  expect(
    await page
      .locator(".trend-spark [data-inspected] > circle")
      .first()
      .evaluate((node) => getComputedStyle(node).strokeWidth),
  ).toBe("2px");
  await point.hover();
  await page.close();
});

test("category charts without renderer bands retain the shared hover overlay", async () => {
  const { page, errors } = await open(1280);
  try {
    await page.locator(".overlay-histogram [data-chart-datum]").nth(1).hover();
    await page.waitForSelector('.overlay-histogram[data-inspecting="category"]');
    await settled(page);
    expect(await page.locator(".overlay-histogram").evaluate((chart) => getComputedStyle(chart, "::before").content)).not.toBe("none");
    expect(await page.locator(".overlay-histogram [data-inspected] rect").evaluate((mark) => getComputedStyle(mark).stroke)).toBe("none");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
