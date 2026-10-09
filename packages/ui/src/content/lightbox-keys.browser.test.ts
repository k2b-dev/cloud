import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Which dialog the browser cancels on Escape is the engine's top layer, which happy-dom does not model, so a real
// engine runs the shipped browser build with a dialog opened from a Lightbox action above the Lightbox.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "lightbox-keys.fixture.ts");
const fixture = `
import { createSignal, Show } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { Button, Lightbox, dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const image = (fill) =>
  "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'><rect width='40' height='30' fill='" + fill + "'/></svg>");
const rename = () =>
  void dialogCore.open((close) => {
    const body = document.createElement("div");
    body.innerHTML = "<h2>Rename photo</h2><input aria-label='Name' value='Beach'><button type='button'>Done</button>";
    body.querySelector("button").onclick = () => close();
    return body;
  });
const [open, setOpen] = createSignal(false);
window.lightboxClosed = 0;

render(
  () => [
    createComponent(Button, { size: "sm", variant: "secondary", onClick: () => setOpen(true), children: "View album" }),
    createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        return createComponent(Lightbox, {
          images: [
            { src: image("teal"), alt: "Beach", actions: [{ label: "Rename", icon: "ti ti-pencil", onClick: rename }] },
            { src: image("navy"), alt: "Dunes" },
          ],
          onClose: () => {
            window.lightboxClosed += 1;
            setOpen(false);
          },
        });
      },
    }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the Lightbox fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><main id="app"></main></body></html>`);
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "View album" }).click();
  await page.locator("dialog.k2b-content-lightbox[open]").waitFor();
  return page;
};

/** Waits two frames: dialogs move focus in a microtask or the next frame after the input that opens them. */
const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

const state = (page: Page) =>
  page.evaluate(() => ({
    counter: document.querySelector(".k2b-content-lightbox__counter")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
    lightbox: document.querySelector("dialog.k2b-content-lightbox[open]") !== null,
    above: Array.from(document.querySelectorAll("dialog[open]")).filter((dialog) => !dialog.matches(".k2b-content-lightbox")).length,
    closed: (window as unknown as { lightboxClosed: number }).lightboxClosed,
  }));

const openRename = async (page: Page) => {
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.matches("input[aria-label='Name']"));
};

describe("@k2b/ui Lightbox leaves its keys to a dialog opened above it", () => {
  test("Escape closes the dialog an image action opened, and arrows typed in it stay there", async () => {
    const page = await load();
    try {
      await openRename(page);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("ArrowRight");
      expect(await state(page)).toEqual({ counter: "1 / 2", lightbox: true, above: 1, closed: 0 });

      await page.keyboard.press("Escape");
      await settle(page);
      expect(await state(page)).toEqual({ counter: "1 / 2", lightbox: true, above: 0, closed: 0 });

      // With the dialog gone, the Lightbox has its keys again.
      await page.keyboard.press("ArrowRight");
      expect((await state(page)).counter).toBe("2 / 2");
      await page.keyboard.press("Escape");
      await settle(page);
      expect(await state(page)).toEqual({ counter: null, lightbox: false, above: 0, closed: 1 });
    } finally {
      await page.close();
    }
  });

  test("with focus nowhere, keys reach the Lightbox only while no dialog is open above it", async () => {
    const page = await load();
    const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    try {
      await blur();
      await page.keyboard.press("ArrowRight");
      expect((await state(page)).counter).toBe("2 / 2");
      await page.keyboard.press("ArrowLeft");

      await openRename(page);
      await blur();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape");
      await settle(page);
      expect(await state(page)).toEqual({ counter: "1 / 2", lightbox: true, above: 0, closed: 0 });
    } finally {
      await page.close();
    }
  });
});
