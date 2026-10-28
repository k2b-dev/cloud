import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

// Initials are small text on a tinted face, so every tint keeps 4.5:1 in both themes. Contrast is a result of the
// shipped cascade, which only a real engine computes.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const TINTS = 8;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

describe("Avatar initials", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`keep 4.5:1 on every tint in ${theme}`, async () => {
      const page = await browser.newPage();
      try {
        const faces = Array.from({ length: TINTS }, (_, tint) => `<span class="k2b-avatar" data-tint="${tint}">AB</span>`).join("");
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}">${faces}<span class="k2b-avatar">AB</span></body></html>`,
        );
        const ratios = await page.evaluate(() => {
          // A canvas resolves every color syntax, including the color() that color-mix() computes to.
          const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
          const luminance = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), (value) => {
              const channel = value / 255;
              return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          return Array.from(document.querySelectorAll<HTMLElement>(".k2b-avatar"), (avatar) => {
            const style = getComputedStyle(avatar);
            const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
            return [avatar.dataset.tint ?? "none", (light! + 0.05) / (dark! + 0.05)] as const;
          });
        });
        expect(ratios).toHaveLength(TINTS + 1);
        for (const [tint, ratio] of ratios) expect(ratio, `tint ${tint}`).toBeGreaterThanOrEqual(4.5);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
