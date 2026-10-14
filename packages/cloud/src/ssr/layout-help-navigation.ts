type HelpArticleSession = { articleScrollTop: number };
type HelpArticleScroller = { scrollTop: number };
type HelpArticleHeading = { focus: (options?: FocusOptions) => void };

export const resetHelpArticleScroll = (session: HelpArticleSession, scroller?: HelpArticleScroller) => {
  session.articleScrollTop = 0;
  if (scroller) scroller.scrollTop = 0;
};

export const focusHelpArticleHeading = (heading?: HelpArticleHeading) => {
  heading?.focus({ preventScroll: true });
};
