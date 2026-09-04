import { describe, expect, test } from "bun:test";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks, QUERY_MAX_COLUMNS, QUERY_MAX_FILTERS } from "./query-blocks";

describe("notebook query blocks", () => {
  test("code fences close only on a bare matching delimiter", () => {
    for (const marker of ["```", "~~~"]) {
      const markdown = `${marker}md\n${marker}not-a-closing-fence\n:::query\nsource: notes\n:::\n:::toc\n:::\n${marker}`;
      expect(parseNotebookQueryBlocks(markdown)).toEqual({ blocks: [], diagnostics: [] });
      expect(parseNotebookTocBlocks(markdown)).toEqual({ blocks: [], diagnostics: [] });
    }
  });

  test("indented code examples do not become directives", () => {
    for (const indent of ["    ", "\t"]) {
      expect(parseNotebookQueryBlocks(`${indent}:::query\n${indent}source: notes\n${indent}:::`)).toEqual({ blocks: [], diagnostics: [] });
      expect(parseNotebookTocBlocks(`${indent}:::toc\n${indent}:::`)).toEqual({ blocks: [], diagnostics: [] });
    }
  });

  test("CRLF fences keep examples inert without hiding following directives", () => {
    const markdown = ["```text", ":::query", "source: notes", ":::", "```", "", ":::query", "source: notes", ":::"].join("\r\n");
    const result = parseNotebookQueryBlocks(markdown);
    expect(result.diagnostics).toEqual([]);
    expect(result.blocks.map((block) => block.line)).toEqual([7]);
  });

  test("parses the bounded query contract into a DOM-free AST", () => {
    const result = parseNotebookQueryBlocks(`:::query
source: notes
scope: descendants
match: all
where:
  - field: $tags
    op: contains-all
    value: [handbook, "internal docs"]
  - field: meta.priority
    op: gte
    value: 2
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - meta.priority
limit: 50
:::`);

    expect(result.diagnostics).toEqual([]);
    expect(result.blocks).toEqual([
      {
        source: "notes",
        scope: "descendants",
        match: "all",
        where: [
          { field: "$tags", op: "contains-all", value: ["handbook", "internal docs"] },
          { field: "meta.priority", op: "gte", value: 2 },
        ],
        sort: { field: "$updated", direction: "desc" },
        columns: ["$title", "meta.priority"],
        limit: 50,
        line: 1,
      },
    ]);
  });

  test("rejects unknown keys, nested filters, formulas, regex and other sources", () => {
    const result = parseNotebookQueryBlocks(`:::query
source: grids
group:
  match: any
where:
  - field: meta.score
    op: regex
    value: /hot.*/
formula: score * 2
:::`);

    expect(result.blocks).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toContain("unknown-key");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "query.source", code: "invalid-type" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ path: "query.where.0.op", code: "invalid-type" }));
  });

  test("rejects unsupported field and operator combinations", () => {
    const result = parseNotebookQueryBlocks(`:::query
source: notes
where:
  - field: $title
    op: gt
    value: 2
  - field: $tags
    op: in
    value: [wiki]
  - field: $updated
    op: eq
    value: tomorrow
:::`);

    expect(result.blocks).toEqual([]);
    expect(result.diagnostics.filter((entry) => entry.path.endsWith(".op"))).toHaveLength(3);
  });

  test("reports duplicate keys, invalid bounds and unclosed blocks", () => {
    const result = parseNotebookQueryBlocks(`:::query
source: notes
source: notes
limit: 101`);

    expect(result.blocks).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate-key", path: "query.source" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-type", path: "query.limit" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unclosed-block", path: "query" }));
  });

  test("rejects duplicate selected columns", () => {
    const result = parseNotebookQueryBlocks(`:::query
source: notes
columns:
  - $title
  - $title
:::`);
    expect(result.blocks).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "duplicate-key", path: "query.columns.1" }));
  });

  test("bounds filters and columns", () => {
    const filters = Array.from({ length: QUERY_MAX_FILTERS + 1 }, () => "  - field: $title\n    op: eq\n    value: Note").join("\n");
    const columns = Array.from({ length: QUERY_MAX_COLUMNS + 1 }, () => "  - $title").join("\n");
    const result = parseNotebookQueryBlocks(`:::query
source: notes
where:
${filters}
columns:
${columns}
:::`);

    expect(result.diagnostics.filter((entry) => entry.code === "too-many-items")).toHaveLength(2);
  });

  test("keeps query-looking content inside scripts inert", () => {
    const result = parseNotebookQueryBlocks(`\`\`\`script
:::query
source: notes
:::
\`\`\`
`);
    expect(result).toEqual({ blocks: [], diagnostics: [] });
  });
});

describe("notebook toc blocks", () => {
  test("parses heading-depth bounds", () => {
    expect(parseNotebookTocBlocks(":::toc\nmin-depth: 2\nmax-depth: 4\n:::")).toEqual({
      blocks: [{ minDepth: 2, maxDepth: 4, line: 1 }],
      diagnostics: [],
    });
  });

  test("rejects unknown settings and inverted bounds", () => {
    const result = parseNotebookTocBlocks(":::toc\nmin-depth: 5\nmax-depth: 2\nlayout: tree\n:::");
    expect(result.blocks).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown-key", path: "toc.layout" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-type", path: "toc.max-depth" }));
  });
});
