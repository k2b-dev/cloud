import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { demoBundle, serverMarkup } from "../../test/v2-behavior/harness";
import type {} from "../../test/v2-tabs-device.demo";

// Notebooks #4245: a view whose default depends on the device (the list on the phone, the graph on the desktop) had
// no open tab until the browser knew its width, and then one switched on: a flash on every load. A tab with
// `current: "phone"` or `"desktop"` is the open one on that device only, painted so by the stylesheet from the first
// frame of the server's markup; the mount moves and repaints nothing and only tells assistive technology.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let bundle: string;
let markup: string;
beforeAll(async () => {
  [bundle, markup, browser] = await Promise.all([demoBundle("../v2-tabs-device"), serverMarkup("../v2-tabs-device"), launchBrowser()]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** Each display tab: its box, its look, whether it looks open (as the plain open tab "Offen" does), and its state. */
const tabs = (page: Page) =>
  page.evaluate(() => {
    const look = (element: Element) => {
      const style = getComputedStyle(element);
      return `${style.color} ${style.borderBottomColor} ${style.fontWeight}`;
    };
    const open = look([...document.querySelectorAll(".k2-tab")].find((tab) => tab.textContent?.trim() === "Offen")!);
    return [...document.querySelectorAll("[aria-label='Darstellung'] .k2-tab")].map((tab) => {
      const box = tab.getBoundingClientRect();
      return {
        name: tab.textContent?.trim(),
        box: [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10) / 10).join(","),
        look: look(tab),
        open: look(tab) === open,
        current: tab.getAttribute("aria-current"),
      };
    });
  });

for (const [width, height, device, shown] of [
  [390, 844, "phone", "Liste"],
  [1440, 900, "desktop", "Graph"],
] as const)
  test(`at ${width} px the ${device}'s default tab is open from the server's first paint, and the mount moves nothing`, async () => {
    const page = await browser.newPage({ viewport: { width, height } });
    page.setDefaultTimeout(2000);
    const errors = pageErrors(page);
    try {
      await page.setContent(
        `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${markup}</div></body></html>`,
      );
      await page.addScriptTag({
        content: `window.__shifts = 0; try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__shifts += entry.value; }).observe({ type: "layout-shift", buffered: true }); } catch {}`,
      });
      await settled(page);
      const served = await tabs(page);
      // the server's markup names no device's tab as the page shown (it cannot know the width), the stylesheet paints it
      expect(served.map((tab) => [tab.name, tab.open, tab.current])).toEqual(
        ["Graph", "Liste", "Tabelle"].map((name) => [name, name === shown, null]),
      );
      const before = await page.screenshot();
      await page.addScriptTag({ content: bundle });
      await page.waitForFunction(() => window.__mounted === true);
      await settled(page);
      const live = await tabs(page);
      expect(live.map(({ box, look, open }) => ({ box, look, open }))).toEqual(served.map(({ box, look, open }) => ({ box, look, open })));
      expect(live.map((tab) => tab.current)).toEqual(["Graph", "Liste", "Tabelle"].map((name) => (name === shown ? "page" : null)));
      expect(Buffer.compare(before, await page.screenshot())).toBe(0);
      if (browserName === "chromium") expect(await page.evaluate(() => window.__shifts)).toBe(0);
      // Review of #4251: across 768 px after the mount, the open tab and what assistive technology hears follow the width
      const other = device === "phone" ? "Graph" : "Liste";
      await page.setViewportSize(device === "phone" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
      await settled(page);
      expect((await tabs(page)).map((tab) => [tab.name, tab.open, tab.current])).toEqual(
        ["Graph", "Liste", "Tabelle"].map((name) => [name, name === other, name === other ? "page" : null]),
      );
      await page.setViewportSize({ width, height });
      await settled(page);
      expect((await tabs(page)).map((tab) => [tab.name, tab.open, tab.current])).toEqual(
        ["Graph", "Liste", "Tabelle"].map((name) => [name, name === shown, name === shown ? "page" : null]),
      );
      // a person's choice wins on every device
      await page.evaluate(() => window.__pick?.("table"));
      await settled(page);
      expect((await tabs(page)).map((tab) => [tab.open, tab.current])).toEqual([
        [false, null],
        [false, null],
        [true, "page"],
      ]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });

test("the server's markup names each tab's device and marks no device's tab as the page shown", () => {
  expect(markup).toMatch(/data-current-on="desktop"[^>]*>(?:(?!<\/button>).)*Graph/);
  expect(markup).toMatch(/data-current-on="phone"[^>]*>(?:(?!<\/button>).)*Liste/);
  expect(markup.match(/aria-current="page"/g)?.length).toBe(1);
});
