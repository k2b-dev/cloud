import type { DateContext } from "@k2b/stdlib";
import { createContext, type JSX, useContext } from "solid-js";
import { isServer } from "solid-js/web";

/**
 * Deterministic fallback locale used when neither a `LocaleProvider` nor a
 * browser `<html lang>` value is available.
 */
export const DEFAULT_LOCALE = "en";

const LocaleContext = createContext<() => string>();

export type LocaleProviderProps = {
  /** BCP 47 locale tag, e.g. `"en"`, `"de"`, or `"de-AT"`. */
  locale: string;
  children?: JSX.Element;
};

/**
 * Provides the render locale to all descendant `@k2b/ui` components.
 *
 * On the server this is the only locale source, so SSR consumers wrap their
 * page in a provider and emit a matching `<html lang>` attribute. A browser
 * island is an independent Solid root: an outer server-side provider does not
 * survive the island's browser re-render, which instead falls back to
 * `document.documentElement.lang`. Keeping `<html lang>` equal to the server
 * provider locale therefore keeps both passes coherent.
 */
export const LocaleProvider = (props: LocaleProviderProps): JSX.Element => (
  <LocaleContext.Provider value={() => props.locale}>{props.children}</LocaleContext.Provider>
);

/**
 * Resolves the effective render locale as a reactive accessor.
 *
 * Precedence: nearest `LocaleProvider`, then the browser's
 * `document.documentElement.lang`, then `"en"`. Components with an explicit
 * `locale` prop apply it before consulting this hook.
 */
export const useLocale = (): (() => string) => {
  const provided = useContext(LocaleContext);
  if (provided) return provided;
  if (isServer) return () => DEFAULT_LOCALE;
  return () => document.documentElement.lang || DEFAULT_LOCALE;
};

/**
 * Effective date config for date surfaces: an explicit `dateConfig.locale`
 * wins, otherwise the inherited render locale fills the gap. Timezone and
 * week-start configuration pass through untouched.
 */
export const useDateConfigLocale = (config: () => DateContext | undefined): (() => DateContext) => {
  const locale = useLocale();
  return () => {
    const current = config();
    return current?.locale ? current : { ...current, locale: locale() };
  };
};

/**
 * The decimal separator `Intl.NumberFormat` uses for a locale, e.g. `"."`
 * for English and `","` for German.
 */
export const decimalSeparator = (locale: string): string =>
  new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
