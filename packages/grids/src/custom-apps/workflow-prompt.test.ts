import { describe, expect, test } from "bun:test";
import { CustomAppPromptValuesSchema, customAppPromptValuesAllowed, projectCustomAppPromptInputs } from "./workflow-prompt";

describe("published workflow prompts", () => {
  test("bounds scalar payloads by the existing workflow query budget", () => {
    expect(CustomAppPromptValuesSchema.safeParse({ amount: "12.50" }).success).toBe(true);
    expect(CustomAppPromptValuesSchema.safeParse({ reference: "x".repeat(20_001) }).success).toBe(false);
    expect(CustomAppPromptValuesSchema.safeParse({ a: "x".repeat(12_000), b: "x".repeat(12_000) }).success).toBe(false);
    expect(
      CustomAppPromptValuesSchema.safeParse(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`input${i}`, ""]))).success,
    ).toBe(false);
  });
  test("exposes only selected scalar fields and presentation config", () => {
    const projected = projectCustomAppPromptInputs(
      [
        { name: "bill", type: "record", config: { table: "private-table", required: true } },
        { name: "amount", type: "text", config: { label: "Amount", required: true, internal: "private-binding" } },
      ],
      ["amount"],
    );
    expect(projected).toEqual({ inputs: [{ name: "amount", type: "text", config: { label: "Amount", required: true } }] });
    expect(() => projectCustomAppPromptInputs([{ name: "bill", type: "record", config: {} }], ["bill"])).toThrow();
  });
  test("rejects unknown values and every attempt to override a bound input", () => {
    expect(customAppPromptValuesAllowed({ amount: "12.50" }, ["amount"], { bill: "private-id" })).toBe(true);
    expect(customAppPromptValuesAllowed({ bill: "other-id" }, ["amount"], { bill: "private-id" })).toBe(false);
    expect(customAppPromptValuesAllowed({ bill: "other-id" }, ["bill"], { bill: "private-id" })).toBe(false);
    expect(customAppPromptValuesAllowed({ amount: "12.50" }, [], {})).toBe(false);
    expect(customAppPromptValuesAllowed({}, [], {})).toBe(true);
  });
});
