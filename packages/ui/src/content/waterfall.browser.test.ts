import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { waterfallFixture } from "../../test/waterfall-fixture";
import { renderWaterfallSvg } from "../charts/core/waterfall";

let browser: Browser, bundle: string, css: string, ssr: string;
const pages: Page[] = [];
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/waterfall.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "waterfall-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Waterfall harness failed");
  bundle = await build.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  const { default: ServerChart } = await import(resolve(import.meta.dir, "../../dist/ssr/content/Chart.js"));
  const { LocaleProvider } = await import(resolve(import.meta.dir, "../../dist/ssr/intl/locale.js"));
  ssr = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ServerChart, { kind: "waterfall", ...waterfallFixture, locale: "de" });
      },
    }),
  );
  const explicitLocale = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(ServerChart, {
          kind: "waterfall",
          start: { label: "Opening", value: 1.5 },
          steps: [],
          end: { label: "Closing" },
          locale: "de",
        });
      },
    }),
  );
  expect(explicitLocale).toContain("1,5");
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
    `<!doctype html><html ${dark ? 'class="dark"' : ""}><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css} body{margin:0;padding:20px} main{max-width:900px;margin:auto}.waterfall-panel{border:1px solid var(--k2b-border);border-radius:12px;padding:16px;margin-top:20px}h2{font-size:17px;margin:0}.meta{font-size:13px;margin:4px 0 16px}.waterfall-frame{height:280px}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await settled(page);
  return page;
};
const tooltip = (page: Page) => page.locator('[role="tooltip"]:popover-open');
for (const width of [1440, 390])
  test(`waterfall at ${width}: SSR drawing, hover, keys, states and retry keep their box`, async () => {
    const page = pages[0]!;
    await page.setViewportSize({ width, height: 900 });
    await settled(page);
    const chart = page.locator('.waterfall-panel [data-chart-kind="waterfall"]');
    const expected = ssr;
    expect(
      await chart.locator("svg").evaluate((svg, expected) => {
        const host = document.createElement("div");
        host.innerHTML = expected;
        return svg.outerHTML === host.querySelector("svg")?.outerHTML;
      }, expected),
    ).toBe(true);
    const box = await page.locator(".state-explorer").boundingBox();
    const viewportBox = await page.locator(".state-explorer .k2b-chart-explorer__viewport").boundingBox();
    await chart.locator(".k2b-waterfall-bar").nth(2).hover();
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]:popover-open')?.textContent?.includes("Wareneinkauf"));
    expect(await tooltip(page).textContent()).toContain("Raus");
    expect(await tooltip(page).textContent()).toContain("↗ 14.800");
    expect(await tooltip(page).textContent()).toContain("Stand danach");
    expect(await tooltip(page).textContent()).not.toContain("before");
    expect(await tooltip(page).textContent()).not.toContain("Stand davor");
    expect(await tooltip(page).textContent()).toContain("33.260");
    expect(await chart.locator("[data-inspected] .k2b-chart-category-band").evaluate((e) => getComputedStyle(e).fillOpacity)).toBe("0.05");
    await page.getByRole("button", { name: "Select outflow", exact: true }).click();
    expect(await chart.locator("[data-selected] .k2b-chart-category-band").evaluate((e) => getComputedStyle(e).stroke)).toBe("none");
    expect(await chart.locator("[data-selected] .k2b-waterfall-bar").evaluate((e) => getComputedStyle(e).stroke)).not.toBe("none");
    await page.getByRole("button", { name: "Select outflow", exact: true }).click();
    await chart.focus();
    await page.keyboard.press("End");
    expect(await tooltip(page).textContent()).toContain("31. Okt.");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await page.mouse.move(0, 0);
    expect(await tooltip(page).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await tooltip(page).count()).toBe(0);
    for (const state of ["loading", "empty", "error", "stale", "data"]) {
      await page.getByRole("button", { name: state, exact: true }).click();
      await settled(page);
      expect(await page.locator(".state-explorer").boundingBox()).toEqual(box);
      expect(await page.locator(".state-explorer .k2b-chart-explorer__viewport").boundingBox()).toEqual(viewportBox);
      if (state === "error") {
        await page.locator(".state-explorer").getByRole("button", { name: "Erneut versuchen" }).click();
        expect(await chart.count()).toBe(1);
      }
    }
  });
test("phone tap pins, swipe leaves no selection, dark and unscoped SVG retain their paint", async () => {
  const page = pages[0]!;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await settled(page);
  const mark = page.locator(".waterfall-panel .k2b-waterfall-bar").nth(1);
  await mark.tap();
  expect(await tooltip(page).count()).toBe(1);
  await page.keyboard.press("Escape");
  const chart = page.locator('.waterfall-panel [data-chart-kind="waterfall"]');
  await settled(page);
  const bounds = (await mark.boundingBox())!;
  await mark.dispatchEvent("pointerdown", { pointerType: "touch", clientX: bounds.x, clientY: bounds.y });
  await chart.dispatchEvent("pointermove", { pointerType: "touch", clientX: bounds.x, clientY: bounds.y + 30 });
  await chart.dispatchEvent("click", { pointerType: "touch", clientX: bounds.x, clientY: bounds.y + 30 });
  expect(await tooltip(page).count()).toBe(0);
  const scoped = await page
    .locator(".waterfall-panel .k2b-waterfall-bar")
    .evaluateAll((nodes) => nodes.slice(0, 3).map((e) => getComputedStyle(e).fill));
  expect(new Set(scoped).size).toBe(3);
  await page.evaluate(() => document.body.classList.remove("k2b-ui"));
  await settled(page);
  const fills = await page
    .locator(".waterfall-panel .k2b-waterfall-bar")
    .evaluateAll((nodes) => nodes.map((e) => getComputedStyle(e).fill));
  expect(new Set(fills.slice(0, 3)).size).toBe(3);
  expect(fills.every((c) => c !== "rgb(0, 0, 0)" && c !== "none")).toBe(true);
});

test("measured widths bound many labels and print amounts only on sufficiently wide bars", async () => {
  const page = pages[0]!;
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const width of [390, 600, 650, 900]) {
    const svg = renderWaterfallSvg({
      start: { label: "Opening balance", value: -100 },
      steps: Array.from({ length: 10 }, (_, i) => ({ label: `Cat${i}`, value: i % 2 ? -10 : 20 })),
      end: { label: "Closing balance" },
      width,
      height: 280,
      displayWidth: width,
    });
    await page.evaluate((svg) => {
      document.querySelector("#width-check")?.remove();
      const host = document.createElement("div");
      host.id = "width-check";
      host.innerHTML = svg;
      document.body.append(host);
    }, svg);
    const labels = await page.locator("#width-check .stdlib-chart-category-label").evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThanOrEqual(labels[i - 1]!.right);
    if (width <= 650) expect(await page.locator("#width-check .k2b-waterfall-value").count()).toBe(0);
  }
  await page.locator("#width-check").evaluate((e) => e.remove());
});
