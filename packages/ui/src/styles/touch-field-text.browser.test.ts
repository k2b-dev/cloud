import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// iOS Safari zooms the page when a focused field's text is smaller than 16 px.
// Font size and the boxes around a field are layout results, which happy-dom
// does not model, so a real engine renders the shipped stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-touch-field-text-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ChatComposer } = await import("../chat/ChatComposer");
const { AutocompleteEditor } = await import("../inputs/AutocompleteEditor");
const { AutocompleteSelect } = await import("../inputs/AutocompleteSelect");
const { PinInput } = await import("../inputs/ChoiceInputs");
const { Combobox } = await import("../inputs/Combobox");
const { MarkdownEditor } = await import("../inputs/markdown/MarkdownEditor");
const { NumberInput } = await import("../inputs/NumberInput");
const { TagsInput } = await import("../inputs/TagsInput");
const { TextInput } = await import("../inputs/TextInput");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const touchQuery = "@media (pointer:coarse)";
// The same phone with the touch rules switched off: what it rendered before them.
const cssWithoutTouchRules = css.replaceAll(touchQuery, "@media not all");
const phone = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const noop = () => {};
const rendered: [string, () => JSX.Element][] = [
  [
    "text",
    () => createComponent(TextInput, { label: "Project", description: "Shown on the overview.", value: "Atlas", icon: "ti ti-folder" }),
  ],
  ["password", () => createComponent(TextInput, { label: "Password", value: "secret", password: true })],
  ["textarea", () => createComponent(TextInput, { label: "Notes", value: "First line\nSecond line", multiline: true, lines: 3 })],
  ["monospace", () => createComponent(TextInput, { label: "Token", value: "a1b2c3", monospace: true })],
  ["number", () => createComponent(NumberInput, { label: "Budget", value: 1200, prefix: "€", suffix: "gross", onValueChange: noop })],
  ["combobox", () => createComponent(Combobox, { label: "City", query: "Par", fetchData: async () => [], onSelect: noop })],
  [
    "autocomplete select",
    () =>
      createComponent(AutocompleteSelect, { label: "Category", value: null, search: async () => ({ options: [] }), onValueChange: noop }),
  ],
  ["tags", () => createComponent(TagsInput, { label: "Tags", value: ["alpha", "beta"], onValueChange: noop })],
  ["pin", () => createComponent(PinInput, { label: "Code", value: "12", length: 6, onValueChange: noop })],
  [
    "autocomplete editor",
    () => createComponent(AutocompleteEditor, { label: "Message", value: "Hello @de", lines: 3, onValueChange: noop }),
  ],
  ["markdown editor", () => createComponent(MarkdownEditor, { label: "Release note", value: "# Title\n\nSome **bold** text.", lines: 4 })],
  ["chat composer", () => createComponent(ChatComposer, { value: "", onValueChange: noop, onSubmit: noop })],
];
// These fields exist only inside an opened popover, dialog, or edit mode, so
// the page carries the markup their components render there.
const opened: [string, string][] = [
  ["select search", `<div class="k2b-choice-search"><i class="ti ti-search"></i><input type="search" placeholder="Search"></div>`],
  [
    "time",
    `<label class="k2b-date-time"><span>Time</span><span class="k2b-date-time__control"><input type="text" inputmode="numeric" value="09:00"><i class="ti ti-clock"></i></span></label>`,
  ],
  [
    "search prompt",
    `<div class="k2b-prompt-search"><label class="k2b-prompt-search__input"><i class="ti ti-search"></i><input type="search" placeholder="Search"></label></div>`,
  ],
  ["file rename", `<input class="k2b-content-file-tree__rename" value="report.pdf">`],
  [
    "source file",
    `<div class="k2b-markdown-editor__surface" style="position:relative;height:8rem"><textarea class="k2b-content-file-view__code-input">const a = 1;</textarea></div>`,
  ],
];
const fields = [...rendered.map(([name, view]): [string, string] => [name, renderToString(view)]), ...opened];
// @k2b/ui sets no line height of its own. Cloud inherits 1.5 from Tailwind's
// base styles; a plain host leaves `normal`, which browsers derive from
// rounded font metrics.
const hosts = { tailwind: "line-height:1.5", plain: "" };
type Host = keyof typeof hosts;
// The search prompt row has no height of its own and takes it from the field's
// line box. `lh` restores that height exactly for a numeric line height; with
// `normal` the rounded metrics leave a fraction of a pixel.
const fieldsIn = (host: Host) => fields.filter(([name]) => host === "tailwind" || name !== "search prompt");
const page = (styles: string, host: Host) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style>` +
  `<style>solid-client,solid-island{display:contents}</style></head>` +
  `<body class="k2b-ui" style="${hosts[host]}"><main style="padding:1rem">${fieldsIn(host)
    .map(([name, markup]) => `<section data-field="${name}">${markup}<p>After ${name}</p></section>`)
    .join("")}</main></body></html>`;

const editable =
  "input:not([type=hidden], [type=checkbox], [type=radio], [type=range], [type=file], [type=color]), textarea, select, [contenteditable]:not([contenteditable=false])";

/** Every element's box and every editable field's text metrics, with each field focused in turn. */
const measure = async (styles: string, host: Host) => {
  const tab = await browser.newPage(phone);
  try {
    await tab.setContent(page(styles, host));
    await tab.evaluate(() => document.fonts.ready);
    return await tab.evaluate((selector) => {
      const boxes = () =>
        Array.from(document.querySelectorAll("main *")).map((element, index) => {
          const box = element.getBoundingClientRect();
          const name = `${index} ${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""}`;
          return `${name} ${[box.x, box.y, box.width, box.height].map((value) => Math.round(value * 100) / 100).join(" ")}`;
        });
      const text: Record<string, { fontSize: number; lineHeight: string }[]> = {};
      const focused: Record<string, string[]> = {};
      for (const section of Array.from(document.querySelectorAll<HTMLElement>("[data-field]"))) {
        const name = section.dataset.field!;
        const inputs = Array.from(section.querySelectorAll<HTMLElement>(selector));
        text[name] = inputs.map((input) => {
          const style = getComputedStyle(input);
          return { fontSize: Number.parseFloat(style.fontSize), lineHeight: style.lineHeight };
        });
        // Some fields swap their presentation for the editor on focus.
        inputs[0]?.focus();
        focused[name] = boxes();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      return { text, focused, idle: boxes(), pageHeight: document.documentElement.scrollHeight };
    }, editable);
  } finally {
    await tab.close();
  }
};

describe("@k2b/ui field text on a phone", () => {
  test("is at least 16 px in every editable field, so iOS Safari does not zoom on focus", async () => {
    const { text } = await measure(css, "tailwind");
    for (const [name] of fields) {
      expect(text[name]?.length, name).toBeGreaterThan(0);
      for (const field of text[name]!) expect(field.fontSize, name).toBeGreaterThanOrEqual(16);
    }
  }, 30_000);

  test.each(Object.keys(hosts) as Host[])(
    "keeps every box of the field, its label, and its neighbours where it was in a %s host",
    async (host) => {
      expect(css).toContain(touchQuery);
      const before = await measure(cssWithoutTouchRules, host);
      const after = await measure(css, host);
      // Guards the comparison itself: without the touch rules the text is small again.
      expect(before.text.text![0]!.fontSize).toBe(14);
      expect(after.idle).toEqual(before.idle);
      expect(after.focused).toEqual(before.focused);
      expect(after.pageHeight).toBe(before.pageHeight);
    },
    30_000,
  );
});
