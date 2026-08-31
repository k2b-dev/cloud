import { describe, expect, test } from "bun:test";
import { normalizeFaqTranslations, resolveFaqTranslation } from "./content";

const translations = {
  en: { question: "English question", answer: "English answer" },
  de: { question: "Deutsche Frage", answer: "Deutsche Antwort" },
};

describe("FAQ content locales", () => {
  test("resolves exact, language, and English fallback", () => {
    expect(resolveFaqTranslation(translations, "de")).toEqual({ ...translations.de, locale: "de" });
    expect(resolveFaqTranslation(translations, "de-CH")).toEqual({ ...translations.de, locale: "de" });
    expect(resolveFaqTranslation(translations, "fr")).toEqual({ ...translations.en, locale: "en" });
  });

  test("canonicalizes stored locale keys", () => {
    expect(normalizeFaqTranslations({ en: translations.en, "DE-ch": translations.de })).toEqual({
      en: translations.en,
      "de-CH": translations.de,
    });
  });
});
