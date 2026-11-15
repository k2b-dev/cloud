import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../test/browser";

// A letter per entry: it chooses the entry while the menu is open, shows as a key cap, and never takes a field's letters.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dropdown-keys.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Dropdown, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.chosen = [];
const choose = (name) => () => window.chosen.push(name);
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return [
          createComponent(Dropdown, {
            label: "Open beside",
            heading: "Open beside",
            keyHint: ["↑↓ choose · Enter opens", "A letter chooses directly"],
            items: [
              { label: "Result from this chat", icon: "ti ti-table", key: "E", disabled: true, description: "No result yet", action: choose("result") },
              { label: "Files of the chat", icon: "ti ti-paperclip", key: "D", action: choose("files") },
              { label: "Read a web page", icon: "ti ti-world", key: "W", action: choose("web") },
            ],
            get children() {
              return createComponent(Dropdown.Trigger, { class: "keys-trigger", label: "Add", children: "Add" });
            },
          }),
          createComponent(Dropdown, {
            label: "Find",
            search: { label: "Find" },
            items: [{ label: "Wochenbericht", key: "W", action: choose("search-web") }],
            get children() {
              return createComponent(Dropdown.Trigger, { class: "search-trigger", label: "Find", children: "Find" });
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the dropdown keys fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui"><div id="app"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".keys-trigger").waitFor();
  return page;
};
const chosen = (page: Page) => page.evaluate(() => (window as unknown as { chosen: string[] }).chosen);

describe(`Dropdown keys in ${browserName}`, () => {
  test("a letter chooses its entry while the menu is open, shows as a key cap, and a disabled entry keeps its letter", async () => {
    const page = await open();
    try {
      await page.locator(".keys-trigger").focus();
      await page.keyboard.press("Enter");
      const menu = page.getByRole("menu", { name: "Open beside" });
      await menu.waitFor();
      await settled(page);
      expect(await menu.locator(".k2b-dropdown__heading").textContent()).toBe("Open beside");
      expect(await menu.locator(".k2b-dropdown__keys span").allTextContents()).toEqual([
        "↑↓ choose · Enter opens",
        "A letter chooses directly",
      ]);
      expect(await menu.locator(".k2b-dropdown__key").count()).toBe(3);
      expect(await menu.getByRole("menuitem", { name: /Files of the chat/ }).getAttribute("aria-keyshortcuts")).toBe("D");
      // The focus starts on the first entry that can be chosen.
      expect(await page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Files of the chat");
      // Letters elsewhere do nothing while the menu is closed.
      await page.keyboard.press("e");
      expect(await chosen(page)).toEqual([]);
      expect(await menu.isVisible()).toBe(true);
      await page.keyboard.press("w");
      await menu.waitFor({ state: "hidden" });
      expect(await chosen(page)).toEqual(["web"]);
      expect(await page.evaluate(() => document.activeElement?.classList.contains("keys-trigger"))).toBe(true);
      await page.keyboard.press("d");
      expect(await chosen(page)).toEqual(["web"]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a field in the menu keeps its letters", async () => {
    const page = await open();
    try {
      await page.locator(".search-trigger").click();
      const field = page.getByRole("combobox", { name: "Find" });
      await field.waitFor();
      await page.keyboard.type("w");
      expect(await field.inputValue()).toBe("w");
      expect(await chosen(page)).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
