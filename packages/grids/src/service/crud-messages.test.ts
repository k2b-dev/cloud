import { describe, expect, test } from "bun:test";
import { getGridsCrudMessages, gridsCrudMessages } from "./crud-messages";
import { validateFieldConfig } from "./field-validation";

describe("Grids CRUD service messages", () => {
  test("keeps every locale complete", () => expect(gridsCrudMessages.check()).toEqual([]));

  test("timeout guidance includes narrowing fields even for a single-record query", () => {
    expect(getGridsCrudMessages("en").queryTimedOut).toContain("Select only the fields you need");
    expect(getGridsCrudMessages("de").queryTimedOut).toContain("nur benötigte Felder");
  });

  test("uses German messages for regional locales", () => {
    expect(validateFieldConfig("unknown-type", {}, "de-CH")).toEqual({
      ok: false,
      error: {
        code: "BAD_INPUT",
        status: 400,
        message: "Unbekannter Feldtyp „unknown-type“.",
      },
    });
    expect(getGridsCrudMessages("de-CH").recordFinalized).toBe("Dieser Datensatz ist finalisiert und kann nicht geändert werden.");
  });
});
