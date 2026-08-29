import { describe, expect, test } from "bun:test";
import { accessMessages } from "./messages";

describe("accessMessages", () => {
  test("keeps both catalogs structurally complete", () => {
    expect(accessMessages.check()).toEqual([]);
  });

  test("uses German for regional German locales", () => {
    const { t } = accessMessages.resolve(["de-CH"]);

    expect(t.view).toBe("Ansehen");
    expect(t.revokeConfirm({ name: "Website" })).toContain("sofort den Zugriff");
  });

  test("falls back to English for unsupported locales", () => {
    expect(accessMessages.resolve(["fr-FR"]).t.view).toBe("View");
  });
});
