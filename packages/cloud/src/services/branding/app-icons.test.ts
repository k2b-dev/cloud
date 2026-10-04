import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as canvasWorker from "../../_internal/canvas-worker";
import { PWA_CANVAS_COLORS } from "../../contracts/pwa";
import * as settings from "../settings";
import { readAppIconSource } from "./app-icon-source";
import { APP_ICON_RETRY_SECONDS, APP_ICON_VARIANTS, type AppIconVariant, createAppIcons } from "./app-icons";

let logo = "";
const settingsSpy = spyOn(settings, "get").mockImplementation((async (key: string) => (key === "app.logo" ? logo : undefined)) as never);
const spawnSpy = spyOn(canvasWorker, "spawnCanvasWorker");
afterAll(() => {
  settingsSpy.mockRestore();
  spawnSpy.mockRestore();
});
beforeEach(() => {
  logo = "";
  spawnSpy.mockClear();
});

/** An invented square logo: a solid red disc on transparency. */
const pngLogo = (() => {
  const canvas = createCanvas(64, 64);
  const context = canvas.getContext("2d");
  context.fillStyle = "#e11d48";
  context.beginPath();
  context.arc(32, 32, 32, 0, Math.PI * 2);
  context.fill();
  return `data:image/png;base64,${Buffer.from(canvas.toBuffer("image/png")).toString("base64")}`;
})();
/** An invented wide SVG logo without a size, which must scale rather than crop. */
const svgLogo = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#0d9488"/></svg>').toString("base64")}`;

const pixels = async (png: Uint8Array) => {
  const image = await loadImage(Buffer.from(png));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number) => [...data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)],
  };
};
const rgba = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).concat(255);

const runtime = process.platform === "linux" ? describe : describe.skip;

test("decodes an unchanged logo once, and a new logo on its next read", async () => {
  logo = pngLogo;
  const first = await readAppIconSource();
  expect(await readAppIconSource()).toBe(first);
  logo = svgLogo;
  const second = await readAppIconSource();
  expect(second).not.toBe(first);
  expect(second.mime).toBe("image/svg+xml");
});

runtime("app icons", () => {
  test("draws every variant at its size, transparent for any and opaque on the light canvas for maskable and Apple", async () => {
    logo = pngLogo;
    const icons = createAppIcons();
    for (const [variant, spec] of Object.entries(APP_ICON_VARIANTS) as [AppIconVariant, (typeof APP_ICON_VARIANTS)[AppIconVariant]][]) {
      const icon = await icons.render(variant);
      const image = await pixels(icon.png);
      expect([variant, image.width, image.height]).toEqual([variant, spec.size, spec.size]);
      expect([variant, image.at(0, 0)]).toEqual([variant, spec.background ? rgba(PWA_CANVAS_COLORS.light) : [0, 0, 0, 0]]);
      // The logo is drawn in the centre.
      expect([variant, image.at(spec.size / 2, spec.size / 2)]).toEqual([variant, rgba("#e11d48")]);
    }
    // One isolated run draws all four.
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("keeps the maskable logo inside the safe circle", async () => {
    logo = svgLogo;
    const image = await pixels((await createAppIcons().render("pwa-icon-maskable-512")).png);
    const background = rgba(PWA_CANVAS_COLORS.light).join();
    let outside = 0;
    let inked = 0;
    for (let y = 0; y < 512; y += 2)
      for (let x = 0; x < 512; x += 2) {
        if (image.at(x, y).join() === background) continue;
        inked += 1;
        if (Math.hypot(x - 256, y - 256) > 0.4 * 512) outside += 1;
      }
    expect(inked).toBeGreaterThan(1000);
    expect(outside).toBe(0);
    // A wide logo keeps its aspect: full width of the box, half its height.
    expect(image.at(256 - 140, 256).join()).toBe(rgba("#0d9488").join());
    expect(image.at(256, 256 - 100).join()).toBe(background);
  }, 30_000);

  test("versions the icons by the logo and shares one run between concurrent requests", async () => {
    const icons = createAppIcons();
    logo = pngLogo;
    const first = await icons.version();
    const [a, b] = await Promise.all([icons.render("pwa-icon-192"), icons.render("apple-touch-icon")]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect([a.etag, b.etag]).toEqual([`"${first}"`, `"${first}"`]);
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    logo = svgLogo;
    const second = await icons.version();
    expect(second).not.toBe(first);
    expect((await icons.render("pwa-icon-192")).etag).toBe(`"${second}"`);
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  }, 30_000);

  test("keeps a failed run for the retry window, so failing requests do not start a worker each", async () => {
    logo = pngLogo;
    const icons = createAppIcons();
    spawnSpy.mockImplementationOnce(() => {
      throw new Error("The worker could not start.");
    });
    await expect(icons.render("pwa-icon-192")).rejects.toThrow();
    await expect(icons.render("pwa-icon-512")).rejects.toThrow();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + APP_ICON_RETRY_SECONDS * 1000);
    try {
      expect((await icons.render("pwa-icon-192")).png.byteLength).toBeGreaterThan(0);
      expect(spawnSpy).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  }, 30_000);

  test("falls back to the Cloud logo when the logo cannot be decoded or is not an uploaded image", async () => {
    logo = "data:image/png;base64,bm90IGFuIGltYWdl";
    const broken = await pixels((await createAppIcons().render("apple-touch-icon")).png);
    logo = "https://logo.example.test/logo.png";
    const linked = await pixels((await createAppIcons().render("apple-touch-icon")).png);
    // The Cloud logo is a blue cloud.
    for (const image of [broken, linked]) {
      const [red, green, blue] = image.at(90, 100);
      expect(blue).toBeGreaterThan(red! + 40);
      expect(blue).toBeGreaterThan(green!);
    }
    expect(await createAppIcons().version()).toBe(await createAppIcons().version());
  }, 30_000);
});
