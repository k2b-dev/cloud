import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// Whether the browser keeps its own menu shows only in a real engine: the app menu must not cancel the event.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "context-menu.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { ContextMenu, LocaleProvider } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const content = (prefix) => {
  const wrapper = document.createElement("div");
  wrapper.innerHTML =
    '<p class="' + prefix + '-text">Invented delivery note for the browser test.</p>' +
    '<a class="' + prefix + '-link" href="#note">Open the note</a> ' +
    '<input class="' + prefix + '-field" aria-label="Field" value="Draft text"> ' +
    '<div class="' + prefix + '-editable" contenteditable="true">Editable text</div>' +
    '<button type="button" class="' + prefix + '-button">Button</button>';
  return wrapper;
};
const inner = () => {
  const article = document.createElement("article");
  article.className = "inner-text";
  article.textContent = "Nested message";
  return article;
};
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return [
          createComponent(ContextMenu, {
            label: "Conversation actions",
            keepNativeMenu: true,
            items: [{ label: "Conversation item", action: () => {} }],
            get children() {
              return [
                content("native"),
                createComponent(ContextMenu, {
                  label: "Message actions",
                  keepNativeMenu: true,
                  tabIndex: -1,
                  items: [{ label: "Message item", action: () => {} }],
                  get children() {
                    const article = inner();
                    const header = document.createElement("button");
                    header.type = "button";
                    header.className = "inner-header";
                    header.textContent = "Message header";
                    article.append(header);
                    return article;
                  },
                }),
              ];
            },
          }),
          createComponent(ContextMenu, {
            label: "Row actions",
            items: [{ label: "Row item", action: () => {} }],
            get children() {
              return content("row");
            },
          }),
        ];
      },
    }),
  document.getElementById("app"),
);
// Captured first and read once dispatch ended, since the app menu stops the event before it bubbles back up.
window.events = [];
window.addEventListener("contextmenu", (event) => window.events.push(event), true);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the context menu fixture for the browser.");
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
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><main id="app" style="padding:16px"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator(".native-text").waitFor();
  return page;
};

/** The open context menu's entries, or null, and whether the last contextmenu event was cancelled. */
const outcome = async (page: Page) => {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const menu = page.locator(".k2b-context-menu");
  const items = (await menu.count()) ? await menu.getByRole("menuitem").allTextContents() : null;
  const prevented = await page.evaluate(() => (window as unknown as { events: Event[] }).events.at(-1)?.defaultPrevented ?? null);
  return { items: items?.map((item) => item.trim()) ?? null, prevented };
};

const closeMenu = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
};

describe("ContextMenu keepNativeMenu", () => {
  test("content opens the app menu; links, fields, editable text and selected text keep the browser's", async () => {
    const page = await load();
    try {
      await page.locator(".native-text").click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: ["Conversation item"], prevented: true });
      await closeMenu(page);

      await page.locator(".native-button").click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: ["Conversation item"], prevented: true });
      await closeMenu(page);

      for (const target of [".native-link", ".native-field", ".native-editable"]) {
        await page.locator(target).click({ button: "right" });
        expect({ target, ...(await outcome(page)) }).toEqual({ target, items: null, prevented: false });
      }

      await page.locator(".native-text").selectText();
      await page.locator(".native-text").click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: null, prevented: false });

      // A selection elsewhere leaves this text to the app menu.
      await page.locator(".native-text").evaluate(() => window.getSelection()?.removeAllRanges());
      await page.locator(".inner-text").click({ button: "right" });
      expect(await outcome(page)).toEqual({ items: ["Message item"], prevented: true });
      await closeMenu(page);
    } finally {
      await page.close();
    }
  });

  test("a nested host opens its own menu by pointer and keyboard; a field keeps Shift+F10", async () => {
    const page = await load();
    try {
      await page.locator(".inner-header").focus();
      await page.keyboard.press("Shift+F10");
      expect((await outcome(page)).items).toEqual(["Message item"]);
      await page.keyboard.press("Escape");
      await page.locator(".k2b-context-menu").waitFor({ state: "detached" });
      expect(await page.evaluate(() => document.activeElement?.className)).toBe("inner-header");

      await page.locator(".native-field").focus();
      await page.keyboard.press("Shift+F10");
      expect((await outcome(page)).items).toBeNull();
    } finally {
      await page.close();
    }
  });

  test("without keepNativeMenu, every target opens the app menu as before", async () => {
    const page = await load();
    try {
      for (const target of [".row-text", ".row-link", ".row-field"]) {
        await page.locator(target).click({ button: "right" });
        expect({ target, ...(await outcome(page)) }).toEqual({ target, items: ["Row item"], prevented: true });
        await closeMenu(page);
      }
    } finally {
      await page.close();
    }
  });
});
