import { describe, expect, test } from "bun:test";
import { gridsSettingsMessages } from "./messages";

describe("Grids settings messages", () => {
  test("keeps every locale complete", () => expect(gridsSettingsMessages.check()).toEqual([]));

  test("uses the German catalog for regional locales", () => {
    expect(gridsSettingsMessages.resolve(["de-CH"]).t.baseSettings).toBe("Base-Einstellungen");
  });
});
