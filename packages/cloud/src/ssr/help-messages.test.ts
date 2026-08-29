import { describe, expect, test } from "bun:test";
import { helpMessages } from "./help-messages";

describe("shared Help message catalog", () => {
  test("keeps Help chrome complete and base-fallback ready", () => {
    expect(helpMessages.check()).toEqual([]);
    expect(helpMessages.resolve(["de-CH"]).t.help).toBe("Hilfe");
  });
});
