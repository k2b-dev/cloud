import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderSafeMarkdown } from "@k2b/ui";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const types = ["note", "info", "success", "warning", "danger"] as const;
const html = renderSafeMarkdown(types.map((type) => `:::${type} ${type} title\nBody text.\n:::`).join("\n\n"));
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
});
afterAll(async () => {
  await page?.close();
  await browser?.close();
});

// As in date-picker-today.browser.test.ts, resolve CSS colours through a canvas
// and composite transparent backgrounds over the first opaque ancestor.
const contrast = (callout: Locator) =>
  callout.evaluate((element) => {
    const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!canvas) throw new Error("No 2D canvas to resolve colours.");
    const rgba = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = canvas.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = ([r = 0, g = 0, b = 0, a = 0]: number[], below: number[]) =>
      [r, g, b].map((channel, index) => channel * a + (below[index] ?? 0) * (1 - a));
    const layers: number[][] = [];
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      layers.unshift(rgba(getComputedStyle(ancestor).backgroundColor));
      if (layers[0]?.[3] === 1) break;
    }
    const surface = layers.reduce((below, layer) => over(layer, below), [255, 255, 255]);
    const luminance = (rgb: number[]) => {
      const [r = 0, g = 0, b = 0] = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (selector: string) => {
      const child = element.querySelector(selector);
      if (!child) throw new Error(`Missing callout ${selector}.`);
      const [light = 0, dark = 0] = [luminance(over(rgba(getComputedStyle(child).color), surface)), luminance(surface)].sort(
        (a, b) => b - a,
      );
      return (light + 0.05) / (dark + 0.05);
    };
    return { title: ratio(".k2b-notice-card__title"), icon: ratio(".k2b-callout__icon") };
  });

describe("Markdown callout contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`titles and icons keep WCAG contrast on the effective callout background (${theme})`, async () => {
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="background:var(--k2b-surface)">${html}</body></html>`,
      );
      for (const type of types) {
        const tone = type === "note" ? "neutral" : type;
        const callout = page.locator(`.k2b-callout[data-tone="${tone}"]`);
        expect(await callout.locator('svg.k2b-callout__icon[aria-hidden="true"]').count()).toBe(1);
        const ratios = await contrast(callout);
        expect(ratios.title, `${theme} ${type} title`).toBeGreaterThanOrEqual(4.5);
        expect(ratios.icon, `${theme} ${type} icon`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
