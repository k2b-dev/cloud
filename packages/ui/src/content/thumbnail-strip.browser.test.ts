import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Scrolling, fades, and roving focus are real layout and focus behavior, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "thumbnail-strip.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Lightbox, ThumbnailStrip } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const tile = (hue) => "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='hsl(" + hue + " 70% 60%)'/></svg>");
const items = Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, name: "Photo " + (i + 1), thumbnail: tile(i * 30), dirty: i === 1 }));
const [current, setCurrent] = createSignal("p0");
window.selected = [];
window.added = 0;
window.setCurrent = setCurrent;
render(() => createComponent(ThumbnailStrip, {
  label: "Images", items, get currentItem() { return current(); },
  onSelectItem: (id) => { window.selected.push(id); setCurrent(id); },
  onAddItems: () => window.added++,
}), document.getElementById("strip"));
const images = (count) => Array.from({ length: count }, (_, i) => ({ src: tile(i * 40), alt: "Image " + (i + 1) }));
window.openLightbox = (count) => render(() => createComponent(Lightbox, { images: images(count), onClose: () => {} }), document.getElementById("lightbox"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the thumbnail strip fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style><style>#strip{width:300px;margin:16px;display:flex}</style></head>` +
      `<body class="k2b-ui"><div id="strip"></div><div id="lightbox"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-thumbnail-strip__thumb").first().waitFor();
  await settled(page);
  return page;
};
const fade = (page: Page) => page.locator("#strip ul").getAttribute("data-scroll-fade");
const focused = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute("title") ?? document.activeElement?.getAttribute("aria-label"));

describe("@k2b/ui ThumbnailStrip", () => {
  test("is 44 px high and fades only on the side where more images follow", async () => {
    const page = await load();
    try {
      expect(Math.round((await page.locator("#strip nav").boundingBox())!.height)).toBe(44);
      expect(await fade(page)).toBe("bottom");
      await page.locator("#strip ul").evaluate((list) => list.scrollTo({ left: 120, behavior: "instant" }));
      await settled(page);
      expect(await fade(page)).toBe("both");
      await page.locator("#strip ul").evaluate((list) => list.scrollTo({ left: list.scrollWidth, behavior: "instant" }));
      await settled(page);
      expect(await fade(page)).toBe("top");
    } finally {
      await page.close();
    }
  });

  test("the arrow keys, Home, and End move focus only; Enter shows an image; the + tile is in reach", async () => {
    const page = await load();
    try {
      // The current image is the one tab stop.
      expect(await page.locator('#strip [tabindex="0"]').count()).toBe(1);
      await page.locator('.k2b-thumbnail-strip__thumb[aria-current="true"]').focus();
      await page.keyboard.press("ArrowRight");
      expect(await focused(page)).toBe("Photo 2");
      expect(await page.evaluate(() => (window as unknown as { selected: string[] }).selected)).toEqual([]);
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as { selected: string[] }).selected)).toEqual(["p1"]);
      expect(await page.locator('.k2b-thumbnail-strip__thumb[aria-current="true"]').getAttribute("aria-label")).toBe(
        "Photo 2, current, unsaved changes",
      );
      await page.keyboard.press("End");
      expect(await focused(page)).toBe("Add images");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as { added: number }).added)).toBe(1);
      await page.keyboard.press("Home");
      expect(await focused(page)).toBe("Photo 1");
    } finally {
      await page.close();
    }
  });

  test("a new current image scrolls into view", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as { setCurrent: (id: string) => void }).setCurrent("p11"));
      await settled(page);
      const visible = await page.evaluate(() => {
        const list = document.querySelector("#strip ul")!.getBoundingClientRect();
        const current = document.querySelector('.k2b-thumbnail-strip__thumb[aria-current="true"]')!.getBoundingClientRect();
        return current.left >= list.left && current.right <= list.right;
      });
      expect(visible).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("a gallery shows dots up to three images and the strip from four, whose arrow keys do not switch the image", async () => {
    const page = await load();
    try {
      await page.evaluate(() => (window as unknown as { openLightbox: (count: number) => void }).openLightbox(3));
      await page.locator(".k2b-content-lightbox__dots").waitFor();
      expect(await page.locator(".k2b-content-lightbox .k2b-thumbnail-strip").count()).toBe(0);
      await page.evaluate(() => document.getElementById("lightbox")!.replaceChildren());
      await page.evaluate(() => (window as unknown as { openLightbox: (count: number) => void }).openLightbox(6));
      await page.locator(".k2b-content-lightbox .k2b-thumbnail-strip").waitFor();
      expect(await page.locator(".k2b-content-lightbox__dots").count()).toBe(0);
      await page.locator('.k2b-content-lightbox .k2b-thumbnail-strip__thumb[aria-current="true"]').focus();
      await page.keyboard.press("ArrowRight");
      // Focus moved in the strip; the shown image stayed the first.
      expect(await page.locator(".k2b-content-lightbox__counter").textContent()).toContain("1 / 6");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".k2b-content-lightbox__counter")?.textContent?.includes("2 / 6"));
    } finally {
      await page.close();
    }
  });
});
