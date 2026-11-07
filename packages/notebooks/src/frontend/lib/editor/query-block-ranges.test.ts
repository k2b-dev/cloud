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

  test("preview messages are fully localized", () => {
    expect(queryBlockMessages.check()).toEqual([]);
  });
});
