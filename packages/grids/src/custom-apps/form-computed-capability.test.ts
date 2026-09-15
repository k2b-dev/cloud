import { expect, test } from "bun:test";
import type { FormConfig } from "../service/forms";
import { type CustomAppFormSecurityField, customAppFormSecurityHash } from "./form-capability";

test("summary publication pins name bindings without treating cosmetic ID-based renames as drift", () => {
  const input = (id: string, name: string): CustomAppFormSecurityField => ({
    id,
    name,
    type: "number",
    tableId: "Bills1",
    config: {},
    required: true,
    defaultValue: null,
    deletedAt: null,
  });
  const original = [input("InputA", "Left"), input("InputB", "Right")];
  const swapped = [input("InputA", "Right"), input("InputB", "Left")];
  const hash = (fields: CustomAppFormSecurityField[], expression: string) =>
    customAppFormSecurityHash({
      tableId: "Bills1",
      config: { fields: original.map((field) => ({ kind: "user_input", fieldId: field.id })), computedFields: [{ fieldId: "Result" }] },
      fields: [...fields, { ...input("Result", "Result"), type: "formula", config: { expression } }],
    });
  expect(hash(original, "Left - Right")).not.toBe(hash(swapped, "Left - Right"));
  expect(hash(original, "InputA - InputB")).toBe(hash(swapped, "InputA - InputB"));
});

test("published form summaries bind their transitive schema but not unrelated fields", () => {
  const fields: CustomAppFormSecurityField[] = [
    { id: "Amount", name: "Amount", tableId: "Bills1", type: "number", config: {}, required: true, defaultValue: null, deletedAt: null },
    {
      id: "Net001",
      name: "Net",
      tableId: "Bills1",
      type: "formula",
      config: { expression: "Amount * 2" },
      required: false,
      defaultValue: null,
      deletedAt: null,
    },
    {
      id: "Gross1",
      name: "Gross",
      tableId: "Bills1",
      type: "formula",
      config: { expression: "Net001 * 1.19" },
      required: false,
      defaultValue: null,
      deletedAt: null,
    },
    { id: "Secret", name: "Secret", tableId: "Bills1", type: "text", config: {}, required: false, defaultValue: null, deletedAt: null },
  ];
  const config: FormConfig = { fields: [{ kind: "user_input", fieldId: "Amount" }], computedFields: [{ fieldId: "Gross1" }] };
  const hash = (input = fields, form = config) => customAppFormSecurityHash({ tableId: "Bills1", config: form, fields: input });
  expect(hash(fields.map((field) => (field.id === "Net001" ? { ...field, config: { expression: "Amount * 3" } } : field)))).not.toBe(
    hash(),
  );
  expect(hash(fields.map((field) => (field.id === "Net001" ? { ...field, deletedAt: "2026-01-01" } : field)))).not.toBe(hash());
  expect(hash(fields.map((field) => (field.id === "Secret" ? { ...field, config: { maxLength: 99 } } : field)))).toBe(hash());
  expect(hash(fields, { ...config, computedFields: [] })).not.toBe(hash());
  expect(hash(fields, { ...config, computedFields: [{ fieldId: "Gross1", label: "New title", helpText: "Helpful explanation" }] })).toBe(hash());
});
