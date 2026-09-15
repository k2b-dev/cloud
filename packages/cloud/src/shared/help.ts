import { localeFallbackChain } from "./locale";

export type HelpDocumentManifest = {
  /** Resolved content locale on central Help manifests. */
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

export type HelpSearchPayload = {
  /** Resolved request locale. */
  locale: string;
  ids: string[];
};

export type HelpDocumentPayload = {
  /** Resolved request locale. */
  locale: string;
  id: string;
  title: string;
  markdown: string;
  html: string;
};

/** Exact locale, then BCP 47 ancestors, then the corpus base locale. */
export const helpLocaleChain = localeFallbackChain;
