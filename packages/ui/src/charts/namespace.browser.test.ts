import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser, pageErrors, settled } from "../../test/browser";
import { chartFixtures } from "../../test/charts/fixtures";

test("named charts preserve browser output and reactive data at desktop and phone widths", async () => {
  const build = await Bun.build({
    entrypoints: ["chart-namespace-fixture"],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "chart-namespace-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^chart-namespace-fixture$/ }, () => ({ path: "fixture", namespace: "chart-namespace" }));
          builder.onLoad({ filter: /.*/, namespace: "chart-namespace" }, () => ({
            loader: "ts",
            resolveDir: import.meta.dir,
            contents: `
            import { createComponent, createSignal } from "solid-js";
            import { render } from "solid-js/web";
            import Chart from ${JSON.stringify(resolve(import.meta.dir, "../../dist/browser/content/Chart.js"))};
            import { chartKinds } from ${JSON.stringify(resolve(import.meta.dir, "core/registry.ts"))};
            const fixtures = ${JSON.stringify(chartFixtures)};
            for (const [name, kind] of Object.entries(chartKinds)) {
              const section = document.createElement("section");
              section.innerHTML = '<h2>' + name + '</h2><div class="direct"></div><div class="named"></div>';
              document.querySelector("main").append(section);
              const spec = fixtures[kind];
              const {kind: _, ...props} = spec;
              render(() => createComponent(Chart, spec), section.querySelector(".direct"));
              render(() => createComponent(Chart[name], props), section.querySelector(".named"));
            }
            const [data, setData] = createSignal([{label:"Old", value:4}]);
            render(() => createComponent(Chart.Bar, {get data() { return data(); }}), document.querySelector("#reactive"));
            document.querySelector("#update-chart").onclick = () => setData([{label:"Updated",value:9}]);
          `,
          }));
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]!.text();
  const css = await Bun.file(resolve(import.meta.dir, "../../dist/styles.css")).text();
  const browser = await launchBrowser();
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const errors = pageErrors(page);
        await page.setContent(`<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}
          body{margin:0;padding:24px;background:white;color:#202632}main{display:grid;gap:24px;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))}section{min-width:0}h2{font:600 16px sans-serif}.direct,.named{height:220px}
          .direct:has([data-balance-flow]),.named:has([data-balance-flow]){height:auto}
          </style></head><body class="k2b-ui"><main></main><button id="update-chart">Update</button><div id="reactive" style="height:200px"></div></body></html>`);
        await page.addScriptTag({ content: bundle });
        await settled(page);
        const equal = await page
          .locator("main > section")
          .evaluateAll((sections) =>
            sections.map((section) => section.querySelector(".direct svg")?.outerHTML === section.querySelector(".named svg")?.outerHTML),
          );
        expect(equal).toEqual(Array(Object.keys(chartFixtures).length).fill(true));
        if (process.env.CHART_SCREENSHOTS) {
          mkdirSync(process.env.CHART_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: resolve(process.env.CHART_SCREENSHOTS, `charts-light-${width}.png`), fullPage: true });
        }
        await page.getByRole("button", { name: "Update", exact: true }).click();
        await page.locator("#reactive .stdlib-chart-category-label", { hasText: "Updated" }).waitFor();
        expect(await page.locator("#reactive").textContent()).toContain("Updated");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}, 30_000);
