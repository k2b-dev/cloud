import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";

let browser: Browser;
let harness: string;
let css: string;
beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CodeAccountHandle.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-code-handle",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Handle harness build failed");
  harness = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Handle stylesheet build failed");
  css = await styles.outputs[0]!.text();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

for (const width of [390, 1200])
  test(`${width}px: the handle copies before any run and a failed copy remains retryable`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 260 }, reducedMotion: "reduce" });
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="k2b-ui"><main id="root" style="padding:24px"></main></body></html>`,
      );
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              document.body.dataset.copied = text;
            },
          },
        });
      });
      await page.addScriptTag({ content: harness });
      await page.getByRole("button", { name: "Kennung kopieren" }).click();
      await page.waitForFunction(() => document.body.dataset.copied === "code-7k2q9m4xwt");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.CODE_A2_SCREENSHOTS) {
        mkdirSync(process.env.CODE_A2_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: resolve(process.env.CODE_A2_SCREENSHOTS, `handle-${width}.png`) });
      }
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error("Denied");
            },
          },
        });
      });
      await page.getByRole("button", { name: "Kennung kopieren" }).click();
      await page.getByText("Die Kennung konnte nicht kopiert werden.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Kennung kopieren" }).isEnabled()).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
