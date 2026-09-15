import { describe, expect, test } from "bun:test";
import { FORMULA_LIMITS } from "../formula/parser";
import { createObjectListEntry, OBJECT_LIST_LIMITS, ObjectListConfigSchema, objectListRecordInputValues, validateObjectList } from "./object-list";

const fields = [
  { id: "Label1", name: "Description", type: "text", required: true, config: { maxLength: 80 } },
  { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2, min: "0" } },
];
const config = { fields };

describe("typed object-list values", () => {
  test("column defaults use scalar validation and initialize independent entries only", () => {
    const config = ObjectListConfigSchema.parse({ fields: [
      { id: "Amount", name: "Amount", type: "number", defaultValue: 0 },
      { id: "Flag01", name: "Flag", type: "boolean", defaultValue: false },
      { id: "Choice", name: "Choice", type: "select", defaultValue: ["one"], config: { multiple: true, options: [{ id: "one", label: "One" }] } },
      { id: "Empty1", name: "Empty", type: "text", defaultValue: null },
      { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
    ] });
    const first = createObjectListEntry(config);
    const second = createObjectListEntry(config);
    expect(first).toEqual({ Amount: "0", Flag01: false, Choice: ["one"] });
    expect(first).toEqual(second);
    expect(first.Choice).not.toBe(second.Choice);
    expect(first.Choice).not.toBe(config.fields[2]!.defaultValue);
    const validated = validateObjectList([{ Amount: null, Flag01: true, Choice: [] }], config, false);
    expect(validated.ok && validated.value?.[0]).toMatchObject({ Amount: null, Flag01: true, Choice: null });
  });

  test.each([
    { type: "number", config: { min: "1" }, defaultValue: "0" },
    { type: "select", config: { options: [{ id: "one", label: "One" }] }, defaultValue: ["missing"] },
    { type: "text", config: { maxLength: 2 }, defaultValue: "long" },
    { type: "date", defaultValue: { kind: "now" } },
    { type: "number", formula: { expression: "1" }, defaultValue: "1" },
  ])("rejects invalid column defaults: %j", (column) => {
    const result = ObjectListConfigSchema.safeParse({ fields: [{ id: "Value1", name: "Value", ...column }] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["fields", 0, "defaultValue"]);
  });

  test("localizes calculation failures without exposing evaluator codes", () => {
    for (const [expression, detail] of [
      ["1 / 0", "Durch null kann nicht geteilt werden."],
      ["POW(10, 1000000)", "Der berechnete Wert ist zu groß. Verkleinere die Werte oder vereinfache die Formel."],
      ["SQRT(-1)", "Der Wert konnte nicht berechnet werden. Prüfe die Formel und ihre Eingabewerte."],
    ] as const) {
      const result = validateObjectList(
        [{}],
        { fields: [{ id: "Result", name: "Ergebnis", type: "number", formula: { expression } }] },
        false,
        { context: { locale: "de" } },
      );
      expect(result).toEqual({
        ok: false,
        error: `Zeile 1, Ergebnis: ${detail}`,
        calculationError: { field: "Ergebnis", detail },
      });
    }
  });

  test("rejects duration overflow through the shared scalar validator", () => {
    const result = validateObjectList(
      [{ Time01: "1e308:00:00" }],
      {
        fields: [{ id: "Time01", name: "Time", type: "duration" }],
      },
      false,
    );
    expect(result.ok).toBe(false);
  });
  test("rejects excessive calculation complexity through the shared field configuration", () => {
    const expression = Array(FORMULA_LIMITS.depth + 1)
      .fill("1")
      .join("+");
    const result = ObjectListConfigSchema.safeParse({
      fields: [{ id: "Result", name: "Result", type: "number", formula: { expression } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["fields", 0, "formula", "expression"]);
      expect(result.error.issues[0]?.message).toContain("levels of nesting");
    }
  });
  test("prepares edit/default snapshots without accepting computed writes or changing unrelated values", () => {
    const config = {
      fields: [
        { id: "Amount", name: "Amount", type: "number" },
        { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
      ],
    };
    const fields = [{ id: "Items1", type: "object_list", config }];
    const stored = { Items1: [{ Amount: "0.10", Total1: "0.2" }], Title1: "Invoice" };
    expect(objectListRecordInputValues(fields, stored)).toEqual({ Items1: [{ Amount: "0.10" }], Title1: "Invoice" });
    expect(stored.Items1[0]?.Total1).toBe("0.2");
    expect(validateObjectList(stored.Items1, config, false).ok).toBe(false);
    expect(objectListRecordInputValues(fields, {})).toEqual({});
    expect(objectListRecordInputValues(fields, { Items1: null })).toEqual({ Items1: null });
    expect(objectListRecordInputValues(fields, { Items1: [] })).toEqual({ Items1: [] });
  });

  test("calculates exact typed row values in dependency order", () => {
    const calculated = {
      fields: [
        { id: "Total1", name: "Total", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "ROUND(Subtotal * 1.19, 2)" } },
        { id: "Qty001", name: "Quantity", type: "number", required: true },
        { id: "Price1", name: "Unit price", type: "number", config: { decimalPlaces: 2 }, required: true },
        {
          id: "Subtot",
          name: "Subtotal",
          type: "number",
          config: { decimalPlaces: 2 },
          formula: { expression: 'Quantity * "Unit price"' },
        },
      ],
    };
    expect(validateObjectList([{ Qty001: "3", Price1: "0.10" }], calculated, true)).toEqual({
      ok: true,
      value: [{ Qty001: "3", Price1: "0.10", Subtot: "0.30", Total1: "0.36" }],
    });
    expect(validateObjectList([{ Qty001: "1", Price1: "9007199254740993.25" }], calculated, true)).toEqual({
      ok: true,
      value: [{ Qty001: "1", Price1: "9007199254740993.25", Subtot: "9007199254740993.25", Total1: "10718567113141781.97" }],
    });
    expect(validateObjectList([{ Qty001: "3", Price1: "0.10", Total1: null }], calculated, true).ok).toBe(false);
    expect(validateObjectList([{ Qty001: "3", Price1: "0.10", Total1: "999" }], calculated, true, { stored: true })).toEqual({
      ok: true,
      value: [{ Qty001: "3", Price1: "0.10", Subtot: "0.30", Total1: "0.36" }],
    });
  });

  test("rejects invalid calculations and applies scalar constraints to results", () => {
    for (const expression of ["1 / 0", "-1", "0.001"]) {
      expect(
        validateObjectList(
          [{}],
          { fields: [{ id: "Amount", name: "Amount", type: "number", config: { min: "0", decimalPlaces: 2 }, formula: { expression } }] },
          true,
        ).ok,
      ).toBe(false);
    }
    for (const expression of ["Outside", "UNKNOWN_FN(1)", "ROUND()", "Amount + 1", ""]) {
      expect(
        ObjectListConfigSchema.safeParse({ fields: [{ id: "Amount", name: "Amount", type: "number", formula: { expression } }] }).success,
      ).toBe(false);
    }
    expect(
      ObjectListConfigSchema.safeParse({
        fields: [
          { id: "First1", name: "First", type: "number", formula: { expression: "Second" } },
          { id: "Second", name: "Second", type: "number", formula: { expression: "First" } },
        ],
      }).success,
    ).toBe(false);
  });

  test("bounds calculated string growth before a later expression can hide it", () => {
    const result = validateObjectList(
      [{ Text01: "x".repeat(OBJECT_LIST_LIMITS.bytes / 2) }],
      {
        fields: [
          { id: "Text01", name: "Text", type: "text" },
          { id: "Short1", name: "Short", type: "text", formula: { expression: "LEFT(CONCAT(Text, Text, Text), 1)" } },
        ],
      },
      false,
    );
    expect(result).toEqual({
      ok: false,
      error: "Row 1, Short: The calculated value is too large. Reduce the values or simplify the formula.",
      calculationError: { field: "Short", detail: "The calculated value is too large. Reduce the values or simplify the formula." },
    });
  });

  test("normalizes through scalar validators without changing the input", () => {
    const input = [{ Label1: "  Consulting  ", Amount: "9007199254740993.25" }];
    expect(validateObjectList(input, config, true)).toEqual({ ok: true, value: [{ Label1: "Consulting", Amount: "9007199254740993.25" }] });
    expect(input[0]?.Label1).toBe("  Consulting  ");
  });

  test("distinguishes absent and empty values and enforces list requirements", () => {
    expect(validateObjectList(null, config, false)).toEqual({ ok: true, value: null });
    expect(validateObjectList([], config, false)).toEqual({ ok: true, value: [] });
    expect(validateObjectList([], config, true).ok).toBe(false);
    expect(validateObjectList(null, { ...config, minItems: 1 }, false).ok).toBe(false);
    expect(validateObjectList([{ Label1: "A" }], config, true)).toEqual({ ok: true, value: [{ Label1: "A", Amount: null }] });
  });

  test("projects removed stored columns without accepting unknown columns in new writes", () => {
    const original = [{ Label1: "Valid", Amount: "12.30", Removed: "Keep in history" }];
    expect(validateObjectList(original, config, false).ok).toBe(false);
    expect(validateObjectList(original, config, false, { stored: true })).toEqual({
      ok: true,
      value: [{ Label1: "Valid", Amount: "12.30" }],
    });
    expect(original[0]?.Removed).toBe("Keep in history");
  });

  test("reports the affected row and field, rejecting the entire value", () => {
    const result = validateObjectList([{ Label1: "Valid" }, { Label1: "Invalid", Amount: "-1" }], config, false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Row 2, Amount:");
    expect(validateObjectList([{ Label1: "" }], config, false)).toEqual({ ok: false, error: "Row 1, Description: required" });
    expect(validateObjectList([{ Label1: "Valid", extra: "data" }], config, false)).toEqual({
      ok: false,
      error: 'Row 1: unknown field "extra"',
    });
  });

  test("rejects nested, cyclic and non-JSON scalar inputs without recursion", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [cycle, [], new Date(), Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
      expect(validateObjectList([{ Label1: "A", Amount: value }], config, false).ok).toBe(false);
    }
    expect(validateObjectList([null], config, false).ok).toBe(false);
    expect(validateObjectList([[]], config, false).ok).toBe(false);
  });

  test("retains the existing select and date contracts", () => {
    const scalarConfig = {
      fields: [
        { id: "Choice", name: "Choice", type: "select", config: { options: [{ id: "a", label: "A" }] } },
        { id: "OnDate", name: "Date", type: "date" },
      ],
    };
    expect(validateObjectList([{ Choice: ["a", "a"], OnDate: "2026-09-10" }], scalarConfig, false)).toEqual({
      ok: true,
      value: [{ Choice: ["a"], OnDate: "2026-09-10" }],
    });
    expect(validateObjectList([{ Choice: ["missing"] }], scalarConfig, false).ok).toBe(false);
    expect(validateObjectList([{ OnDate: "2026-02-30" }], scalarConfig, false).ok).toBe(false);
  });

  test("bounds rows and serialized bytes, including multi-byte text", () => {
    expect(validateObjectList([{ Label1: "A" }, { Label1: "B" }], { ...config, maxItems: 1 }, false).ok).toBe(false);
    const textConfig = { fields: [{ id: "Text01", name: "Text", type: "text" }] };
    const overhead = JSON.stringify([{ Text01: "" }]).length;
    expect(validateObjectList([{ Text01: "x".repeat(OBJECT_LIST_LIMITS.bytes - overhead) }], textConfig, false).ok).toBe(true);
    expect(validateObjectList([{ Text01: "x".repeat(OBJECT_LIST_LIMITS.bytes - overhead + 1) }], textConfig, false).ok).toBe(false);
    expect(validateObjectList([{ Text01: "x".repeat(OBJECT_LIST_LIMITS.bytes) }], textConfig, false).ok).toBe(false);
    expect(validateObjectList([{ Text01: "😀".repeat(OBJECT_LIST_LIMITS.bytes / 3) }], textConfig, false).ok).toBe(false);
  });

  test("rejects ambiguous schemas, nested types and inconsistent bounds", () => {
    expect(ObjectListConfigSchema.safeParse(config).success).toBe(true);
    for (const invalid of [
      { fields: [] },
      { fields: [fields[0], fields[0]] },
      { fields: [fields[0], { ...fields[1], name: "Description" }] },
      { fields: [fields[0], { ...fields[1], name: "label1" }] },
      { fields: [fields[0], { ...fields[1], id: "label1" }] },
      { fields: [{ id: "Nested", name: "Nested", type: "object_list" }] },
      { fields: [{ id: "Relate", name: "Related", type: "relation" }] },
      { fields: [{ id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: -1 } }] },
      { ...config, minItems: 3, maxItems: 2 },
      { ...config, maxItems: OBJECT_LIST_LIMITS.rows + 1 },
    ])
      expect(ObjectListConfigSchema.safeParse(invalid).success).toBe(false);
  });

  test("retains scalar configuration defaults and drops unsupported properties", () => {
    const parsed = ObjectListConfigSchema.parse({
      fields: [
        { id: "Choice", name: "Choice", type: "select", config: { options: [{ id: "a", label: "A" }], extra: true } },
        { id: "Period", name: "Period", type: "duration", config: { min: 500, decimalPlaces: 0, unit: "hours" } },
      ],
    });
    expect(parsed.fields[0]!.config).toEqual({ options: [{ id: "a", label: "A" }], multiple: false });
    expect(parsed.fields[1]!.config).toEqual({ unit: "hours" });
  });
});
