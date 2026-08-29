import { describe, expect, test } from "bun:test";
import { validateRecordQueryForFields } from "./query-validation";
import type { Field } from "./types";

const tableId = "00000000-0000-4000-8000-000000000001";
const textId = "00000000-0000-4000-8000-000000000002";
const fileId = "00000000-0000-4000-8000-000000000003";
const deletedId = "00000000-0000-4000-8000-000000000004";
const missingId = "00000000-0000-4000-8000-000000000099";

const field = (id: string, name: string, type: string, deletedAt: string | null = null): Field => ({
  id,
  shortId: id.slice(-6),
  tableId,
  name,
  description: null,
  icon: null,
  type,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const fields = [
  field(textId, "Name", "text"),
  field(fileId, "Attachment", "file"),
  field(deletedId, "Removed", "text", "2026-01-02T00:00:00.000Z"),
];

const expectBadInput = (query: Parameters<typeof validateRecordQueryForFields>[1], message: string, locale?: string): void => {
  const result = validateRecordQueryForFields(tableId, query, fields, locale);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("BAD_INPUT");
    expect(result.error.message).toContain(message);
  }
};

describe("record query validation", () => {
  test("rejects unknown or deleted fields in every query surface", () => {
    expectBadInput({ filter: { fieldId: missingId, op: "equals", value: "x" } }, "filter is invalid");
    expectBadInput({ sort: [{ fieldId: missingId, direction: "asc" }] }, "sort is invalid");
    expectBadInput({ search: { q: "x", fieldIds: [missingId] } }, "no longer exists");
    expectBadInput({ columns: [{ fieldId: missingId }] }, "no longer exists");
    expectBadInput({ columns: [{ fieldId: deletedId }] }, "no longer exists");
  });

  test("rejects non-searchable fields and invalid computed expressions", () => {
    expectBadInput({ search: { q: "x", fieldIds: [fileId] } }, "Field “Attachment” is not searchable");
    expectBadInput(
      { columns: [{ kind: "computed", id: "computed_parse", label: "Broken", expression: "LEN(" }] },
      "Computed column “Broken”",
    );
    expectBadInput(
      { columns: [{ kind: "computed", id: "computed_ref", label: "Missing", expression: "LEN(Unknown)" }] },
      "no longer exists",
    );
  });

  test("requires grouping before grouped sort and validates grouped fields", () => {
    expectBadInput({ groupSort: [{ fieldId: "*", agg: "count", direction: "desc" }] }, "Group sorting requires a grouping");
    expectBadInput({ groupBy: [{ fieldId: missingId }] }, "grouping is invalid");
  });

  test("accepts one coherent query spanning all supported sections", () => {
    expect(
      validateRecordQueryForFields(
        tableId,
        {
          filter: { fieldId: textId, op: "contains", value: "Ada" },
          search: { q: "Ada", fieldIds: [textId] },
          sort: [{ fieldId: textId, direction: "asc" }],
          columns: [{ fieldId: textId }, { kind: "computed", id: "computed_name", label: "Length", expression: "LEN(Name)" }],
        },
        fields,
      ).ok,
    ).toBe(true);
  });

  test("localizes validation errors for regional German locales", () => {
    expectBadInput({ search: { q: "x", fieldIds: [fileId] } }, "Das Feld „Attachment“ kann nicht durchsucht werden.", "de-CH");
    expectBadInput(
      { columns: [{ kind: "computed", id: "computed_parse", label: "Fehlerhaft", expression: "LEN(" }] },
      "Die berechnete Spalte „Fehlerhaft“ enthält eine ungültige Formel.",
      "de-CH",
    );
  });
});
