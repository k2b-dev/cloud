import { describe, expect, test } from "bun:test";
import { platformMessages } from "./platform-messages";

describe("platformMessages", () => {
  test("keeps both catalogs structurally complete", () => {
    expect(platformMessages.check()).toEqual([]);
  });

  test("uses German for regional German locales", () => {
    const { locale, t } = platformMessages.resolve(["de-CH"]);

    expect(locale).toBe("de");
    expect(t.openApps).toBe("Apps öffnen");
    expect(t.accountExpires({ date: "31.12.2026" })).toBe("Dein Konto läuft am 31.12.2026 ab.");
  });

  test("falls back to English for unsupported locales", () => {
    expect(platformMessages.resolve(["fr-FR"]).t.openApps).toBe("Open apps");
  });
});
