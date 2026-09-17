import { expect, test } from "bun:test";
import { formFieldError } from "./form-input-validation";
import { displayNumberInput, normalizeNumberInput } from "./number-input";

test("localized decimal input preserves exact canonical text without grouping guesses", () => {
  expect(normalizeNumberInput("22,60", "de-DE")).toBe("22.60");
  expect(normalizeNumberInput("9007199254740993,123400", "de")).toBe("9007199254740993.123400");
  expect(normalizeNumberInput("-0,125", "fr")).toBe("-0.125");
  expect(normalizeNumberInput(",5", "de")).toBe(".5");
  expect(normalizeNumberInput("22.60", "de")).toBe("22.60");
  expect(normalizeNumberInput("1,234", "de")).toBe("1.234");
  expect(normalizeNumberInput("1,234", "en")).toBe("1,234");
  expect(displayNumberInput("9007199254740993.1234", "de")).toBe("9007199254740993,1234");
  const number = { type: "number", config: {}, required: false };
  for (const value of ["1.234,56", "1,234.56", "1,234,567", "1 234,56", "22,6,0"]) {
    expect(normalizeNumberInput(value, "de")).toBe(value);
    expect(formFieldError(number, {}, value, { locale: "de" })).toBeDefined();
  }
  expect(formFieldError(number, {}, "22,60", { locale: "de" })).toBeUndefined();
  expect(formFieldError(number, {}, "22,60", { locale: "en" })).toBeDefined();
  expect(formFieldError({ ...number, config: { integerOnly: true } }, {}, "1,5", { locale: "de" })).toBeDefined();
});
