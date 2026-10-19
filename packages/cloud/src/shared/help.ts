import { localeFallbackChain } from "./locale";

/** Maximum number of page-specific Help articles shared with the panel. */
export const HELP_VIEW_LIMIT = 3;

export const HELP_KINDS = ["start", "task", "reference", "troubleshoot"] as const;
export type HelpKind = (typeof HELP_KINDS)[number];
/** The glossary's access levels; Help names only these, never app-specific permissions. */
export const HELP_ACCESS_LEVELS = ["view", "edit", "manage"] as const;
export type HelpAccessLevel = (typeof HELP_ACCESS_LEVELS)[number];
/** An article another article points to, resolved for the current reader. */
export type HelpArticleLink = {
  appId: string;
  appName: string;
  /** The target app's accent colour (registry appearance), when it declares one. */
  accent?: string;
  documentId: string;
  title: string;
  description?: string;
  icon?: string;
  /** Canonical page path: `/help/apps/<appId>/<documentId>`. */
  url: string;
};

export type HelpLinkResolver = (ref: { appId?: string; documentId: string }) => HelpArticleLink | undefined;

/** References have the same app-id grammar as capability declarations. */
export const HELP_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9-]*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const parseHelpReference = (value: string): { appId?: string; documentId: string; fragment: string } | undefined => {
  const [reference = "", ...fragments] = value.split("#");
  if (!HELP_REFERENCE_PATTERN.test(reference)) return undefined;
  const parts = reference.split("/");
  return {
    appId: parts.length === 2 ? parts[0] : undefined,
    documentId: parts.at(-1)!,
    fragment: fragments.length ? `#${fragments.join("#")}` : "",
  };
};

export type HelpDocumentManifest = {
  /** Resolved content locale on central Help manifests. */
  locale?: string;
  id: string;
  title: string;
  icon?: string;
  description?: string;
  order: number;
  /** Where the Help start lists the article; missing means `task`. */
  kind?: HelpKind;
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
  /** Agent text with Help-only presentation converted to portable Markdown. */
  markdown: string;
  html: string;
  kind: HelpKind;
  needs?: HelpAccessLevel;
  next?: HelpArticleLink;
  related: HelpArticleLink[];
};

/** Exact locale, then BCP 47 ancestors, then the corpus base locale. */
export const helpLocaleChain = localeFallbackChain;
