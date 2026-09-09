import type { HelpDocumentManifest } from "@k2b/cloud/shared";

type HelpArticleSession = { articleScrollTop: number };
type HelpArticleScroller = { scrollTop: number };
type HelpArticleHeading = { focus: (options?: FocusOptions) => void };

export const adjacentHelpDocuments = (documents: readonly HelpDocumentManifest[], activeId: string | null) => {
  const index = documents.findIndex((document) => document.id === activeId);
  if (index < 0) return { previous: null, next: null };

  return {
    previous: documents[index - 1] ?? null,
    next: documents[index + 1] ?? null,
  };
};

export const resetHelpArticleScroll = (session: HelpArticleSession, scroller?: HelpArticleScroller) => {
  session.articleScrollTop = 0;
  if (scroller) scroller.scrollTop = 0;
};

export const focusHelpArticleHeading = (heading?: HelpArticleHeading) => {
  heading?.focus({ preventScroll: true });
};
