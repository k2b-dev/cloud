import { cookies } from "@k2b/stdlib/browser";
import { canonicalLocale, LOCALE_COOKIE } from "../shared/locale";

export const PROFILE_PREFERENCE_LOCALES = ["en", "de"] as const;
export type ProfilePreferenceLocale = (typeof PROFILE_PREFERENCE_LOCALES)[number];

export const profilePreferenceLocale = (locale: string): ProfilePreferenceLocale =>
  canonicalLocale(locale)?.split("-")[0] === "de" ? "de" : "en";

type LocalePreferenceRuntime = {
  writeCookie: (name: string, value: string) => void;
  reload: () => void;
};

export const setLocalePreference = (
  locale: ProfilePreferenceLocale,
  runtime: LocalePreferenceRuntime = {
    writeCookie: cookies.writeCookie,
    reload: () => window.location.reload(),
  },
): ProfilePreferenceLocale => {
  runtime.writeCookie(LOCALE_COOKIE, locale);
  runtime.reload();
  return locale;
};
