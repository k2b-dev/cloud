import { describe, expect, test } from "bun:test";
import { helpApiMessages } from "./help-messages";

describe("Help API message catalog", () => {
  test("keeps stable errors separate from base-fallback display messages", () => {
    expect(helpApiMessages.check()).toEqual([]);
    expect(helpApiMessages.resolve(["de-CH"]).t.notFound).toBe("Hilfedokument nicht gefunden");
  });
});
