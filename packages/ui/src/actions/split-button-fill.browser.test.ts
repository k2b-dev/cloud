import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// How a split button shares extra width is a question of real flex layout, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "split-button-fill.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { SplitButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const items = [{ label: "Save a copy", action: () => {} }];
const button = (id, extra = {}) => {
  const host = document.createElement("div");
  host.id = id;
  render(() => createComponent(SplitButton, { menuLabel: "More " + id, items, children: "Save", ...extra }), host);
  return host;
};
const app = document.getElementById("app");
for (const [id, extra] of [
  ["natural", {}],
  ["wide", {}],
  ["wide-secondary", { variant: "secondary" }],
  ["wide-menu", { primaryItems: [{ label: "other.ts", action: () => {} }], primaryMenuLabel: "Choose file" }],
  ["natural-menu", { primaryItems: [{ label: "other.ts", action: () => {} }], primaryMenuLabel: "Choose file" }],
]) app.append(button(id, extra));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the split button fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Widths = { root: number; primary: number; trigger: number };

describe("@k2b/ui SplitButton width", () => {
  test("a host's extra width goes to the main action; the menu segment and the natural width stay as they were", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style><style>#app{width:300px;display:grid;gap:8px;justify-items:start}` +
          `[id^="wide"] > .k2b-split-button{width:100%}[id^="wide"]{width:100%}</style></head>` +
          `<body class="k2b-ui"><main id="app"></main></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.locator("#natural-menu .k2b-split-button__menu-trigger").waitFor();
      await settled(page);
      const widths = await page.evaluate(() =>
        Object.fromEntries(
          ["natural", "wide", "wide-secondary", "wide-menu", "natural-menu"].map((id) => {
            const host = document.getElementById(id)!;
            const width = (selector: string) => Math.round(host.querySelector(selector)!.getBoundingClientRect().width);
            return [
              id,
              {
                root: width(".k2b-split-button"),
                primary: width(".k2b-split-button__primary"),
                trigger: width(".k2b-split-button__menu-trigger"),
              },
            ];
          }),
        ),
      );
      const natural = widths.natural as Widths;
      for (const id of ["wide", "wide-secondary", "wide-menu"]) {
        const wide = widths[id] as Widths;
        expect([id, wide.root]).toEqual([id, 300]);
        // The segments touch with a one-pixel overlap, so together they fill the root.
        expect([id, wide.primary + wide.trigger - 1]).toEqual([id, 300]);
        expect([id, wide.trigger]).toEqual([id, natural.trigger]);
      }
      // At its natural width the button stays as compact as its content.
      expect(natural.root).toBeLessThan(150);
      expect(natural.primary + natural.trigger - 1).toBe(natural.root);
      expect((widths["natural-menu"] as Widths).root).toBeLessThan(150);
    } finally {
      await page.close();
    }
  });
});
