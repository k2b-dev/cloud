import { describe, expect, test } from "bun:test";
import { parseJsonbRow } from "./jsonb";

describe("native JSONB row values", () => {
  test("uses the fallback only for nullish values", () => {
    expect(parseJsonbRow(null, 42)).toBe(42);
    expect(parseJsonbRow(undefined, "fallback")).toBe("fallback");
    expect(parseJsonbRow(0, 42)).toBe(0);
    expect(parseJsonbRow(false, true)).toBe(false);
    expect(parseJsonbRow("", "fallback")).toBe("");
  });

  test("preserves object and array identity", () => {
    const object = { a: 1, b: "two" };
    const array = [1, 2, 3];
    expect(parseJsonbRow(object, {})).toBe(object);
    expect(parseJsonbRow<number[]>(array, [])).toBe(array);
  });

  test.each(['{"a":1}', "[1,2,3]", '"hello"', "{not json", "[done]", "42", "-3.14", "true", "false", "null", "hello"])(
    "preserves native JSONB string %s without guessing its contents",
    (value) => expect(parseJsonbRow(value, "fallback")).toBe(value),
  );
});
