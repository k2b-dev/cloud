import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appColorStyle } from "@k2b/cloud/ssr/app-color";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { buildFontAssets } from "../../../core/scripts/font-assets";
import { launchBrowser, settled } from "../../../ui/test/browser";

const root = mkdtempSync(join(tmpdir(), "gateway-range-tabs-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: RangeTabs } = await import("./RangeTabs");
const origin = "https://cloud.example.test";
const items = ["1h", "6h", "24h", "7d", "30d"].map((id) => ({ id, href: `?range=${id}` }));
const content = (current: string) =>
  renderToString(() =>
    createComponent(RangeTabs, {
      caption: "Traffic window",
      label: "Traffic window",
      current,
      items,
    }),
  );
let browser: Browser;
let css = "";
beforeAll(async () => {
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const builds = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of builds) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(builds.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  await buildFontAssets(join(root, "public"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (current: string) => {
  const page = await browser.newPage({
    // The page has no scripts of its own; settled() needs animation frames, which run only with JavaScript on.
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  await page.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
  await page.setContent(
    `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${origin}/public/fonts.css"><style>${css}</style></head><body class="k2b-ui"><div class="cloud-app-canvas" style="--app-accent:#155e75;${appColorStyle("#155e75")}"><div id="range-host">${content(current)}</div></div></body></html>`,
  );
  await settled(page);
  return page;
};

describe("Gateway Ops range selection", () => {
  test("uses the app navigation fill and ink instead of a solid action fill", async () => {
    const page = await open("24h");
    try {
      const colors = await page.locator('nav a[aria-current="page"]').evaluate((tab) => {
        // Resolve each variable in the tab's scope; CSS may store an alias or a color-mix expression.
        const probe = document.createElement("span");
        tab.append(probe);
        const resolve = (token: string) => {
          probe.style.backgroundColor = `var(${token})`;
          return getComputedStyle(probe).backgroundColor;
        };
        const actual = getComputedStyle(tab);
        const result = {
          background: actual.backgroundColor,
          color: actual.color,
          selected: resolve("--k2b-app-workspace-selected"),
          solid: resolve("--k2b-action-solid"),
          active: resolve("--k2b-app-workspace-active"),
        };
        probe.remove();
        return result;
      });
      expect(colors.selected).not.toBe("rgba(0, 0, 0, 0)");
      expect(colors.background).toBe(colors.selected);
      expect(colors.background).not.toBe(colors.solid);
      expect(colors.color).toBe(colors.active);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("switching the current range keeps row and tab geometry at desktop and phone widths", async () => {
    const page = await open("1h");
    try {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const layouts = [];
        for (const current of ["1h", "30d"]) {
          await page.locator("#range-host").evaluate((host, html) => {
            host.innerHTML = html;
          }, content(current));
          await settled(page);
          const layout = await page.evaluate(() => {
            const box = (element: Element) => {
              const rect = element.getBoundingClientRect();
              return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 2) / 2);
            };
            return {
              row: box(document.querySelector("#range-host > div")!),
              tabs: Array.from(document.querySelectorAll("nav a"), box),
              overflow: document.documentElement.scrollWidth - window.innerWidth,
            };
          });
          expect(layout.tabs).toHaveLength(5);
          if (width === 390) expect(layout.overflow).toBeLessThanOrEqual(0);
          layouts.push(layout);
        }
        expect(layouts[1]!.row).toEqual(layouts[0]!.row);
        expect(layouts[1]!.tabs).toEqual(layouts[0]!.tabs);
      }
    } finally {
      await page.close();
    }
  }, 30_000);
});
