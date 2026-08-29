import { describe, expect, test } from "bun:test";
import { gridsCapabilityMessages } from "./capability-messages";

describe("Grids capability messages", () => {
  test("keeps every locale complete", () => expect(gridsCapabilityMessages.check()).toEqual([]));

  test("uses the German catalog for regional locales", () => {
    const { t } = gridsCapabilityMessages.resolve(["de-CH"]);
    expect(t.invalidCursor).toBe("Der Cursor ist ungültig.");
    expect(t.updatedRecord({ count: 2, id: "Rec001", table: "Aufträge", version: 3 })).toContain("2 Felder");
  });
});
