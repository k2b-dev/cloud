import { i18n } from "@k2b/stdlib";
import { canonicalLocale, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER, normalizeLocale } from "../shared/locale";
import { readCookie } from "./request-cookies";

export { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_HEADER };

type LocaleContext = {
  get(key: "settings"): Record<string, any> | undefined;
  req: { raw: { headers: Headers } };
};

/**
 * Languages Cloud ships platform catalogs for and offers in its language
 * picker. `Accept-Language` negotiation prefers a tag in one of these.
 */
const CATALOG_LANGUAGES = new Set(["en", "de"]);

/**
 * The caller's explicit locale preference, or `undefined` when the request
 * carries none. Precedence: `x-cloud-locale` transport metadata, then the
 * `cloud.locale` cookie, then `Accept-Language`. Every candidate is
 * canonicalized; invalid tags fall through to the next source.
 *
 * `Accept-Language` picks the first tag in quality order whose language has a
 * catalog, keeping its region (`de-CH`, `en-GB`) for formatting. Without such a
 * tag, the first valid tag still wins so formatting follows the browser.
 */
export const preferredLocale = (headers: Headers): string | undefined => {
  const explicit = canonicalLocale(headers.get(LOCALE_HEADER)) ?? canonicalLocale(readCookie(headers, LOCALE_COOKIE));
  if (explicit) return explicit;
  let firstValid: string | undefined;
  for (const tag of i18n.parseAcceptLanguage(headers.get("Accept-Language"))) {
    const candidate = canonicalLocale(tag);
    if (!candidate) continue;
    if (CATALOG_LANGUAGES.has(new Intl.Locale(candidate).language)) return candidate;
    firstValid ??= candidate;
  }
  return firstValid;
};

/**
 * Resolve the request locale from plain headers: the caller's preference when
 * present, then the operator default, then the deterministic `"en"` fallback.
 * Pure per-request derivation — never cached in process-global state.
 */
export const resolveLocale = (headers: Headers, operatorDefault?: string | null): string =>
  preferredLocale(headers) ?? normalizeLocale(operatorDefault);

/**
 * The canonical request locale: explicit preference (`x-cloud-locale` header,
 * `cloud.locale` cookie, `Accept-Language`), then the operator's `app.locale`
 * setting, then `"en"`. The same value drives the SSR `<html lang>` attribute,
 * the Layout `LocaleProvider`, and `getDateConfig(c).locale`. Timezone stays a
 * separate value — see `getTimeZone`.
 */
export const getLocale = (c: LocaleContext): string => {
  const settingsLocale = c.get("settings")?.app?.locale;
  return resolveLocale(c.req.raw.headers, typeof settingsLocale === "string" ? settingsLocale : undefined);
};

export const locale = {
  LOCALE_COOKIE,
  LOCALE_HEADER,
  DEFAULT_LOCALE,
  getLocale,
  preferredLocale,
  resolveLocale,
} as const;
