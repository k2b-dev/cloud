import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";

// The primary action takes the main colour of its app: blue by default, plum for an app whose appearance.primary is
// "ai" (the assistant never shows blue). The platform marks the page with `data-k2b-primary`; one token follows it.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** The fill and words of a primary button, and the contrast between them. */
const primary = async (theme: "light" | "dark", tone?: "ai", inner?: "blue") => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html lang="de"${theme === "dark" ? ' class="dark"' : ""}><head><style>${css}</style></head>` +
        `<body class="k2b-ui"${tone ? ` data-k2b-primary="${tone}"` : ""}><div class="k2-ui"${inner ? ` data-k2b-primary="${inner}"` : ""}><button class="k2-btn" data-k2-part="Button" data-variant="primary"><span class="k2-btn-label">Senden</span></button></div></body></html>`,
    );
    await settled(page);
    return await page.locator(".k2-btn").evaluate((button) => {
      const style = getComputedStyle(button);
      const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (color: string) => {
        const [r, g, b] = channels(color).map((value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const [a, b] = [luminance(style.backgroundColor), luminance(style.color)];
      return { fill: style.backgroundColor, words: style.color, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
  } finally {
    await page.close();
  }
};

for (const theme of ["light", "dark"] as const)
  test(`${theme}: an app with the assistant's main colour has a plum primary action, readable; others keep blue`, async () => {
    const ai = await primary(theme, "ai");
    expect(ai.fill).toBe("rgb(142, 27, 111)");
    expect(ai.words).toBe("rgb(255, 255, 255)");
    expect(ai.contrast).toBeGreaterThanOrEqual(4.5);
    // a part that keeps blue on purpose, inside such an app
    expect((await primary(theme, "ai", "blue")).fill).toBe("rgb(37, 99, 235)");
    const plain = await primary(theme);
    expect(plain.fill).toBe("rgb(37, 99, 235)");
    expect(plain.contrast).toBeGreaterThanOrEqual(4.5);
  });
