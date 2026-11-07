import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { chartFixtures } from "../../test/charts/fixtures";
import type ChartComponent from "../content/Chart";

const uiRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(uiRoot, "../..");
const buildFixture = async (contents: string, legacy = false, hydratable = false) => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: ["chart-parity-fixture"],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "chart-parity-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^chart-parity-fixture$/ }, () => ({ path: "fixture", namespace: "chart-parity" }));
          builder.onLoad({ filter: /.*/, namespace: "chart-parity" }, () => ({ contents, loader: "ts", resolveDir: repoRoot }));
          if (legacy)
            builder.onLoad({ filter: /\/charts\/core\/svg\.js$/ }, () => ({
              contents: 'export * from "@k2b/stdlib"; export const referenceLineAttributes = () => "";',
              loader: "js",
            }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable }]],
            });
            if (!result?.code) throw new Error(`Chart fixture transform failed: ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Chart parity fixture failed");
  return build.outputs[0]!.text();
};

test("all registered kinds match server SVG and geometry on the first client render", async () => {
  const ServerChart: typeof ChartComponent = (await import(resolve(uiRoot, "dist/ssr/content/Chart.js"))).default;
  const specs = Object.values(chartFixtures);
  const html = specs
    .map(
      (spec, index) =>
        `<div id="chart-${index}">${renderToString(() => createComponent(ServerChart, spec), { renderId: `chart${index}` })}</div>`,
    )
    .join("");
  const bundle = await buildFixture(
    `
    import { createComponent } from "solid-js";
    import { render } from "solid-js/web";
    import Chart from ${JSON.stringify(resolve(uiRoot, "dist/browser/content/Chart.js"))};
    const specs = ${JSON.stringify(specs)};
    for (let index=0; index<specs.length; index++) render(() => createComponent(Chart, specs[index]), document.querySelector("#chart-"+index));
    document.body.dataset.mounted="true";
  `,
    false,
    true,
  );
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    await page.setContent(`<html><body>${html}</body></html>`);
    // @k2b/ssr mounts islands afresh. Compare exact drawing markup and logical geometry;
    // Solid's HTML comment markers, attribute order and generated tooltip IDs differ by runtime.
    const drawing = () =>
      page.locator(".k2b-chart__svg").evaluateAll((charts) =>
        charts.map((chart) => ({
          svg: chart.innerHTML,
          style: chart
            .getAttribute("style")
            ?.split(";")
            .map((part) => part.replace(/\s/g, ""))
            .filter(Boolean)
            .sort(),
          stretch: chart.getAttribute("data-stretch"),
        })),
      );
    const before = await drawing();
    await page.locator("body > div").evaluateAll((charts) => charts.forEach((chart) => chart.replaceChildren()));
    await page.addScriptTag({ content: bundle });
    expect(errors).toEqual([]);
    expect(await page.locator("body").getAttribute("data-mounted")).toBe("true");
    const after = await drawing();
    expect(after).toEqual(before);
    expect(after).toHaveLength(specs.length);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

// Compare the demo previews, omitting their long TSX source listings from screenshots.
const demoFixture = async () => {
  const contents = `
    import {createComponent} from "solid-js";
    import {render} from "solid-js/web";
    import {ChartDemo, BarChartStatesDemo} from ${JSON.stringify(resolve(repoRoot, "docs-site/src/ui/demo-sections/charts.tsx"))};
    import {ChartExplorerShowcases} from ${JSON.stringify(resolve(repoRoot, "docs-site/src/ui/ChartExplorerShowcases.tsx"))};
    render(() => createComponent(ChartDemo,{window:"24h"}), document.querySelector("#charts"));
    render(() => createComponent(BarChartStatesDemo,{}), document.querySelector("#bars"));
    render(() => createComponent(ChartExplorerShowcases,{}), document.querySelector("#explorers"));
  `;
  const beforeBundle = await buildFixture(contents, true);
  const afterBundle = await buildFixture(contents);
  const css = await Bun.file(resolve(uiRoot, "dist/styles.css")).text();
  const docsCss = await Bun.file(resolve(repoRoot, "docs-site/src/ui/cloud-components.css")).text();
  return { beforeBundle, afterBundle, css, docsCss };
};
let demos: ReturnType<typeof demoFixture> | undefined;

for (const width of [1440, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`existing chart and explorer demos remain pixel-identical: ${theme} ${width}px`, async () => {
      demos ??= demoFixture();
      const { beforeBundle, afterBundle, css, docsCss } = await demos;
      const browser = await launchBrowser();
      try {
        const screenshots: Buffer[] = [];
        for (const [stage, bundle] of [
          ["before", beforeBundle],
          ["after", afterBundle],
        ] as const) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
          try {
            const errors = pageErrors(page);
            await page.setContent(
              `<html lang="en" data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${docsCss}\nbody{margin:0;padding:24px}main{max-width:1200px;margin:auto}.k2b-content-doc-code{display:none}.ui-demo-card{margin-bottom:24px}.ui-demo-card__preview{padding:16px}.ui-chart-demo{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))}.ui-chart-demo .k2b-chart{height:240px}</style></head><body class="k2b-ui"><main><div id="charts"></div><div id="bars"></div><div id="explorers"></div></main></body></html>`,
            );
            await page.addScriptTag({ content: bundle });
            await page.locator("#chart-static .k2b-chart").first().waitFor();
            await settled(page);
            const screenshot = await page.screenshot({ fullPage: true, animations: "disabled" });
            screenshots.push(screenshot);
            if (process.env.CHART_SCREENSHOTS && theme === "light") {
              const output = resolve(process.env.CHART_SCREENSHOTS, stage);
              mkdirSync(output, { recursive: true });
              await Bun.write(resolve(output, `chart-demos-light-${width}.png`), screenshot);
            }
            expect(errors).toEqual([]);
          } finally {
            await page.close();
          }
        }
        expect(screenshots[1]!.equals(screenshots[0]!), `${theme} ${width}px`).toBe(true);
      } finally {
        await browser.close();
      }
    }, 30_000);
  }
}

test("reference styles and tones remain distinct at desktop and phone widths", async () => {
  const bundle = await buildFixture(`
    import {createComponent} from "solid-js";
    import {render} from "solid-js/web";
    import {ReferenceLineStylesDemo} from ${JSON.stringify(resolve(repoRoot, "docs-site/src/ui/demo-sections/charts.tsx"))};
    render(() => createComponent(ReferenceLineStylesDemo,{}), document.querySelector("main"));
  `);
  const css = await Bun.file(resolve(uiRoot, "dist/styles.css")).text();
  const browser = await launchBrowser();
  try {
    for (const width of [1440, 390]) {
      for (const theme of ["light", "dark"] as const) {
        const page = await browser.newPage({ viewport: { width, height: 600 }, colorScheme: theme });
        try {
          const errors = pageErrors(page);
          await page.setContent(
            `<html lang="en" data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;padding:24px}main{max-width:960px;margin:auto}.k2b-content-doc-code{display:none}</style></head><body class="k2b-ui"><main></main></body></html>`,
          );
          await page.addScriptTag({ content: bundle });
          await settled(page);
          const lines = page.locator(".stdlib-chart-reference");
          expect(await lines.count()).toBe(3);
          expect(await lines.evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).strokeDasharray))).toEqual([
            "none",
            "4px, 4px",
            "1px, 3px",
          ]);
          const colors = await lines.evaluateAll((marks) => marks.map((mark) => getComputedStyle(mark).color));
          expect(new Set(colors).size).toBe(3);
          const labels = page.locator(".stdlib-chart-reference-label");
          expect(await labels.allTextContents()).toEqual(["Target", "Forecast", "Limit"]);
          expect(
            await labels.evaluateAll((nodes) =>
              nodes.every((node) => {
                const box = node.getBoundingClientRect();
                const chart = node.closest("svg")!.getBoundingClientRect();
                return (
                  box.width > 0 && box.left >= chart.left && box.right <= chart.right && box.top >= chart.top && box.bottom <= chart.bottom
                );
              }),
            ),
          ).toBe(true);
          expect(errors).toEqual([]);
          if (process.env.CHART_SCREENSHOTS && theme === "light") {
            const output = resolve(process.env.CHART_SCREENSHOTS, "reference-styles");
            mkdirSync(output, { recursive: true });
            await page.screenshot({ path: resolve(output, `chart-references-light-${width}.png`), fullPage: true });
          }
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}, 30_000);
