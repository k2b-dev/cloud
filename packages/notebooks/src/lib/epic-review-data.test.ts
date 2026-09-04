import { describe, expect, test } from "bun:test";
import { extractDataBlocks, extractNamedBlocks, extractNamedDataProperties } from "./named-blocks";
import { parseNotebookQueryBlocks } from "./query-blocks";

describe("epic data review regressions", () => {
  test("headings inside code fences do not truncate named sections", () => {
    const source = "@policy\n# Policy\n\n```md\n# Example heading\n```\nActual policy text\n\n# Next";
    const section = extractNamedBlocks(source)[0]!;
    expect(section.type).toBe("section");
    expect(source.slice(section.blockStart, section.blockEnd)).toContain("Actual policy text");
    expect(source.slice(section.blockStart, section.blockEnd)).not.toContain("# Next");
  });

  test("named lists retain their owner while code examples within them stay inert", () => {
    const source = "@steps\n- ```md\n  @hidden\n  :::data\n  status: wrong\n  :::\n  ```\n\n@real\n:::data\nstatus: right\n:::";
    expect(extractNamedBlocks(source).map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "steps", type: "list" },
      { name: "real", type: "data" },
    ]);
  });

  test("an owner before indented list or table source remains unknown", () => {
    for (const body of ["    - not a real list\n    - code", "    | Name |\n    | --- |\n    | Code |", "\t- code"]) {
      expect(extractNamedBlocks(`@example\n${body}\n`).map(({ type }) => type)).toEqual(["unknown"]);
    }
    for (const indent of ["", " ", "  ", "   "]) {
      expect(extractNamedBlocks(`@steps\n${indent}- Real step\n`)[0]?.type).toBe("list");
    }
  });

  test("query list options do not hide following properties", () => {
    const source = ":::query\nsource: notes\ncolumns:\n  - $title\n:::\n\n@real\n:::data\nstatus: right\n:::";
    expect(extractNamedDataProperties(source).properties).toEqual({ real: { status: "right" } });
    expect(extractNamedDataProperties(source.replace(":::\n\n@real", ":::\n@real")).properties).toEqual({ real: { status: "right" } });
  });

  test("notice headings do not truncate their surrounding named section", () => {
    const source = "@policy\n# Policy\n\n:::info\n# Example heading\n:::\nActual policy text\n\n# Next";
    const section = extractNamedBlocks(source)[0]!;
    expect(source.slice(section.blockStart, section.blockEnd)).toContain("Actual policy text");
    expect(source.slice(section.blockStart, section.blockEnd)).not.toContain("# Next");
  });

  test("a quote inside a notice cannot consume following named data", () => {
    const source = ":::info\n> Quote\n:::\n@real\n:::data\nstatus: right\n:::";
    expect(extractNamedDataProperties(source).properties).toEqual({ real: { status: "right" } });
  });

  for (const language of ["script", "typescript", ""]) {
    test(`a named ${language || "plain"} code fence stays inert`, () => {
      const source = `@legacy\n\`\`\`${language}\n@hidden\n:::data\nstatus: wrong\n:::\n\`\`\`\n\n@real\n:::data\nstatus: right\n:::`;
      expect(extractNamedDataProperties(source)).toEqual({ properties: { real: { status: "right" } }, diagnostics: [] });
    });
  }

  for (const value of [
    "2026-02-30T12:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "0000-01-01T00:00:00Z",
    "2026-01-01T12:00:00+16:00",
  ]) {
    test(`rejects invalid calendar instant ${value}`, () => {
      const source = `:::query\nsource: notes\nwhere:\n  - field: $created\n    op: eq\n    value: ${value}\n:::`;
      const parsed = parseNotebookQueryBlocks(source);
      expect(parsed.blocks).toEqual([]);
      expect(parsed.diagnostics).toHaveLength(1);
    });
  }

  test("accepts leap day and an explicit timezone", () => {
    const source = ":::query\nsource: notes\nwhere:\n  - field: $created\n    op: eq\n    value: 2024-02-29T12:34:56+02:00\n:::";
    expect(parseNotebookQueryBlocks(source).blocks).toHaveLength(1);
  });

  test("fence-like code content does not expose hidden properties", () => {
    const source = "```markdown\n```typescript\n@hidden\n:::data\nstatus: wrong\n:::\n```\n@real\n:::data\nstatus: right\n:::";
    expect(extractNamedDataProperties(source).properties).toEqual({ real: { status: "right" } });
    expect(extractDataBlocks(source)).toHaveLength(1);
  });

  test("indented data examples are not properties or rendered blocks", () => {
    const source = "    @hidden\n    :::data\n    status: wrong\n    :::\n\n@alsoHidden\n    :::data\n    status: wrong\n    :::";
    expect(extractNamedDataProperties(source).properties).toEqual({});
    expect(extractDataBlocks(source)).toEqual([]);
  });

  test("CRLF data blocks preserve typed properties", () => {
    expect(extractNamedDataProperties("@meta\r\n:::data\r\nstatus: ready\r\nrank: 2\r\n:::").properties).toEqual({
      meta: { status: "ready", rank: 2 },
    });
  });

  for (const example of [
    "- ```md\n  @hidden\n  :::data\n  status: wrong\n  :::\n  ```",
    ":::note\n@hidden\n:::data\nstatus: wrong\n:::",
    ":::info\n- ```md\n  :::\n  @hidden\n  :::data\n  status: wrong\n  :::\n  ```\n:::",
  ]) {
    test(`nested data remains inert: ${example.split("\n")[0]}`, () => {
      const source = `${example}\n\n@real\n:::data\nstatus: right\n:::`;
      expect(extractNamedDataProperties(source).properties).toEqual({ real: { status: "right" } });
      expect(extractDataBlocks(source).map((block) => block.name)).toEqual(["real"]);
    });
  }
});
