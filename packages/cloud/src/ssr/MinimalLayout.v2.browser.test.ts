import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// A visitor page without the Cloud shell on v2: the k2b-ui "public page" recipe inside `MinimalLayout ui="v2"`. The
// page and its footer share the window; a kiosk page without the footer takes the whole window and scrolls inside.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-v2-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
const recipe = await import("../../../ui/skills/k2b-ui/recipes/public-page");
type Context = Parameters<typeof MinimalLayout>[0]["c"];

const legalApp = { id: "legal-probe", legalLinks: [{ label: "Imprint", href: "/impressum" }] };
const render = (kiosk: boolean) => {
  const page: { appUi?: "v2"; stylesheets?: "v2" } = {};
  const context = {
    get: (key: string) => (key === "page" ? page : key === "runtime" ? { apps: [legalApp] } : undefined),
    req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/public/kulturhaus" } },
  } as unknown as Context;
  const html = renderToString(() =>
    createComponent(MinimalLayout, {
      c: context,
      ui: "v2",
      preferences: !kiosk,
      get children() {
        return createComponent(recipe.default, { kiosk });
      },
    }),
  );
  return { html, page };
};

let browser: Browser;
let css: string;
beforeAll(async () => {
  // The page loads Core's v2.css alone, as `MinimalLayout ui="v2"` links it: no global.css, no v1.
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  if (!build.success) throw new AggregateError(build.logs, "Could not build v2.css.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

describe("MinimalLayout ui v2", () => {
  test("a page without ui keeps global.css, its v1 footer and its page options", () => {
    const page: Record<string, unknown> = {};
    const context = {
      get: (key: string) => (key === "page" ? page : key === "runtime" ? { apps: [legalApp] } : undefined),
      req: { raw: { headers: new Headers({ "Accept-Language": "en" }), url: "https://cloud.test/share/probe" } },
    } as unknown as Context;
    const html = renderToString(() => createComponent(MinimalLayout, { c: context, children: "Share" }));
    expect(page).toEqual({});
    expect(html).toContain('<footer class="minimal-layout-footer">');
    expect(html).not.toContain("k2-ui");
  });

  test("the page is the v2 scope in the app's colours, without the Cloud shell", () => {
    const { html, page } = render(false);
    expect(page.appUi).toBe("v2");
    // The page links Core's v2.css alone, and its footer is a v2 scope with v2 menus (no v1 markup).
    expect(page.stylesheets).toBe("v2");
    expect(html).toContain('<footer class="minimal-layout-footer" data-ui="v2"');
    expect(html).not.toMatch(/k2b-button|k2b-dropdown/);
    expect(html).toContain('<div class="k2-ui minimal-layout" data-ui="v2"');
    expect(html).toContain('<main class="minimal-layout-main"');
    expect(html).toContain('data-k2-part="Workspace"');
    for (const shell of ["rail-item", "cloud-app-canvas", "layout-header"]) expect(html).not.toContain(shell);
    expect(html).toContain("Imprint");
  });

  for (const kiosk of [false, true])
    for (const width of [1440, 390])
      test(`${kiosk ? "kiosk" : "visitor page"} at ${width} px: clean, inside the window, the footer after it`, async () => {
        const tab = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await tab.setContent(
            `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
              `<body class="k2b-ui">${render(kiosk).html}</body></html>`,
          );
          const outline = await describeV2Page(tab, "main");
          expect(outline.includes("Problems (") ? outline : "").toBe("");
          const layout = await measureV2Layout(tab, { root: "[data-k2-workspace]" });
          expect(layout.problems).toEqual([]);
          const boxes = await tab.evaluate(() => {
            const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON() as DOMRect | undefined;
            return {
              main: box("main"),
              footer: box("footer"),
              scrollWidth: document.documentElement.scrollWidth,
              scrollHeight: document.documentElement.scrollHeight,
            };
          });
          expect(boxes.scrollWidth).toBeLessThanOrEqual(width);
          if (kiosk) {
            // A wall screen takes the whole window and scrolls inside; no footer.
            expect(boxes.footer).toBeUndefined();
            expect(Math.round(boxes.main!.height)).toBe(900);
            expect(boxes.scrollHeight).toBeLessThanOrEqual(900);
          } else expect(boxes.footer!.top).toBeGreaterThanOrEqual(boxes.main!.bottom - 0.5);
        } finally {
          await tab.close();
        }
      }, 30_000);
});
