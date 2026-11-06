import { afterAll, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "../src/text-editor/language";
import { createDomTestHarness } from "./dom";

const dom = createDomTestHarness();
// DOMPurify reads Node.prototype.nodeName directly. happy-dom only supplies
// concrete names on subclasses, so provide browser-equivalent element/text names.
const nodePrototype = dom.window.Node.prototype;
const nodeName = Object.getOwnPropertyDescriptor(nodePrototype, "nodeName");
if (!nodeName) throw new Error("happy-dom Node.nodeName getter is missing");
Object.defineProperty(nodePrototype, "nodeName", {
  ...nodeName,
  get: function (this: typeof nodePrototype) {
    if (this instanceof dom.window.Element) return this.tagName;
    if (this.nodeType === dom.window.Node.TEXT_NODE) return "#text";
    if (this.nodeType === dom.window.Node.COMMENT_NODE) return "#comment";
    return nodeName.get?.call(this);
  },
});
const prototype = dom.window.Element.prototype;
const querySelectorAll = prototype.querySelectorAll;
// happy-dom cannot parse the escaped Office namespace selector. DOMPurify
// already removes that tag; leave every sanitizer and conversion path real.
Object.defineProperty(prototype, "querySelectorAll", {
  configurable: true,
  writable: true,
  value: function (this: typeof prototype, selectors: string) {
    return querySelectorAll.call(this, selectors.replace(",o\\:p", ""));
  },
});
const { cleanPaste, htmlToMarkdown } = await import("../src/text-editor/paste");
const { loadHtmlClipboard } = await import("../src/text-editor/clipboard");
await loadHtmlClipboard();
const { tableHost } = await import("../src/text-editor/table");
afterAll(() => {
  prototype.querySelectorAll = querySelectorAll;
  Object.defineProperty(nodePrototype, "nodeName", nodeName);
  dom.cleanup();
});

const source = "def f():\n    return 1";
const editorHtml = '<div style="white-space: pre;"><div><span>def</span><span> f():</span></div><div><span>    return 1</span></div></div>';
const fenced = (text: string) => `\`\`\`\n${text}\n\`\`\``;

function paste({
  doc = "",
  at = doc.length,
  to = at,
  text = "",
  html = "",
  readOnly = false,
  plain = false,
  maxLength = 10_000,
  maxPasteCells = 2000,
}: {
  doc?: string;
  at?: number;
  to?: number;
  text?: string;
  html?: string;
  readOnly?: boolean;
  plain?: boolean;
  maxLength?: number;
  maxPasteCells?: number;
}) {
  const errors: string[] = [];
  const images: number[] = [];
  const view = new EditorView({
    parent: dom.root,
    state: EditorState.create({
      doc,
      selection: { anchor: at, head: to },
      extensions: [
        markdown(),
        EditorState.readOnly.of(readOnly),
        tableHost.of({
          undo() {},
          redo() {},
          boundary() {},
          cellLabel: () => "Cell",
          maxLength,
          maxPasteCells,
          onError: (error) => errors.push(error),
          onRecovery() {},
        }),
        cleanPaste((count) => images.push(count), plain),
      ],
    }),
  });
  const data = new dom.window.DataTransfer();
  if (text) data.setData("text/plain", text);
  if (html) data.setData("text/html", html);
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  try {
    view.contentDOM.dispatchEvent(event);
    return { text: view.state.doc.toString(), errors, images, prevented: event.defaultPrevented, html: view.dom.innerHTML };
  } finally {
    view.destroy();
  }
}

describe("code clipboard fidelity", () => {
  test("editor HTML becomes one fenced block outside code, with exact indentation", () => {
    expect(htmlToMarkdown(editorHtml)).toEqual({ markdown: fenced(source), droppedImages: 0 });
    expect(paste({ text: source, html: editorHtml }).text).toBe(fenced(source));
    expect(paste({ html: editorHtml }).text).toBe(fenced(source));
  });

  test.each([
    ["empty fenced Python block", "```python\n\n```", 10],
    ["fenced block content end", "```python\nx\n```", 11],
    ["unclosed fence", "```python\n", 10],
    ["tilde fence", "~~~python\n\n~~~", 10],
    ["indented code", "    x", 5],
    ["leading code indentation", "    x", 2],
    ["start of inline code", "Text `xy` end", 6],
    ["inline code", "Text `xy` end", 7],
  ])("native plain text wins in %s", (_name, doc, at) => {
    expect(paste({ doc, at, text: source, html: editorHtml }).text).toBe(doc.slice(0, at) + source + doc.slice(at));
  });

  test("the Notebook regression pastes exact Python without paragraph gaps", () => {
    expect(paste({ doc: "```python\n\n```", at: 10, text: source, html: editorHtml }).text).toBe("```python\ndef f():\n    return 1\n```");
  });

  test("HTML-only editor code inside a fence has no extra fence or paragraph gaps", () => {
    expect(paste({ doc: "```python\n\n```", at: 10, html: editorHtml }).text).toBe("```python\ndef f():\n    return 1\n```");
  });

  test("HTML-only formatted content in inline code stays literal", () => {
    expect(paste({ doc: "`xy`", at: 2, html: "<b>  bold</b><br><i> tail  </i>" }).text).toBe("`x  bold\n tail  y`");
  });

  test("code context beyond the initial parse viewport still pastes raw", () => {
    const doc = `${"Paragraph\n\n".repeat(1000)}\`\`\`python\n\n\`\`\``;
    const at = doc.length - 4;
    expect(paste({ doc, at, text: source, html: editorHtml }).text).toBe(doc.slice(0, at) + source + doc.slice(at));
  });

  test("native code paste keeps tabs and table-looking text raw", () => {
    const text = "a\tb\nc\td";
    expect(paste({ doc: "```\n\n```", at: 4, text }).text).toBe(`\`\`\`\n${text}\n\`\`\``);
  });

  test("code selection replacement stays literal", () => {
    expect(paste({ doc: "`replace`", at: 1, to: 8, text: " **raw** ", html: "<b>raw</b>" }).text).toBe("` **raw** `");
  });

  test("paste after a closing marker is ordinary formatted HTML", () => {
    for (const doc of ["`code`", "```\ncode\n```", "```\ncode\n```\n"]) {
      expect(paste({ doc, html: "<b>bold</b>", text: "bold" }).text).toBe(`${doc}**bold**`);
    }
  });

  test("HTML-only whitespace keeps tabs, empty lines, entities, trailing spaces and safe fences", () => {
    const text = "  <tag>\t\n\n    ```  \n tail  ";
    const html = '<div style="white-space:pre-wrap"><div>  &lt;tag&gt;\t</div><div><br></div><div>    ```  </div><div> tail  </div></div>';
    expect(htmlToMarkdown(html)?.markdown).toBe(`\`\`\`\`\n${text}\n\`\`\`\``);
    expect(paste({ doc: "```\n\n```", at: 4, html }).text).toBe(`\`\`\`\n${text}\n\`\`\``);
  });

  test("whitespace containers preserve direct breaks and empty source lines", () => {
    for (const style of ["pre", "pre-wrap", "break-spaces"]) {
      expect(htmlToMarkdown(`<div style="white-space:${style}">  one<br>\ttwo</div>`)?.markdown).toBe(fenced("  one\n\ttwo"));
    }
    expect(htmlToMarkdown('<div style="white-space:pre"><div>one</div><div></div><div>  two</div></div>')?.markdown).toBe(
      fenced("one\n\n  two"),
    );
  });

  test("pre content uses line breaks rather than concatenating child divs", () => {
    expect(htmlToMarkdown("<pre><code><div>one</div><div>  two</div></code></pre>")?.markdown).toBe(fenced("one\n  two"));
    expect(htmlToMarkdown("<pre>one\n  two\n</pre>")?.markdown).toBe(fenced("one\n  two"));
  });
});

describe("existing paste contracts", () => {
  test("Word/web paragraphs and supported formatting still convert", () => {
    const html =
      '<p><b style="font-weight:normal">Hello <strong>world</strong></b> <em>again</em></p><p>Second <a href="https://example.test">link</a></p>';
    const expected = "Hello **world** *again*\n\nSecond [link](https://example.test)";
    expect(htmlToMarkdown(html)?.markdown).toBe(expected);
    expect(paste({ html }).text).toBe(expected);
  });

  test("HTML and TSV tables remain tables outside code", () => {
    expect(paste({ html: "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>" }).text).toContain("| A | B |");
    expect(paste({ text: "A\tB\n1\t2" }).text).toContain("| A | B |");
  });

  test("sanitization and dropped-image reporting apply inside and outside code", () => {
    const html =
      '<div style="white-space:pre">safe<script>bad()</script><img src="https://example.test/tracker" onerror="bad()"><span onclick="bad()">  text</span></div>';
    expect(htmlToMarkdown(html)).toEqual({ markdown: fenced("safe  text"), droppedImages: 1 });
    for (const doc of ["", "```\n\n```"]) {
      const result = paste({ doc, at: doc ? 4 : 0, html });
      expect(result.images).toEqual([1]);
      expect(result.text).toContain("safe  text");
      expect(result.text).not.toContain("bad");
      expect(result.html).not.toContain("example.test");
    }
    const result = paste({ html: '<img src="https://example.test/tracker">' });
    expect(result.text).toBe("");
    expect(result.images).toEqual([1]);
    expect(result.prevented).toBe(true);
  });

  test("read-only documents do not paste or report images", () => {
    const result = paste({ doc: "```\n\n```", at: 4, text: source, html: `${editorHtml}<img>`, readOnly: true });
    expect(result.text).toBe("```\n\n```");
    expect(result.images).toEqual([]);
  });

  test("source/plain mode still uses native plain text", () => {
    expect(paste({ text: source, html: editorHtml, plain: true }).text).toBe(source);
  });

  test("text and HTML length preflight cannot be bypassed by code context", () => {
    for (const doc of ["", "```\n\n```"]) {
      for (const content of [{ text: source }, { html: editorHtml }, { text: source, html: editorHtml }]) {
        const result = paste({ doc, at: doc ? 4 : 0, ...content, maxLength: 10 });
        expect(result.text).toBe(doc);
        expect(result.errors).toEqual(["textTooLarge"]);
        expect(result.prevented).toBe(true);
      }
    }
  });

  test("cell budgets still reject TSV and HTML tables in code and prose", () => {
    for (const doc of ["", "```\n\n```"]) {
      for (const content of [
        { text: "a\tb\nc\td" },
        { html: "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>" },
      ]) {
        const result = paste({ doc, at: doc ? 4 : 0, ...content, maxPasteCells: 3 });
        expect(result.text).toBe(doc);
        expect(result.errors).toEqual(["pasteTooLarge"]);
      }
    }
  });
});
