import { describe, expect, test } from "bun:test";
import type { Field } from "../../../service";
import { initialFieldInputValue, isRecordInputField, sanitizeFieldValues } from "./field-render";

const field = (patch: Partial<Field> & Pick<Field, "id" | "type">): Field => ({
  shortId: patch.id.slice(0, 6),
  tableId: "table",
  name: patch.id,
  description: null,
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

describe("field-render helpers", () => {
  test("object-list edits contain only input cells without changing the loaded snapshot", () => {
    const list = field({
      id: "Items1",
      type: "object_list",
      config: {
        fields: [
          { id: "Amount", name: "Amount", type: "number" },
          { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
        ],
      },
    });
    const snapshot = [{ Amount: "9007199254740993.25", Total1: "18014398509481986.5" }];
    expect(initialFieldInputValue(list, snapshot)).toEqual([{ Amount: "9007199254740993.25" }]);
    expect(snapshot[0]?.Total1).toBe("18014398509481986.5");
    expect(initialFieldInputValue({ ...list, defaultValue: snapshot })).toEqual([{ Amount: "9007199254740993.25" }]);
    expect(initialFieldInputValue({ ...list, defaultValue: snapshot }, null)).toBeNull();
    for (const omitEmpty of [false, true]) {
      expect(sanitizeFieldValues([list], { Items1: [] }, { omitEmpty })).toEqual({ Items1: [] });
    }
    // Submission must not silently accept an attempted computed-cell write.
    expect(sanitizeFieldValues([list], { Items1: snapshot })).toEqual({ Items1: snapshot });
  });

  test("record input field support excludes computed and system fields", () => {
    expect(isRecordInputField("text")).toBe(true);
    expect(isRecordInputField("relation")).toBe(true);
    expect(isRecordInputField("object_list")).toBe(true);
    expect(isRecordInputField("formula")).toBe(false);
    expect(isRecordInputField("created_at")).toBe(false);
  });

  test("select and relation inputs normalize to id arrays", () => {
    const fields = [
      field({ id: "status", type: "select" }),
      field({ id: "tags", type: "select", config: { multiple: true } }),
      field({ id: "parent", type: "relation" }),
    ];
    expect(
      sanitizeFieldValues(fields, {
        status: "open",
        tags: ["a", "", "b"],
        parent: "record-id",
      }),
    ).toEqual({
      status: ["open"],
      tags: ["a", "b"],
      parent: ["record-id"],
    });
  });

  test("single select keeps one value and create mode omits empty fields", () => {
    const fields = [field({ id: "status", type: "select" }), field({ id: "title", type: "text" })];
    expect(sanitizeFieldValues(fields, { status: ["open", "closed"], title: "" }, { omitEmpty: true })).toEqual({
      status: ["open"],
    });
  });

  test("initial values preserve defaults but keep now dates empty for server resolution", () => {
    expect(initialFieldInputValue(field({ id: "done", type: "boolean" }))).toBe(false);
    expect(initialFieldInputValue(field({ id: "due", type: "date", defaultValue: { kind: "now" } }))).toBe("");
    expect(initialFieldInputValue(field({ id: "owner", type: "relation" }), "abc")).toEqual(["abc"]);
  });
});
