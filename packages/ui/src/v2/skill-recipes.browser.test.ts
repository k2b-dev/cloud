import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { describeV2Page, measureV2Layout } from "./testing";

// The recipes of the k2b-ui skill are what agents copy. Each one must keep the v2 rules and show no outline problem at
// 1440 and 390 px, so a recipe and its picture never teach a mistake.
const root = mkdtempSync(resolve(tmpdir(), "k2-v2-recipes-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const recipesDir = resolve(import.meta.dir, "../../skills/k2b-ui/recipes");
const recipes = readdirSync(recipesDir)
  .filter((name) => name.endsWith(".tsx"))
  .sort();
// Each recipe renders as it is and in every state it exports for Fibel's Example (`states`: empty, loading, failed or
// what fits the screen), so a state an agent copies keeps the rules as well.
type Recipe = { default: Parameters<typeof createComponent>[0]; states?: Record<string, () => JSX.Element> };
const markup = new Map<string, string>();
for (const name of recipes) {
  const recipe = (await import(resolve(recipesDir, name))) as Recipe;
  markup.set(
    name,
    renderToString(() => createComponent(recipe.default, {})),
  );
  for (const [state, render] of Object.entries(recipe.states ?? {})) markup.set(`${name} (${state})`, renderToString(render));
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
  for (const name of markup.keys())
    for (const width of [1440, 390])
      test(`${name} at ${width} px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.setContent(
            `<!doctype html><html lang="de"><head><style>${css}</style><style>${testCss}</style></head>` +
              `<body class="k2-ui"><div class="frame">${markup.get(name)}</div></body></html>`,
          );
          const outline = await describeV2Page(page, ".frame");
          expect(outline).not.toContain("Problems");
          const layout = await measureV2Layout(page, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
          expect(layout.measured.texts).toBeGreaterThan(5);
        } finally {
          await page.close();
        }
      }, 30_000);
});
