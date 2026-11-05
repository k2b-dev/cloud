import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Overlapping faces sit in rows that change colour on hover and selection, often in a cell that clips. The gap
// between two faces must show whatever lies behind them, and nothing may paint outside a face: a ring in a fixed
// surface colour showed as a white ring on a hovered Mail row and was cut square by the cell. Paint is a result of
// the shipped cascade, which only a real engine computes.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
// A colour no face uses, so every pixel that is not a face reads as exactly this.
const behind = [0, 255, 0] as const;

const faces = (count: number) =>
  Array.from({ length: count }, (_, tint) => `<span class="k2b-avatar" data-size="xs" data-tint="${tint}">AB</span>`).join("");
const GROUPS = {
  "AvatarFaces sm": `<span class="k2b-avatar-stack__faces">${faces(3)}</span>`,
  "AvatarFaces md": `<span class="k2b-avatar-stack__faces" data-faces-size="md">${faces(3)}</span>`,
  "AvatarFaces sm, right to left": `<span class="k2b-avatar-stack__faces" dir="rtl">${faces(3)}</span>`,
  DetailPresenceSlot: `<span class="k2b-detail-presence-slot">${faces(2)}</span>`,
  "ChatPreview faces": `<span class="k2b-chat-preview__faces">${faces(3)}</span>`,
};

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The host's pixels as RGB triples, row by row, and the faces' boxes relative to the host. */
const paint = async (page: Page, host: string) => {
  const clip = (await page.locator(host).boundingBox())!;
  const png = await page.screenshot({ clip });
  const pixels = await page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    return { width: image.width, data: Array.from(context.getImageData(0, 0, image.width, image.height).data) };
  }, `data:image/png;base64,${png.toString("base64")}`);
  const boxes = await page.locator(`${host} .k2b-avatar`).evaluateAll((elements, origin) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left - origin.x, right: box.right - origin.x, cx: box.left - origin.x + box.width / 2, cy: box.top - origin.y + box.height / 2, r: box.width / 2 };
    }),
  clip);
  const at = (x: number, y: number) => {
    const index = (Math.floor(y) * pixels.width + Math.floor(x)) * 4;
    return [pixels.data[index]!, pixels.data[index + 1]!, pixels.data[index + 2]!];
  };
  return { width: pixels.width, height: pixels.data.length / 4 / pixels.width, boxes, at };
};

const isBehind = (rgb: number[]) => rgb.every((channel, index) => Math.abs(channel - behind[index]!) <= 8);

describe("Overlapping faces", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`show the background in the gap and paint nothing outside a face, even in a clipping cell, in ${theme}`, async () => {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      try {
        const hosts = Object.values(GROUPS)
          .map(
            (group, index) =>
              // A row cell as tall as the faces that clips, in a colour no surface token has.
              `<div id="host-${index}" style="display:flex;align-items:center;width:max-content;padding:0 4px;overflow:hidden;background:rgb(${behind})">${group}</div>`,
          )
          .join("");
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}" style="margin:8px">${hosts}</body></html>`,
        );
        for (const [index, name] of Object.keys(GROUPS).entries()) {
          const { width, height, boxes, at } = await paint(page, `#host-${index}`);
          expect(boxes.length, name).toBeGreaterThan(1);
          const rtl = name.includes("right to left");
          for (let face = 0; face < boxes.length - 1; face++) {
            const next = boxes[face + 1]!;
            // The pixel just outside the next face, still inside the face it covers, is the gap.
            const x = rtl ? next.right + 0.5 : next.left - 0.5;
            expect(isBehind(at(x, next.cy)), `${name}: gap before face ${face + 1}`).toBe(true);
            // The covered face still paints its own visible part.
            const own = boxes[face]!;
            expect(isBehind(at(rtl ? own.right - 3 : own.left + 3, own.cy)), `${name}: face ${face}`).toBe(false);
          }
          // Outside every face, give or take a pixel of anti-aliasing, the background shows unchanged.
          const outside: string[] = [];
          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const near = boxes.some((box) => Math.hypot(x + 0.5 - box.cx, y + 0.5 - box.cy) <= box.r + 1);
              if (!near && !isBehind(at(x, y))) outside.push(`${x},${y}`);
            }
          }
          expect(outside, `${name}: paint outside the faces`).toEqual([]);
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});
