import { expect, test } from "bun:test";
import { formFieldError } from "./form-input-validation";

const context = { locale: "de", dateConfig: { timeZone: "Europe/Berlin" } };
test("local scalar checks reuse field constraints and form-required overrides", () => {
  const date = { type: "date", config: {}, required: false };
  expect(formFieldError(date, { required: true }, null, context)).toBe("Bitte einen Wert eingeben.");
  expect(formFieldError(date, {}, null, context)).toBeUndefined();
  expect(formFieldError(date, {}, "2026-02-30", context)).toBeDefined();
  const number = { type: "number", config: { min: "0.0001", decimalPlaces: 4 }, required: true };
  expect(formFieldError(number, {}, "1.5", context)).toBeUndefined();
  expect(formFieldError(number, {}, "9007199254740993.1234", context)).toBeUndefined();
  for (const input of ["0", "bad", "1.23456"]) expect(formFieldError(number, {}, input, context)).toBeDefined();
  expect(formFieldError({ type: "text", config: { maxLength: 3 }, required: false }, {}, "long", context)).toBeDefined();
  expect(formFieldError({ type: "boolean", config: {}, required: true }, {}, false, context)).toBeUndefined();
  expect(formFieldError({ type: "relation", config: {}, required: true }, {}, [], context)).toBeDefined();
  expect(formFieldError({ type: "relation", config: {}, required: true }, {}, ["REC001"], context)).toBeUndefined();
  expect(formFieldError({ type: "relation", config: {}, required: true }, {}, ["tmp_new"], context)).toBeUndefined();
});
