import { describe, expect, test } from "bun:test";
import { truncateUtf8 } from "./utf8";

describe("truncateUtf8", () => {
  test("keeps a value within the byte budget unchanged", () => {
    expect(truncateUtf8("Report", 6)).toBe("Report");
  });

  test("cuts before a character that would cross the budget", () => {
    expect(truncateUtf8("aé漢😀", 3)).toBe("aé");
    expect(truncateUtf8("aé漢😀", 6)).toBe("aé漢");
    expect(truncateUtf8("aé漢😀", 9)).toBe("aé漢");
    expect(truncateUtf8("aé漢😀", 10)).toBe("aé漢😀");
  });
});
