import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

const entry = resolve(import.meta.dir, "text-input-clear.fixture.ts");
const fixture = `
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { TextInput } from ${JSON.stringify(resolve(import.meta.dir, "../../dist/browser/index.js"))};
const [value, setValue] = createSignal("Find a file");
const custom = location.hash === "#custom";
render(() => createComponent(TextInput, {
  label: "Search files",
  type: "search",
  clearable: true,
  clearLabel: "Clear search",
  get value() { return value(); },
  onValueChange: setValue,
  onValueCommit: () => document.body.dataset.committed = "true",
  ...(custom ? { onClear: () => {
    document.body.dataset.customCleared = "true";
    setValue("");
  }} : {}),
}), document.body);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not build the TextInput clear fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const custom of [false, true])
  test(`clearing by keyboard returns focus to the field with ${custom ? "custom onClear" : "value callbacks"}`, async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`about:blank${custom ? "#custom" : ""}`);
      await page.addScriptTag({ content: script });
      const field = page.getByRole("searchbox", { name: "Search files", exact: true });
      const clear = page.getByRole("button", { name: "Clear search", exact: true });
      await page.keyboard.press("Tab");
      expect(await field.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await clear.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("Space");
      await clear.waitFor({ state: "hidden" });
      expect(await field.inputValue()).toBe("");
      expect(await field.evaluate((node) => node === document.activeElement)).toBe(true);
      expect(await page.locator("body").getAttribute(custom ? "data-custom-cleared" : "data-committed")).toBe("true");
      expect(await page.locator("body").getAttribute(custom ? "data-committed" : "data-custom-cleared")).toBeNull();
      await page.keyboard.type("next search");
      expect(await field.inputValue()).toBe("next search");
    } finally {
      await context.close();
    }
  });
