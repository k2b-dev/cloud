import { describe, expect, test } from "bun:test";
import {
  type FormComputedField,
  inspectFormComputedFields,
  planFormComputedFields,
  previewFormComputedFields,
} from "./form-computed-fields";
import { formComputedDiagnosticMessage } from "./form-computed-messages";

const field = (id: string, type: string, config: Record<string, unknown>): FormComputedField => ({
  id,
  name: id,
  type,
  config,
  required: true,
});
const inputs = new Set(["Items1"]);
const fields = [
  field("Items1", "object_list", {
    minItems: 1,
    fields: [
      { id: "Price1", name: "Price", type: "number", required: true, config: { decimalPlaces: 2 } },
      {
        id: "Vat001",
        name: "Rate",
        type: "select",
        required: true,
        config: {
          multiple: false,
          options: [
            { id: "vat007", label: "7%" },
            { id: "vat019", label: "19%" },
          ],
        },
      },
      {
        id: "Net007",
        name: "Low rate",
        type: "number",
        required: false,
        config: { decimalPlaces: 2 },
        formula: { expression: "IF(HAS_OPTION(Vat001, 'vat007'), Price1, 0)" },
      },
      {
        id: "Net019",
        name: "High rate",
        type: "number",
        required: false,
        config: { decimalPlaces: 2 },
        formula: { expression: "IF(HAS_OPTION(Vat001, 'vat019'), Price1, 0)" },
      },
    ],
  }),
  field("Net007", "formula", { expression: "LIST_SUM(Items1, 'Net007')" }),
  field("Net019", "formula", { expression: "LIST_SUM(Items1, 'Net019')" }),
  field("Total1", "formula", { expression: "Net007 + Net019 + ROUND(Net007 * 0.07, 2) + ROUND(Net019 * 0.19, 2)" }),
];

describe("form computed summaries", () => {
  test("authoring diagnostics distinguish actionable causes without returning schema data", () => {
    const amount = field("Amount", "number", {});
    const result = (expression: string) => field("Result", "formula", { expression });
    const cases = [
      { code: "missing", fields: [result("Absent + 1")] },
      { code: "syntax", fields: [result("1 +")] },
      { code: "cycle", fields: [result("Result + 1")] },
      { code: "hidden", fields: [amount, result("Amount + 1")] },
      { code: "unsupported", fields: [field("Amount", "lookup", {}), result("Amount + 1")] },
      { code: "ambiguous", fields: [amount, { ...field("Other1", "number", {}), name: "Amount" }, result("Amount + 1")] },
    ] as const;
    for (const entry of cases) {
      const inspected = inspectFormComputedFields(["Result"], new Set<string>(), entry.fields);
      expect(inspected).toEqual({ ok: false, code: entry.code });
      expect(planFormComputedFields(["Result"], new Set<string>(), entry.fields)).toBeNull();
      expect(formComputedDiagnosticMessage(entry.code, "de")).not.toEqual(formComputedDiagnosticMessage(entry.code, "en"));
    }
    expect(inspectFormComputedFields(["Amount"], new Set(["Amount"]), [amount])).toEqual({ ok: false, code: "target" });
    expect(inspectFormComputedFields(["Result", "Result"], new Set(["Amount"]), [amount, result("Amount")])).toEqual({
      ok: false,
      code: "duplicate",
    });
  });
  test("ambiguous short ID/name references fail closed in internal and public schemas", () => {
    for (const internal of [false, true]) {
      const amount = { ...field(internal ? "internal-amount" : "Amount", "number", {}), shortId: "Amount", name: "Unit price" };
      const other = { ...field("Other1", "number", {}), name: "Amount" };
      const result = field("Result", "formula", { expression: "{Amount} * 2" });
      expect(previewFormComputedFields(["Result"], new Set([amount.id]), [amount, result], { [amount.id]: "3" })).toEqual({
        kind: "values",
        values: { Result: "6" },
      });
      expect(previewFormComputedFields(["Result"], new Set([amount.id]), [amount, other, result], { [amount.id]: "3" })).toEqual({
        kind: "error",
      });
    }
  });
  test("previews canonical exact list calculations without mutating inputs or accepting supplied totals", () => {
    const values = {
      Items1: [
        { Price1: "0.03", Vat001: ["vat019"] },
        { Price1: "0.03", Vat001: ["vat019"] },
      ],
      Total1: "999",
    };
    const before = structuredClone(values);
    expect(previewFormComputedFields(["Total1"], inputs, fields, values)).toEqual({ kind: "values", values: { Total1: "0.07" } });
    expect(values).toEqual(before);
    expect(previewFormComputedFields(["Total1"], inputs, fields, { Items1: [] })).toEqual({ kind: "incomplete" });
  });
  test("rejects hidden inputs, external computed data, missing fields and cycles", () => {
    for (const source of [field("Hidden", "number", {}), field("Hidden", "lookup", {}), field("Hidden", "relation", {})]) {
      expect(
        planFormComputedFields(["Result"], inputs, [...fields, source, field("Result", "formula", { expression: "Hidden + 1" })]),
      ).toBeNull();
    }
    expect(planFormComputedFields(["Result"], inputs, [field("Result", "formula", { expression: "Missing + 1" })])).toBeNull();
    expect(planFormComputedFields(["Result"], inputs, [field("Result", "formula", { expression: "Result + 1" })])).toBeNull();
    expect(planFormComputedFields(["Items1"], inputs, fields)).toBeNull();
    expect(planFormComputedFields(["Total1", "Total1"], inputs, fields)).toBeNull();
  });
  test("returns only the necessary dependency metadata", () => {
    const plan = planFormComputedFields(["Total1"], inputs, [...fields, field("Secret", "text", {})]);
    expect(plan?.fields.map((item) => item.id)).toEqual(fields.map((item) => item.id));
    expect(Object.values(plan?.refs ?? {})).not.toContain("Secret");
  });
  test("distinguishes incomplete input from formula errors without exposing raw codes", () => {
    const simple = [field("Amount", "number", {}), field("Result", "formula", { expression: "1 / Amount" })];
    for (const value of ["", "bad"]) {
      expect(previewFormComputedFields(["Result"], new Set(["Amount"]), simple, { Amount: value })).toEqual({ kind: "incomplete" });
    }
    expect(previewFormComputedFields(["Result"], new Set(["Amount"]), simple, { Amount: "0" })).toEqual({ kind: "error" });
    expect(previewFormComputedFields(["Result"], new Set(["Amount"]), simple, { Amount: "4" })).toEqual({
      kind: "values",
      values: { Result: "0.25" },
    });
    expect(
      previewFormComputedFields(["Result"], new Set(["Amount"]), [field("Amount", "number", { decimalPlaces: -1 }), simple[1]!], {
        Amount: "4",
      }),
    ).toEqual({ kind: "error" });
  });
  test("distinguishes owned-row calculation errors from missing row input", () => {
    const list = field("Items1", "object_list", {
      fields: [
        { id: "Amount", name: "Amount", type: "number", required: true, config: {} },
        { id: "Total1", name: "Total", type: "number", config: {}, formula: { expression: "1 / Amount" } },
      ],
    });
    const total = field("Result", "formula", { expression: "LIST_SUM(Items1, 'Total1')" });
    expect(previewFormComputedFields(["Result"], inputs, [list, total], { Items1: [{ Amount: "0" }] })).toEqual({ kind: "error" });
    expect(previewFormComputedFields(["Result"], inputs, [list, total], { Items1: [{}] })).toEqual({ kind: "incomplete" });
  });
});
