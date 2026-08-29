import { describe, expect, test } from "bun:test";
import { accountsMessages } from "./messages";

describe("accounts messages", () => {
  test("uses German for regional German locales", () => {
    const { locale, t } = accountsMessages.resolve(["de-CH"]);

    expect(locale).toBe("de");
    expect(t.accounts).toBe("Konten");
    expect(t.groupCreatedMessage({ name: "Support" })).toBe("Gruppe „Support“ erstellt.");
  });

  test("falls back to English for unsupported locales", () => {
    const { locale, t } = accountsMessages.resolve(["fr-FR"]);

    expect(locale).toBe("en");
    expect(t.createAccountFailed).toBe("The account could not be created.");
  });
});
