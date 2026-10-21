import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const topLegendFixture = `
import { createChartCursor } from "../src/content/chart-cursor";
const linkedTopCursor = createChartCursor();
const topHost = document.createElement("div"); document.body.append(topHost);
const topSeries = Array.from({length:8}, (_,i) => ({
  label:i === 0 ? "" : "Complete series " + (i + 1) + " descriptive name with the full measurement and aggregation",
  data:i === 0 ? [] : [{x:1,y:i+2},{x:2,y:i+4}],
}));
render(() => <>
  <Chart kind="line" class="top-line" className="report-palette" style={{height: window.innerWidth < 760 ? "180px" : "200px"}} series={topSeries} legend legendPlacement="top-start" cursor={linkedTopCursor} />
  <Chart kind="line" class="top-pulse" style={{height: window.innerWidth < 760 ? "210px" : "230px"}} series={topSeries} legend legendPlacement="top-start" />
  <Chart kind="line" class="top-short" style={{height: window.innerWidth < 760 ? "210px" : "230px"}} series={[{label:"Requests",data:[{x:1,y:2},{x:2,y:3}]}]} legend legendPlacement="top-start" />
  <Chart kind="line" class="top-tiny" style={{height:"80px"}} series={topSeries} legend legendPlacement="top-start" />
  <Chart kind="line" class="top-linked" style={{height:"160px"}} series={topSeries} cursor={linkedTopCursor} />
  <Chart kind="line" class="top-natural" series={topSeries.slice(1,2)} legend legendPlacement="top-start" />
</>, topHost);
`;

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
            const source = await Bun.file(path).text();
            const result = await transformAsync(source + (path.endsWith("chart-tooltips.browser-harness.tsx") ? topLegendFixture : ""), {
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
const tooltipContent = (page: Page, chart: string) =>
  page.locator(`${chart} [role="tooltip"]:popover-open`).evaluate((tooltip) => ({
    title: tooltip.querySelector(".k2b-chart__tooltip-title")?.textContent ?? null,
    rows: Array.from(tooltip.querySelectorAll(".k2b-chart__tooltip-row")).map((row) => [
      row.querySelector("span")?.textContent?.replace(/:\s*$/, ""),
      row.querySelector("b")?.textContent,
    ]),
  }));
// Hovering scrolls a mark into view first; the scroll event that follows would close the tooltip again, so the page
// scrolls and lets a frame pass before the pointer arrives.
const hoverLastPoint = async (page: Page, cell: string) => {
  const point = page.locator(`${cell} [data-chart-datum] circle`).last();
  await point.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await point.hover();
};
const closed = (page: Page) => page.waitForFunction(() => !document.querySelector('[role="tooltip"]:popover-open'));
const focused = (page: Page) => page.locator(".plain-bar").evaluate((chart) => chart === document.activeElement);

test("a plain bar chart shows label and value on hover without shifting layout", async () => {
  const page = await open();
  try {
    const chart = page.locator(".plain-bar");
    await settled(page);
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
    const chart = page.locator('.requests-trend [data-chart-kind="sparkline"]');
    expect(await chart.getAttribute("aria-label")).toBe("Requests");
    await settled(page);
    const before = await chart.boundingBox();
    expect(before).not.toBeNull();
    await chart.locator("[data-chart-datum] circle").last().hover();
    const text = await tooltipText(page, ".requests-trend .k2b-stat-cell__trend", "18");
    expect(await tooltipContent(page, ".requests-trend")).toEqual({ title: null, rows: [["Requests", "18"]] });
    expect(text).toContain("Requests: 18");
    expect(text).not.toMatch(/\b[XY]:|\bX\b|\bY\b|Value|Wert/);
    expect(await chart.boundingBox()).toEqual(before);
    await page.mouse.move(0, 0);
    await closed(page);
    await chart.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await chart.focus();
    await tooltipText(page, ".requests-trend .k2b-stat-cell__trend", "12");
    expect(await tooltipContent(page, ".requests-trend")).toEqual({ title: null, rows: [["Requests", "12"]] });
    expect(await chart.boundingBox()).toEqual(before);
    await page.locator("#after").focus();
    await closed(page);
    expect(await chart.boundingBox()).toEqual(before);
  } finally {
    await page.close();
  }
});

test("a StatCell trend shows one named value on a phone and closes on outside touch", async () => {
  const page = await open({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const chart = page.locator('.requests-trend [data-chart-kind="sparkline"]');
    await chart.locator("[data-chart-datum] circle").last().tap();
    const text = await tooltipText(page, ".requests-trend .k2b-stat-cell__trend", "18");
    expect(await tooltipContent(page, ".requests-trend")).toEqual({ title: null, rows: [["Requests", "18"]] });
    expect(text).not.toMatch(/\b[XY]:|\bX\b|\bY\b|Value|Wert/);
    await page.locator("#before").dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
    await closed(page);
  } finally {
    await page.close();
  }
});

test("a StatCell trend formats values in the inherited locale and keeps small fractions", async () => {
  const page = await open();
  try {
    await hoverLastPoint(page, ".de-trend");
    await tooltipText(page, ".de-trend .k2b-stat-cell__trend", "1.500");
    expect(await tooltipContent(page, ".de-trend")).toEqual({ title: null, rows: [["Umsatz", "1.500"]] });
    // Small measurements keep the six fraction digits of the Chart default instead of rounding to 0.
    await hoverLastPoint(page, ".fraction-trend");
    await tooltipText(page, ".fraction-trend .k2b-stat-cell__trend", "0.00025");
    expect(await tooltipContent(page, ".fraction-trend")).toEqual({ title: null, rows: [["Error rate", "0.00025"]] });
  } finally {
    await page.close();
  }
});

test("a StatCell trend formatter replaces the default with a period title and unit", async () => {
  const page = await open();
  try {
    await hoverLastPoint(page, ".custom-trend");
    await tooltipText(page, ".custom-trend .k2b-stat-cell__trend", "18 ms");
    expect(await tooltipContent(page, ".custom-trend")).toEqual({ title: "Day 2", rows: [["Latency", "18 ms"]] });
  } finally {
    await page.close();
  }
});

for (const width of [390, 1440])
  test(`top line legends wrap inside the budget and keep real inspection at ${width}px`, async () => {
    const page = await open({ viewport: { width, height: 1000 } });
    try {
      const chart = page.locator(".top-line");
      await chart.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      const plot = chart.locator(".k2b-chart__svg");
      await settled(page);
      const outer = await chart.boundingBox();
      const legend = await chart.locator(".k2b-chart__legend").boundingBox();
      const drawing = await plot.boundingBox();
      expect(outer!.height).toBe(width < 760 ? 180 : 200);
      expect(legend!.height).toBeLessThanOrEqual(Math.min(44, outer!.height * 0.4) + 1);
      for (const [selector, total, legendHeight] of [
        [".top-pulse", width < 760 ? 210 : 230, 44],
        [".top-short", width < 760 ? 210 : 230, 30],
        [".top-tiny", 80, 32],
      ] as const) {
        const sample = page.locator(selector);
        expect((await sample.boundingBox())!.height).toBe(total);
        expect((await sample.locator(".k2b-chart__legend").boundingBox())!.height).toBe(legendHeight);
        expect((await sample.locator(".k2b-chart__svg").boundingBox())!.height).toBe(total - legendHeight);
      }
      expect(drawing!.height).toBeGreaterThanOrEqual(outer!.height * 0.6 - 1);
      expect(drawing!.y).toBeGreaterThanOrEqual(legend!.y + legend!.height - 1);
      expect(drawing!.y + drawing!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
      expect((await page.locator(".top-natural").boundingBox())!.height).toBeGreaterThan(100);
      expect(await chart.locator(".k2b-chart__legend-item").count()).toBe(8);
      expect(await chart.locator(".k2b-chart__legend-item").first().textContent()).toContain("Series 1");
      expect(await chart.locator(".k2b-chart__svg .stdlib-chart-legend").count()).toBe(0);
      expect(await chart.locator(".k2b-chart__legend").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      if (width === 390) {
        const legendControl = chart.getByRole("group", { name: "Legend", exact: true });
        expect(await legendControl.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
        await legendControl.focus();
        await legendControl.press("End");
        await page.waitForFunction(() => {
          const element = document.querySelector(".top-line .k2b-chart__legend");
          return element && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
        });
        expect(await legendControl.textContent()).toContain("Complete series 8 descriptive name with the full measurement and aggregation");
        expect(await chart.locator("[role=tooltip]:popover-open").count()).toBe(0);
        const lastName = await chart.locator(".k2b-chart__legend-item").last().boundingBox();
        const viewport = await legendControl.boundingBox();
        expect(lastName!.y + lastName!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1);
      }
      for (const theme of ["light", "dark"]) {
        await page.locator("body").evaluate((body, theme) => (body.dataset.theme = theme), theme);
        // The same renderer classes must take both default and consumer palette overrides.
        if (theme === "dark") await page.addStyleTag({ content: ".stdlib-chart.report-palette { --stdlib-chart-c2: rgb(123, 45, 67); }" });
        const colors = await chart.evaluate((e) => ({
          legend: getComputedStyle(e.querySelector(".k2b-chart__legend-item:nth-child(2) rect")!).fill,
          series: getComputedStyle(e.querySelector(".stdlib-chart-line.stdlib-chart-series-1")!).stroke,
        }));
        expect(colors.legend).toBe(colors.series);
        if (theme === "dark") expect(colors.legend).toBe("rgb(123, 45, 67)");
      }
      await chart.focus();
      await chart.press("ArrowRight");
      await chart.locator("[role=tooltip]:popover-open").waitFor();
      expect(await chart.locator("[role=tooltip]:popover-open").textContent()).toContain("Complete series");
      expect(await page.locator(".top-linked [data-inspected]").count()).toBeGreaterThan(0);
      await chart.press("Escape");
      // A rendered line can cover its own invisible inspection circle. Move a real
      // pointer to the point instead of requiring the circle to receive the event.
      const point = chart.locator("[data-chart-datum] circle").last();
      await point.scrollIntoViewIfNeeded();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await settled(page);
      const pointBox = await point.boundingBox();
      expect(pointBox).not.toBeNull();
      await page.mouse.move(pointBox!.x + pointBox!.width / 2, pointBox!.y + pointBox!.height / 2);
      await chart.locator("[role=tooltip]:popover-open").waitFor();
      expect(await chart.locator("[role=tooltip]:popover-open").textContent()).toContain("Complete series");
      const anchor = await chart.locator(".k2b-chart__anchor").boundingBox();
      const currentPlot = await plot.boundingBox();
      expect(anchor!.y).toBeGreaterThanOrEqual(currentPlot!.y);
      expect(anchor!.y).toBeLessThanOrEqual(currentPlot!.y + currentPlot!.height);
      expect(await page.locator(".top-linked [data-inspected]").count()).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30_000);
