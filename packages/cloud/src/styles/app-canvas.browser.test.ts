import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAppearanceStyle } from "../ssr/app-appearance";

// happy-dom drops the canvas gradient because it cannot resolve nested var()
// fallbacks, so only a real engine shows which background rule wins.
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

// Spaces' appearance, written onto the canvas as the shell does for its routes.
const canvasStyle = appAppearanceStyle({ accent: "#4d7c0f", background: { from: "#65a30d", to: "#84cc16", angle: 135 } });

const canvasBackground = async (theme: "light" | "dark", width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.setContent(
      `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body>` +
        `<div class="cloud-app-canvas" style="${canvasStyle}"><span style="color: var(--ui-surface)"></span></div></body></html>`,
    );
    return await page.evaluate(() => {
      const canvas = document.querySelector(".cloud-app-canvas")!;
      const { backgroundImage, backgroundColor } = getComputedStyle(canvas);
      if (backgroundImage.startsWith("linear-gradient(")) return "gradient";
      return backgroundImage === "none" && backgroundColor === getComputedStyle(canvas.firstElementChild!).color
        ? "surface"
        : backgroundColor;
    });
  } finally {
    await page.close();
  }
};

test("phones get the flat surface in both themes and the app gradient starts at lg", async () => {
  const widths = [390, 1023, 1024, 1440];
  const actual = [];
  for (const theme of ["light", "dark"] as const) {
    for (const width of widths) actual.push({ theme, width, background: await canvasBackground(theme, width) });
  }
  expect(actual).toEqual(
    (["light", "dark"] as const).flatMap((theme) =>
      widths.map((width) => ({ theme, width, background: width < 1024 ? "surface" : "gradient" })),
    ),
  );
}, 30_000);
