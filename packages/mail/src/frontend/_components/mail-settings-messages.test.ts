import { describe, expect, test } from "bun:test";
import { mailSettingsMessages } from "./mail-settings-messages";

describe("Mail settings message catalog", () => {
  test("provides every German message", () => {
    expect(mailSettingsMessages.check()).toEqual([]);
  });

  test("inherits regional German locales", () => {
    const messages = mailSettingsMessages.resolve(["de-CH"]).t;

    expect(messages.mailboxSettings).toBe("Postfacheinstellungen");
    expect(messages.newIdentity).toBe("Neue Absenderidentität");
    expect(messages.trustedAuthDescription).toContain("Authentication-Results");
  });

  test("falls back to English for unsupported locales", () => {
    const messages = mailSettingsMessages.resolve(["fr"]).t;

    expect(messages.mailboxSettings).toBe("Mailbox settings");
    expect(messages.newIdentity).toBe("New identity");
  });
});
