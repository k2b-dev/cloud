import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";
import { lineForecastFixture } from "../../test/line-forecast-fixture";
import { line } from "../charts/core/svg";
import { responsiveChartSvg } from "./chart-svg";

let browser: Browser, bundle: string, css: string;
const pages: Page[] = [];
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/line-forecast.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "line-forecast-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Line forecast harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
  pages.push(await open(1440, false, true));
}, 30000);
afterAll(async () => {
  for (const page of pages) await page.close();
  await browser?.close();
});
const open = async (width: number, dark = false, touch = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: false });
  await page.setContent(
    `<!doctype html><html ${dark ? 'class="dark"' : ""}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body{margin:0;padding:20px} main{max-width:900px;margin:auto}.line-forecast-panel{border:1px solid var(--k2b-border);border-radius:12px;padding:16px;margin-top:20px}h2{font-size:17px;margin:0}.meta{font-size:13px;margin:4px 0 16px}.line-forecast-frame{height:280px}.many{margin-top:20px}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await settled(page);
  return page;
};
const tooltip = (page: Page) => page.locator('[role="tooltip"]:popover-open');

for (const width of [1440, 390])
  test(`line forecast at ${width}: SSR drawing, grouped hover, keyboard and fixed states`, async () => {
    const page = pages[0]!;
    await page.setViewportSize({ width, height: 1100 });
    await settled(page);
    const chart = page.locator('.line-forecast-frame [data-chart-kind="line"]');
    const expected = responsiveChartSvg(
      line({
        ...lineForecastFixture,
        legend: false,
        width: 480,
        height: 280,
        inspect: true,
        yAxis: {
          format: (value) => new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
        },
      }),
    );
    expect(
      await chart.locator(".k2b-chart__svg > svg").evaluate((svg, expected) => {
        const host = document.createElement("div");
        host.innerHTML = expected;
        return svg.outerHTML === host.firstElementChild?.outerHTML;
      }, expected),
    ).toBe(true);
    const before = await page.locator(".line-forecast-panel").first().boundingBox();
    const plot = await chart.locator(".k2b-chart__svg").boundingBox();
    await page.mouse.move(plot!.x + plot!.width * 0.55, plot!.y + plot!.height * 0.3);
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent?.includes("Cash"));
    expect(await tooltip(page).textContent()).toContain("Committed");
    expect(await tooltip(page).textContent()).toContain("€");
    await chart.focus();
    await page.keyboard.press("Home");
    expect(await tooltip(page).textContent()).toContain("1");
    expect(await chart.locator("[data-chart-legend-value]").first().textContent()).toBe("32.000 €");
    await page.keyboard.press("ArrowRight");
    expect(await tooltip(page).textContent()).toContain("2");
    await page.keyboard.press("ArrowLeft");
    expect(await tooltip(page).textContent()).toContain("1");
    await page.keyboard.press("End");
    expect(await tooltip(page).textContent()).toContain("9");
    await page.keyboard.press("Enter");
    await page.mouse.move(0, 0);
    expect(await tooltip(page).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await tooltip(page).count()).toBe(0);
    for (const state of ["loading", "empty", "error", "stale", "data"]) {
      await page.getByRole("button", { name: state, exact: true }).click();
      await settled(page);
      expect(await page.locator(".line-forecast-panel").first().boundingBox()).toEqual(before);
      if (state === "error") await page.getByRole("button", { name: "Erneut versuchen" }).click();
    }
    expect(await chart.locator(".k2b-line-forecast-band").count()).toBe(1);
    expect(await chart.locator(".k2b-line-negative-zone").count()).toBe(1);
    expect(await chart.locator(".k2b-line-threshold").count()).toBe(1);
    expect(await chart.locator(".k2b-line-marker").count()).toBe(1);
    expect(await chart.locator(".k2b-chart__legend").evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(44);
  });
test("line tap pins at a coordinate; dark and unscoped paths remain painted", async () => {
  const page = pages[0]!;
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await settled(page);
  const chart = page.locator('.line-forecast-frame [data-chart-kind="line"]');
  const plot = await chart.locator(".k2b-chart__svg").boundingBox();
  await page.touchscreen.tap(plot!.x + plot!.width * 0.6, plot!.y + plot!.height * 0.3);
  expect(await tooltip(page).count()).toBe(1);
  await page.keyboard.press("Escape");
  await chart.dispatchEvent("pointerdown", { pointerType: "touch", clientX: plot!.x + 40, clientY: plot!.y + 40 });
  await chart.dispatchEvent("pointermove", { pointerType: "touch", clientX: plot!.x + 40, clientY: plot!.y + 70 });
  await chart.dispatchEvent("click", { pointerType: "touch", clientX: plot!.x + 40, clientY: plot!.y + 70 });
  expect(await tooltip(page).count()).toBe(0);
  await page.evaluate(() => document.body.classList.remove("k2b-ui"));
  await settled(page);
  const fills = await chart.locator(".stdlib-chart-line").evaluateAll((nodes) => nodes.map((e) => getComputedStyle(e).stroke));
  expect(fills.every((c) => c !== "rgb(0, 0, 0)" && c !== "none")).toBe(true);
});
