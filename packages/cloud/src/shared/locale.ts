/** Explicit per-browser locale preference, readable on every Cloud host. */
export const LOCALE_COOKIE = "cloud.locale";

/**
 * Transport metadata header carrying the caller's resolved locale preference
 * on Cloud-internal requests such as capability invocations. Metadata only:
 * the locale never appears in capability input schemas or auth tokens.
 */
export const LOCALE_HEADER = "x-cloud-locale";

/**
 * Deterministic server fallback when no request, operator, or cookie locale
 * applies. Matches the `@k2b/ui` default so SSR and islands agree.
 */
export const DEFAULT_LOCALE = "en";

/**
 * The canonical BCP 47 form of one locale tag, or `undefined` when the value
 * is empty or not a structurally valid tag. Canonicalization fixes casing
 * (`DE-ch` → `de-CH`) and keeps regional subtags such as `de-CH` intact.
 */
export const canonicalLocale = (value: string | null | undefined): string | undefined => {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) return undefined;
  try {
    return Intl.getCanonicalLocales(candidate)[0];
  } catch {
    return undefined;
  }
};

/** Canonicalize one locale tag, falling back when the value is invalid. */
export const normalizeLocale = (value: string | null | undefined, fallback = DEFAULT_LOCALE): string => canonicalLocale(value) ?? fallback;

/** Exact requested locale, then its BCP 47 ancestors, then the canonical base locale. */
export const localeFallbackChain = (requestedLocale: string | null | undefined, baseLocale = DEFAULT_LOCALE): string[] => {
  const requested = canonicalLocale(requestedLocale);
  const base = normalizeLocale(baseLocale);
  const chain: string[] = [];
  let candidate = requested;
  while (candidate) {
    chain.push(candidate);
    const separator = candidate.lastIndexOf("-");
    candidate = separator > 0 ? candidate.slice(0, separator) : undefined;
  }
  if (!chain.includes(base)) chain.push(base);
  return chain;
};
