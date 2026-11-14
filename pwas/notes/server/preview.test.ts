import { expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPreview } from "./preview";

test.each(["bar", "line"])("%s standalone Notes preview rasterizes the UI blue instead of its old private palette", async (kind) => {
  const png = await renderPreview(
    `# Invented shares\n\n:::chart\ntype: ${kind}\ncolumns: [Team, Count]\nrows:\n  - [A, 12]\n  - [B, 20]\n:::\n`,
  );
  const context = createCanvas(1200, 630).getContext("2d");
  context.drawImage(await loadImage(png), 0, 0);
  const pixels = context.getImageData(666, 180, 470, 310).data;
  let uiBlue = 0;
  let oldPurple = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset] === 59 && pixels[offset + 1] === 130 && pixels[offset + 2] === 246) uiBlue++;
    if (pixels[offset] === 109 && pixels[offset + 1] === 40 && pixels[offset + 2] === 217) oldPurple++;
  }
  // A one-pixel diagonal is mostly antialiased; exact-color pixels still prove the renderer's palette.
  expect(uiBlue).toBeGreaterThan(0);
  expect(oldPurple).toBe(0);
});
