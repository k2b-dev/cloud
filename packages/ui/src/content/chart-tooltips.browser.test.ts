import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chart-tooltips.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "chart-tooltips-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Chart tooltip harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (options: BrowserContextOptions = {}) => {
  const page = await browser.newPage(options);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".plain-bar .stdlib-chart-bar");
  return page;
};

const tooltipText = async (page: Page, chart = ".plain-bar", text = "Imports") => {
  await page.waitForFunction(
    ({ chart, text }) => document.querySelector(`${chart} [role="tooltip"]:popover-open`)?.textContent?.includes(text),
    { chart, text },
  );
  return page.locator(`${chart} [role="tooltip"]`).textContent();
};
const closed = (page: Page) => page.waitForFunction(() => !document.querySelector('[role="tooltip"]:popover-open'));
const focused = (page: Page) => page.locator(".plain-bar").evaluate((chart) => chart === document.activeElement);

test("a plain bar chart shows label and value on hover without shifting layout", async () => {
  const page = await open();
  try {
    const chart = page.locator(".plain-bar");
    const before = await chart.boundingBox();
    expect(before).not.toBeNull();
    await chart.locator(".stdlib-chart-bar").first().hover();
    expect(await tooltipText(page)).toContain("42");
    expect(await chart.boundingBox()).toEqual(before);
    await page.mouse.move(0, 0);
    await closed(page);
    expect(await chart.boundingBox()).toEqual(before);
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe(true);
    expect(await tooltipText(page)).toContain("42");
    expect(await chart.boundingBox()).toEqual(before);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("after");
    await closed(page);
    expect(await chart.boundingBox()).toEqual(before);
  } finally {
    await page.close();
  }
});

test("one chart tab stop supports ArrowRight, End, Home and Escape", async () => {
  const page = await open();
  try {
    await page.locator("#before").focus();
    await page.keyboard.press("Tab");
    expect(await focused(page)).toBe(true);
    expect(await tooltipText(page)).toContain("42");
    for (const [key, label, value] of [
      ["ArrowRight", "Exports", "28"],
      ["End", "Retries", "7"],
      ["Home", "Imports", "42"],
    ]) {
      await page.keyboard.press(key!);
      expect(await tooltipText(page, ".plain-bar", label!)).toContain(value!);
      expect(await focused(page)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await closed(page);
    expect(await focused(page)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("after");
  } finally {
    await page.close();
  }
});

test("phone taps pin inspection; outside pointerdown and scrolling dismiss it", async () => {
  const page = await open({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const first = page.locator(".plain-bar .stdlib-chart-bar").first();
    await first.tap();
    expect(await tooltipText(page)).toContain("42");
    // A pinned tooltip survives leaving the mark until an explicit dismissal.
    await page.locator(".plain-bar").dispatchEvent("pointerleave", { pointerType: "touch" });
    expect(await tooltipText(page)).toContain("42");
    // Stop at pointerdown: a click/focus change must not be needed to close it.
    await page.locator("#before").dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
    await closed(page);
    await first.tap();
    expect(await tooltipText(page)).toContain("42");
    await page.evaluate(() => window.scrollTo(0, 80));
    await page.waitForFunction(() => window.scrollY > 0);
    await closed(page);
    for (const selector of [".plain-bar", ".plain-line"]) {
      expect(await page.locator(selector).evaluate((chart) => getComputedStyle(chart).touchAction)).not.toBe("none");
    }
  } finally {
    await page.close();
  }
});

test("a StatCell trend has a named sparkline with hover inspection and stable geometry", async () => {
  const page = await open();
  try {
    const chart = page.locator('.k2b-stat-cell [data-chart-kind="sparkline"]');
    expect(await chart.getAttribute("aria-label")).toBe("Requests");
    const before = await chart.boundingBox();
    expect(before).not.toBeNull();
    await chart.locator("[data-chart-datum] circle").last().hover();
    const text = await tooltipText(page, ".k2b-stat-cell__trend", "18");
    expect(text).toContain("18");
    expect(await chart.boundingBox()).toEqual(before);
    await page.mouse.move(0, 0);
    await closed(page);
    await chart.focus();
    await tooltipText(page, ".k2b-stat-cell__trend", "12");
    expect(await chart.boundingBox()).toEqual(before);
    await page.locator("#after").focus();
    await closed(page);
    expect(await chart.boundingBox()).toEqual(before);
  } finally {
    await page.close();
  }
});
