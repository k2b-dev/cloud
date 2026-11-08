import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../ui/test/browser";
import { buildTablerIconAssets } from "./tabler-assets";

let output: string | undefined;
let browser: Browser;
let css: Buffer;
let font: Buffer;

// Share process and asset setup; each viewport spends its budget on its own layout.
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "cloud-tabler-box-"));
  await buildTablerIconAssets(output);
  css = await readFile(join(output, "tabler-icons.css"));
  const fontUrl = css.toString().match(/url\((\/public\/fonts\/tabler-icons-[a-f0-9]{64}\.woff2)\)/)?.[1];
  expect(fontUrl).toBeDefined();
  font = await readFile(join(output, fontUrl!.slice("/public/".length)));
  browser = await launchBrowser();
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    if (output) await rm(output, { recursive: true, force: true });
  }
});

// Exercise the actual font CSS and WOFF2 that Core ships, with the font held back.
// Width and adjacent label position must be identical before and after glyphs arrive.
for (const [device, width] of [
  ["phone", 390],
  ["desktop", 1440],
] as const) {
  test(`late icon fonts preserve icon boxes and adjacent labels on ${device}`, async () => {
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
      await fontRequested;
      const geometry = () =>
        // settled: Measure reserved boxes while the real icon font is held, then after its load promise resolves.
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
      const before = await geometry();
      expect(before.filter((_, index) => index % 2 === 0).map((box) => box.width)).toEqual([24, 24, 24]);
      release();
      await page.evaluate(() => document.fonts.load('24px "tabler-icons"').then(() => undefined));
      expect(await fontStatus()).toEqual(["loaded"]);
      expect(await geometry()).toEqual(before);
    } finally {
      release();
      await page.close();
    }
  });
}
