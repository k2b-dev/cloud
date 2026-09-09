import { canonicalLocale, localeFallbackChain } from "@k2b/cloud/shared";
import { FAQ_BASE_LOCALE, type FaqEntry, type FaqTranslation, type FaqTranslations } from "./contracts";

export type ResolvedFaqEntry = Omit<FaqEntry, "translations"> & FaqTranslation & { locale: string };

export const normalizeFaqTranslations = (translations: FaqTranslations): FaqTranslations => {
  const normalized: FaqTranslations = {};
  for (const [locale, translation] of Object.entries(translations)) {
    const canonical = canonicalLocale(locale);
    if (!canonical) throw new Error(`Invalid FAQ locale: ${locale}`);
    if (normalized[canonical]) throw new Error(`Duplicate FAQ locale: ${canonical}`);
    normalized[canonical] = translation;
  }
  return normalized;
};

export const resolveFaqTranslation = (
  translations: FaqTranslations,
  requestedLocale?: string | null,
): FaqTranslation & { locale: string } => {
  for (const locale of localeFallbackChain(requestedLocale, FAQ_BASE_LOCALE)) {
    const translation = translations[locale];
    if (translation) return { ...translation, locale };
  }
  const fallback = translations[FAQ_BASE_LOCALE];
  if (!fallback) throw new Error(`FAQ translation ${FAQ_BASE_LOCALE} is required`);
  return { ...fallback, locale: FAQ_BASE_LOCALE };
};

export const resolveFaqEntry = (entry: FaqEntry, locale?: string | null): ResolvedFaqEntry => {
  const { translations, ...metadata } = entry;
  return { ...metadata, ...resolveFaqTranslation(translations, locale) };
};
