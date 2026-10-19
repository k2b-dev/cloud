import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { appHostCss } from "../../../ui/test/app-host-fixture";
import { launchBrowser } from "../../../ui/test/browser";

let browser: Browser;
let css: string;
beforeAll(async () => {
  css = await appHostCss(resolve(import.meta.dir, "app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

// Pins app chrome to Cloud's host, including a narrow app inside a wide window.
// The 952/792px cases fail with viewport queries; wide cases guard the column form.
test("Chat chrome beside a panel matches a window as wide as its host", async () => {
  for (const [windowWidth, host] of [
    [1440, 952],
    [1440, 792],
    [1680, 1192],
    [1680, 1032],
  ] as const) {
    const page = await browser.newPage({ viewport: { width: windowWidth, height: 900 }, reducedMotion: "reduce" });
    try {
      const markup = `<div style="width:100%"><button class="chat-conversation__back">Back</button><div class="chat-list-page">Chats</div><div class="chat-select">Select a chat</div></div>`;
      const content = (narrowed: boolean) =>
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;display:flex">${narrowed ? `<div style="container:k2b-app-area / inline-size;width:${host}px;flex:none">${markup}</div><aside style="flex:1">Panel</aside>` : markup}</body></html>`;
      const measure = () =>
        page.evaluate(() => {
          return [".chat-conversation__back", ".chat-list-page", ".chat-select"].map(
            (selector) => getComputedStyle(document.querySelector(selector)!).display,
          );
        });
      await page.setContent(content(true));
      const besidePanel = await measure();
      await page.setViewportSize({ width: host, height: 900 });
      await page.setContent(content(false));
      expect(besidePanel, `${windowWidth}px window / ${host}px host`).toEqual(await measure());
      expect(besidePanel).toEqual(host < 1024 ? ["flex", "flex", "none"] : ["none", "none", "flex"]);
    } finally {
      await page.close();
    }
  }
});
