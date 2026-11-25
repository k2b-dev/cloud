import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { measureV2Layout } from "../v2/testing";
import { textEdge, typeRoles } from "../v2/tokens";

// A chart of @k2b/ui in a v2 screen, in the two pages that have one: a v2 screen of Cloud (the v1 sheet on
// `.k2b-ui`, the v2 sheet on the `.k2-ui` content area) and a page that loads only `v2.css` and has no `.k2b-ui` at
// all (a standalone v2 app, Fibel's recipe route, v2-preview). In both the chart sizes itself from its Canvas and
// speaks v2: the v2 font, the meta role, the v2 inks and lines, a separator in the surface of either theme, the text
// edge in a Canvas, a tooltip like a v2 overlay, and loading, failed and empty states as high as the Canvas.
type Shape = "cloud" | "v2 only";
const shapes: readonly Shape[] = ["cloud", "v2 only"];
let browser: Browser;
let bundle: string;
const css: Record<Shape, string> = { cloud: "", "v2 only": "" };
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/charts-in-v2.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "charts-in-v2-dom",
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
  if (!build.success) throw new AggregateError(build.logs, "Charts in v2 harness failed");
  bundle = await build.outputs[0]!.text();
  // the sheets as they ship: dist/v2.css carries the chart's own stylesheet after v2 (see scripts/build.ts)
  const v2 = await Bun.file(resolve(import.meta.dir, "../../dist/v2.css")).text();
  css.cloud = (await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text()) + v2;
  css["v2 only"] = v2;
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (shape: Shape, width: number, theme: "light" | "dark") => {
  const page = await browser.newPage({ viewport: { width, height: 1300 }, colorScheme: theme });
  const errors = pageErrors(page);
  await page.setContent(
    `<!doctype html><html lang="de" class="${theme === "dark" ? "dark" : ""}"><head><style>${css[shape]}</style>` +
      `<style>html,body{margin:0;height:100%}.frame{position:fixed;inset:0;display:flex}</style></head>` +
      `<body${shape === "cloud" ? ' class="k2b-ui"' : ""}><div class="frame k2-ui" id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".charts-v2-bar .stdlib-chart-bar");
  await settled(page);
  return { page, errors };
};

/** The computed look of the chart words and marks next to the v2 tokens of the scope. */
const look = (page: Page) =>
  page.evaluate(() => {
    const scope = getComputedStyle(document.querySelector(".k2-ui")!);
    const probe = document.createElement("span");
    document.querySelector(".k2-ui")!.append(probe);
    const ink = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const tokens = { muted: ink("--k2-muted"), subtle: ink("--k2-subtle"), surface: ink("--k2-surface") };
    probe.remove();
    const text = (selector: string) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return {
        family: style.fontFamily.split(",")[0]!.replaceAll('"', ""),
        size: style.fontSize,
        fill: style.fill,
        opacity: style.opacity,
      };
    };
    const canvas = document.querySelector(".charts-v2-line")!.closest(".k2-canvas")!.getBoundingClientRect();
    return {
      font: scope.getPropertyValue("--k2-font").split(",")[0]!.trim().replaceAll('"', ""),
      tokens,
      tick: text(".charts-v2-line .stdlib-chart-tick-label"),
      category: text(".charts-v2-bar .stdlib-chart-category-label"),
      value: text(".charts-v2-bar .stdlib-chart-bar-value"),
      funnel: text(".charts-v2-funnel .stdlib-chart-tick-label"),
      slice: getComputedStyle(document.querySelector(".charts-v2-donut .stdlib-chart-slice")!).stroke,
      legendInset: Math.round(document.querySelector(".charts-v2-line .k2b-chart__legend")!.getBoundingClientRect().left - canvas.left),
    };
  });

/** Each chart's box next to its Canvas, and the drawing inside it. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    ["line", "bar", "donut", "funnel"].map((name) => {
      const chart = document.querySelector(`.charts-v2-${name}`)!;
      const canvas = chart.closest(".k2-canvas")!.getBoundingClientRect();
      const root = chart.getBoundingClientRect();
      const drawing = chart.querySelector(".k2b-chart__svg > svg")!.getBoundingClientRect();
      const style = getComputedStyle(chart);
      return {
        name,
        position: style.position,
        // rows of a funnel or a horizontal bar keep their own height and scroll inside the chart
        scrolls: style.overflowY === "auto",
        inset: { left: Math.round(root.left - canvas.left), right: Math.round(canvas.right - root.right) },
        height: { canvas: Math.round(canvas.height), chart: Math.round(root.height) },
        drawing: { width: Math.round(drawing.width), height: Math.round(drawing.height) },
      };
    }),
  );

for (const shape of shapes)
  for (const theme of ["light", "dark"] as const)
    for (const width of [1440, 390])
      test(`${shape}: a chart in a v2 screen takes the v2 font, role, inks and edge (${theme}, ${width} px)`, async () => {
        const { page, errors } = await open(shape, width, theme);
        try {
          const found = await look(page);
          const meta = `${typeRoles.meta.size}px`;
          expect(found.font).toBe("IBM Plex Sans");
          for (const words of [found.tick, found.category, found.value, found.funnel]) {
            expect(words.family).toBe(found.font);
            expect(words.size).toBe(meta);
            expect(words.opacity).toBe("1");
          }
          expect(found.tick.fill).toBe(found.tokens.subtle);
          expect(found.category.fill).toBe(found.tokens.muted);
          expect(found.value.fill).toBe(found.tokens.muted);
          // The separator between slices is the surface of the theme, never white on a dark page.
          expect(found.slice).toBe(found.tokens.surface);
          expect(found.legendInset).toBe(width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide);
          expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);

for (const shape of shapes)
  for (const width of [1440, 390])
    test(`${shape}: a chart fills its Canvas between the text edges and draws at that size (${width} px)`, async () => {
      const { page, errors } = await open(shape, width, "light");
      try {
        const edge = width < textEdge.phoneBelow ? textEdge.phone : textEdge.wide;
        for (const box of await boxes(page)) {
          expect(box.position).toBe("relative");
          expect(box.inset).toEqual({ left: edge, right: edge });
          expect(box.height.chart).toBe(box.height.canvas);
          // the drawing takes the chart's width and most of its height (the line keeps its legend above it)
          expect(box.drawing.height).toBeGreaterThan(box.height.canvas * 0.6);
          if (!box.scrolls) expect(box.drawing.height).toBeLessThanOrEqual(box.height.canvas);
          expect(box.drawing.width).toBeGreaterThan(width < textEdge.phoneBelow ? 250 : 400);
        }
        // the sparkline and its padded drawing box stay in the 96 × 24 its caller gives (border-box, as in v1)
        for (const part of [".k2b-chart", ".k2b-chart__svg"]) {
          const spark = await page.locator(`.charts-v2-spark ${part}`).boundingBox();
          expect({ width: Math.round(spark!.width), height: Math.round(spark!.height) }).toEqual({ width: 96, height: 24 });
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);

for (const shape of shapes)
  test(`${shape}: the tooltip of a chart is a v2 overlay with words in the meta role, beside the mark`, async () => {
    const { page, errors } = await open(shape, 1440, "light");
    try {
      const mark = page.locator(".charts-v2-bar [data-chart-datum]").first();
      await mark.hover();
      const tooltip = page.locator(".charts-v2-bar .k2b-chart__tooltip");
      await tooltip.waitFor({ state: "visible" });
      const found = await tooltip.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement("span");
        probe.style.cssText = "border-radius: var(--k2-r-overlay); box-shadow: var(--k2-float); color: var(--k2-surface)";
        element.closest(".k2-ui")!.append(probe);
        const overlay = getComputedStyle(probe);
        const found = {
          font: `${style.fontSize}/${style.lineHeight}`,
          radius: style.borderRadius,
          shadow: style.boxShadow,
          background: style.backgroundColor,
          position: style.position,
          margin: style.margin,
          overlay: { radius: overlay.borderRadius, shadow: overlay.boxShadow, surface: overlay.color },
        };
        probe.remove();
        return found;
      });
      expect(found.font).toBe(`${typeRoles.meta.size}px/${typeRoles.meta.lineHeight}px`);
      expect({ radius: found.radius, shadow: found.shadow }).toEqual({ radius: found.overlay.radius, shadow: found.overlay.shadow });
      expect(found.background).toBe(found.overlay.surface);
      expect({ position: found.position, margin: found.margin }).toEqual({ position: "fixed", margin: "0px" });
      // placed by the script beside the mark, not stretched or centred in the viewport by the popover defaults
      const tip = (await tooltip.boundingBox())!;
      const bar = (await mark.boundingBox())!;
      expect(tip.width).toBeLessThan(400);
      expect(tip.y + tip.height).toBeGreaterThan(bar.y - 200);
      expect(tip.y).toBeLessThan(bar.y + bar.height + 200);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

/** The height of each chart's Section and Canvas, and what stands in the Canvas. */
const places = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".k2-canvas")].map((canvas) => {
      const inside = canvas.firstElementChild as HTMLElement | null;
      return {
        canvas: Math.round(canvas.getBoundingClientRect().height),
        section: Math.round(canvas.parentElement!.getBoundingClientRect().height),
        top: Math.round(canvas.getBoundingClientRect().top),
        inside: inside?.dataset.k2Part ?? inside?.className.split(" ")[0] ?? "",
        fills: Math.round(inside?.getBoundingClientRect().height ?? 0) === Math.round(canvas.getBoundingClientRect().height),
      };
    }),
  );

for (const shape of shapes)
  for (const width of [1440, 390])
    test(`${shape}: loading, failed and empty stand in the Canvas and keep its height (${width} px)`, async () => {
      const { page, errors } = await open(shape, width, "light");
      try {
        const ready = await places(page);
        expect(ready.map((place) => place.inside)).toEqual(["k2b-chart", "k2b-chart", "k2b-chart", "k2b-chart"]);
        for (const [state, part] of [
          ["loading", "Loading"],
          ["failed", "Failed"],
          ["empty", "k2b-chart"],
        ] as const) {
          await page.evaluate((next) => (window as unknown as { setChartsState: (state: string) => void }).setChartsState(next), state);
          await settled(page);
          const now = await places(page);
          // nothing moves: every Canvas, its Section and everything below keep their place
          expect(now.map(({ canvas, section, top }) => ({ canvas, section, top }))).toEqual(
            ready.map(({ canvas, section, top }) => ({ canvas, section, top })),
          );
          for (const place of now) {
            expect(place.inside).toBe(part);
            expect(place.fills).toBe(true);
          }
          if (state === "empty") expect(await page.locator(".charts-v2-bar.k2b-chart__empty").isVisible()).toBe(true);
        }
        expect((await measureV2Layout(page, { root: "[data-k2-workspace]" })).problems).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);

test("v2 only: a focused chart shows the v2 ring", async () => {
  const { page, errors } = await open("v2 only", 1440, "light");
  try {
    await page.locator(".charts-v2-bar").focus();
    await page.keyboard.press("ArrowRight");
    await settled(page);
    const ring = await page.locator(".charts-v2-bar").evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.color = "var(--k2-blue)";
      element.closest(".k2-ui")!.append(probe);
      const blue = getComputedStyle(probe).color;
      probe.remove();
      return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, blue };
    });
    expect({ style: ring.style, width: ring.width, color: ring.color }).toEqual({ style: "solid", width: "2px", color: ring.blue });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
