import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";

// Happy DOM has no native modal: a real engine checks that disposal releases inertness, focus and scroll lock.
const ui = resolve(import.meta.dir, "../..");
const entry = resolve(import.meta.dir, "dialog-island-dispose.fixture.ts");
const fixture = `
import { dialogCore } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.results = [];
document.querySelector("#open").addEventListener("click", () => {
  void dialogCore.open(() => {
    const field = document.createElement("input");
    field.setAttribute("aria-label", "Name");
    return field;
  }, { history: true }).then((value) => window.results.push(value === undefined ? "undefined" : "value"));
});
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dialog island fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test(`an open dialog closes when an island is disposed and leaves history alone (${browserName})`, async () => {
  const page = await browser.newPage();
  try {
    // A real http document: WebKit keeps no same-URL history entries for about:blank.
    await page.route("http://island.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html><body class="k2b-ui"><input id="elsewhere" aria-label="Elsewhere">` +
          `<solid-island data-id="a"><button id="open" type="button">Open</button></solid-island></body></html>`,
      }),
    );
    await page.goto("http://island.test/");
    await page.addScriptTag({ content: script });
    // Focus sits outside the island, as WebKit leaves it after a click on a button; the dialog closes anyway.
    await page.focus("#elsewhere");
    const length = await page.evaluate(() => history.length);
    await page.click("#open");
    await page.locator("dialog[open] input").waitFor();
    expect(await page.evaluate(() => [document.body.style.overflow, history.length])).toEqual(["hidden", length + 1]);
    await page.evaluate(() => {
      document.querySelector("solid-island")!.dispatchEvent(new CustomEvent("ssr:island-dispose", { bubbles: true, detail: { id: "a" } }));
    });
    await page.waitForFunction(() => (window as unknown as { results: string[] }).results.length === 1);
    const state = await page.evaluate(() => ({
      dialog: document.querySelector("dialog") !== null,
      overflow: [document.body.style.overflow, document.documentElement.style.overflow],
      focusInDialog: Boolean(document.activeElement?.closest("dialog")),
      length: history.length,
      results: (window as unknown as { results: string[] }).results,
    }));
    expect(state).toEqual({ dialog: false, overflow: ["", ""], focusInDialog: false, length: length + 1, results: ["undefined"] });
    // The page is no longer inert: a click outside the former dialog reaches its target.
    await page.click("#elsewhere");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("elsewhere");
  } finally {
    await page.close();
  }
});
