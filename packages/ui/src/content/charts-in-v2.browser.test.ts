import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { textEdge, typeRoles } from "../v2/tokens";
import { measureV2Layout } from "../v2/testing";

// A chart of @k2b/ui in a v2 screen of Cloud: the page carries the v1 sheet on `.k2b-ui` and the v2 sheet on the
// `.k2-ui` content area. The chart must speak v2 there: the v2 font, the meta role, the v2 inks and lines, a separator
// in the surface of either theme, the text edge in a Canvas, and a tooltip like a v2 overlay.
let browser: Browser;
let bundle: string;
let css: string;
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
  css =
    (await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text()) +
    (await Bun.file(resolve(import.meta.dir, "../v2/v2.css")).text());
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, theme: "light" | "dark") => {
  const page = await browser.newPage({ viewport: { width, height: 1300 }, colorScheme: theme });
  const errors = pageErrors(page);
  await page.setContent(
    `<!doctype html><html lang="de" class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style>` +
      `<style>html,body{margin:0;height:100%}.frame{position:fixed;inset:0;display:flex}</style></head>` +
      `<body class="k2b-ui"><div class="frame k2-ui" id="root"></div></body></html>`,
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
      return { family: style.fontFamily.split(",")[0]!.replaceAll('"', ""), size: style.fontSize, fill: style.fill, opacity: style.opacity };
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

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`a chart in a v2 screen takes the v2 font, role, inks and edge (${theme}, ${width} px)`, async () => {
      const { page, errors } = await open(width, theme);
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

test("the tooltip of a chart in a v2 screen is a v2 overlay with words in the meta role", async () => {
  const { page, errors } = await open(1440, "light");
  try {
    await page.locator(".charts-v2-bar [data-chart-datum]").first().hover();
    const tooltip = page.locator(".charts-v2-bar .k2b-chart__tooltip");
    await tooltip.waitFor({ state: "visible" });
    const found = await tooltip.evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement("span");
      probe.style.cssText = "border-radius: var(--k2-r-overlay); box-shadow: var(--k2-float)";
      element.closest(".k2-ui")!.append(probe);
      const overlay = getComputedStyle(probe);
      const found = {
        font: `${style.fontSize}/${style.lineHeight}`,
        radius: style.borderRadius,
        shadow: style.boxShadow,
        overlay: { radius: overlay.borderRadius, shadow: overlay.boxShadow },
      };
      probe.remove();
      return found;
    });
    expect(found.font).toBe(`${typeRoles.meta.size}px/${typeRoles.meta.lineHeight}px`);
    expect({ radius: found.radius, shadow: found.shadow }).toEqual(found.overlay);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
