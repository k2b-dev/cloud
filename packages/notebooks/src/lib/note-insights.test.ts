import { describe, expect, test } from "bun:test";
import { extractTocFromMarkdown } from "./note-insights";

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
