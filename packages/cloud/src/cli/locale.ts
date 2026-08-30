import { i18n } from "@k2b/stdlib";
import type { CloudCliContext } from "./index";

export type CloudCliText = { en: string; de: string };

const languageCatalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: { language: "en" as string },
    de: { language: "de" },
  },
});

export const resolveCloudCliLocale = (requested?: string | null): string => {
  const value = requested?.trim();
  if (!value) return "en";
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical ?? "en";
  } catch {
    throw new TypeError(`Invalid locale: ${value}`);
  }
};

export const cloudCliLanguage = (locale?: string | null): "en" | "de" =>
  languageCatalog.resolve(locale ? [locale] : []).t.language === "de" ? "de" : "en";

export const localizeCloudCliText = (locale: string | null | undefined, text: CloudCliText): string => text[cloudCliLanguage(locale)];

export const cliText = (ctx: Pick<CloudCliContext, "options">, text: CloudCliText): string =>
  localizeCloudCliText(ctx.options.locale, text);
