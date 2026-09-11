import { describe, expect, test } from "bun:test";
import { getRecordWritableFieldType } from "../field-types";
import { materializeFieldDefault, validateDefaultValue } from "./fields";

test("object-list defaults retain editable values, not calculated assignments", () => {
  const config = {
    fields: [
      { id: "Amount", name: "Amount", type: "number" },
      { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
    ],
  };
  const validated = validateDefaultValue("object_list", config, [{ Amount: "0.10" }]);
  expect(validated).toEqual({ ok: true, data: [{ Amount: "0.1" }] });
  if (!validated.ok) throw validated.error;
  expect(getRecordWritableFieldType("object_list")?.validate(validated.data, config, false)).toEqual({
    ok: true,
    value: [{ Amount: "0.1", Total1: "0.2" }],
  });
});

import type { Field } from "./types";

const dateField = (defaultValue: unknown, includeTime = false): Field => ({
  id: "date",
  shortId: "date",
  tableId: "table",
  name: "date",
  description: null,
  type: "date",
  config: { includeTime },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("date defaults", () => {
  test("accepts dynamic now as the only object default for date fields", () => {
    expect(validateDefaultValue("date", {}, { kind: "now" }).ok).toBe(true);
    expect(validateDefaultValue("date", {}, { kind: "now", value: "2026-01-01" }).ok).toBe(false);
    expect(validateDefaultValue("date", {}, { kind: "fixed", value: "2026-01-01" }).ok).toBe(false);
  });

  test("materializes now server-side", () => {
    const now = new Date("2026-05-01T22:30:00.000Z");
    const value = materializeFieldDefault(dateField({ kind: "now" }), { now, dateConfig: { timeZone: "Europe/Berlin" } });
    expect(value).toBe("2026-05-02");

    const timed = materializeFieldDefault(dateField({ kind: "now" }, true), { now, dateConfig: { timeZone: "Europe/Berlin" } });
    expect(timed).toBe("2026-05-01T22:30:00.000Z");
  });
});

describe("default value write policy", () => {
  test("rejects defaults for computed/system/external field kinds", () => {
    expect(validateDefaultValue("formula", {}, "1 + 1").ok).toBe(false);
    expect(validateDefaultValue("lookup", {}, "anything").ok).toBe(false);
    expect(validateDefaultValue("id", {}, "INV-1").ok).toBe(false);
    expect(validateDefaultValue("file", {}, "anything").ok).toBe(false);
  });

  test("allows relation defaults through the link validator", () => {
    const target = "8d2fc223-a7af-4e77-80e8-35008033479d";
    const config = { targetTableId: "7644cd04-e6c5-4b15-a86f-41f1c9f3598f", cardinality: "single" };
    expect(validateDefaultValue("relation", config, target)).toEqual({ ok: true, data: [target] });
  });
});
