import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeV2Page, measureV2Layout } from "@k2b/ui/v2/testing";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import * as watcher from "../_internal/runtime-watcher";

// A visitor page without the Cloud shell on v2: the k2b-ui "public page" recipe inside `MinimalLayout ui="v2"`. The
// page and its footer share the window; a kiosk page without the footer takes the whole window and scrolls inside.
const root = mkdtempSync(resolve(tmpdir(), "cloud-minimal-layout-v2-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MinimalLayout } = await import("./MinimalLayout");
const recipe = await import("../../../ui/skills/k2b-ui/recipes/public-page");
type Context = Parameters<typeof MinimalLayout>[0]["c"];

/** What the registered Core serves: from the v2 sheet on it declares `/public/v2.css`; an older Core does not. */
const coreRoutes = spyOn(watcher, "registeredCoreRoutes");
type Core = "with v2.css" | "older";
const declare = (core: Core) =>
  coreRoutes.mockReturnValue(core === "with v2.css" ? ["/public/global.css", "/public/v2.css"] : ["/public/global.css"]);

const legalApp = { id: "legal-probe", legalLinks: [{ label: "Imprint", href: "/impressum" }] };
const render = (kiosk: boolean, core: Core = "with v2.css") => {
  declare(core);
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

/**
 * Core's global.css as a Core from before the v2 sheet built it: without the file that holds the v2 frame of visitor
 * pages and their v2 footer (`minimal-layout.css`, new with it). Built from a copy beside global.css, whose imports are
 * relative, and removed at once. Stricter than the real older sheet, which still had the plain `.minimal-layout` rule.
 */
const buildOlderGlobal = async () => {
  const styles = resolve(import.meta.dir, "../styles");
  const copy = join(styles, `.older-core-${process.pid}.css`);
  const source = readFileSync(join(styles, "global.css"), "utf8");
  if (!source.includes('@import "./minimal-layout.css";')) throw new Error("global.css no longer imports the visitor frame.");
  writeFileSync(copy, source.replace('@import "./minimal-layout.css";', ""));
  try {
    return await Bun.build({ entrypoints: [copy], plugins: [tailwind] });
  } finally {
    rmSync(copy, { force: true });
  }
};

let browser: Browser;
// The page loads Core's v2.css alone, as `MinimalLayout ui="v2"` links it (its body then is the v2 scope). Beside an
// older Core it keeps that Core's global.css and the v1 footer.
const sheets: Record<Core, { css: string; body: string }> = {
  "with v2.css": { css: "", body: "k2b-ui k2-ui" },
  older: { css: "", body: "k2b-ui" },
};
beforeAll(async () => {
  const v2 = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../styles/v2-page.css")] });
  const older = await buildOlderGlobal();
  for (const build of [v2, older]) if (!build.success) throw new AggregateError(build.logs, "Could not build the stylesheets.");
  sheets["with v2.css"].css = await v2.outputs[0]!.text();
  sheets.older.css = await older.outputs[0]!.text();
  if (sheets.older.css.includes("minimal-layout-main")) throw new Error("The older sheet still holds the v2 visitor frame.");
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  coreRoutes.mockRestore();
});

describe("MinimalLayout ui v2", () => {
  test("a page without ui keeps global.css, its v1 footer and its page options", () => {
    declare("with v2.css");
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
    // The appearance menu names the current choice, not what a press would switch to.
    expect(html).toMatch(/>(Automatic|Automatisch)</);
    expect(html).not.toMatch(/Switches to|Wechselt zu/);
    expect(html).toContain('<div class="k2-ui minimal-layout" data-ui="v2"');
    expect(html).toContain('<main class="minimal-layout-main"');
    expect(html).toContain('data-k2-part="Workspace"');
    for (const shell of ["rail-item", "cloud-app-canvas", "layout-header"]) expect(html).not.toContain(shell);
    expect(html).toContain("Imprint");
  });

  test("beside an older Core, whose global.css has no v2 footer, the page keeps the v1 footer and its content stays v2", () => {
    for (const kiosk of [false, true]) {
      const { html, page } = render(kiosk, "older");
      // The app's v2 inks, but no v2.css: such a Core does not serve it.
      expect(page).toEqual({ appUi: "v2" });
      expect(html).not.toContain('data-ui="v2"');
      expect(html).toMatch(/<main class="k2-ui minimal-layout-main" style="[^"]*flex/);
      expect(html).toContain('data-k2-part="Workspace"');
      if (kiosk) expect(html).not.toContain("<footer");
      else {
        expect(html).toMatch(/<div class="minimal-layout" style="[^"]*min-height/);
        expect(html).toContain('<footer class="minimal-layout-footer">');
        expect(html).toContain("Imprint");
      }
    }
  });

  for (const core of ["with v2.css", "older"] as const)
    for (const kiosk of [false, true])
      for (const width of [1440, 390])
        test(`Core ${core}: ${kiosk ? "kiosk" : "visitor page"} at ${width} px: clean, inside the window, the footer after it`, async () => {
          const tab = await browser.newPage({ viewport: { width, height: 900 } });
          try {
            await tab.setContent(
              `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sheets[core].css}</style></head>` +
                `<body class="${sheets[core].body}">${render(kiosk, core).html}</body></html>`,
            );
            await settled(tab);
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
            } else {
              expect(boxes.footer!.top).toBeGreaterThanOrEqual(boxes.main!.bottom - 0.5);
              // The content fills the window above the footer.
              expect(boxes.main!.height).toBeGreaterThan(400);
            }
          } finally {
            await tab.close();
          }
        }, 30_000);
});
