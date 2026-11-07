import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";
import { buildHarness } from "./image-intake/browser-harness";

setDefaultTimeout(30_000);
const script = await buildHarness(new URL("./image-processor.browser-harness.tsx", import.meta.url));
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/editor.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path === "/styles.css") return new Response(Bun.file(resolve(import.meta.dir, "../../../../ui/dist/styles.css")));
      if (path === "/photo.jpg")
        return new Response(Bun.file(resolve(import.meta.dir, "../../../../ui/src/inputs/image-editor/fixtures/photo.jpg")));
      if (path === "/sample.heic") return new Response(Bun.file(resolve(import.meta.dir, "image-intake/fixtures/sample-48x32.heic")));
      return new Response(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="k2b-ui" data-theme="light" style="margin:0"><main id="tools"></main><script src="/editor.js"></script></body></html>',
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
const open = async (query = "") => {
  const page = await browser.newPage();
  const errors = pageErrors(page);
  await page.goto(`${server.url}?${query}`);
  if (!query) await page.getByRole("button", { name: "Download", exact: true }).waitFor();
  else await page.getByText("Choose photos to edit", { exact: true }).waitFor();
  return { page, errors };
};
const dirty = (page: Page) => page.locator(".k2b-image-editor[data-dirty=true]").count();

describe("Tools public photo editor adoption", () => {
  test("archive opens unvisited editors, keeps names unique and clears dirty after the destination succeeds", async () => {
    const { page, errors } = await open();
    try {
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
      expect(await dirty(page)).toBe(1);
      await page.getByRole("button", { name: "Download all as ZIP", exact: true }).click();
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      const archive = await page.evaluate(
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
      await page.getByRole("button", { name: "Rotate right 90°", exact: true }).click();
      await page.evaluate("window.photoFixture.rejectArchive = true");
      await page.getByRole("button", { name: "Download all as ZIP", exact: true }).click();
      await page.getByText("The archive could not be created.", { exact: false }).last().waitFor();
      expect(await dirty(page)).toBe(1);
      expect(await page.locator(".k2b-image-editor").nth(1).isVisible()).toBe(true);
      await page.evaluate("window.photoFixture.rejectArchive = false");
      await page.getByRole("button", { name: "Download all as ZIP", exact: true }).click();
      await page.waitForFunction("window.photoFixture.downloads.length === 1");
      await page.waitForFunction(() => !document.querySelector(".k2b-image-editor[data-dirty=true]"));
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
      await page.getByRole("button", { name: "Download all as ZIP", exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".k2b-image-editor__save button")?.disabled);
      await page.getByRole("combobox", { name: "Photo", exact: true }).click();
      await page.getByRole("option", { name: "phone.heic", exact: true }).click();
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
