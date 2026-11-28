import { describe, expect, test } from "bun:test";
import { formatPhone } from "./phone-format";

describe("formatPhone", () => {
  test("writes an international number by the rules of its country", () => {
    expect(formatPhone("+493012345678")).toBe("+49 30 12345678");
    expect(formatPhone("+14155550100")).toBe("+1 415 555 0100");
  });

  test("keeps a number it cannot read as stored", () => {
    expect(formatPhone("030 1234567")).toBe("030 1234567");
    expect(formatPhone("Durchwahl 12")).toBe("Durchwahl 12");
  });
});
