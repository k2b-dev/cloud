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

const { LocaleProvider } = await import("../intl/locale");
const { default: MarkdownView, renderSafeMarkdown } = await import("./MarkdownView");
const { renderMarkdownInfoBlock, scanMarkdownInfoBlock } = await import("./markdown-info-blocks");
const contentCss = await Bun.file(resolve(import.meta.dir, "../styles/content-parity.css")).text();

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
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a>');
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

  test("the body's outer margins collapse inside the card", () => {
    expect(contentCss).toMatch(/\.k2b-content-markdown \.k2b-notice-card__body > :first-child \{\s*margin-block-start: 0;/);
    expect(contentCss).toMatch(/\.k2b-content-markdown \.k2b-notice-card__body > :last-child \{\s*margin-block-end: 0;/);
  });
});
