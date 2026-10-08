/**
 * Links extension for marked
 *
 * Renders links with the shared Markdown link contract of `@k2b/ui`: a
 * reference to Cloud content (a relative URL) is a calm pill with a type icon,
 * a web link is prose text with a thin accent underline and a small arrow, and
 * a mail link has no arrow. A `note://` or `attach://` link names Notebooks
 * content that only Notebooks resolves, so here its label is text.
 */

import { markdownLinkReference, renderMarkdownLink } from "@k2b/ui";
import type { MarkedExtension, Token, Tokens } from "marked";

export type LinksExtensionOptions = {
  /** Open external links in a new tab by default. */
  externalTarget?: "_blank" | "_self";
  /** Existing content keeps `_blank`; help opts into in-app navigation. */
  internalTarget?: "_blank" | "_self";
  /** Locale of the type name that starts a reference's accessible name. */
  locale?: string;
};

const isExternalHref = (href: string) => /^(?:https?:)?\/\//i.test(href);

/** A link label holds no second link: a raw anchor tag in it stays text, as in `MarkdownView`. */
const labelTokens = (tokens: Token[]): Token[] =>
  tokens.map((token) => {
    if (token.type === "html" && /^<\/?a(?:[\s/>]|$)/i.test(token.raw))
      return { type: "text", raw: token.raw, text: token.raw, escaped: false };
    return "tokens" in token && token.tokens ? { ...token, tokens: labelTokens(token.tokens) } : token;
  });

export function linksExtension(options: LinksExtensionOptions = {}): MarkedExtension {
  return {
    renderer: {
      link(token: Tokens.Link): string {
        const html = this.parser.parseInline(labelTokens(token.tokens));
        if (/^(?:note|attach):/i.test(token.href)) return html;
        const target = isExternalHref(token.href) ? (options.externalTarget ?? "_blank") : (options.internalTarget ?? "_blank");
        return renderMarkdownLink({
          href: token.href,
          html,
          title: token.title ?? undefined,
          target: target === "_blank" ? "_blank" : undefined,
          reference: markdownLinkReference(token.href),
          locale: options.locale,
        });
      },
    },
  };
}
