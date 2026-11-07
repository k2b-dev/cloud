import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { lineForecastFixture } from "../../test/line-forecast-fixture";

let browser: Browser, bundle: string, hostsBundle: string, css: string, baseCss: string;
const pages: Page[] = [];
const errorsByPage = new Map<Page, string[]>();
let ssr: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  for (const hosts of [false, true]) {
    const build = await Bun.build({
      entrypoints: [
        resolve(
          import.meta.dir,
          hosts ? "../../../cloud/test/charts/line-host-fixtures.tsx" : "../../test/line-forecast.browser-harness.tsx",
        ),
      ],
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
    if (hosts) hostsBundle = await build.outputs[0]!.text();
    else bundle = await build.outputs[0]!.text();
  }
  baseCss = await Bun.file(resolve(import.meta.dir, "../../dist/base.css")).text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  css += `\n${await Bun.file(resolve(import.meta.dir, "../../../editor/src/styles.css")).text()}`;
  browser = await launchBrowser();
  const { default: ServerChart } = await import(resolve(import.meta.dir, "../../dist/ssr/content/Chart.js"));
  const { LocaleProvider } = await import(resolve(import.meta.dir, "../../dist/ssr/intl/locale.js"));
  ssr = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(ServerChart, {
          kind: "line",
          ...lineForecastFixture,
          yAxis: {
            format: (value: number) =>
              new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value),
          },
        });
      },
    }),
  );
}, 30000);
afterEach(async () => {
  for (const page of pages.splice(0)) {
    const errors = errorsByPage.get(page);
    await page.close();
    errorsByPage.delete(page);
    expect(errors).toEqual([]);
  }
});
afterAll(async () => {
  for (const page of pages) await page.close();
  await browser?.close();
});
const open = async (width: number, dark = false, touch = false) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: touch, isMobile: false });
  errorsByPage.set(page, pageErrors(page));
  await page.setContent(
    `<!doctype html><html ${dark ? 'class="dark"' : ""}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body{margin:0;padding:20px} main{max-width:900px;margin:auto}.line-forecast-panel{border:1px solid var(--k2b-border);border-radius:12px;padding:16px;margin-top:20px}h2{font-size:17px;margin:0}.meta{font-size:13px;margin:4px 0 16px}.line-forecast-frame{height:280px}.many{margin-top:20px}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.addScriptTag({ content: hostsBundle });
  await settled(page);
  return page;
};
const documentBox = (page: Page, selector: string) =>
  page.locator(selector).evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  });
const tooltip = (page: Page) => page.locator('[role="tooltip"]:popover-open');

for (const width of [1440, 390]) {
  test(`line forecast at ${width}: SSR drawing, grouped hover, keyboard and fixed states`, async () => {
    const page = await open(width, false, true);
    pages.push(page);
    await page.setViewportSize({ width, height: 1100 });
    await settled(page);
    const chart = page.locator('.line-forecast-frame [data-chart-kind="line"]');
    const expected = ssr;
    expect(
      await chart.locator(".k2b-chart__svg > svg").evaluate((svg, expected) => {
        const host = document.createElement("div");
        host.innerHTML = expected;
        return svg.outerHTML === host.querySelector(".k2b-chart__svg > svg")?.outerHTML;
      }, expected),
    ).toBe(true);
    await settled(page);
    const labelsFit = await chart.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll(".stdlib-chart-tick-label[text-anchor=end]")].every(
        (label) => label.getBoundingClientRect().left >= box.left,
      );
    });
    expect(labelsFit).toBe(true);
    const earlyEnding = page.locator(".early-ending [data-chart-kind=line]");
    expect(await earlyEnding.locator("[data-chart-legend-value]").nth(1).textContent()).toBe("—");
    await earlyEnding.focus();
    await page.keyboard.press("Home");
    expect(await earlyEnding.locator("[data-chart-legend-value]").nth(1).textContent()).toBe("7");
    await page.keyboard.press("End");
    expect(await earlyEnding.locator("[data-chart-legend-value]").nth(1).textContent()).toBe("—");
    await page.keyboard.press("Escape");
    const before = await documentBox(page, ".snapshot");
    const viewportBefore = await documentBox(page, ".snapshot .k2b-chart-explorer__viewport");
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
      await page.getByRole("button", { name: state, exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
      await settled(page);
      expect(await documentBox(page, ".snapshot")).toEqual(before);
      expect(await documentBox(page, ".snapshot .k2b-chart-explorer__viewport")).toEqual(viewportBefore);
      if (state === "error")
        await page.getByRole("button", { name: "Erneut versuchen" }).evaluate((button) => (button as HTMLButtonElement).click());
    }
  });
  test(`line at ${width}: selected mark and forecast annotations`, async () => {
    const page = await open(width, false, true);
    pages.push(page);
    const chart = page.locator('.line-forecast-frame [data-chart-kind="line"]');
    await page.getByRole("button", { name: "Select cash observation", exact: true }).click();
    await settled(page);
    expect(await chart.locator("[data-selected]").count()).toBe(1);
    expect(await chart.locator("[data-selected] circle").evaluate((mark) => getComputedStyle(mark).stroke)).not.toBe("none");
    await page.getByRole("button", { name: "Select cash observation", exact: true }).click();
    await settled(page);
    expect(await chart.locator(".k2b-line-forecast-band").count()).toBe(1);
    expect(await chart.locator(".k2b-line-negative-zone").count()).toBe(1);
    expect(await chart.locator(".k2b-line-threshold").count()).toBe(1);
    expect(await chart.locator(".k2b-line-marker").count()).toBe(1);
    expect(await chart.locator(".k2b-chart__legend").evaluate((e) => e.clientHeight)).toBeLessThanOrEqual(44);
  });
}
test("line tap pins at a coordinate; dark and unscoped paths remain painted", async () => {
  const page = await open(390, true, true);
  pages.push(page);
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
  await settled(page);
  expect(await chart.evaluate((e) => getComputedStyle(e).colorScheme)).toBe("dark");
  const negative = await chart.locator(".k2b-line-negative-zone").evaluate((mark) => ({
    fill: getComputedStyle(mark).fill,
    opacity: Number(getComputedStyle(mark).fillOpacity),
    height: mark.getBoundingClientRect().height,
  }));
  expect(negative.fill).toBe("rgb(239, 68, 68)");
  expect(negative.opacity).toBeGreaterThan(0);
  expect(negative.opacity).toBeLessThan(0.2);
  expect(negative.height).toBeGreaterThan(0);
  const bandPaint = await chart.locator(".k2b-line-forecast-band").evaluate((mark) => getComputedStyle(mark).fill);
  const firstStroke = await chart
    .locator(".stdlib-chart-line")
    .first()
    .evaluate((mark) => getComputedStyle(mark).stroke);
  expect(bandPaint).toBe(firstStroke);
  await page.evaluate(() => document.body.classList.remove("k2b-ui"));
  await settled(page);
  const fills = await chart.locator(".stdlib-chart-line").evaluateAll((nodes) => nodes.map((e) => getComputedStyle(e).stroke));
  expect(fills.every((c) => c !== "rgb(0, 0, 0)" && c !== "none")).toBe(true);
});

test("line values follow the cursor in Pulse, Core AI, Gateway Ops, Chat and Notebook", async () => {
  const page = await open(390);
  pages.push(page);
  for (const host of ["pulse", "core", "gateway", "chat", "notebook"]) {
    const charts = page.locator(`[data-line-host="${host}"] [data-chart-kind="line"]`);
    const chart = host === "core" ? charts.nth(1) : charts.first();
    expect(await chart.count()).toBe(1);
    await settled(page);
    const panelBox = await documentBox(page, `[data-line-host="${host}"]`);
    const legend = page.locator(`[data-line-host="${host}"] [data-chart-legend-value]`);
    const initial = await legend.allTextContents();
    expect(initial.every((value) => value.length > 0)).toBe(true);
    if (host === "chat" || host === "notebook") expect(initial.every((value) => value.includes("€"))).toBe(true);
    await chart.focus();
    await page.keyboard.press("Home");
    const first = await legend.allTextContents();
    expect(first.length).toBeGreaterThan(0);
    await page.keyboard.press("End");
    expect(await legend.allTextContents()).not.toEqual(first);
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await legend.allTextContents()).toEqual(initial);
    expect(await documentBox(page, `[data-line-host="${host}"]`)).toEqual(panelBox);
  }
});

test("framework-free line markup keeps paint and currency labels with base.css alone", async () => {
  const page = await open(390);
  pages.push(page);
  const drawing = await page.locator(".line-forecast-frame .k2b-chart__svg").evaluate((node) => {
    const clone = node.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll("style")) style.remove();
    return clone.outerHTML;
  });
  await page.setContent(
    `<!doctype html><html><head><style>${baseCss}body{margin:0;padding:20px}.base-frame{height:280px;width:100%}</style></head><body><div class="k2b-chart base-frame" data-chart-kind="line">${drawing}</div></body></html>`,
  );
  await settled(page);
  expect(await page.locator(".k2b-ui").count()).toBe(0);
  expect(await page.locator("svg style").count()).toBe(0);
  const paint = await page
    .locator(".stdlib-chart-line")
    .first()
    .evaluate((node) => getComputedStyle(node).stroke);
  expect(paint).not.toBe("none");
  expect(paint).not.toBe("rgb(0, 0, 0)");
  expect(await page.locator(".k2b-line-forecast-band").evaluate((node) => getComputedStyle(node).fill)).toBe(paint);
  expect(
    await page.locator(".base-frame").evaluate((node) => {
      const left = node.getBoundingClientRect().left;
      return [...node.querySelectorAll(".stdlib-chart-tick-label[text-anchor=end]")].every(
        (label) => label.getBoundingClientRect().left >= left,
      );
    }),
  ).toBe(true);
});
