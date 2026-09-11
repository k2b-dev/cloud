import { expect, test } from "bun:test";
import { validateFieldConfig } from "./field-validation";

test("rejects list calculations that cannot be read through the canonical SQL compiler", () => {
  for (const column of [
    { id: "Result", name: "Result", type: "text", formula: { expression: "1 + 2" } },
    { id: "Result", name: "Result", type: "text", config: { regex: "^a$" }, formula: { expression: "'a'" } },
    { id: "Result", name: "Result", type: "select", config: { options: [{ id: "a", label: "A" }] }, formula: { expression: "'a'" } },
  ]) {
    const result = validateFieldConfig("object_list", { fields: [column] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toContain("Result");
    }
  }
});

test("keeps input constraints and supported typed calculations available", () => {
  expect(
    validateFieldConfig("object_list", {
      fields: [
        { id: "Source", name: "Source", type: "text", config: { regex: "^a$" } },
        { id: "Choice", name: "Choice", type: "select", config: { options: [{ id: "a", label: "A" }] } },
        { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 }, formula: { expression: "0.1 + 0.2" } },
      ],
    }).ok,
  ).toBe(true);
});
