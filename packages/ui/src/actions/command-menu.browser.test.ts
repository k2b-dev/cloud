import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// CommandMenu and the slash commands of MarkdownEditor share one item model and one list. Focus, popovers, keys, and
// layout need a real engine, so the shipped build runs here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "command-menu.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { CommandMenu, MarkdownEditor, SlashCommands } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

globalThis.chosen = [];
const log = (name) => () => globalThis.chosen.push(name);
const dot = (color) => () => {
  const span = document.createElement("span");
  span.style.cssText = "display:block;width:10px;height:10px;border-radius:99px;background:" + color;
  return span;
};
const people = ["Mara Brandt", "Jonas Öztürk", "Lea Krüger", "Tom Weiß"];
const items = [
  { group: "Kinds", label: "Phone call", hint: "/telefonat", icon: "ti ti-phone", keywords: ["anruf"], onSelect: log("call") },
  { group: "Kinds", label: "Confirm appointment", hint: "/termin", icon: "ti ti-calendar-check", disabled: "Only with an announcement", onSelect: log("never") },
  { group: "Snippets", label: "Photos requested", hint: "/fotos", icon: "ti ti-template", text: "Please send us a few photos." },
  { group: "Actions", label: "Assign", hint: "/zuweisen", icon: "ti ti-user-plus", keywords: ["zuständig"],
    next: { label: "Search person", items: people.map((name) => ({ label: name, leading: dot("#2563eb"), onSelect: log("assign:" + name) })) } },
  { group: "Actions", label: "Tag", hint: "/tag", icon: "ti ti-tag",
    next: { label: "Search tag", items: [{ label: "Urgent", leading: dot("#dc2626"), onSelect: log("tag:urgent") }] } },
];

