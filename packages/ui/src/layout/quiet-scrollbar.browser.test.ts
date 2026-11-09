import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// Whether a scrollbar is painted, and whether its appearance moves content, is
// a question of real rendering, so a real engine draws the shipped stylesheet.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const backgrounds = { light: [255, 255, 255], dark: [24, 24, 27] } as const;
type Theme = keyof typeof backgrounds;

const page = (theme: Theme) => `<!doctype html>
<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}
body { margin: 0; }
.k2b-ui, .k2b-ui .scroller { background: rgb(${backgrounds[theme].join(" ")}); }
.k2b-ui { padding: 24px; }
</style></head>
<body><div class="k2b-ui">
  <div id="vertical" class="k2b-quiet-scrollbar scroller" style="width: 280px; height: 160px; overflow-y: auto">
    <div id="vertical-content" style="height: 600px"><button id="vertical-card" type="button">Card</button></div>
  </div>
  <div style="height: 24px"></div>
  <div id="horizontal" class="k2b-quiet-scrollbar scroller" style="width: 280px; height: 120px; overflow-x: auto; overflow-y: hidden">
    <div id="horizontal-content" style="width: 900px; height: 100%"><button id="horizontal-card" type="button">Card</button></div>
  </div>
  <div style="height: 24px"></div>
  <!-- An inset ScrollArea draws its fixed track through ::-webkit-scrollbar, in Chromium and WebKit alike. -->
  <div id="inset" class="k2b-scroll-area k2b-quiet-scrollbar scroller" data-inset="true" data-orientation="vertical" style="width: 280px; height: 160px">
    <div id="inset-content" style="height: 600px"><button id="inset-card" type="button">Card</button></div>
  </div>
  <div style="height: 24px"></div>
  <button id="outside" type="button">Outside</button>
</div></body></html>`;

type Axis = "vertical" | "horizontal" | "inset";
type Box = { left: number; right: number; top: number; bottom: number };

/** The scroll track of a classic scrollbar, or undefined where the engine draws an overlay scrollbar of no size. */
const trackOf = (target: Page, axis: Axis) =>
  target.evaluate((id) => {
    const element = document.getElementById(id)!;
    const rect = element.getBoundingClientRect();
    const size = id !== "horizontal" ? element.offsetWidth - element.clientWidth : element.offsetHeight - element.clientHeight;
    if (size <= 0) return undefined;
    return id !== "horizontal"
      ? { x: rect.right - size, y: rect.top, width: size, height: element.clientHeight }
      : { x: rect.left, y: rect.bottom - size, width: element.clientWidth, height: size };
  }, axis);

const contentBox = (target: Page, axis: Axis) =>
  target.evaluate((id): Box => {
    const { left, right, top, bottom } = document.getElementById(`${id}-content`)!.getBoundingClientRect();
    return { left, right, top, bottom };
  }, axis);

/** How far the most different pixel of the scroll track lies from the background, per colour channel. */
const trackInk = async (target: Page, track: { x: number; y: number; width: number; height: number }, theme: Theme) => {
  const png = (await target.screenshot({ clip: track })).toString("base64");
  return target.evaluate(
    async ([data, background]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let most = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        for (let channel = 0; channel < 3; channel++) most = Math.max(most, Math.abs(pixels[index + channel]! - background[channel]!));
      }
      return most;
    },
    [png, backgrounds[theme]] as const,
  );
};

const rest = async (target: Page) => {
  await target.mouse.move(2, 2);
  await target.focus("#outside");
};

describe(`k2b-quiet-scrollbar (${browserName})`, () => {
  let browser: Browser;

  beforeAll(async () => {
    // Headless Chromium hides classic scrollbars by default; this test needs them painted.
    browser = await launchBrowser({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  });

  afterAll(async () => {
    await browser?.close();
  });

  for (const theme of ["light", "dark"] as const) {
    for (const axis of ["vertical", "horizontal", "inset"] as const) {
      test(`${theme} ${axis}: hidden at rest, shown on hover and keyboard focus, content never moves`, async () => {
        const target = await browser.newPage({ viewport: { width: 800, height: 600 } });
        try {
          await target.setContent(page(theme));
          await rest(target);
          await settled(target);
          const track = await trackOf(target, axis);
          // Chromium paints a classic track here. An engine with overlay scrollbars takes no room and hides them
          // natively, so only the geometry applies there.
          expect(track !== undefined || (browserName === "webkit" && axis !== "inset")).toBe(true);
          const still = await contentBox(target, axis);
          const idle = track && (await trackInk(target, track, theme));

          const box = (await (await target.$(`#${axis}`))!.boundingBox())!;
          await target.mouse.move(box.x + 40, box.y + 40);
          await settled(target);
          expect(await contentBox(target, axis)).toEqual(still);
          const hovered = track && (await trackInk(target, track, theme));

          await rest(target);
          await settled(target);
          await target.focus(`#${axis}-card`);
          await settled(target);
          expect(await target.evaluate((id) => document.getElementById(id)!.matches(":focus-within"), axis)).toBe(true);
          expect(await contentBox(target, axis)).toEqual(still);
          const focused = track && (await trackInk(target, track, theme));

          await rest(target);
          await settled(target);
          expect(await contentBox(target, axis)).toEqual(still);
          if (!track) return;
          expect(idle).toBeLessThanOrEqual(2);
          expect(hovered).toBeGreaterThan(30);
          expect(focused).toBeGreaterThan(30);
        } finally {
          await target.close();
        }
      });
    }
  }

  test("forced colors keep the system scrollbar visible at rest", async () => {
    if (browserName !== "chromium") return;
    const target = await browser.newPage({ viewport: { width: 800, height: 600 } });
    try {
      await target.emulateMedia({ forcedColors: "active" });
      await target.setContent(page("light"));
      await rest(target);
      await settled(target);
      expect(await target.evaluate(() => getComputedStyle(document.getElementById("vertical")!).scrollbarColor)).toBe("auto");
      const track = await trackOf(target, "vertical");
      expect(track).toBeDefined();
      expect(await trackInk(target, track!, "light")).toBeGreaterThan(30);
    } finally {
      await target.close();
    }
  });
});
