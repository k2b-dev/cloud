import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// happy-dom has no layout engine. Exercise the actual viewport and scroller
// geometry in both supported browser engines instead of mocking rectangles.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "toc.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import { TableOfContents } from ${JSON.stringify(resolve(import.meta.dir, "../../dist/browser/index.js"))};
const scroller = document.getElementById("scroller");
const container = document.body.dataset.mode === "container";
const changes = [];
const listeners = [];
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function(type, listener, options) {
  if ((type === "scroll" && (this === scroller || this === window)) || (type === "resize" && this === window)) listeners.push({ target: this, type, listener });
  return add.call(this, type, listener, options);
};
EventTarget.prototype.removeEventListener = function(type, listener, options) {
  const index = listeners.findIndex(entry => entry.target === this && entry.type === type && entry.listener === listener);
  if (index >= 0) listeners.splice(index, 1);
  return remove.call(this, type, listener, options);
};
const [root, setRoot] = createSignal(container ? scroller : undefined);
// A store keeps its array: only reading the ids tells the spy that they changed.
const [items, setItems] = createStore([{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }]);
const dispose = render(() => createComponent(TableOfContents, {
  get items() { return items; }, scrollRoot: root, sticky: true,
  onActiveChange(id) { changes.push(id); document.body.dataset.changes = JSON.stringify(changes); },
}), document.getElementById("nav"));
document.getElementById("dispose").onclick = () => {
  dispose(); document.body.dataset.listeners = String(listeners.length);
  EventTarget.prototype.addEventListener = add;
  EventTarget.prototype.removeEventListener = remove;
};
document.getElementById("switch").onclick = () => setRoot(undefined);
document.getElementById("items").onclick = () => setItems([{ id: "one", label: "First" }]);
document.body.dataset.ready = "true";
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle TableOfContents fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
});
afterAll(async () => {
  await page?.close();
  await browser?.close();
});
const load = async (mode: "container" | "window") => {
  const height = mode === "container" ? 300 : 800;
  await page.setContent(
    `<style>${css} body{margin:0} h2{margin:0;height:24px} #nav{position:fixed;left:700px;top:0} #controls{position:fixed;left:700px;top:200px}</style><body class="k2b-ui" data-mode="${mode}" data-changes="[]"><div id="nav"></div><div id="controls"><button id="dispose">Dispose</button><button id="switch">Window</button><button id="items">Items</button></div><div id="scroller" style="${mode === "container" ? "height:240px;overflow:auto;" : ""}"><section style="height:${height}px"><h2 id="one">One</h2></section><section style="height:${height}px"><h2 id="two">Two</h2></section><section style="height:100px"><h2 id="three">Three</h2></section></div></body>`,
  );
  await page.addScriptTag({ content: script });
  await page.waitForSelector('body[data-ready="true"]');
};
const current = () => page.locator('.k2b-toc__link[aria-current="location"]').getAttribute("href");
const settle = () =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

for (const mode of ["container", "window"] as const)
  test(`${mode} scroll spy, end rule, notifications and cleanup`, async () => {
    await load(mode);
    expect(await current()).toBe("#one");
    const initialBox = await page.locator(".k2b-toc").boundingBox();
    await page.evaluate((mode) => {
      if (mode === "container") document.getElementById("scroller")!.scrollTop = 250;
      else window.scrollTo(0, 660);
    }, mode);
    await settle();
    expect(await current()).toBe("#two");
    expect(await page.locator("body").getAttribute("data-changes")).toBe('["two"]');
    await page.evaluate((mode) => {
      const target = mode === "container" ? document.getElementById("scroller")! : window;
      target.dispatchEvent(new Event("scroll"));
      target.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    }, mode);
    await settle();
    expect(await page.locator("body").getAttribute("data-changes")).toBe('["two"]');
    await page.evaluate((mode) => {
      if (mode === "container") document.getElementById("scroller")!.scrollTop = 10000;
      else window.scrollTo(0, 10000);
    }, mode);
    await settle();
    // The last heading is below the quarter line here, but visible at the end.
    expect(await current()).toBe("#three");
    expect(await page.locator("body").getAttribute("data-changes")).toBe('["two","three"]');
    expect(await page.locator(".k2b-toc").boundingBox()).toEqual(initialBox);
    await page.click("#dispose");
    expect(await page.locator("body").getAttribute("data-listeners")).toBe("0");
    await page.evaluate(() => {
      window.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(await page.locator("body").getAttribute("data-changes")).toBe('["two","three"]');
  });

test("native anchors, changed items and changed scroll roots", async () => {
  await load("container");
  await page.locator('a[href="#two"]').click();
  await settle();
  expect(await current()).toBe("#two");
  expect(await page.evaluate(() => location.hash)).toBe("#two");
  await page.click("#switch");
  await settle();
  expect(await current()).toBe("#three");
  await page.click("#items");
  await settle();
  expect(await current()).toBe("#one");
  expect(await page.locator(".k2b-toc__link").textContent()).toBe("First");
  await page.click("#dispose");
  expect(await page.locator("body").getAttribute("data-listeners")).toBe("0");
});
