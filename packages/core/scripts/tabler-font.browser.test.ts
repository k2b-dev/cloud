import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../ui/test/browser";
import { buildTablerIconAssets } from "./tabler-assets";

// Exercise the actual font CSS and WOFF2 that Core ships, with the font held back.
// Width and adjacent label position must be identical before and after glyphs arrive.
test("late icon fonts preserve icon boxes and adjacent labels on phone and desktop", async () => {
  const output = await mkdtemp(join(tmpdir(), "cloud-tabler-box-"));
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    await buildTablerIconAssets(output);
    const css = await readFile(join(output, "tabler-icons.css"));
    const fontUrl = css.toString().match(/url\((\/public\/fonts\/tabler-icons-[a-f0-9]{64}\.woff2)\)/)?.[1];
    expect(fontUrl).toBeDefined();
    const font = await readFile(join(output, fontUrl!.slice("/public/".length)));
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let requested!: () => void;
      const fontRequested = new Promise<void>((resolve) => {
        requested = resolve;
      });
      await page.route("http://font-box.test/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith(".woff2")) {
          requested();
          await held;
          return route.fulfill({ contentType: "font/woff2", body: font });
        }
        if (path.endsWith(".css")) return route.fulfill({ contentType: "text/css", body: css });
        return route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/tabler.css"><style>body{font:16px/1.5 Arial}p{display:flex;align-items:center;gap:8px}.ti{font-size:24px}</style><p><i class="ti ti-home" aria-hidden="true"></i><span>Start</span></p><p><i class="ti ti-message" aria-hidden="true"></i><span>Chat</span></p><p><i class="ti ti-settings" aria-hidden="true"></i><span>Settings</span></p>`,
        });
      });
      try {
        await page.goto("http://font-box.test/", { waitUntil: "domcontentloaded" });
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            fontRequested,
            new Promise<never>((_, reject) => {
              deadline = setTimeout(() => reject(new Error("Tabler font was not requested")), 2000);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
        const geometry = () =>
          page.evaluate(() =>
            [...document.querySelectorAll("i, span")].map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
        const fontStatus = () =>
          page.evaluate(() => {
            const statuses: FontFaceLoadStatus[] = [];
            document.fonts.forEach((face) => {
              if (face.family === "tabler-icons") statuses.push(face.status);
            });
            return statuses;
          });
        expect(await fontStatus()).toEqual(["loading"]);
        // settled: This sample intentionally measures the reserved boxes while the real icon font is held back.
        const before = await geometry();
        expect(before.filter((_, index) => index % 2 === 0).map((box) => box.width)).toEqual([24, 24, 24]);
        release();
        await page.waitForFunction(
          () => {
            let loaded = false;
            document.fonts.forEach((face) => {
              if (face.family === "tabler-icons" && face.status === "loaded") loaded = true;
            });
            return loaded;
          },
          undefined,
          { timeout: 2000 },
        );
        expect(await fontStatus()).toEqual(["loaded"]);
        expect(await geometry()).toEqual(before);
      } finally {
        release();
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await rm(output, { recursive: true, force: true });
  }
});
