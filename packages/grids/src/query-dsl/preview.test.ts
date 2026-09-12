import { expect, test } from "bun:test";
import { normalizeDslResultValue } from "./preview";

test("SQL integer results keep exact digits outside the JavaScript safe range", () => {
  for (const value of [0n, 42n, 9007199254740991n, -9007199254740991n]) {
    expect(normalizeDslResultValue(value, { sqlType: "numeric" })).toBe(Number(value));
  }
  for (const value of [9007199254740992n, 9007199254740993n, -9007199254740993n, 9223372036854775807n]) {
    expect(normalizeDslResultValue(value, { sqlType: "numeric" })).toBe(value.toString());
  }
});

test("SQL decimal normalization retains typed strings, nulls and booleans", () => {
  expect(normalizeDslResultValue("9007199254740993.4200", { sqlType: "numeric" })).toBe("9007199254740993.42");
  expect(normalizeDslResultValue("001.20", { sqlType: "text" })).toBe("001.20");
  expect(normalizeDslResultValue(null)).toBeNull();
  expect(normalizeDslResultValue(false)).toBe(false);
});
