import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import { measureV2Layout } from "../../test/measure-v2-layout";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { describeV2 } from "./describe";

// The recipes of the k2b-ui skill are what agents copy. Each one must keep the v2 rules and show no outline problem at
// 1440 and 390 px, so a recipe and its picture never teach a mistake.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-recipes-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const recipes = readdirSync(recipesDir)
  .filter((name) => name.endsWith(".tsx"))
  .sort();
const markup = new Map<string, string>();
for (const name of recipes) {
  const screen = (await import(resolve(recipesDir, name))) as { default: Parameters<typeof createComponent>[0] };
  markup.set(
    name,
    renderToString(() => createComponent(screen.default, {})),
  );
}
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } .frame { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("k2b-ui skill recipes keep the v2 rules", () => {
  test("there are recipes", () => {
    expect(recipes.length).toBeGreaterThanOrEqual(6);
  });
  for (const name of recipes)
    for (const width of [1440, 390])
      test(`${name} at ${width} px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.setContent(
            `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss}</style></head>` +
              `<body class="k2-ui"><div class="frame">${markup.get(name)}</div></body></html>`,
          );
          const outline = (await page.evaluate(`(${describeV2})(document.querySelector(".frame"), { layout: true })`)) as string;
          expect(outline).not.toContain("Problems");
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
          expect(layout.measured.texts).toBeGreaterThan(5);
        } finally {
          await page.close();
        }
      }, 30_000);
});
