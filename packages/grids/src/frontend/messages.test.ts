import { describe, expect, test } from "bun:test";
import { gridsMessages } from "./messages";

describe("Grids frontend messages", () => {
  test("keeps every locale complete", () => expect(gridsMessages.check()).toEqual([]));

  test("uses the German catalog for regional locales", () => {
    expect(gridsMessages.resolve(["de-CH"]).t.formUnavailable).toBe("Dieses Formular ist nicht mehr verfügbar.");
  });
});
