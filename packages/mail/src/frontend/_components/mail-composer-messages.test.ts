import { describe, expect, test } from "bun:test";
import { mailComposerMessages } from "./mail-composer-messages";

describe("Mail composer message catalog", () => {
  test("provides every German message", () => {
    expect(mailComposerMessages.check()).toEqual([]);
  });

  test("inherits regional German locales", () => {
    const messages = mailComposerMessages.resolve(["de-CH"]).t;
    expect(messages.newMessage).toBe("Neue Nachricht");
    expect(messages.deliveryReceiptUnsupported).toContain("SMTP-Server");
  });

  test("falls back to English for unsupported locales", () => {
    expect(mailComposerMessages.resolve(["fr"]).t.newMessage).toBe("New message");
  });
});