const [textarea, setTextarea] = createSignal();
render(
  () => [
    createComponent(MarkdownEditor, { label: "Message", variant: "embedded", noToolbar: true, lines: 4, textareaRef: setTextarea, onValueChange: (value) => (globalThis.text = value) }),
    createComponent(SlashCommands, { get textarea() { return textarea(); }, items }),
    createComponent(CommandMenu, {
      items,
      label: "Add to message",
      search: "Search commands",
      onInsert: (text) => globalThis.chosen.push("insert:" + text),
      get children() {
        return createComponent(CommandMenu.Trigger, { iconOnly: true, label: "Add", children: "+" });
      },
    }),
  ],
  document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the command menu fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (viewport = { width: 1280, height: 800 }) => {
  const page = await browser.newPage({ viewport });
  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><main id="app" style="display:flex;flex-direction:column;gap:12px;padding:16px;max-width:40rem"></main></body></html>`;
  await page.route("http://commands.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://commands.test/");
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Add" }).waitFor();
  return page;
};

/** The focused field's role and name, and the entry it marks. */
const state = (page: Page) =>
  page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    const id = focused?.getAttribute("aria-activedescendant");
    const active = id ? document.getElementById(id) : null;
    return {
      role: focused?.getAttribute("role") ?? focused?.tagName.toLowerCase() ?? null,
      name: focused?.getAttribute("aria-label") ?? null,
      active: active?.querySelector(".k2b-dropdown__copy > span")?.textContent ?? null,
      listbox: active?.closest("[role='listbox']")?.getAttribute("aria-label") ?? null,
    };
  });
const chosen = (page: Page) => page.evaluate(() => (globalThis as unknown as { chosen: string[] }).chosen);
const box = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }, selector);

describe("CommandMenu", () => {
  test("opens from its trigger as a searchable list with group labels and chooses with Enter", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Add" }).click();
      await settled(page);
      expect(await page.getByRole("dialog", { name: "Add to message" }).isVisible()).toBe(true);
      expect(await state(page)).toMatchObject({ role: "combobox", name: "Search commands", active: "Phone call" });
      expect(await page.getByRole("group", { name: "Snippets" }).isVisible()).toBe(true);
      const unavailable = page.getByRole("option", { name: /Confirm appointment/ });
      expect(await unavailable.getAttribute("aria-disabled")).toBe("true");
      // The unavailable entry is passed over and cannot be chosen.
      await page.keyboard.press("ArrowDown");
      expect((await state(page)).active).toBe("Photos requested");
      await unavailable.dispatchEvent("click");
      expect(await chosen(page)).toEqual([]);
      await page.keyboard.press("End");
      expect((await state(page)).active).toBe("Tag");
      await page.keyboard.press("Home");
      await page.keyboard.type("anruf");
      expect((await state(page)).active).toBe("Phone call");
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await chosen(page)).toEqual(["call"]);
      expect(await page.getByRole("dialog", { name: "Add to message" }).isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Add");
    } finally {
      await page.close();
    }
  });

  test("a second list opens in place, filters, and goes back with Backspace and Escape before Escape closes", async () => {
    const page = await load();
    try {
      await page.getByRole("button", { name: "Add" }).click();
      await page.keyboard.type("zustaendig");
      expect((await state(page)).active).toBe("Assign");
      await settled(page);
      const width = (await box(page, ".k2b-dropdown__menu:popover-open"))!.width;
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await state(page)).toMatchObject({ name: "Search person", listbox: "Search person", active: "Mara Brandt" });
      expect(await page.locator("input[role='combobox']:visible").inputValue()).toBe("");
      expect(await page.getByRole("button", { name: "Back from Assign" }).isVisible()).toBe(true);
      // The menu keeps its width for the second list.
      expect((await box(page, ".k2b-dropdown__menu:popover-open"))!.width).toBe(width);
      await page.keyboard.type("ozt");
      expect((await state(page)).active).toBe("Jonas Öztürk");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("Backspace");
      expect(await state(page)).toMatchObject({ name: "Search commands", active: "Phone call" });
      await page.keyboard.type("tag");
      await page.keyboard.press("Tab");
      expect((await state(page)).name).toBe("Search tag");
      await page.keyboard.press("Escape");
      expect((await state(page)).name).toBe("Search commands");
      expect(await page.getByRole("dialog", { name: "Add to message" }).isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await settled(page);
      expect(await page.getByRole("dialog", { name: "Add to message" }).isVisible()).toBe(false);
      // Reopened, it starts at the first list with an empty field.
      await page.getByRole("button", { name: "Add" }).click();
      expect(await state(page)).toMatchObject({ name: "Search commands", active: "Phone call" });
      await page.getByRole("option", { name: /Photos requested/ }).click();
      expect(await chosen(page)).toEqual(["insert:Please send us a few photos."]);
    } finally {
      await page.close();
    }
  });
});

describe("MarkdownEditor slash commands", () => {
  test("/ opens the same list at the slash without moving the editor; a pointer works through both lists", async () => {
    const page = await load();
    try {
      const textarea = page.getByRole("textbox", { name: "Message" });
      await textarea.click();
      await page.keyboard.type("Hello ");
      await settled(page);
      const before = await box(page, ".k2b-markdown-editor");
      await page.keyboard.type("/");
      await settled(page);
      const popover = ".k2b-autocomplete__options[data-commands]:popover-open";
      expect(await page.locator(popover).isVisible()).toBe(true);
      expect(await state(page)).toMatchObject({ role: "textarea", active: "Phone call", listbox: "Commands" });
      const opened = (await box(page, popover))!;
      await page.keyboard.type("as");
      await settled(page);
      // Typing filters without moving the list or the editor.
      expect((await box(page, popover))!.x).toBe(opened.x);
      expect(await box(page, ".k2b-markdown-editor")).toEqual(before);
      // A pointer enters the second list as Enter does: the typed /query leaves the text while the list's own search
      // field has the focus, so the text stays clean however the person got there.
      await page.getByRole("option", { name: /Assign/ }).click();
      await settled(page);
      const search = page.getByRole("combobox", { name: "Search person" });
      expect(await textarea.inputValue()).toBe("Hello ");
      expect(await search.getAttribute("placeholder")).toBe("Search person");
      expect(await search.evaluate((field) => field === document.activeElement)).toBe(true);
      expect((await box(page, popover))!.width).toBe(opened.width);
      // The back control returns to the first list, and the /query returns to the text with the focus.
      await page.getByRole("button", { name: /Assign/ }).click();
      await settled(page);
      expect(await textarea.inputValue()).toBe("Hello /as");
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("TEXTAREA");
      expect(await state(page)).toMatchObject({ role: "textarea", listbox: "Commands" });
      // Escape and Backspace in the empty field go back the same way. A real browser blurs the removed search field,
      // which a DOM test does not show, so the ways back are checked here.
      for (const back of ["Escape", "Backspace"]) {
        await page.getByRole("option", { name: /Assign/ }).click();
        await settled(page);
        expect(await textarea.inputValue()).toBe("Hello ");
        await search.press(back);
        await settled(page);
        expect(await textarea.inputValue()).toBe("Hello /as");
        expect(await textarea.evaluate((field: HTMLTextAreaElement) => [document.activeElement === field, field.selectionStart])).toEqual([
          true,
          9,
        ]);
        expect(await page.locator(popover).isVisible()).toBe(true);
      }
      await page.getByRole("option", { name: /Assign/ }).click();
      await settled(page);
      expect(await textarea.inputValue()).toBe("Hello ");
      await page.getByRole("option", { name: "Lea Krüger" }).click();
      await settled(page);
      expect(await chosen(page)).toEqual(["assign:Lea Krüger"]);
      expect(await textarea.inputValue()).toBe("Hello ");
      expect(await page.locator(popover).count()).toBe(0);
      expect(await box(page, ".k2b-markdown-editor")).toEqual(before);
    } finally {
      await page.close();
    }
  });

  test("on a phone the list stays inside the viewport", async () => {
    const phone = await load({ width: 390, height: 700 });
    try {
      await phone.getByRole("textbox", { name: "Message" }).click();
      await phone.keyboard.type("/");
      await settled(phone);
      const rect = (await box(phone, ".k2b-autocomplete__options[data-commands]:popover-open"))!;
      expect(rect.x).toBeGreaterThanOrEqual(8);
      expect(rect.x + rect.width).toBeLessThanOrEqual(390 - 8);
    } finally {
      await phone.close();
    }
  });
});
