import { describe, expect, test } from "bun:test";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks, QUERY_MAX_COLUMNS, QUERY_MAX_FILTERS } from "./query-blocks";

describe("notebook query blocks", () => {
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
