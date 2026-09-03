import { describe, expect, test } from "bun:test";
import { extractNotebookDirectiveRanges, parseNotebookQueryBlocks } from "../../../lib/query-blocks";
import { queryBlockMessages } from "./query-block-messages";

describe("shared directive source geometry", () => {
  test("ranges cover complete directive source and match parser line keys", () => {
    const markdown = "# Title\n\n:::query\nsource: notes\n:::\n\n:::toc\nmax-depth: 3\n:::";
    const ranges = extractNotebookDirectiveRanges(markdown);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.line).toBe(parseNotebookQueryBlocks(markdown).blocks[0]!.line);
    expect(markdown.slice(ranges[0]!.from, ranges[0]!.to)).toBe(":::query\nsource: notes\n:::");
    expect(markdown.slice(ranges[1]!.from, ranges[1]!.to)).toBe(":::toc\nmax-depth: 3\n:::");
  });

  test("invalid and unclosed directives retain editable source ranges", () => {
    const markdown = ":::query\nwrong: value\n:::\n\n:::toc\nmax-depth: 9";
    const ranges = extractNotebookDirectiveRanges(markdown);
    expect(ranges[0]!.closed).toBe(true);
    expect(ranges[1]!.closed).toBe(false);
    expect(ranges[1]!.to).toBe(markdown.length);
  });

  test("directive examples inside both fence forms remain literal code", () => {
    const markdown = "```markdown\n:::query\nsource: notes\n:::\n```\n\n~~~script\n:::toc\n:::\n~~~";
    expect(extractNotebookDirectiveRanges(markdown)).toEqual([]);
  });

  test("CRLF offsets still select the original complete block", () => {
    const markdown = "Title\r\n:::query\r\nsource: notes\r\n:::\r\nEnd";
    const [range] = extractNotebookDirectiveRanges(markdown);
    expect(range?.line).toBe(2);
    expect(markdown.slice(range!.from, range!.to).trim()).toBe(":::query\r\nsource: notes\r\n:::");
  });

  test("preview messages are fully localized", () => {
    expect(queryBlockMessages.check()).toEqual([]);
  });
});
