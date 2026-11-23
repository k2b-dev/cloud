// ==========================
// Internationalization Utilities
// ==========================

/**
 * A single message: a plain string or a function from typed parameters to a
 * string.
 */
export type Message = string | ((params: never) => string);

/** A flat record of message keys to messages. */
export type MessageRecord = Record<string, Message>;

/**
 * Messages for a non-base locale: any subset of the base locale's keys, with
 * parameter types matching the base message. Missing keys fall back through
 * the locale's defined BCP-47 ancestors (`de-CH` -> `de`) down to the base
 * locale at runtime; keys that fall all the way through are reported by
 * {@link Catalog.check}.
 */
export type CompatibleMessages<Base extends MessageRecord> = {
  [K in keyof Base]?: Base[K];
};

/**
 * Validates the full messages object: the base locale keeps its inferred
 * shape, every other locale must be a compatible subset of it. Also provides
 * contextual parameter types for non-base message functions.
 */
type ValidateMessages<BaseLocale extends string, M> = {
  [L in keyof M]: L extends BaseLocale
    ? M[L]
    : M extends Record<BaseLocale, infer Base extends MessageRecord>
      ? CompatibleMessages<Base>
      : never;
};

/** A key-set problem in one locale, as reported by {@link Catalog.check}. */
export type CatalogIssue = {
  locale: string;
  /** Keys present in the base locale but missing here. */
  missing: string[];
  /** Keys present here but not in the base locale (likely typos). */
  extra: string[];
};

export type Catalog<Base extends MessageRecord> = {
  /** The catalog's base locale tag. */
  baseLocale: string;
  /** All locale tags defined in the catalog, base first. */
  locales: string[];
  /**
   * Resolve a list of requested BCP-47 tags (most preferred first) to the
   * best available locale and its translator. See {@link defineCatalog}.
   */
  resolve: (requested?: readonly string[]) => { locale: string; t: Base };
  /**
   * Compare every locale's keys against the base locale. `missing` lists keys
   * that fall back to the base locale (keys provided by a defined ancestor
   * such as `de` for `de-CH` count as covered); `extra` lists keys not in the
   * base locale. Returns an empty array when all locales are complete.
   * Intended for a unit test or dev-time assertion; parameter compatibility
   * is already enforced at compile time.
   */
  check: () => CatalogIssue[];
};

/**
 * Define a type-safe message catalog.
 *
 * The base locale defines the full key set and the parameter types of every
 * message function; all other locales are checked against it at compile time
 * and may omit keys. Missing keys fall back through the locale's defined
 * BCP-47 ancestors to the base locale (`de-CH` -> `de` -> base), most
 * specific wins.
 *
 * The catalog holds no global state: `resolve` returns a request-local
 * translator, so the same catalog is safe to share across concurrent
 * requests in SSR.
 *
 * @example
 * const catalog = i18n.define({
 *   baseLocale: "en",
 *   messages: {
 *     en: { greeting: ({ name }: { name: string }) => `Hello ${name}` },
 *     de: { greeting: ({ name }) => `Hallo ${name}` },
 *   },
 * });
 * const { locale, t } = catalog.resolve(["de-AT", "en"]); // locale === "de"
 * t.greeting({ name: "Ada" });                            // "Hallo Ada"
 */
