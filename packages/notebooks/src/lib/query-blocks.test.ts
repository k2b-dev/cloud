import { describe, expect, test } from "bun:test";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks, QUERY_MAX_COLUMNS, QUERY_MAX_FILTERS } from "./query-blocks";

describe("notebook query blocks", () => {
  const filterQuery = (value: string) =>
    parseNotebookQueryBlocks(`:::query\nsource: notes\nwhere:\n  - field: $title\n    op: in\n    value: ${value}\n:::`);

  test("inline lists preserve apostrophes, escaped backslashes, commas and doubled single quotes", () => {
    for (const [source, expected] of [
      [String.raw`["C:\\", "next"]`, ["C:\\", "next"]],
      [`[O'Reilly, handbook]`, ["O'Reilly", "handbook"]],
      [`['O''Reilly, Inc.', handbook]`, ["O'Reilly, Inc.", "handbook"]],
      [String.raw`["a\"b,c", next]`, ['a"b,c', "next"]],
    ] as const) {
      const result = filterQuery(source);
      expect(result.diagnostics).toEqual([]);
      expect(result.blocks[0]?.where[0]?.value).toEqual([...expected]);
    }
  });

  test("malformed quoted values cannot silently become plain strings", () => {
    for (const value of [`"unterminated`, `'unterminated`, `'a'b'`, `["a" trailing, b]`, `['a' trailing, b]`]) {
      const result = filterQuery(value);
      expect(result.blocks).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  test("trailing whitespace is harmless but explicitly empty enum options are invalid", () => {
    const result = parseNotebookQueryBlocks(
      ":::query\nsource: notes  \nscope: notebook \nmatch: all \nsort:\n  field: $title \n  direction: asc \n:::",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.blocks[0]?.sort).toEqual({ field: "$title", direction: "asc" });
    for (const option of ["scope:", "match:", "sort:\n  field:", "sort:\n  direction:"]) {
      expect(parseNotebookQueryBlocks(`:::query\nsource: notes\n${option}\n:::`).blocks).toEqual([]);
    }
  });

  test("NUL values produce a diagnostic before database execution", () => {
    expect(filterQuery(String.raw`["unsafe\u0000value"]`).blocks).toEqual([]);
  });

  test("unpaired Unicode surrogates are rejected while valid pairs survive", () => {
    for (const value of [String.raw`["\ud800"]`, String.raw`["\udc00"]`, String.raw`["\ud800x"]`]) {
      expect(filterQuery(value).blocks).toEqual([]);
    }
    const result = filterQuery(String.raw`["\ud83d\ude00"]`);
    expect(result.diagnostics).toEqual([]);
    expect(result.blocks[0]?.where[0]?.value).toEqual(["😀"]);
  });

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

  test("directive delimiters use the renderer's space and tab rules", () => {
    for (const type of ["query", "toc"] as const) {
      const parse = type === "query" ? parseNotebookQueryBlocks : parseNotebookTocBlocks;
      const body = type === "query" ? "source: notes\n" : "";
      for (const prefix of ["\u00a0", "\t", "    "]) {
        expect(parse(`${prefix}:::${type}\n${body}:::`).blocks).toEqual([]);
        const invalidClose = parse(`:::${type}\n${body}${prefix}:::`);
        expect(invalidClose.blocks).toEqual([]);
        expect(invalidClose.diagnostics).toContainEqual(expect.objectContaining({ code: "unclosed-block" }));
      }
      for (const indent of ["", " ", "  ", "   "]) {
        expect(parse(`${indent}:::${type}\t\n${body}${indent}:::\t`).blocks).toHaveLength(1);
      }
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
