import { describe, expect, test } from "bun:test";
import {
  extractDataBlocks,
  extractNamedBlocks,
  extractNamedDataProperties,
  parseNamedDataBlockResult,
  renderNamedBlockHandlesMarkdown,
} from "./named-blocks";

describe("named blocks", () => {
  test("legacy script fences have no executable named-block type", () => {
    const blocks = extractNamedBlocks("@legacy\n```script\nkit.ui.text('hello');\n```\n");
    expect(blocks.map(({ name, type }) => ({ name, type }))).toEqual([{ name: "legacy", type: "unknown" }]);
  });

  test("detects named block types in the current note", () => {
    const blocks = extractNamedBlocks(`@ideas
| Idea | Tags |
|---|---|
| Treehouse | #garden |

@shopping
- nails
- paint

@recipe
:::data
flour: 40
water: 20
:::

@materials
## Materials
Wood
`);

    expect(blocks.map((block) => [block.name, block.type])).toEqual([
      ["ideas", "table"],
      ["shopping", "list"],
      ["recipe", "data"],
      ["materials", "section"],
    ]);
  });

  test("does not treat handles inside fenced code as named blocks", () => {
    const blocks = extractNamedBlocks(`\`\`\`script
@insideCode
\`\`\`

@outside
- one
`);

    expect(blocks.map((block) => block.name)).toEqual(["outside"]);
  });

  test("does not extract data blocks inside tilde fences", () => {
    expect(
      extractDataBlocks(`~~~md
:::data
status: hidden
:::
~~~`),
    ).toEqual([]);
  });

  test("detects nested handles inside named sections", () => {
    const blocks = extractNamedBlocks(`@review
# Review

- Use the weekly review button after a few daily notes.

@fooo
## Starter links

- [2026](note://abc123)
`);

    expect(blocks.map((block) => [block.name, block.type])).toEqual([
      ["review", "section"],
      ["fooo", "section"],
    ]);
  });

  test("renders only real handles for markdown output", () => {
    const rendered = renderNamedBlockHandlesMarkdown(`\`\`\`script
@insideCode
\`\`\`

@outside
- one
`);

    expect(rendered).toContain("@insideCode");
    expect(rendered).toContain('data-block-name="outside"');
    expect(rendered).not.toContain('data-block-name="insideCode"');
  });

  test("renders named data blocks as pretty html", () => {
    const rendered = renderNamedBlockHandlesMarkdown(`@recipe
:::data
flour: 40
tags:
  - bread
  - weekend
:::
`);

    expect(rendered).toContain('class="md-data-block"');
    expect(rendered).toContain('data-block-name="recipe"');
    expect(rendered).toContain("Flour");
    expect(rendered).toContain("bread");
    expect(rendered).not.toContain(":::data");
  });

  test("extracts and renders unnamed data blocks as pretty html", () => {
    const source = `Intro

:::data
flour: 40
water: 20
:::
`;
    const blocks = extractDataBlocks(source);
    const rendered = renderNamedBlockHandlesMarkdown(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.name).toBeNull();
    expect(rendered).toContain('class="md-data-block"');
    expect(rendered).toContain('class="md-data-handle-row"');
    expect(rendered).toContain("add @ref to use in scripts");
    expect(rendered).toContain("Flour");
    expect(rendered).toContain("Water");
    expect(rendered).not.toContain(":::data");
  });

  test("parses typed flat data without executing YAML features", () => {
    const result = parseNamedDataBlockResult(`title: "Handbook"
priority: 3
published: true
tags:
  - wiki
  - 2026
  - false
unsafe: !include secrets.md`);

    expect(result.entries).toEqual([
      { key: "title", value: "Handbook" },
      { key: "priority", value: 3 },
      { key: "published", value: true },
      { key: "tags", value: ["wiki", 2026, false] },
    ]);
    expect(result.diagnostics).toEqual([{ code: "invalid-value", line: 8, path: "unsafe" }]);
  });

  test("keeps the first duplicate data key and reports malformed nesting", () => {
    const result = parseNamedDataBlockResult(`status: draft
status: published
nested:
  child: value`);

    expect(result.entries).toEqual([
      { key: "status", value: "draft" },
      { key: "nested", value: [] },
    ]);
    expect(result.diagnostics).toEqual([
      { code: "duplicate-key", line: 2, path: "status" },
      { code: "unexpected-line", line: 4, path: "data" },
    ]);
  });

  test("projects only valid, uniquely named data blocks deterministically", () => {
    const source = `@meta
:::data
status: reviewed
priority: 3
:::

@meta
:::data
status: draft
:::

@book
:::data
published: true
authors:
  - Ada
  - Grace
:::

:::data
ignored: unnamed
:::`;
    const first = extractNamedDataProperties(source);

    expect(first.properties).toEqual({ book: { published: true, authors: ["Ada", "Grace"] } });
    expect(first.diagnostics).toEqual([{ code: "duplicate-block", line: 1, path: "meta" }]);
    expect(extractNamedDataProperties(source)).toEqual(first);
  });
});
