import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-markdown-info-blocks-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Lexer, Marked } = await import("marked");
const { LocaleProvider } = await import("../intl/locale");
const { default: MarkdownView, renderSafeMarkdown } = await import("./MarkdownView");
const { markdownInfoBlocks, renderMarkdownInfoBlock, scanMarkdownInfoBlock } = await import("./markdown-info-blocks");

const view = (markdown: string, locale?: string) =>
  renderToString(() =>
    locale
      ? createComponent(LocaleProvider, {
          locale,
          get children() {
            return createComponent(MarkdownView, { markdown });
          },
        })
      : createComponent(MarkdownView, { markdown }),
  );

const types = [
  ["note", "neutral", "Note", "Notiz"],
  ["info", "info", "Info", "Info"],
  ["success", "success", "Success", "Erfolg"],
  ["warning", "warning", "Warning", "Warnung"],
  ["danger", "danger", "Danger", "Gefahr"],
] as const;

describe("MarkdownView info blocks", () => {
  test("every type renders as the calm NoticeCard with a localized screen-reader name", () => {
    for (const [type, tone, en, de] of types) {
      const source = `:::${type}\nBack up **first**.\n:::`;
      const card = `<aside class="k2b-notice-card" data-tone="${tone}" role="note">`;
      const body = `<div class="k2b-notice-card__body"><p>Back up <strong>first</strong>.</p>\n</div></aside>`;

      expect(renderSafeMarkdown(source)).toBe(`${card}<span class="k2b-sr-only">${en}: </span>${body}`);
      expect(view(source, "en")).toContain(`${card}<span class="k2b-sr-only">${en}: </span>${body}`);
      expect(view(source, "de")).toContain(`${card}<span class="k2b-sr-only">${de}: </span>${body}`);
    }
  });

  test("a title is the visible heading and replaces the screen-reader name", () => {
    const html = view(":::warning Before <deleting>\nThis cannot be undone.\n:::", "de");

    expect(html).toContain('<p class="k2b-notice-card__title">Before &lt;deleting&gt;</p>');
    expect(html).not.toContain("k2b-sr-only");
    expect(html).not.toContain(":::");
  });

  test("the body is safe Markdown with the same escaping as the rest of the view", () => {
    const html = renderSafeMarkdown(
      ":::danger\n<img src=x onerror=alert(1)> [run](javascript:alert(1)) [docs](https://example.com)\n\n- one\n- two\n:::",
      { linkTarget: "_blank" },
    );

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toContain(
      '<a href="https://example.com" class="k2b-text-link" data-link="web" target="_blank" rel="noopener noreferrer">docs<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i></a>',
    );
    expect(html).toContain("<li>one</li>");
  });

  test("blocks start a new block after a paragraph and end at their own closing line", () => {
    const html = renderSafeMarkdown("Intro\n:::note\n```\n:::\n```\n:::\nOutro");

    expect(html).toBe(
      `<p>Intro</p>\n${renderMarkdownInfoBlock({ type: "note", bodyHtml: "<pre><code>:::\n</code></pre>\n" })}<p>Outro</p>\n`,
    );
  });

  test("unclosed, unknown, nested, and indented-code blocks stay ordinary text", () => {
    for (const source of [
      ":::note\nNever closed",
      ":::notes\nUnknown\n:::",
      "- item\n  :::note\n  Inside a list\n  :::",
      "> :::note\n> Inside a quote\n> :::",
      "    :::note\n    Code\n    :::",
    ]) {
      expect(renderSafeMarkdown(source), source).not.toContain("<aside");
    }
    // A block inside a block is the outer body's text; the first closing line ends the outer block.
    const nested = renderSafeMarkdown(":::note\n:::info\nInner\n:::\n:::");
    expect(nested.match(/<aside /g)?.length).toBe(1);
    expect(nested).toContain("<p>:::info\nInner</p>");
  });

  test("the scanner reports the exact extent applications reuse", () => {
    expect(scanMarkdownInfoBlock("Text")).toBeNull();
    expect(scanMarkdownInfoBlock("  :::info  Title  \nBody\n  :::\nAfter")).toEqual({
      type: "info",
      title: "Title",
      body: "Body",
      length: "  :::info  Title  \nBody\n  :::\n".length,
      closed: true,
    });
    // A closing line indented deeper than the opener belongs to the body.
    expect(scanMarkdownInfoBlock(":::note\nBody\n  :::")).toMatchObject({ closed: false, length: ":::note\nBody\n  :::".length });
  });

  test("the type takes any letter case and renders lowercase", () => {
    expect(renderSafeMarkdown(":::WARNING\nBody\n:::")).toBe(renderMarkdownInfoBlock({ type: "warning", bodyHtml: "<p>Body</p>\n" }));
    expect(scanMarkdownInfoBlock(":::Note Title\nBody\n:::")).toMatchObject({ type: "note", title: "Title", closed: true });
  });

  test("a line of inline HTML continues the body's paragraph and cannot hide the closing line", () => {
    expect(renderSafeMarkdown(":::note\nLine one\n<br>\n:::\n\nafter")).toBe(
      `${renderMarkdownInfoBlock({ type: "note", bodyHtml: "<p>Line one\n&lt;br&gt;</p>\n" })}<p>after</p>\n`,
    );
    // Block HTML still keeps its lines, as it would anywhere else.
    expect(scanMarkdownInfoBlock(":::note\n<div>\n:::\n</div>\n\n:::")).toMatchObject({ body: "<div>\n:::\n</div>\n", closed: true });
  });

  test("code in a list item cannot close an indented block, but a line that leaves the item can", () => {
    expect(scanMarkdownInfoBlock("  :::note\n- item\n\n  ```\n  :::\n  ```\n  :::\nafter")).toMatchObject({
      body: "- item\n\n  ```\n  :::\n  ```",
      closed: true,
    });
    expect(scanMarkdownInfoBlock(":::note\n- item\n  ```\n  code\n:::\nafter")).toMatchObject({
      body: "- item\n  ```\n  code",
      closed: true,
    });
  });

  test("the scanner accepts any line endings and counts the source as given", () => {
    const source = ":::note\r\n~~~\r\n:::\r\n~~~\r\n:::\r\nAfter";
    const block = scanMarkdownInfoBlock(source);

    expect(block).toMatchObject({ body: "~~~\n:::\n~~~", closed: true });
    expect(source.slice(block?.length)).toBe("After");
  });

  test("a document without a closed block renders as if blocks did not exist", () => {
    const plain = new Marked();
    const blocks = new Marked(markdownInfoBlocks());
    for (const source of [
      ":::note\ntext\n".repeat(20),
      "  :::note\n- a\n".repeat(5),
      "> quote\n   :::\n===\n:::info\n<br>\n| - | - |\n===\n:::",
      "Title\n:::note\n---",
    ]) {
      expect(blocks.parse(source), source).toBe(plain.parse(source) as string);
    }
  });

  test("paragraphs end only at blocks that close, and a setext underline cannot swallow one", () => {
    const [extension] = markdownInfoBlocks().extensions ?? [];
    if (!extension || !("start" in extension) || !extension.start) throw new Error("the extension has a start function");
    const start = extension.start;
    let splits = 0;
    const counting = new Marked({
      ...markdownInfoBlocks(),
      extensions: [
        {
          ...extension,
          start(source) {
            const index = start.call(this, source);
            if (typeof index === "number") splits++;
            return index;
          },
        },
      ],
    });

    counting.parse(":::note\ntext\n".repeat(50));
    expect(splits).toBe(0);
    const html = counting.parse("x\n:::note\nb\n:::\n".repeat(50)) as string;
    expect(splits).toBe(50);
    expect(html.match(/<aside /g)?.length).toBe(50);
    expect(renderSafeMarkdown("Intro\n:::note\nBody\n:::\n---")).toBe(
      `<p>Intro</p>\n${renderMarkdownInfoBlock({ type: "note", bodyHtml: "<p>Body</p>\n" })}<hr>\n`,
    );
  });

  test("documents with many openers render in linear time", () => {
    // Each of these took tens of seconds while every opener rescanned the rest of the document.
    for (const source of [":::note\ntext\n".repeat(1600), "x\n:::note\nb\n:::\n".repeat(1500), "  :::note\n- a\n".repeat(1600)]) {
      const started = performance.now();
      renderSafeMarkdown(source);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  test("scanning keeps no state between documents", () => {
    // The tokenizer's lexer queues inline work for every list item; a shared one would grow forever.
    const inline = Lexer.prototype.inline;
    const lexers = new Set<InstanceType<typeof Lexer>>();
    Lexer.prototype.inline = function (this: InstanceType<typeof Lexer>, ...args: Parameters<typeof inline>) {
      lexers.add(this);
      return inline.apply(this, args);
    };
    try {
      for (let index = 0; index < 100; index++) scanMarkdownInfoBlock(":::note\n- a list item\n> a quote\n:::");
    } finally {
      Lexer.prototype.inline = inline;
    }
    expect(lexers.size).toBe(100);
    expect(Math.max(...[...lexers].map((lexer) => lexer.inlineQueue.length))).toBeLessThanOrEqual(2);
  });

  test("locales that share a UI catalog share one extension", () => {
    expect(markdownInfoBlocks({ locale: "de-x-private" })).toBe(markdownInfoBlocks({ locale: "de" }));
    expect(markdownInfoBlocks({ locale: "en-x-000001" })).toBe(markdownInfoBlocks({ locale: "en" }));
    expect(markdownInfoBlocks({ locale: "de" })).not.toBe(markdownInfoBlocks({ locale: "en" }));
  });
});
