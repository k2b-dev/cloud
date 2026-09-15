import { describe, expect, test } from "bun:test";
import { buildPersistedUpdateData, buildRecordDiff, mapRecordRow, splitRelationsFromData } from "./record-persistence";
import type { Field } from "./types";

const field = (id: string, type: string, patch: Partial<Field> = {}): Field => ({
  id,
  shortId: id.slice(0, 6),
  tableId: "00000000-0000-0000-0000-000000000000",
  name: id,
  description: null,
  type,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("record persistence", () => {
  test("maps database rows into the public record shape", () => {
    expect(
      mapRecordRow({
        id: "record-id",
        short_id: "REC001",
        table_id: "table-id",
        data: { name: "Ada" },
        version: 3,
        deleted_at: null,
        created_by: null,
        updated_by: "user-id",
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        updated_at: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ).toEqual({
      id: "record-id",
      shortId: "REC001",
      tableId: "table-id",
      data: { name: "Ada" },
      version: 3,
      finalizedAt: null,
      finalizedBy: null,
      finalRevisionId: null,
      deletedAt: null,
      createdBy: null,
      updatedBy: "user-id",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  test("separates live relation values from JSONB data", () => {
    const result = splitRelationsFromData({ title: "Book", authors: ["a", 42, "b"], owner: "c", deletedRelation: ["d"] }, [
      field("title", "text"),
      field("authors", "relation"),
      field("owner", "relation"),
      field("deletedRelation", "relation", { deletedAt: "2026-01-02T00:00:00.000Z" }),
    ]);

    expect(result.data).toEqual({ title: "Book", deletedRelation: ["d"] });
    expect(Object.fromEntries(result.relations)).toEqual({ authors: ["a", "b"], owner: ["c"] });
  });

  test("preserves writable and generated id values while stripping computed and relation data", () => {
    expect(
      buildPersistedUpdateData(
        { title: "Old", recordId: "ITEM-0001", relation: ["a"], formula: 10, deleted: "stale", note: "keep" },
        { title: "New", note: null },
        [
          field("title", "text"),
          field("recordId", "id"),
          field("note", "longtext"),
          field("relation", "relation"),
          field("formula", "formula"),
          field("deleted", "text", { deletedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      ),
    ).toEqual({ title: "New", recordId: "ITEM-0001", deleted: "stale" });
  });

  test("reports only semantically changed validated fields", () => {
    expect(buildRecordDiff({ title: "Same", count: 2, cleared: "value" }, { title: "Same", count: 3, cleared: null })).toEqual({
      count: { old: 2, new: 3 },
      cleared: { old: "value", new: null },
    });
  });
});
