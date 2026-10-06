import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

// A dialog section group tints its content with the muted surface. Cloud's
// own text and card utilities sit inside it, so a real engine checks the
// compiled global stylesheet against that tint.
let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const measure = async (theme: "light" | "dark") => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui">` +
        `<i id="muted" style="background: var(--k2b-surface-muted)"></i><i id="surface" style="background: var(--ui-surface)"></i>` +
        `<div class="k2b-panel-dialog__section-body"><p class="text-dimmed">Counted per request.</p>` +
        `<div class="paper"><div class="k2b-input-shell" id="paper-well"></div></div></div>` +
        `</body></html>`,
    );
    return await page.evaluate(() => {
      const rgb = (color: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const luminance = (color: string) => {
        const [r, g, b] = rgb(color).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const contrast = (a: string, b: string) => {
        const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (light! + 0.05) / (dark! + 0.05);
      };
      const background = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
      const dimmed = getComputedStyle(document.querySelector(".text-dimmed")!).color;
      return {
        onGroup: contrast(dimmed, background(".k2b-panel-dialog__section-body")),
        onSurface: contrast(dimmed, background("#surface")),
        paperWell: background("#paper-well") === background("#muted") ? "muted" : background("#paper-well"),
      };
    });
  } finally {
    await page.close();
  }
};

for (const theme of ["light", "dark"] as const) {
  test(`dimmed text keeps WCAG AA on a section group and paper fields stay muted in ${theme}`, async () => {
    const result = await measure(theme);
    expect(result.onGroup).toBeGreaterThanOrEqual(4.5);
    expect(result.onSurface).toBeGreaterThanOrEqual(4.5);
    // A paper card inside the group paints its own surface, so its wells
    // return to the muted recess instead of vanishing into the card.
    expect(result.paperWell).toBe("muted");
  }, 30_000);
}
