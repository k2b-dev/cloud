import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { appAccentStyle } from "@k2b/cloud/ssr/app-appearance";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../ui/test/browser";

let browser: Awaited<ReturnType<typeof launchBrowser>>;
let css: string;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

test("Tools catalog and header icons keep shared app ink, chip geometry and platform keyboard focus", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
      <body class="k2b-ui"><main class="app-accent-scope" style="${appAccentStyle("#475569")}">
        <span data-ink style="color:var(--ui-app-accent-text)"></span>
        <span data-focus style="box-shadow:var(--ui-focus)"></span>
        <div class="k2b-app-overview"><div class="k2b-app-overview__columns"><section class="k2b-app-overview__main">
          <a href="#" class="paper focus-ui group/quick flex min-w-0 items-center gap-3 p-3 transition-colors hover:paper-highlighted">
            <span class="tools-tool-icon k2b-icon-tile app-accent-text"><i class="ti ti-qrcode text-base"></i></span>
            <span class="min-w-0 flex-1"><span class="block truncate text-sm font-semibold text-primary">QR code</span></span>
          </a>
        </section></div></div>
        <div class="tools-main">
          <header class="tools-tool-header flex items-center gap-3">
            <div class="k2b-icon-tile app-accent-text h-10 w-10"><i class="ti ti-qrcode text-xl"></i></div>
            <div class="min-w-0"><h1 class="text-xl font-semibold text-primary">QR code</h1></div>
          </header>
        </div>
      </main></body></html>`);
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((theme) => {
        document.documentElement.className = theme;
        document.querySelector<HTMLElement>("a.group\\/quick")!.blur();
      }, theme);
      await settled(page);
      const results = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d", { willReadFrequently: true })!;
        const luminance = () => {
          const [r, g, b] = Array.from(paint.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
        };
        const ink = getComputedStyle(document.querySelector("[data-ink]")!).color;
        return Array.from(document.querySelectorAll(".tools-tool-icon, .tools-tool-header .k2b-icon-tile"), (tile) => {
          const style = getComputedStyle(tile);
          const color = getComputedStyle(tile.querySelector("i")!).color;
          const box = tile.getBoundingClientRect();
          paint.clearRect(0, 0, 1, 1);
          paint.fillStyle = style.backgroundColor;
          paint.fillRect(0, 0, 1, 1);
          const tileAlpha = paint.getImageData(0, 0, 1, 1).data[3];
          paint.clearRect(0, 0, 1, 1);
          // Composite the actual ancestor surfaces, including translucent Paper, over the page canvas.
          paint.fillStyle = getComputedStyle(document.body).getPropertyValue("--k2b-surface-canvas");
          paint.fillRect(0, 0, 1, 1);
          const ancestors: Element[] = [];
          for (let element: Element | null = tile; element; element = element.parentElement) {
            ancestors.push(element);
            if (element === document.body) break;
          }
          for (const element of ancestors.reverse()) {
            paint.fillStyle = getComputedStyle(element).backgroundColor;
            paint.fillRect(0, 0, 1, 1);
          }
          const background = luminance();
          const surfaceAlpha = paint.getImageData(0, 0, 1, 1).data[3];
          paint.fillStyle = color;
          paint.fillRect(0, 0, 1, 1);
          const foreground = luminance();
          const radius = style.borderTopLeftRadius;
          return {
            kind: tile.className,
            width: box.width,
            height: box.height,
            radius: Number.parseFloat(radius) * (radius.endsWith("%") ? box.width / 100 : 1),
            color,
            ink,
            tileAlpha,
            surfaceAlpha,
            shadow: style.boxShadow,
            ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
          };
        });
      });
      expect(results).toHaveLength(2);
      for (const [index, result] of results.entries()) {
        const label = `${theme}: ${result.kind}`;
        const size = [32, 40][index]!;
        expect(result.color, label).toBe(result.ink);
        expect(result.ratio, label).toBeGreaterThanOrEqual(3);
        expect(result.tileAlpha, label).toBeGreaterThan(0);
        expect(result.surfaceAlpha, label).toBe(255);
        expect(result.shadow, label).toBe("none");
        expect(result.width, label).toBe(size);
        expect(result.height, label).toBe(size);
        expect(result.radius, label).toBeCloseTo(size * 0.28, 2);
      }
      // Establish keyboard modality before programmatic focus, including on the second theme pass.
      await page.keyboard.press("Tab");
      await page.locator("a.group\\/quick").focus();
      await settled(page);
      const focus = await page.locator("a.group\\/quick").evaluate((link) => {
        const style = getComputedStyle(link);
        return {
          visible: link.matches(":focus-visible"),
          shadow: style.boxShadow,
          platform: getComputedStyle(document.querySelector("[data-focus]")!).boxShadow,
          outlineStyle: style.outlineStyle,
          outlineColor: style.outlineColor,
        };
      });
      expect(focus.visible, theme).toBe(true);
      expect(focus.platform, theme).not.toBe("none");
      expect(focus.shadow, theme).toBe(focus.platform);
      expect(focus.outlineStyle, theme).toBe("none");
      expect(focus.outlineColor, theme).not.toBe("rgb(71, 85, 105)");
    }
  } finally {
    await context.close();
  }
}, 30_000);
