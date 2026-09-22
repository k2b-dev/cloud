import { describe, expect, test } from "bun:test";
import { deriveOperationalHealth } from "./health";

describe("mailbox operational health", () => {
  test("keeps an active transport active without failed hydrations", () => {
    expect(deriveOperationalHealth({ health: "active", healthReason: null }, 0)).toEqual({ health: "active", healthReason: null });
  });

  test("reports failed hydrations as degraded with the count", () => {
    expect(deriveOperationalHealth({ health: "active", healthReason: null }, 27)).toEqual({
      health: "degraded",
      healthReason: "27 messages failed hydration; run `mail repair hydration` to retry",
    });
    expect(deriveOperationalHealth({ health: "active", healthReason: null }, 1).healthReason).toBe(
      "1 message failed hydration; run `mail repair hydration` to retry",
    );
  });

  test("never masks a transport problem with the hydration reason", () => {
    const stored = { health: "auth_required" as const, healthReason: "Sign in again" };
    expect(deriveOperationalHealth(stored, 27)).toBe(stored);
  });
});