export const defineCatalog = <BaseLocale extends string, M extends Record<BaseLocale, MessageRecord>>(config: {
  baseLocale: BaseLocale;
  messages: M & ValidateMessages<BaseLocale, M>;
}): Catalog<M[BaseLocale]> => {
  const { baseLocale } = config;
  const messages: Record<string, CompatibleMessages<M[BaseLocale]>> = config.messages;
  const base = messages[baseLocale] as M[BaseLocale];
  const locales = [baseLocale, ...Object.keys(messages).filter((locale) => locale !== baseLocale)];

  // Lookup keys are lowercased because BCP-47 tags are case-insensitive.
  const byLowerTag = new Map<string, string>();
  for (const locale of locales) byLowerTag.set(locale.toLowerCase(), locale);

  // Defined ancestors of a tag, least specific first, excluding the base
  // locale: "zh-Hant-TW" -> ["zh", "zh-Hant", "zh-Hant-TW"] (where defined).
  const ancestorChain = (locale: string): string[] => {
    const subtags = locale.toLowerCase().split("-");
    const chain: string[] = [];
    for (let length = 1; length <= subtags.length; length++) {
      const match = byLowerTag.get(subtags.slice(0, length).join("-"));
      if (match !== undefined && match !== baseLocale) chain.push(match);
    }
    return chain;
  };

  // Merged translators are precomputed once so resolve() is a cheap lookup.
  // Messages fall back per key through the defined ancestors down to the base
  // locale; the most specific locale wins.
  const translators = new Map<string, { locale: string; t: M[BaseLocale] }>();
  for (const locale of locales) {
    const t = Object.assign({}, base, ...ancestorChain(locale).map((ancestor) => messages[ancestor]));
    translators.set(locale.toLowerCase(), { locale, t });
  }

  const resolve = (requested?: readonly string[]): { locale: string; t: M[BaseLocale] } => {
    for (const tag of requested ?? []) {
      // Progressive subtag fallback: "de-AT-x" -> "de-AT" -> "de".
      const subtags = tag.toLowerCase().split("-");
      while (subtags.length > 0) {
        const match = translators.get(subtags.join("-"));
        if (match) return match;
        subtags.pop();
      }
    }
    return translators.get(baseLocale.toLowerCase())!;
  };

  const check = (): CatalogIssue[] => {
    const baseKeys = Object.keys(base);
    const issues: CatalogIssue[] = [];
    for (const locale of locales) {
      if (locale === baseLocale) continue;
      // Keys provided by defined ancestors count as covered: "de-CH" without
      // its own "title" is not a translation gap when "de" supplies it.
      const covered = new Set(ancestorChain(locale).flatMap((ancestor) => Object.keys(messages[ancestor]!)));
      const missing = baseKeys.filter((key) => !covered.has(key));
      const extra = Object.keys(messages[locale]!).filter((key) => !(key in base));
      if (missing.length > 0 || extra.length > 0) issues.push({ locale, missing, extra });
    }
    return issues;
  };

  return { baseLocale, locales, resolve, check };
};

/**
 * Parse an `Accept-Language` header into locale tags sorted by preference.
 *
 * Entries are ordered by descending quality value (missing `q` counts as 1);
 * ties keep header order. `q=0` entries and the `*` wildcard are dropped.
 *
 * @example i18n.parseAcceptLanguage("en;q=0.8, de-AT")  // ["de-AT", "en"]
 * @example i18n.parseAcceptLanguage(null)               // []
 */
export const parseAcceptLanguage = (header: string | null | undefined): string[] => {
  if (!header) return [];
  return header
    .split(",")
    .flatMap((entry) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const locale = tag.trim();
      if (!locale || locale === "*") return [];
      const qParam = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const quality = qParam === undefined ? 1 : Number(qParam.slice(2));
      if (!Number.isFinite(quality) || quality <= 0) return [];
      return [{ locale, quality }];
    })
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.locale);
};

/**
 * CLDR plural forms. `other` is the required fallback; the remaining
 * categories are only used by locales that distinguish them.
 */
export type PluralForms = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

/**
 * Pick the plural form for a count using `Intl.PluralRules`.
 *
 * Categories the locale distinguishes but the forms object omits fall back
 * to `other`.
 *
 * @example i18n.plural(1, "en", { one: "1 item", other: "items" })  // "1 item"
 * @example i18n.plural(2, "pl", { one: "plik", few: "pliki", other: "plików" }) // "pliki"
 */
export const plural = (count: number, locale: string | undefined, forms: PluralForms): string =>
  forms[new Intl.PluralRules(locale).select(count)] ?? forms.other;

export type FormatListOptions = {
  /** `"conjunction"` (and, default), `"disjunction"` (or), or `"unit"`. */
  type?: "conjunction" | "disjunction" | "unit";
  /** Phrase length. Defaults to `"long"`. */
  style?: "long" | "short" | "narrow";
};

/**
 * Format a list of strings with locale-aware separators via `Intl.ListFormat`.
 *
 * @example i18n.formatList(["Tue", "Wed", "Fri"], "en")  // "Tue, Wed, and Fri"
 * @example i18n.formatList(["Di", "Mi"], "de", { type: "disjunction" })  // "Di oder Mi"
 */
export const formatList = (
  items: readonly string[],
  locale?: string,
  options: FormatListOptions = {},
): string =>
  new Intl.ListFormat(locale, {
    type: options.type ?? "conjunction",
    style: options.style ?? "long",
  }).format(items);

/**
 * Build a locale-aware string comparator via `Intl.Collator`, e.g. for
 * `Array.prototype.sort`.
 *
 * @example ["Öl", "Apfel"].sort(i18n.compare("de"))  // ["Apfel", "Öl"]
 * @example i18n.compare("de", { sensitivity: "base" })("a", "A")  // 0
 */
export const compare = (
  locale?: string,
  options?: Intl.CollatorOptions,
): ((a: string, b: string) => number) => new Intl.Collator(locale, options).compare;

// =============================================================================
// Namespace Export
// =============================================================================

export const i18n = {
  define: defineCatalog,
  parseAcceptLanguage,
  plural,
  formatList,
  compare,
} as const;
