import { describe, expect, test } from "bun:test";
import { statusLabel } from "./labels";
import { capabilityOpsMessages } from "./ops-messages";
import { ORIGIN_ICON, STATUS_TONE, valueShape } from "./presentation";

describe("capability execution presentation", () => {
  test("separates defects from refusals", () => {
    expect(STATUS_TONE.succeeded).toBe("ok");
    expect(STATUS_TONE.failed).toBe("error");
    expect(STATUS_TONE.timed_out).toBe("error");
    expect(STATUS_TONE.invalid_input).toBe("warning");
    expect(STATUS_TONE.denied).toBe("warning");
    expect(STATUS_TONE.rejected).toBe("neutral");
  });

  test("labels every status in both shipped locales", () => {
    const { t } = capabilityOpsMessages.resolve(["de"]);
    expect(capabilityOpsMessages.check()).toEqual([]);
    expect(statusLabel("invalid_input", t)).toBe("Ungültige Eingabe");
    expect(statusLabel("rejected", t)).toBe("Zurückgewiesen");
  });

  test("gives every origin an icon", () => {
    expect(Object.keys(ORIGIN_ICON).sort()).toEqual(["app", "assistant", "http", "mcp"]);
  });

  test("reduces shape metadata to size and keys, never to values", () => {
    expect(valueShape(null)).toBeNull();
    expect(valueShape({ type: "object", keys: ["id", "name"], omittedKeys: 3 })).toEqual({
      type: "object",
      size: 5,
      keys: ["id", "name"],
      omittedKeys: 3,
      value: null,
    });
    expect(valueShape({ type: "array", length: 12 })).toMatchObject({ type: "array", size: 12, value: null });
    expect(valueShape({ type: "string", length: 40 })).toMatchObject({ type: "string", size: 40, value: null });
    expect(valueShape({ type: "number", value: 7 })).toMatchObject({ type: "number", size: null, value: "7" });
    expect(valueShape({ type: "boolean", value: false })).toMatchObject({ type: "boolean", value: "false" });
    expect(valueShape({ type: "unknown" })).toMatchObject({ type: "unknown", size: null, value: null });
  });
});
