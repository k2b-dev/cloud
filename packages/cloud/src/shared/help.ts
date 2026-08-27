export type HelpDocumentManifest = {
  /** Resolved content locale. Present on request-scoped manifests. */
  locale?: string;
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order: number;
  /** Core-owned endpoint used for debounced full-text search. */
  searchUrl: string;
  url: string;
};

export type HelpManifest = {
  manifestHash: string;
  pageBase: string;
  /** Base language that owns the complete logical article set. Absent on legacy registrations. */
  baseLocale?: string;
  /** Localized metadata variants keyed by canonical BCP 47 locale. */
  documentsByLocale?: Readonly<Record<string, readonly HelpDocumentManifest[]>>;
  documents: readonly HelpDocumentManifest[];
};

export type HelpSearchPayload = {
  /** Resolved request locale. Optional only for rolling compatibility with older Cloud hosts. */
  locale?: string;
  ids: string[];
};

export type HelpDocumentPayload = {
  /** Resolved request locale. Optional only for rolling compatibility with older Cloud hosts. */
  locale?: string;
  id: string;
  title: string;
  markdown: string;
  html: string;
};

export type ResolvedHelpManifest = Omit<HelpManifest, "documentsByLocale" | "documents"> & {
  locale: string;
  documents: readonly HelpDocumentManifest[];
};

const canonicalLocale = (value: string): string | undefined => {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
};

/** Exact locale, then BCP 47 ancestors, then the corpus base locale. */
export const helpLocaleChain = (requestedLocale: string, baseLocale: string): string[] => {
  const requested = canonicalLocale(requestedLocale);
  const base = canonicalLocale(baseLocale) ?? "en";
  const chain: string[] = [];
  if (requested) {
    let candidate: string | undefined = requested;
    while (candidate) {
      chain.push(candidate);
      const separator = candidate.lastIndexOf("-");
      candidate = separator > 0 ? candidate.slice(0, separator) : undefined;
    }
  }
  if (!chain.includes(base)) chain.push(base);
  return chain;
};

/** Resolve localized Help metadata per article while preserving the base article set and order. */
export const resolveHelpManifest = (manifest: HelpManifest, requestedLocale: string): ResolvedHelpManifest => {
  const baseLocale = canonicalLocale(manifest.baseLocale ?? "en") ?? "en";
  const variants = manifest.documentsByLocale ?? {};
  const chain = helpLocaleChain(requestedLocale, baseLocale);
  const selectedLocale = chain.find((locale) => locale === baseLocale || variants[locale] !== undefined) ?? baseLocale;
  const overlays = [...chain.slice(0, chain.indexOf(baseLocale)), baseLocale].reverse();
  const byId = new Map(manifest.documents.map((document) => [document.id, document]));
  for (const locale of overlays) {
    if (locale === baseLocale) continue;
    for (const document of variants[locale] ?? []) byId.set(document.id, { ...byId.get(document.id), ...document });
  }
  return {
    manifestHash: manifest.manifestHash,
    pageBase: manifest.pageBase,
    baseLocale,
    locale: selectedLocale,
    documents: manifest.documents.map((document) => ({ ...(byId.get(document.id) ?? document), locale: selectedLocale })),
  };
};
