import { describe, expect, test } from "bun:test";
import type { Field } from "../../../service";
import { buildFormSubmitPayload } from "./form-submit-payload";

const relationField = (id: string): Field =>
  ({
    id,
    tableId: "00000000-0000-0000-0000-000000000001",
    shortId: "rel01",
    name: "relation",
    type: "relation",
    description: null,
    icon: null,
    config: { targetTableId: "00000000-0000-0000-0000-000000000002", cardinality: "multiple" },
    required: false,
    presentable: false,
    hideInTable: false,
    defaultValue: null,
    indexed: false,
    uniqueConstraint: false,
    position: 0,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as Field;

describe("buildFormSubmitPayload", () => {
  test("preserves explicitly cleared lists in new inline records while dropping untouched drafts", () => {
    const relation = relationField("REL001");
    const result = buildFormSubmitPayload(
      [relation],
      { REL001: ["tmp_cleared", "tmp_untouched"] },
      {
        REL001: [
          { tempId: "tmp_cleared", data: { Items1: [], Select: [], Amount: "0.00" } },
          { tempId: "tmp_untouched", data: {} },
        ],
      },
      { idempotencyKey: "clear-list" },
    );
    expect(result).toEqual({
      data: { REL001: ["tmp_cleared"] },
      inlineCreates: { REL001: [{ tempId: "tmp_cleared", data: { Items1: [], Select: [], Amount: "0.00" } }] },
      idempotencyKey: "clear-list",
    });
  });

  test("separates edited rows from new rows and replaces only their temporary UI identities", () => {
    const fieldId = "REL001";
    expect(
      buildFormSubmitPayload(
        [relationField(fieldId)],
        { [fieldId]: ["tmp_old", "tmp_new"] },
        {
          [fieldId]: [
            { tempId: "tmp_old", existing: { id: "REC001", version: 3 }, data: { name: "", price: "0" } },
            { tempId: "tmp_new", data: { name: "New" } },
          ],
        },
        { omitEmpty: false, recordVersion: 7, idempotencyKey: "save" },
      ),
    ).toEqual({
      version: 7,
      idempotencyKey: "save",
      data: { [fieldId]: ["REC001", "tmp_new"] },
      inlineUpdates: { [fieldId]: [{ recordId: "REC001", version: 3, data: { name: "", price: "0" } }] },
      inlineCreates: { [fieldId]: [{ tempId: "tmp_new", data: { name: "New" } }] },
    });
  });
  test("retains an explicit empty relation when all existing rows are removed", () => {
    const fieldId = "REL001";
    const result = buildFormSubmitPayload(
      [relationField(fieldId)],
      { [fieldId]: [] },
      { [fieldId]: [] },
      { omitEmpty: false, recordVersion: 1, idempotencyKey: "remove" },
    );
    expect(result.data).toEqual({ [fieldId]: [] });
  });
  test("includes a stable submission key in an envelope even without inline records", () => {
    expect(buildFormSubmitPayload([], {}, {}, { idempotencyKey: "attempt-one" })).toEqual({
      data: {},
      inlineCreates: {},
      idempotencyKey: "attempt-one",
    });
  });
  test("drops empty inline drafts and their temp relation ids", () => {
    const fieldId = "00000000-0000-0000-0000-000000000003";

    expect(
      buildFormSubmitPayload(
        [relationField(fieldId)],
        { [fieldId]: ["existing-id", "tmp_empty", "tmp_filled"] },
        {
          [fieldId]: [
            { tempId: "tmp_empty", data: {} },
            { tempId: "tmp_filled", data: { name: "New target" } },
          ],
        },
      ),
    ).toEqual({
      data: { [fieldId]: ["existing-id", "tmp_filled"] },
      inlineCreates: { [fieldId]: [{ tempId: "tmp_filled", data: { name: "New target" } }] },
    });
  });
});
