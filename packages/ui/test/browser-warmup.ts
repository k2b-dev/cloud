/**
 * Pays an engine's one-time costs before a browser test run, outside every test's budget.
 * Usage: bun test/browser-warmup.ts
 *
 * A fresh Playwright container has no shader cache, so whichever test draws first compiles
 * about 100 shaders and loses its 5 s to it (#2149). Each suite starts its own browser and
 * shares only that on-disk cache with this process, so no test sees any other state from here.
 * Any failure exits non-zero: the runner stops, since the first test would otherwise fail in disguise.
 */
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import tailwind from "bun-plugin-tailwind";
import { browserName, launchBrowser } from "./browser";

if (Bun.argv.includes("--help")) {
  console.log(
    "Usage: bun test/browser-warmup.ts\nDraws real @k2b/ui surfaces once, so the engine's one-time costs fall outside every test.",
  );
  process.exit(0);
}

const began = performance.now();
const script = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "browser-warmup.browser-harness.tsx")],
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [
    {
      name: "browser-warmup-dom",
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
if (!script.success) throw new AggregateError(script.logs, "Browser warm-up harness failed");
const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../styles.css")], plugins: [tailwind] });
if (!styles.success) throw new AggregateError(styles.logs, "Browser warm-up styles failed");
const bundle = await script.outputs[0]!.text();
const css = await styles.outputs[0]!.text();

const browser = await launchBrowser();
try {
  for (const width of [390, 1440])
    for (const dark of [false, true]) {
      const sceneBegan = performance.now();
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("https://cloud.example.test/warmup.js", (route) =>
        route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle }),
      );
      await page.route("https://cloud.example.test/warmup", (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html lang="en" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-theme="${dark ? "dark" : "light"}"><main id="root"></main><script src="/warmup.js"></script></body></html>`,
        }),
      );
      await page.goto("https://cloud.example.test/warmup");
      await page.getByRole("button", { name: "Open", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").fill("Option");
      await page.getByRole("option", { name: /Option/ }).click();
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await page.close();
      if (errors.length) throw new Error(`Browser warm-up page errors: ${errors.join("; ")}`);
      console.log(`browser warm-up ${browserName} ${width} ${dark ? "dark" : "light"}: ${Math.round(performance.now() - sceneBegan)} ms`);
    }
} finally {
  await browser.close();
}
console.log(`browser warm-up ${browserName}: ${((performance.now() - began) / 1000).toFixed(1)} s`);
