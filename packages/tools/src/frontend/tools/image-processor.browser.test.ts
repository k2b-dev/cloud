import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { basename, resolve } from "node:path";
import { launchBrowser, pageErrors, settled } from "../../../../ui/test/browser";
import { buildHarness } from "./image-intake/browser-harness";

setDefaultTimeout(30_000);
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../../ui")))).default;
const script = await buildHarness(new URL("./image-processor.browser-harness.tsx", import.meta.url));
const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "image-processor.browser.css")], plugins: [tailwind] });
if (!styles.success) throw new AggregateError(styles.logs, "Could not build Tools photo editor styles");
const css = await styles.outputs[0]!.text();
const cssAssets = new Map(styles.outputs.slice(1).map((asset) => [basename(asset.path), asset]));
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const asset = cssAssets.get(basename(path));
      if (asset) return new Response(asset);
      if (path === "/editor.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/styles.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (path === "/photo.jpg")
        return new Response(Bun.file(resolve(import.meta.dir, "../../../../ui/src/inputs/image-editor/fixtures/photo.jpg")));
      if (path === "/sample.heic") return new Response(Bun.file(resolve(import.meta.dir, "image-intake/fixtures/sample-48x32.heic")));
      return new Response(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" data-theme="light" style="margin:0"><main id="tools" style="height:100dvh;display:flex;flex-direction:column"></main><script src="/editor.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});
const open = async (query = "", width = 1440, deferEditorResize = false) => {
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
  if (deferEditorResize) {
    await page.addInitScript(() => {
      const Native = ResizeObserver;
      const pending = new Map<ResizeObserver, () => void>();
      let hold = true;
      Object.assign(window, {
        deliverEditorResize: () => {
          hold = false;
          for (const deliver of pending.values()) deliver();
          pending.clear();
        },
      });
      window.ResizeObserver = class extends Native {
        constructor(callback: ResizeObserverCallback) {
          super((entries, observer) => {
            if (hold && entries.some(({ target }) => target.closest(".k2b-image-editor")))
              pending.set(observer, () => callback(entries, observer));
            else callback(entries, observer);
          });
        }
      };
    });
  }
  await page.goto(`${server.url}?${query}`);
  if (!query.includes("empty")) await page.getByRole("button", { name: "Download", exact: true }).waitFor();
  else await page.getByText("Choose photos to edit", { exact: true }).waitFor();
  return { page, errors };
};
const dirty = (page: Page) => page.locator(".k2b-image-editor[data-dirty=true]").count();
/** "Download all as ZIP" sits in the menu beside Download once there are several photos. */
const zip = async (page: Page) => {
  await page.getByRole("button", { name: "More download options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download all as ZIP", exact: true }).click();
};
const rotate = async (page: Page) => {
  await page.getByRole("tab", { name: "Crop", exact: true }).click();
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
};
const mirror = async (page: Page) => {
  await page.getByRole("tab", { name: "Crop", exact: true }).click();
  await page.getByRole("button", { name: "Mirror", exact: true }).click();
};
/** Photos are chosen in the editor's image strip; hidden editors keep their strips out of reach. */
const choose = (page: Page, name: RegExp, nth = 0) =>
  page.getByRole("navigation", { name: "Images" }).getByRole("button", { name }).nth(nth).click();
const shownCanvases = ".k2b-image-editor__image > canvas";

