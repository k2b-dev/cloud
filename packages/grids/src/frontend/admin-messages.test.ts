import { describe, expect, test } from "bun:test";
import { gridsAdminMessages } from "./admin-messages";

describe("Grids admin messages", () => {
  test("keeps every locale complete", () => expect(gridsAdminMessages.check()).toEqual([]));
  test("falls back from regional German", () => expect(gridsAdminMessages.resolve(["de-CH"]).t.settings).toBe("Einstellungen"));
});
