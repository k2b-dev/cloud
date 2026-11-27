import { expect, test } from "bun:test";
import { validateFieldConfig } from "../service/field-validation";

const select = (color: string) => ({ options: [{ id: "open", label: "Open", color }] });

test("a select option colour longer than any colour is refused on write", () => {
  expect(validateFieldConfig("select", select(`#${"a".repeat(5_000)}`)).ok).toBe(false);
  expect(validateFieldConfig("select", select("blue".repeat(100))).ok).toBe(false);
});

test("a select option colour with a semicolon is refused on write", () => {
  expect(validateFieldConfig("select", select("#fff;")).ok).toBe(false);
  expect(validateFieldConfig("select", select("red;")).ok).toBe(false);
});

test("a colour the field editor's picker writes is accepted", () => {
  expect(validateFieldConfig("select", select("#3b82f6")).ok).toBe(true);
});
