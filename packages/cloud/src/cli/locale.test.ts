import { describe, expect, test } from "bun:test";
import { cloudCliLanguage, localizeCloudCliText, resolveCloudCliLocale } from "./locale";

describe("Cloud CLI locale", () => {
  test("uses a deterministic English default and canonicalizes explicit tags", () => {
    expect(resolveCloudCliLocale()).toBe("en");
    expect(resolveCloudCliLocale("de-ch")).toBe("de-CH");
    expect(() => resolveCloudCliLocale("not_a_locale")).toThrow("Invalid locale");
  });

  test("falls back from regional German tags without process-global state", async () => {
    const text = { en: "Saved", de: "Gespeichert" };
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => localizeCloudCliText("en", text)),
      Promise.resolve().then(() => localizeCloudCliText("de-CH", text)),
    ]);
    expect(cloudCliLanguage("fr")).toBe("en");
    expect(english).toBe("Saved");
    expect(german).toBe("Gespeichert");
  });
});