describe("Tools public photo editor adoption", () => {
  for (const width of [1440, 390]) {
    test(`the real Tools host shows crop, Auto and recoverable download at ${width}px`, async () => {
      const { page, errors } = await open("many=1", width);
      try {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>(".k2b-image-editor__image > canvas")?.width ?? 0) > 1);
        const shot = async (motif: string) => {
          if (width === 1440 && ["mark-up", "saving", "save-error", "recovered"].includes(motif)) {
            const body = page.locator(".k2b-image-editor__body");
            await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
            await settled(page);
            expect(
              await body.evaluate((element) => {
                const view = element.getBoundingClientRect();
                const rows = [...element.querySelectorAll(".k2b-image-editor__layer")];
                return (
                  rows.length === 3 &&
                  rows.every((row) => {
                    const box = row.getBoundingClientRect();
                    return box.top >= view.top && box.bottom <= view.bottom;
                  })
                );
              }),
            ).toBe(true);
          }
          await settled(page);
          if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/tools-host-${motif}-light-${width}.png` });
        };
        await page.getByRole("tab", { name: "Crop", exact: true }).click();
        expect(await page.locator(".k2b-image-editor__chips").getByRole("button", { name: "Close", exact: true }).isVisible()).toBe(true);
        await shot("crop");
        await page.getByRole("tab", { name: "Adjust", exact: true }).click();
        await page.getByRole("button", { name: "Auto", exact: true }).first().click();
        await page.waitForFunction(() => document.querySelector(".k2b-image-editor")?.getAttribute("data-dirty") === "true");
        if (width === 390) await page.locator(".k2b-image-editor__name").click();
        const strip = page.getByRole("navigation", { name: "Images", exact: true });
        const list = strip.locator("ul");
        expect(await strip.getByRole("button").count()).toBe(29);
        await page.waitForFunction(() => document.querySelector(".k2b-image-editor__strip ul")?.getAttribute("data-fade")?.includes("end"));
        await page.waitForFunction(() => document.querySelectorAll(".k2b-image-editor__strip img").length === 28);
        expect(await list.evaluate((node) => node.scrollLeft)).toBe(0);
        await shot("auto-many-images");
        await strip.getByRole("button").first().focus();
        await page.keyboard.press("End");
        await page.waitForFunction(() => {
          const list = document.querySelector(".k2b-image-editor__strip ul")!;
          const add = list.querySelector(".k2b-image-editor__thumb--add")!;
          return document.activeElement === add && add.getBoundingClientRect().right <= list.getBoundingClientRect().right;
        });
        await settled(page);
        expect(
          await strip.getByRole("button", { name: "Add photos", exact: true }).evaluate((node) => {
            const list = node.closest("ul")!;
            const button = node.getBoundingClientRect();
            const viewport = list.getBoundingClientRect();
            return document.activeElement === node && button.left >= viewport.left && button.right <= viewport.right;
          }),
        ).toBe(true);
        expect(await strip.getByRole("button", { name: "Add photos", exact: true }).locator(".ti-plus").isVisible()).toBe(true);
        await shot("strip-add");
        await page.keyboard.press("Home");
        if (width === 390) await page.locator(".k2b-image-editor__name").click();
        await page.getByRole("tab", { name: "Mark up", exact: true }).click();
        for (const [name, from, to] of [
          ["Rectangle", [0.5, 0.5], [0.7, 0.7]],
          ["Arrow", [0.55, 0.4], [0.75, 0.6]],
          [/^Redact/, [0.15, 0.2], [0.35, 0.35]],
        ] as const) {
          await page
            .getByRole("radiogroup", { name: "Tool", exact: true })
            .getByRole("radio", { name, exact: typeof name === "string" })
            .click();
          await settled(page);
          const image = (await page.locator(".k2b-image-editor__image").boundingBox())!;
          await page.mouse.move(image.x + image.width * from[0], image.y + image.height * from[1]);
          await page.mouse.down();
          await page.mouse.move(image.x + image.width * to[0], image.y + image.height * to[1], { steps: 6 });
          await page.mouse.up();
        }
        expect(await page.locator(".k2b-image-editor__layer").count()).toBe(3);
        await shot("mark-up");
        await page.evaluate(() => {
          const encode = HTMLCanvasElement.prototype.toBlob;
          HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
            if (this.width > 1000) {
              HTMLCanvasElement.prototype.toBlob = encode;
              Object.assign(window, { releasePhotoExport: () => encode.call(this, callback, type, quality) });
            } else encode.call(this, callback, type, quality);
          };
        });
        await page.evaluate("window.photoFixture.rejectDownload = true");
        await page.getByRole("button", { name: "Download", exact: true }).click();
        await page.locator('.k2b-image-editor[data-state="saving"]').waitFor();
        await shot("saving");
        await page.evaluate("window.releasePhotoExport()");
        await page.getByRole("alert").filter({ hasText: "Download destination unavailable" }).first().waitFor();
        await shot("save-error");
        expect(await dirty(page)).toBe(1);
        await page.evaluate("window.photoFixture.rejectDownload = false");
        await page.getByRole("button", { name: "Try again", exact: true }).first().click();
        await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
        await shot("recovered");
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }

  test("archive opens unvisited editors, keeps names unique and clears dirty after the destination succeeds", async () => {
    const { page, errors } = await open("", 390, true);
    try {
      // Decode may finish before the observer delivers the phone overlay sizes. A later delivery must refit
      // the image even when the canvas dimensions stay unchanged (the stale fit was only 40 px high).
      await settled(page);
      await page.evaluate("window.deliverEditorResize()");
      await settled(page);
      const image = await page.locator(".k2b-image-editor__image").boundingBox();
      expect(image!.height).toBeGreaterThanOrEqual(160);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // On a phone the main action shows only its icon and keeps its name; the photo name keeps its room.
      const download = page.getByRole("button", { name: "Download", exact: true });
      expect((await download.boundingBox())!.width).toBeLessThan(64);
      expect(await page.locator(".k2b-image-editor__chip-name").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await rotate(page);
      expect(await dirty(page)).toBe(1);
      await zip(page);
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      const archive = await page.evaluate<{ name: string; magic: number[]; text: string }>(
        `(async () => { const item=window.photoFixture.downloads[0]; const blob=await item.blob; const bytes=new Uint8Array(await blob.arrayBuffer()); return {name:item.filename,magic:[...bytes.slice(0,4)],text:new TextDecoder().decode(bytes)}; })()`,
      );
      expect(archive.name).toBe("photos.zip");
      expect(archive.magic).toEqual([80, 75, 3, 4]);
      expect(archive.text).toContain("photo.jpg");
      expect(archive.text).toContain("photo (2).jpg");
      // Decode the actual ZIP members: neither the strip thumbnail nor the fitted display sets export size.
      expect(await page.evaluate<{ name: string; width: number; height: number }[]>("window.photoFixture.archiveImages()")).toEqual([
        { name: "photo.jpg", width: 1067, height: 1600 },
        { name: "photo (2).jpg", width: 1600, height: 1067 },
      ]);
      await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
      expect(await page.locator(".k2b-image-editor").count()).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("a failed ZIP preserves edits and a fresh archive retry succeeds", async () => {
    const { page, errors } = await open();
    try {
      await rotate(page);
      await page.evaluate("window.photoFixture.rejectArchive = true");
      await zip(page);
      await page.getByText("The archive could not be created.", { exact: false }).last().waitFor();
      expect(await dirty(page)).toBe(1);
      expect(await page.locator(".k2b-image-editor").nth(1).isVisible()).toBe(true);
      await page.evaluate("window.photoFixture.rejectArchive = false");
      await zip(page);
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("a reduced per-photo retry cannot resume a failed ZIP and a fresh archive saves all entries", async () => {
    const { page, errors } = await open();
    try {
      await mirror(page);
      await choose(page, /^photo\.jpg/, 1);
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 2, shownCanvases);
      await mirror(page);
      await page.evaluate(() => {
        const encode = HTMLCanvasElement.prototype.toBlob;
        let exports = 0;
        HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
          if (this.width > 1 && ++exports === 2) {
            callback(null);
            return;
          }
          encode.call(this, callback, type, quality);
        };
      });
      await zip(page);
      await page
        .getByRole("button", { name: /Save again at .* MP/ })
        .first()
        .waitFor();
      expect(await dirty(page)).toBe(2);
      await page
        .getByRole("button", { name: /Save again at .* MP/ })
        .first()
        .click();
      await page.getByRole("alert").filter({ hasText: "Start Download all as ZIP again" }).first().waitFor();
      expect(await page.evaluate<number>("window.photoFixture.downloads.length")).toBe(0);
      expect(await dirty(page)).toBe(2);
      await zip(page);
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
      expect(await page.locator(".k2b-image-editor [role=alert]").count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("an unvisited photo load failure ends ZIP visibly and preserves earlier captured edits", async () => {
    const { page, errors } = await open("brokenSecond=1");
    try {
      await rotate(page);
      expect(await page.locator(".k2b-image-editor").count()).toBe(1);
      await zip(page);
      await page.getByText("This image cannot be opened", { exact: true }).waitFor();
      await page.getByText("The archive could not be created.", { exact: false }).last().waitFor();
      const close = page.getByRole("alert").getByRole("button", { name: "Close", exact: true });
      expect(await close.isVisible()).toBe(true);
      expect(await dirty(page)).toBe(1);
      expect(await page.evaluate<number>("window.photoFixture.downloads.length")).toBe(0);
      await close.click();
      expect(await page.locator(".k2b-image-editor").count()).toBe(1);
      expect(await dirty(page)).toBe(1);
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("multiple mounted editors retain bounded canvases and release them on removal and unmount", async () => {
    const page = await browser.newPage();
    const errors = pageErrors(page);
    try {
      await page.addInitScript(() => {
        const canvases: HTMLCanvasElement[] = [];
        const create = document.createElement.bind(document);
        document.createElement = ((...args: Parameters<typeof document.createElement>) => {
          const element = create(...args);
          if (element instanceof HTMLCanvasElement) canvases.push(element);
          return element;
        }) as typeof document.createElement;
        Object.assign(window, { retainedCanvases: canvases });
      });
      await page.goto(`${server.url}?large=1`);
      await page.getByText("3000 × 1500 px", { exact: true }).waitFor();
      await choose(page, /^photo\.jpg/, 1);
      await page.waitForFunction((selector) => document.querySelectorAll(selector).length === 2, shownCanvases);
      await page.waitForFunction(
        (selector) => [...document.querySelectorAll<HTMLCanvasElement>(selector)].every((c) => c.width > 1),
        shownCanvases,
      );
      const sizes = await page.evaluate<{ width: number; height: number }[]>(
        "window.retainedCanvases.filter(c=>c.width>0&&c.height>0).map(c=>({width:c.width,height:c.height}))",
      );
      expect(sizes.filter((c) => c.width === 2048 && c.height === 1024)).toHaveLength(2);
      expect(sizes.every((c) => Math.max(c.width, c.height) <= 2048)).toBe(true);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      expect(await page.locator(".k2b-image-editor").count()).toBe(1);
      expect(await page.evaluate<number>("window.retainedCanvases.filter(c=>c.width===2048&&c.height===1024).length")).toBe(1);
      await page.evaluate("window.photoFixture.dispose()");
      expect(await page.evaluate<boolean>("window.retainedCanvases.every(c=>c.width===0&&c.height===0)")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
  test("empty intake accepts pasted native and HEIF photos through the public editor", async () => {
    const { page, errors } = await open("empty=1");
    try {
      await page.evaluate(async () => {
        const data = new DataTransfer();
        data.items.add(new File([await (await fetch("/photo.jpg")).blob()], "native.jpg", { type: "image/jpeg" }));
        data.items.add(new File([await (await fetch("/sample.heic")).blob()], "phone.heic", { type: "image/heic" }));
        document
          .querySelector("#tools > div")!
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await page.getByRole("button", { name: "More download options", exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__actions button")?.disabled);
      await choose(page, /^phone\.heic/);
      await page.getByText("48 × 32 px", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Download", exact: true }).click();
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      expect(["phone.png", "phone.jpg"]).toContain(await page.evaluate("window.photoFixture.downloads[0].filename"));
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
