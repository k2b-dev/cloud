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

  test("localizes attachment context empty and error states", () => {
    expect(mailComposerMessages.resolve(["en"]).t.noMatchingAttachments).toBe("No matching files for these recipients");
    expect(mailComposerMessages.resolve(["de"]).t.noMatchingAttachments).toBe("Keine passenden Dateien für diese Empfänger");
    expect(mailComposerMessages.resolve(["en"]).t.attachmentContextFailed).toBe("Could not look up these recipients' contacts");
    expect(mailComposerMessages.resolve(["de"]).t.attachmentContextFailed).toBe(
      "Die Kontakte dieser Empfänger konnten nicht nachgeschlagen werden",
    );
  });

  test("falls back to English for unsupported locales", () => {
    expect(mailComposerMessages.resolve(["fr"]).t.newMessage).toBe("New message");
  });
});
