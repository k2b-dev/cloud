import { describe, expect, test } from "bun:test";
import { attachmentLinkPromptConfig, attachmentLinkPromptMessages } from "./attachment-link-ui";

describe("attachment link prompt localization", () => {
  test("provides every German message", () => {
    expect(attachmentLinkPromptMessages.check()).toEqual([]);
  });

  test("localizes every visible prompt string", () => {
    const english = attachmentLinkPromptConfig("en");
    expect(english.title).toBe("Share attachment");
    expect(english.confirmText).toBe("Create link");
    expect(english.fields.info.content).toContain("Anyone with the link");
    expect(english.fields.expiresAt).toMatchObject({ label: "Expires", description: "Optional. Leave empty for no expiry." });
    expect(english.fields.password).toMatchObject({
      label: "Password",
      description: "Optional, at least 8 characters. Share it separately from the link.",
    });
    expect(english.fields.maxDownloads).toMatchObject({
      label: "Maximum downloads",
      description: "Optional. Leave empty for no download limit.",
    });

    const german = attachmentLinkPromptConfig("de");
    expect(german.title).toBe("Anhang freigeben");
    expect(german.confirmText).toBe("Link erstellen");
    expect(german.fields.info.content).toContain("Jede Person mit dem Link");
    expect(german.fields.expiresAt).toMatchObject({
      label: "Gültig bis",
      description: "Optional. Leer lassen, wenn der Link nicht ablaufen soll.",
    });
    expect(german.fields.password).toMatchObject({
      label: "Passwort",
      description: "Optional, mindestens 8 Zeichen. Teile es getrennt vom Link.",
    });
    expect(german.fields.maxDownloads).toMatchObject({
      label: "Maximale Downloads",
      description: "Optional. Leer lassen, wenn es kein Downloadlimit geben soll.",
    });
  });

  test("inherits regional German and falls back to English", () => {
    expect(attachmentLinkPromptConfig("de-CH").title).toBe("Anhang freigeben");
    expect(attachmentLinkPromptConfig("fr").title).toBe("Share attachment");
    expect(attachmentLinkPromptConfig().title).toBe("Share attachment");
  });
});
