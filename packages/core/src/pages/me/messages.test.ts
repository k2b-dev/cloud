import { describe, expect, test } from "bun:test";
import { accountMessages } from "./messages";
import { notificationChannelMeta, notificationErrorText, notificationStatusMeta } from "./notification-ui";

describe("account messages", () => {
  test("keeps the English and German catalogs complete", () => {
    expect(accountMessages.check()).toEqual([]);
  });

  test("falls back from de-CH to German and unknown locales to English", () => {
    const swiss = accountMessages.resolve(["de-CH"]);
    expect(swiss.locale).toBe("de");
    expect(swiss.t.revokeApiKeyConfirm({ name: "Desktop" })).toContain("verlieren sofort den Zugriff");
    expect(accountMessages.resolve(["fr"]).t.security).toBe("Security");
  });

  test("localizes stable notification channel and status values", () => {
    expect(notificationChannelMeta("none", "de-CH").label).toBe("Nicht zugestellt");
    expect(notificationStatusMeta("suppressed", "de-CH").label).toBe("Nicht gesendet");
    expect(notificationErrorText("no_endpoint", "No configured browser destination is available.", "de-CH")).toBe(
      "Für diesen Zustellkanal ist kein Ziel eingerichtet.",
    );
    expect(notificationErrorText("future_code", "Low-level English detail", "de")).toBe(
      "Die Benachrichtigung konnte nicht zugestellt werden.",
    );
  });

  test("uses correct membership plurals", () => {
    expect(accountMessages.resolve(["de"]).t.membershipSummary({ direct: 1, managed: 1 })).toBe(
      "1 direkte Mitgliedschaft · 1 verwaltete Gruppe",
    );
    expect(accountMessages.resolve(["en"]).t.membershipSummary({ direct: 1, managed: 1 })).toBe("1 direct membership · 1 managed group");
  });
});
