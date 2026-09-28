import { describe, expect, test } from "bun:test";
import { filterSearchableFields } from "../searchable-fields";
import { optionIdsMatchingSearch } from "./search";
import type { Field } from "./types";

const mkField = (id: string, type: string, patch: Partial<Field> = {}): Field => ({
  id,
  shortId: id.slice(0, 6),
  tableId: "t1",
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
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...patch,
});

describe("search field targeting", () => {
  test("UI search scope includes SQL-searchable scalar, select, and relation fields", () => {
    const fields = [
      mkField("txt", "text"),
      mkField("dec", "number"),
      mkField("num", "number"),
      mkField("dat", "date"),
      mkField("boo", "boolean"),
      mkField("sel", "select"),
      mkField("mul", "select"),
      mkField("rel", "relation"),
      mkField("json", "json"),
      mkField("file", "file"),
      mkField("formula", "formula"),
      mkField("lookup", "lookup"),
      mkField("deleted", "text", { deletedAt: "2026-01-01T00:00:00Z" }),
    ];

    expect(filterSearchableFields(fields).map((f) => f.id)).toEqual(["txt", "dec", "num", "dat", "boo", "sel", "mul", "rel"]);
  });

  test("select search targets option labels, not only stored ids", () => {
    const field = mkField("status", "select", {
      config: {
        options: [
          { id: "todo", label: "To do" },
          { id: "in_progress", label: "In Progress" },
          { id: "done", label: "Done" },
        ],
      },
    });

    expect(optionIdsMatchingSearch(field, "progress")).toEqual(["in_progress"]);
    expect(optionIdsMatchingSearch(field, "DO")).toEqual(["todo", "done"]);
    expect(optionIdsMatchingSearch(field, "missing")).toEqual([]);
  });
});
