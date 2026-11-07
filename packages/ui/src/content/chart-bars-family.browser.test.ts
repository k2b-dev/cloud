import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { barFamilyFixtures } from "../../test/chart-bars-family-fixtures";
import { renderHbarSvg } from "../charts/core/hbar";
import { renderBarChartSvg } from "./chart-bar";
import { selectedChartSvg } from "./chart-svg";

const { plugin } = createConfig({ dev: true, rootDir: import.meta.dir });
Bun.plugin(plugin());
const { chartRenderHeight, renderChartSvg } = await import("./Chart");

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const built = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/chart-bars-family.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "bars-dom",
        setup(b) {
          b.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw Error(path);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!built.success) throw new AggregateError(built.logs, "Bars harness build failed");
  bundle = await built.outputs[0]!.text();
  css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});
for (const width of [1440, 390])
  test(`bars family: first render, categories, keyboard, tap and states at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: true });
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;padding:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:20px;max-width:1200px;margin:auto}.k2b-widget{border:1px solid var(--k2b-border);border-radius:10px}.content-box{position:relative}.state{height:100%;display:flex;align-items:center;justify-content:center;gap:8px}.states{display:flex;gap:12px;margin-bottom:20px}</style></head><body class="k2b-ui" data-theme="light"><div id="root"></div></body></html>`,
      );
      await page.addScriptTag({ content: bundle });
      await page.locator(".sample").last().waitFor();
      await settled(page);
      // Parse server SVG through the same HTML parser before comparing DOM serialization.
      for (let i = 0; i < barFamilyFixtures.length; i++) {
        const spec = barFamilyFixtures[i]!;
        const expected = await page.evaluate(
          (svg) => {
            const host = document.createElement("div");
            host.innerHTML = svg;
            return host.firstElementChild!.outerHTML;
          },
          renderChartSvg({ ...spec, title: undefined }, 480, chartRenderHeight(spec)),
        );
        expect(await page.locator(`[data-example="${i}"] svg.stdlib-chart`).evaluate((e) => e.outerHTML)).toBe(expected);
      }
      for (let i = 0; i < barFamilyFixtures.length; i++) {
        const sample = page.locator(`[data-example="${i}"]`),
          chart = sample.locator(".k2b-chart");
        await chart.scrollIntoViewIfNeeded();
        await settled(page);
        const before = await sample.boundingBox();
        const marks = chart.locator("[data-chart-datum]");
        await marks
          .first()
          .locator(".k2b-chart-category-band")
          .hover({ position: { x: 3, y: 3 } });
        await chart.locator('[role="tooltip"]:popover-open').waitFor();
        const first = await chart.locator('[role="tooltip"]').textContent();
        expect(first).not.toContain("series:");
        const legendValue = chart.locator("[data-bar-legend]").first();
        expect(await legendValue.textContent()).not.toBe(await legendValue.getAttribute("data-bar-total"));
        const rects = await marks.evaluateAll((nodes) =>
          nodes.flatMap((g) => [g, ...g.querySelectorAll(".stdlib-chart-bar")].map((e) => getComputedStyle(e).opacity)),
        );
        expect(
          await marks
            .first()
            .locator(":scope > .stdlib-chart-bar")
            .evaluateAll((nodes) => nodes.every((n) => getComputedStyle(n).stroke === "none")),
        ).toBe(true);
        expect(
          await marks
            .first()
            .locator(".k2b-chart-category-band")
            .evaluate((n) => getComputedStyle(n).fill),
        ).not.toBe("none");
        const tipBox = await chart.locator('[role="tooltip"]').boundingBox();
        await marks
          .first()
          .locator(".k2b-chart-category-band")
          .hover({ position: { x: 5, y: 12 } });
        await settled(page);
        expect(await chart.locator('[role="tooltip"]').textContent()).toBe(first);
        expect(await chart.locator('[role="tooltip"]').boundingBox()).toEqual(tipBox);
        expect(rects.every((v) => v === "1")).toBe(true);
        expect(await sample.boundingBox()).toEqual(before);
        await chart.focus();
        await chart.press("End");
        await chart.press("Enter");
        expect(await chart.locator('[role="tooltip"]').textContent()).not.toBe(first);
        await chart.press("Home");
        await settled(page);
        expect(await marks.first().evaluate((n) => CSS.supports("color", n.style.getPropertyValue("--k2b-chart-inspection-color")))).toBe(
          true,
        );
        expect(
          await marks
            .first()
            .locator(":scope > .stdlib-chart-bar")
            .evaluateAll((nodes) =>
              nodes.every((n) => getComputedStyle(n).stroke !== "none" && parseFloat(getComputedStyle(n).strokeWidth) > 0),
            ),
        ).toBe(true);
        await chart.press("Escape");
        expect(await chart.locator('[role="tooltip"]:popover-open').count()).toBe(0);
        await marks.first().evaluate((g) => g.setAttribute("data-selected", ""));
        await settled(page);
        expect(
          await marks
            .first()
            .locator(".k2b-chart-category-band")
            .evaluate((n) => getComputedStyle(n).stroke),
        ).toBe("none");
        await marks.first().evaluate((g) => g.removeAttribute("data-selected"));
        await marks
          .first()
          .locator(".k2b-chart-category-band")
          .tap({ position: { x: 3, y: 3 } });
        await chart.locator('[role="tooltip"]:popover-open').waitFor();
        await page.locator(".states").dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
        expect(await chart.locator('[role="tooltip"]:popover-open').count()).toBe(0);
        await settled(page);
        const box = await marks.first().boundingBox();
        await chart.dispatchEvent("pointerdown", {
          pointerType: "touch",
          pointerId: 1,
          clientX: box!.x + 4,
          clientY: box!.y + 4,
          bubbles: true,
        });
        await chart.dispatchEvent("pointermove", {
          pointerType: "touch",
          pointerId: 1,
          clientX: box!.x + 24,
          clientY: box!.y + 4,
          bubbles: true,
        });
        await chart.dispatchEvent("pointerup", {
          pointerType: "touch",
          pointerId: 1,
          clientX: box!.x + 24,
          clientY: box!.y + 4,
          bubbles: true,
        });
        await marks
          .first()
          .locator(".k2b-chart-category-band")
          .dispatchEvent("click", { clientX: box!.x + 24, clientY: box!.y + 4, bubbles: true });
        expect(await chart.locator('[role="tooltip"]:popover-open').count()).toBe(0);
        await chart.dispatchEvent("pointerdown", {
          pointerType: "touch",
          pointerId: 1,
          clientX: box!.x + 4,
          clientY: box!.y + 4,
          bubbles: true,
        });
        await chart.dispatchEvent("pointermove", {
          pointerType: "touch",
          pointerId: 1,
          clientX: box!.x + 11,
          clientY: box!.y + 4,
          bubbles: true,
        });
        await marks
          .first()
          .locator(".k2b-chart-category-band")
          .dispatchEvent("click", { clientX: box!.x + 11, clientY: box!.y + 4, bubbles: true });
        await chart.locator('[role="tooltip"]:popover-open').waitFor();
        await chart.press("Escape");
      }
      const boxes = () =>
        page.locator(".sample").evaluateAll((nodes) =>
          nodes.map((n) => {
            const r = n.getBoundingClientRect();
            return [r.width, r.height];
          }),
        );
      await settled(page);
      const before = await boxes();
      for (const state of ["loading", "empty", "error", "stale", "data"]) {
        await page.getByRole("button", { name: state, exact: true }).click();
        await settled(page);
        expect(await boxes()).toEqual(before);
      }
      await page.getByRole("button", { name: "error", exact: true }).click();
      await page.getByRole("button", { name: "Retry", exact: true }).first().click();
      expect(await page.locator(".sample .k2b-chart").count()).toBe(barFamilyFixtures.length);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const shots = process.env.CHARTS_SCREENSHOTS;
      if (shots) {
        await mkdir(shots, { recursive: true });
        await page.screenshot({ path: resolve(shots, `bars-data-light-${width}.png`), fullPage: true });
      }
      await page.locator("body").evaluate((e) => (e.dataset.theme = "dark"));
      await settled(page);
      expect(
        await page
          .locator(".k2b-chart-category-band")
          .first()
          .evaluate((e) => getComputedStyle(e).fill),
      ).toBe("none");
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

