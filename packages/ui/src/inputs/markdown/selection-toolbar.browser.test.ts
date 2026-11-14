import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { launchBrowser, settled } from "../../../test/browser";

// `toolbar="selection"` floats the formatting actions above selected text. Selection, focus, popovers, pointer media,
// and layout need a real engine, so the shipped build runs here.
const ui = resolve(import.meta.dir, "../../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "selection-toolbar.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { MarkdownEditor, MarkdownSelectionToolbar } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const editor = (props) => {
  const [textarea, setTextarea] = createSignal();
  return [
    createComponent(MarkdownEditor, { ...props, noToolbar: true, textareaRef: setTextarea }),
    createComponent(MarkdownSelectionToolbar, { get textarea() { return textarea(); } }),
  ];
};

render(
  () => [
    editor({ label: "Note", lines: 4, value: "Hello world, this is a short note.", onValueChange: (value) => (globalThis.text = value) }),
    createComponent(MarkdownEditor, { label: "Fixed", lines: 2, value: "Fixed toolbar" }),
    editor({ label: "Long", lines: 3, value: Array.from({ length: 30 }, (_, index) => "Line " + (index + 1)).join("\\n") }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the selection toolbar fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions = { viewport: { width: 1280, height: 800 } }) => {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><main id="app" style="display:grid;gap:16px;padding:96px 16px 16px;max-width:36rem"></main><button id="elsewhere">Elsewhere</button></body></html>`;
  await page.route("http://selection.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://selection.test/");
  await page.addScriptTag({ content: script });
  await page.getByRole("textbox", { name: "Note" }).waitFor();
  return page;
};
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Format selection" });
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom } : null;
  }, selector);
/** Selects `length` characters from `start` with the keyboard, as a person would with Shift and the arrows. */
const select = async (page: Page, start: number, length: number) => {
  const note = page.getByRole("textbox", { name: "Note" });
  await note.focus();
  await note.evaluate((element: HTMLTextAreaElement, start) => element.setSelectionRange(start, start), start);
  for (let index = 0; index < length; index++) await page.keyboard.press("Shift+ArrowRight");
};
// The toolbar fades in and out, so tests wait for its state rather than for a still page.
const shown = (page: Page) => toolbar(page).waitFor({ state: "visible" });
const hidden = (page: Page) => toolbar(page).waitFor({ state: "hidden" });
/** Waits until the note holds `text`; an action from the toolbar lands in the text after its click. */
const noteIs = (page: Page, text: string) =>
  page.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>("textarea")?.value === text, text, { timeout: 2000 });

describe("MarkdownSelectionToolbar", () => {
  test("no toolbar above the text; selected text gets a floating one above it without moving the editor", async () => {
    const page = await load();
    try {
      expect(await page.getByRole("toolbar", { name: "Markdown formatting" }).count()).toBe(1);
      const before = await box(page, ".k2b-markdown-editor");
      expect(await toolbar(page).isVisible()).toBe(false);
      await select(page, 6, 5);
      await shown(page);
      const floating = (await box(page, ".k2b-selection-toolbar:popover-open"))!;
      const surface = (await box(page, ".k2b-markdown-editor__surface"))!;
      // Above the selected first line, so over the editor's top edge.
      expect(floating.bottom).toBeLessThanOrEqual(surface.y + 8);
      expect(await box(page, ".k2b-markdown-editor")).toEqual(before);
      await toolbar(page).getByRole("button", { name: "Bold" }).click();
      expect(await page.getByRole("textbox", { name: "Note" }).inputValue()).toBe("Hello **world**, this is a short note.");
      // The toolbar follows the selection, which stays on the word, and Bold now reads as pressed.
      expect(await toolbar(page).isVisible()).toBe(true);
      await page.waitForFunction(
        () => document.querySelector(".k2b-selection-toolbar [aria-label='Bold']")?.getAttribute("aria-pressed") === "true",
      );
      expect(await toolbar(page).getByRole("button", { name: "Italic" }).getAttribute("aria-pressed")).toBe("false");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(null);
    } finally {
      await page.context().close();
    }
  });

  test("Escape closes it and keeps the text; shortcuts still work; a collapsed selection or leaving hides it", async () => {
    const page = await load();
    try {
      await select(page, 0, 5);
      await shown(page);
      await page.keyboard.press("Escape");
      await hidden(page);
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
      await page.keyboard.press("ControlOrMeta+i");
      expect(await page.getByRole("textbox", { name: "Note" }).inputValue()).toBe("*Hello* world, this is a short note.");
      // A new selection shows it again; collapsing hides it.
      await page.keyboard.press("Shift+ArrowLeft");
      await shown(page);
      await page.keyboard.press("ArrowRight");
      await hidden(page);
      // Escape forgets its selection once it collapses: the same words selected again show the toolbar.
      await page.keyboard.press("Shift+ArrowLeft");
      await shown(page);
      await page.keyboard.press("Escape");
      await hidden(page);
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Shift+ArrowRight");
      await shown(page);
      await select(page, 8, 5);
      await shown(page);
      await page.locator("#elsewhere").focus();
      await hidden(page);
    } finally {
      await page.context().close();
    }
  });

  test("Tab moves from the selected text into the toolbar, which stays open", async () => {
    const page = await load();
    try {
      // Tab as soon as the toolbar shows, while it still fades in.
      await select(page, 6, 5);
      await shown(page);
      await page.keyboard.press("Tab");
      expect(await toolbar(page).isVisible()).toBe(true);
      // The floating toolbar's own Bold, not the next editor's toolbar.
      expect(
        await page.evaluate(() => [
          document.activeElement?.closest(".k2b-selection-toolbar") !== null,
          document.activeElement?.getAttribute("aria-label"),
        ]),
      ).toEqual([true, "Bold"]);
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await noteIs(page, "Hello *world*, this is a short note.");
    } finally {
      await page.context().close();
    }
  });

  test("it hides while the selected line is scrolled out of the text and returns with it", async () => {
    const page = await load();
    try {
      const long = page.getByRole("textbox", { name: "Long" });
      await long.focus();
      await long.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 0));
      for (let index = 0; index < 4; index++) await page.keyboard.press("Shift+ArrowRight");
      await shown(page);
      await long.evaluate((element: HTMLTextAreaElement) => {
        element.scrollTop = 300;
      });
      await hidden(page);
      await long.evaluate((element: HTMLTextAreaElement) => {
        element.scrollTop = 0;
      });
      await shown(page);
    } finally {
      await page.context().close();
    }
  });

  test("touch devices keep their own selection menu; shortcuts keep working", async () => {
    const page = await load({ viewport: { width: 390, height: 760 }, hasTouch: true, isMobile: true });
    try {
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      await select(page, 6, 5);
      await settled(page);
      // Not hidden but absent: nothing of the toolbar mounts on touch.
      expect(await page.locator(".k2b-selection-toolbar").count()).toBe(0);
      await page.keyboard.press("ControlOrMeta+b");
      expect(await page.getByRole("textbox", { name: "Note" }).inputValue()).toBe("Hello **world**, this is a short note.");
    } finally {
      await page.context().close();
    }
  });
});
