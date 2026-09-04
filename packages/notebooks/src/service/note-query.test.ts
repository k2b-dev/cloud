import { describe, expect, test } from "bun:test";
import type { QueryBlock } from "../lib/query-blocks";
import { resolveNoteQuery, validateNoteQuery } from "./note-query";

const query = (overrides: Partial<QueryBlock> = {}): QueryBlock => ({
  source: "notes",
  scope: "notebook",
  match: "all",
  where: [],
  sort: { field: "$updated", direction: "desc" },
  columns: ["$title"],
  limit: 25,
  line: 1,
  ...overrides,
});

describe("note query validation", () => {
  test("accepts the closed intrinsic, tag, and property operator matrix", () => {
    const valid = query({
      where: [
        { field: "$title", op: "contains", value: "guide" },
        { field: "$created", op: "eq", value: "2026-08-30T10:00:00Z" },
        { field: "$tags", op: "contains-all", value: ["handbook", "policy"] },
        { field: "meta.priority", op: "gte", value: 2 },
        { field: "meta.labels", op: "contains-any", value: ["wiki", 3, true] },
      ],
    });

    expect(validateNoteQuery(valid)).toEqual({ query: valid, diagnostics: [] });
  });

  test("rejects forged AST shapes before SQL execution", () => {
    const invalidQueries = [
      { ...query(), source: "grids" },
      { ...query(), limit: 101 },
      { ...query(), columns: ["$title", "$title"] },
      query({ where: [{ field: "$title", op: "gt", value: 2 }] }),
      query({ where: [{ field: "$tags", op: "in", value: ["wiki"] }] }),
      query({ where: [{ field: "$updated", op: "eq", value: "tomorrow" }] }),
      query({ where: [{ field: "meta.status", op: "eq", value: ["draft"] }] }),
      query({ where: [{ field: "meta.owner", op: "contains", value: 3 }] as QueryBlock["where"] }),
    ];

    for (const input of invalidQueries) {
      expect(validateNoteQuery(input).diagnostics).toEqual([expect.objectContaining({ code: "invalid-query" })]);
    }
  });

  test("rejects unknown keys and oversized filter values", () => {
    expect(validateNoteQuery({ ...query(), rawSql: "SELECT 1" }).diagnostics[0]?.code).toBe("invalid-query");
    expect(
      validateNoteQuery(query({ where: [{ field: "meta.tags", op: "contains-any", value: Array.from({ length: 101 }, (_, i) => i) }] }))
        .diagnostics[0]?.code,
    ).toBe("invalid-query");
  });

  test("does not coerce forged enum values before SQL execution", async () => {
    for (const input of [
      { ...query(), scope: ["notebook"] },
      { ...query(), match: ["all"] },
      { ...query(), sort: { field: ["$title"], direction: "asc" } },
      { ...query(), sort: { field: "$title", direction: ["asc"] } },
    ]) {
      const result = await resolveNoteQuery({
        notebookId: "not-a-uuid",
        noteId: "not-a-uuid",
        query: input,
        userId: null,
      });
      expect(result.diagnostics).toEqual([{ code: "invalid-query", path: "query" }]);
    }
  });

  test("rejects text that exceeds the query budget or cannot be bound to PostgreSQL", async () => {
    for (const [field, op] of [
      ["$title", "eq"],
      ["$tags", "contains"],
      ["meta.owner", "contains"],
      ["meta.owner", "starts-with"],
    ] as const) {
      for (const value of ["x".repeat(2_001), "before\0after", "\ud800", "\udc00"]) {
        const result = await resolveNoteQuery({
          notebookId: "not-a-uuid",
          noteId: "not-a-uuid",
          query: query({ where: [{ field, op, value }] }),
          userId: null,
        });
        expect(result.diagnostics).toEqual([{ code: "invalid-query", path: "query.where.0" }]);
      }
    }
  });

  test("returns invalid-query before touching persistence or access services", async () => {
    const result = await resolveNoteQuery({
      notebookId: "not-a-uuid",
      noteId: "not-a-uuid",
      query: { ...query(), limit: 101 },
      userId: null,
    });
    expect(result).toMatchObject({ items: [], diagnostics: [{ code: "invalid-query", path: "query" }] });
  });
});