test("standalone and base-only hosts paint transparent bands and distinct previous bars", async () => {
  const page = await browser.newPage();
  const errors = pageErrors(page);
  try {
    const base = await Bun.file(resolve(import.meta.dir, "../base/base.css")).text();
    const specs = [
      renderBarChartSvg({ data: [{ label: "Old", value: 10 }], width: 480, height: 280 }),
      renderBarChartSvg({
        x: ["A"],
        series: [{ label: "Now", data: [15] }],
        compare: { label: "Prior", data: [10] },
        width: 480,
        height: 280,
      }),
      renderHbarSvg({ series: ["A"], rows: [{ label: "Row", values: [15] }], width: 480, height: 280 }),
    ];
    for (const strip of [false, true]) {
      await page.setContent(
        `<style>${strip ? base : ""}</style><main>${specs.map((svg) => `<div class="k2b-chart">${strip ? svg.replace(/<style>[\s\S]*?<\/style>/g, "") : svg}</div>`).join("")}</main>`,
      );
      await settled(page);
      expect(await page.locator(".k2b-chart-category-band").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).fill))).toEqual([
        "none",
        "none",
        "none",
      ]);
      const current = page.locator(".k2b-chart").nth(1).locator(".stdlib-chart-bar").last();
      const prior = page.locator(".k2b-chart-previous rect");
      expect(await prior.evaluate((n) => getComputedStyle(n).fill)).toBe(await current.evaluate((n) => getComputedStyle(n).fill));
      expect(await prior.evaluate((n) => getComputedStyle(n).fillOpacity)).toBe("0.14");
      expect(await current.evaluate((n) => getComputedStyle(n).fillOpacity)).toBe("1");
      expect(
        await page
          .locator(".k2b-chart")
          .last()
          .locator(".stdlib-chart-bar")
          .evaluate((n) => getComputedStyle(n).fill),
      ).not.toBe("rgb(0, 0, 0)");
      if (strip) {
        await page
          .locator(".k2b-chart-category-band")
          .first()
          .evaluate((n) => n.parentElement!.setAttribute("data-inspected", "hover"));
        await settled(page);
        expect(
          await page
            .locator(".k2b-chart-category-band")
            .first()
            .evaluate((n) => getComputedStyle(n).fill),
        ).not.toBe("none");
        expect(
          await page
            .locator(".k2b-chart")
            .first()
            .locator("[data-inspected] > rect")
            .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).stroke)),
        ).toEqual(["none", "none"]);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("old bars keep valid SSR/client selection and inspection outlines inside k2b-ui", async () => {
  const page = await browser.newPage();
  try {
    const errors = pageErrors(page);
    const svg = selectedChartSvg(
      renderChartSvg(
        {
          kind: "bar",
          data: [
            { label: "Old A", value: 10 },
            { label: "Old B", value: 20 },
          ],
        },
        480,
        280,
      ),
      { role: "item", index: 0 },
    );
    await page.setContent(
      `<style>${css}</style><body class="k2b-ui"><div id="ssr" class="k2b-chart">${svg}</div><div id="root"></div></body>`,
    );
    await settled(page);
    const serverStroke = await page.locator("#ssr [data-selected] .stdlib-chart-bar").evaluate((n) => getComputedStyle(n).stroke);
    expect(serverStroke).not.toBe("none");
    await page.addScriptTag({ content: bundle });
    const chart = page.locator("#old-bar-outline .k2b-chart");
    await settled(page);
    const first = chart.locator("[data-chart-datum]").first();
    const second = chart.locator("[data-chart-datum]").nth(1);
    expect(await first.locator(".stdlib-chart-bar").evaluate((n) => getComputedStyle(n).stroke)).toBe(serverStroke);
    expect(await first.evaluate((n) => CSS.supports("color", n.style.getPropertyValue("--k2b-chart-selection-color")))).toBe(true);
    await second.locator(".k2b-chart-category-band").hover({ position: { x: 3, y: 3 } });
    await chart.locator('[role="tooltip"]:popover-open').waitFor();
    await settled(page);
    expect(await second.locator(".stdlib-chart-bar").evaluate((n) => getComputedStyle(n).stroke)).toBe("none");
    expect(await second.locator(".k2b-chart-category-band").evaluate((n) => getComputedStyle(n).fill)).not.toBe("none");
    await chart.focus();
    await chart.press("End");
    await settled(page);
    expect(await second.evaluate((n) => CSS.supports("color", n.style.getPropertyValue("--k2b-chart-inspection-color")))).toBe(true);
    expect(await second.locator(".stdlib-chart-bar").evaluate((n) => getComputedStyle(n).stroke)).not.toBe("none");
    await chart.press("Enter");
    await settled(page);
    expect(await second.evaluate((n) => CSS.supports("color", n.style.getPropertyValue("--k2b-chart-selection-color")))).toBe(true);
    expect(await second.locator(".stdlib-chart-bar").evaluate((n) => parseFloat(getComputedStyle(n).strokeWidth))).toBeGreaterThan(0);
    await chart.press("Escape");
    await second.locator(".k2b-chart-category-band").hover({ position: { x: 3, y: 3 } });
    await settled(page);
    expect(await second.locator(".stdlib-chart-bar").evaluate((n) => getComputedStyle(n).stroke)).not.toBe("none");
    expect(await second.locator(".k2b-chart-category-band").evaluate((n) => getComputedStyle(n).stroke)).toBe("none");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
