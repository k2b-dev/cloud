import { describe, expect, test } from "bun:test";
import { serviceMessagesFor } from "./messages";

describe("grids service messages", () => {
  test("uses English by default", () => {
    expect(serviceMessagesFor().durableNotEnabled).toBe("Durable history is not enabled");
  });

  test("resolves de-CH without changing stable diagnostic codes", () => {
    const t = serviceMessagesFor("de-CH");
    expect(t.confirmationMismatch).toContain("Namen der Base");
    expect(t.federatedDiagnostic({ code: "source_required", fallback: "ignored" })).toContain("Quelltabelle");
    expect(t.federatedDiagnostic({ code: "future_code", fallback: "technical fallback" })).toBe("technical fallback");
  });
});
