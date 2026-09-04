import { describe, expect, spyOn, test } from "bun:test";
import { renderNotebookBook } from "./book-renderer";
import * as context from "./markdown-context";
import { literalMarkdownLines } from "./markdown-context";
import { extractDataBlocks, extractNamedBlocks } from "./named-blocks";
import { extractTocFromMarkdown } from "./note-insights";
import { extractNotebookDirectiveRanges, parseNotebookQueryBlocks, parseNotebookTocBlocks } from "./query-blocks";

describe("document-level notebook blocks", () => {
  test("plain task documents skip container parsing when no queried feature exists", () => {
    const source = "- [ ] Complete a task\n".repeat(4_000);
    const scan = spyOn(context, "literalMarkdownLines");
    try {
      expect(extractNamedBlocks(source)).toEqual([]);
      expect(extractDataBlocks(source)).toEqual([]);
      expect(extractNotebookDirectiveRanges(source)).toEqual([]);
      expect(parseNotebookQueryBlocks(source)).toEqual({ blocks: [], diagnostics: [] });
      expect(parseNotebookTocBlocks(source)).toEqual({ blocks: [], diagnostics: [] });
      expect(extractTocFromMarkdown(source)).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      scan.mockRestore();
    }
  });

  for (const source of [
    "- ```md\n  :::query\n  source: notes\n  :::\n  ```",
    "- item\n  :::query\n  source: notes\n  :::",
    "> :::query\n> source: notes\n> :::",
    "<pre>\n:::query\nsource: notes\n:::\n</pre>",
    ":::info\n:::query\nsource: notes\n:::\n:::",
  ]) {
    test(`keeps container source inert: ${source.split("\n")[0]}`, () => {
      expect(parseNotebookQueryBlocks(source)).toEqual({ blocks: [], diagnostics: [] });
      expect(extractNotebookDirectiveRanges(source)).toEqual([]);
      const rendered = renderNotebookBook({ markdown: source, locale: "en", notebookId: "ABC123" });
      expect(rendered.blocks).toEqual([]);
      expect(rendered.html).not.toContain("NOTEBOOKBOOKSLOT");
      expect(rendered.html).toContain(":::query");
    });
  }

  test("YAML lists cannot absorb following document blocks", () => {
    const source =
      "@profile\n:::data\nteams:\n  - ops\n:::\n\n:::query\nsource: notes\ncolumns:\n  - $title\n:::\n\n:::toc\n:::\n\n## Visible";
    const literal = literalMarkdownLines(source);
    for (const line of [0, 1, 6, 12, 15]) expect(literal.has(line)).toBe(false);
    expect(parseNotebookQueryBlocks(source).blocks.map((block) => block.line)).toEqual([7]);
    const rendered = renderNotebookBook({ markdown: source, locale: "en", notebookId: "ABC123" });
    expect(rendered.blocks.map((block) => block.line)).toEqual([7, 13]);
    expect(rendered.headings.map((heading) => heading.text)).toEqual(["Visible"]);
  });

  test("source geometry after definitions and containers preserves CRLF offsets", () => {
    const source =
      "[link]: https://example.org\r\n\r\n- ```md\r\n  :::query\r\n  source: notes\r\n  :::\r\n  ```\r\n\r\n:::query\r\nsource: notes\r\n:::";
    const ranges = extractNotebookDirectiveRanges(source);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.line).toBe(9);
    expect(source.slice(ranges[0]!.from, ranges[0]!.to)).toBe(":::query\r\nsource: notes\r\n:::");
  });

  test.each(["data", "query", "info"])("lists inside %s cannot swallow an adjacent directive", (kind) => {
    const source = `:::${kind}\n${kind === "query" ? "source: notes\ncolumns:\n  - $title" : "teams:\n  - ops"}\n:::\n:::toc\n:::`;
    const rendered = renderNotebookBook({ markdown: source, locale: "en", notebookId: "ABC123" });
    expect(rendered.blocks.at(-1)!.html).toContain("notebook-book-toc");
    expect(rendered.html).not.toContain(":::toc");
    expect(rendered.html).not.toContain("NOTEBOOKBOOKSLOT");
  });

  test("a notice quote cannot absorb following blocks via lazy continuation", () => {
    const source = ":::info\n> Quote\n:::\n:::toc\n:::";
    const rendered = renderNotebookBook({ markdown: source, locale: "en", notebookId: "ABC123" });
    expect(rendered.blocks).toHaveLength(1);
    expect(rendered.blocks[0]!.html).toContain("notebook-book-toc");
    expect(rendered.html).toContain("<blockquote>");
  });
});
