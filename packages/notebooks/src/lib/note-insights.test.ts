import { describe, expect, test } from "bun:test";
import { extractHeadingLines, extractTocFromMarkdown, headingAtLine } from "./note-insights";

describe("note insights", () => {
  test("code info strings cannot close fences or hide following headings", () => {
    const md = "```text\n```example\n# Hidden\n```\n# Visible";
    expect(extractTocFromMarkdown(md).map((item) => item.text)).toEqual(["Visible"]);
  });

  test("extracts only headings inside the selected depth", () => {
    expect(extractTocFromMarkdown("# One\n## Two\n### Three", { minDepth: 2, maxDepth: 2 })).toEqual([
      { level: 2, text: "Two", id: "two" },
    ]);
  });

  test("ignores headings inside code and directive fences", () => {
    const md = `# Visible
\`\`\`md
## Code
\`\`\`
:::query
# Query value
:::
## Also visible`;
    expect(extractTocFromMarkdown(md).map((item) => item.text)).toEqual(["Visible", "Also visible"]);
  });
});

test("line-to-heading mapping shares TOC ids and skips literal headings", () => {
  const markdown = "Intro\n# First\nbody\n```md\n# Hidden\n```\n:::query\n# Also hidden\n:::\n## First\nTail";
  const headings = extractHeadingLines(markdown);
  expect(headings.map(({ line, id }) => ({ line, id }))).toEqual([
    { line: 2, id: "first" },
    { line: 10, id: "first-1" },
  ]);
  expect(headings.map(({ line: _line, ...item }) => item)).toEqual(extractTocFromMarkdown(markdown));
  expect(headingAtLine(headings, 1)).toBeNull();
  expect(headingAtLine(headings, 2)?.id).toBe("first");
  expect(headingAtLine(headings, 9)?.id).toBe("first");
  expect(headingAtLine(headings, 10)?.id).toBe("first-1");
  expect(headingAtLine(headings, 99)?.id).toBe("first-1");
  expect(headingAtLine([], 1)).toBeNull();
});
