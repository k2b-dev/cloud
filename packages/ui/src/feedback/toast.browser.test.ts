import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium } from "playwright";

// The rail moves into the top layer again for every new toast. Only a real engine resets scroll offsets and drops
// focus when nodes move, which is what a custom slot with a list and a focused control must survive.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "toast.fixture.ts");
const fixture = `
import { toast } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const panel = document.createElement("section");
const list = document.createElement("div");
list.id = "list";
list.style.cssText = "height:120px;overflow:auto";
list.innerHTML = Array.from({ length: 30 }, (_, i) => '<div style="height:40px">Row ' + i + ' <button type="button">Retry ' + i + '</button></div>').join("");
panel.append(list);
window.slot = toast.custom(panel);
window.toast = toast;
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the toast fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a new toast keeps the scroll offset and the focus inside a custom slot", async () => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  try {
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"></body></html>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => {
      const list = document.getElementById("list")!;
      list.scrollTop = 200;
      list.querySelectorAll("button")[6]!.focus({ preventScroll: true });
    });
    const state = () =>
      page.evaluate(() => ({
        scrollTop: document.getElementById("list")!.scrollTop,
        focused: document.activeElement?.textContent,
        open: document.getElementById("list")!.closest("[data-k2b-toast-container]")!.matches(":popover-open"),
      }));
    expect(await state()).toEqual({ scrollTop: 200, focused: "Retry 6", open: true });
    await page.evaluate(() => (window as unknown as { toast: (text: string) => void }).toast("Link copied"));
    expect(await state()).toEqual({ scrollTop: 200, focused: "Retry 6", open: true });
  } finally {
    await page.context().close();
  }
});
