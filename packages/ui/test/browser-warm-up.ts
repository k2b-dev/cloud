/**
 * Renders and drives real @k2b/ui components once, before the first browser test file.
 * Usage: bun packages/ui/test/browser-warm-up.ts
 * A fresh Playwright container compiles its graphics shaders on the first frames it draws,
 * which took 3–4 s in WebKit; without this, that one-time cost lands in the first test's budget (#2149).
 */
import { resolve } from "node:path";
import { launchBrowser } from "./browser";

if (process.argv.includes("--help")) {
  console.log(
    "Usage: bun packages/ui/test/browser-warm-up.ts\nDraws a dialog, a combobox list and a menu once in TEST_BROWSER, so a fresh browser compiles its shaders before the first test.",
  );
  process.exit(0);
}

const started = performance.now();
const { transformAsync } = await import("@babel/core");
const typescript = (await import("@babel/preset-typescript")).default;
const solid = (await import("babel-preset-solid")).default;
const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "browser-warm-up.browser-harness.tsx")],
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [
    {
      name: "warm-up-dom",
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
if (!build.success) throw new AggregateError(build.logs, "Browser warm-up harness failed");
const bundle = await build.outputs[0]!.text();
const css = await Bun.file(resolve(import.meta.dir, "../dist/styles.css")).text();

const browser = await launchBrowser();
try {
  for (const [width, theme] of [
    [390, "light"],
    [1440, "dark"],
  ] as const) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(
        `<!doctype html><html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}"><main id="root" class="p-4"></main></body></html>`,
      );
      await page.addScriptTag({ content: bundle });
      await page.getByRole("button", { name: "Open", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("combobox").fill("example");
      await page.getByRole("option", { name: /Grace Example/ }).hover();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("option", { name: /Ada Example/ }).click();
      await dialog.getByRole("button", { name: "Retry", exact: true }).hover();
      await dialog.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("menuitem", { name: "Rename" }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
      await dialog.waitFor({ state: "hidden" });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`browser warm-up: ${((performance.now() - started) / 1000).toFixed(1)}s`);
