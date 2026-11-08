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
const open = async (query = "", width = 1440) => {
  const page = await browser.newPage({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
  const errors = pageErrors(page);
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
  test("archive opens unvisited editors, keeps names unique and clears dirty after the destination succeeds", async () => {
    const { page, errors } = await open("", 390);
    try {
      await settled(page);
      const image = await page.locator(".k2b-image-editor__image").boundingBox();
      expect(image!.height).toBeGreaterThanOrEqual(160);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
      await page.getByRole("button", { name: /Save again at .* MP/ }).first().waitFor();
      expect(await dirty(page)).toBe(2);
      await page.getByRole("button", { name: /Save again at .* MP/ }).first().click();
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
      expect(await page.getByRole("button", { name: "Close", exact: true }).isVisible()).toBe(true);
      expect(await dirty(page)).toBe(1);
      expect(await page.evaluate<number>("window.photoFixture.downloads.length")).toBe(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
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
