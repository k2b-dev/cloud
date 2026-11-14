import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../test/browser";

// The Markdown editor draws its text twice: the textarea holds the caret and the selection, and the highlighted
// preview lies exactly on it. Both layers and the placeholder read one font from the root, mono by default and sans
// with `font="sans"`, so a character in the preview is where the textarea puts its caret.
const ui = resolve(import.meta.dir, "../../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "editor-font.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { MarkdownEditor } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const text = "Guten Tag Frau Weber, wir holen die Eichentruhe am Freitag ab und bringen **zwei** Decken mit.\\nDanke!";
for (const font of ["sans", "mono"]) {
  const box = document.createElement("div");
  box.id = font;
  box.style.cssText = "width:420px;margin:16px";
  document.body.append(box);
  render(() => createComponent(MarkdownEditor, { "aria-label": font, variant: "embedded", noToolbar: true, showStats: false, lines: 5, font, value: text }), box);
}
const empty = document.createElement("div");
empty.id = "empty";
document.body.append(empty);
render(() => createComponent(MarkdownEditor, { "aria-label": "empty", variant: "embedded", noToolbar: true, showStats: false, font: "sans", placeholder: "Nachricht schreiben", value: "" }), empty);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the editor font fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator("#mono .k2b-markdown-editor__preview").waitFor({ state: "attached" });
  await settled(page);
  return page;
};

/**
 * For each index into the text: the textarea offset at the middle of that character as the preview draws it. Equal
 * fonts on both layers give back the same index; a different font on one layer drifts along the line.
 */
const caretAtPreview = (page: Page, editor: string, indices: number[]) =>
  page.evaluate(
    ({ editor, indices }) => {
      const root = document.getElementById(editor)!;
      const preview = root.querySelector<HTMLElement>(".k2b-markdown-editor__preview")!;
      const textarea = root.querySelector<HTMLTextAreaElement>("textarea")!;
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
      const at = (index: number) => {
        let rest = index;
        for (const node of nodes) {
          if (rest < node.length) return { node, offset: rest };
          rest -= node.length;
        }
        throw new Error(`No preview character at ${index}`);
      };
      return indices.map((index) => {
        const { node, offset } = at(index);
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        // The left edge of the character, a pixel inside it, on its line's middle: the caret before it.
        const position = document.caretPositionFromPoint(rect.left + 1, rect.top + rect.height / 2);
        return { index, char: textarea.value[index], node: position?.offsetNode === textarea, offset: position?.offset };
      });
    },
    { editor, indices },
  );

describe("MarkdownEditor font", () => {
  test("font=sans draws text, preview, and placeholder in the sans font; the default stays mono", async () => {
    const page = await load();
    try {
      const fonts = await page.evaluate(() => {
        const read = (id: string) => {
          const root = document.getElementById(id)!;
          const input = getComputedStyle(root.querySelector("textarea")!);
          const preview = getComputedStyle(root.querySelector(".k2b-markdown-editor__preview")!);
          const keys = ["fontFamily", "fontSize", "lineHeight", "letterSpacing", "tabSize", "paddingLeft", "paddingTop"] as const;
          return { input: input.fontFamily, same: keys.every((key) => input[key] === preview[key]) };
        };
        return { sans: read("sans"), mono: read("mono") };
      });
      const tokens = await page.evaluate(() => {
        const root = getComputedStyle(document.body);
        const placeholder = document.querySelector("#empty .k2b-markdown-editor__placeholder");
        return {
          sans: root.getPropertyValue("--k2b-font-sans"),
          mono: root.getPropertyValue("--k2b-font-mono"),
          placeholder: placeholder ? getComputedStyle(placeholder).fontFamily : "",
        };
      });
      // Browsers serialize a font list differently: spaces after commas, and WebKit drops the quotes around a name.
      const list = (value: string) =>
        value
          .split(",")
          .map((name) => name.trim().replace(/^["']|["']$/g, ""))
          .join(",");
      expect(list(fonts.sans.input)).toBe(list(tokens.sans));
      expect(list(fonts.mono.input)).toBe(list(tokens.mono));
      expect(list(tokens.placeholder)).toBe(list(tokens.sans));
      expect(fonts.sans.same).toBe(true);
      expect(fonts.mono.same).toBe(true);
    } finally {
      await page.close();
    }
  });

  test("with font=sans the caret lands on the character the preview draws, at the line end and after a break", async () => {
    const page = await load();
    try {
      const text = await page.locator("#sans textarea").inputValue();
      const breakAt = text.indexOf("\n");
      // The last characters of the first (wrapped) line, the first and last after the break.
      const indices = [breakAt - 2, breakAt - 1, breakAt + 1, text.length - 1];
      for (const editor of ["sans", "mono"]) {
        const hits = await caretAtPreview(page, editor, indices);
        expect(hits.map((hit) => [hit.node, hit.offset])).toEqual(indices.map((index) => [true, index]));
      }
    } finally {
      await page.close();
    }
  });
});
