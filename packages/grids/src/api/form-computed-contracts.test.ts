import { expect, test } from "bun:test";
import { FormConfigSchema } from "../contracts";
import { PublicFormConfigSchema } from "./public-dto";

for (const [name, schema, fieldId] of [
  ["internal", FormConfigSchema, "11111111-1111-4111-8111-111111111111"],
  ["public", PublicFormConfigSchema, "FIELD1"],
] as const) {
  test(`${name} form summaries enforce identical count and presentation budgets`, () => {
    const entry = { fieldId, label: "a".repeat(200), helpText: "b".repeat(2_000) };
    const config = { fields: [], computedFields: Array.from({ length: 20 }, () => ({ ...entry })) };
    expect(schema.safeParse(config).success).toBe(true);
    expect(schema.safeParse({ ...config, computedFields: [...config.computedFields, entry] }).success).toBe(false);
    expect(schema.safeParse({ fields: [], computedFields: [{ ...entry, label: "a".repeat(201) }] }).success).toBe(false);
    expect(schema.safeParse({ fields: [], computedFields: [{ ...entry, helpText: "b".repeat(2_001) }] }).success).toBe(false);
    expect(schema.safeParse({ fields: [] }).success).toBe(true);
  });
}
