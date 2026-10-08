/**
 * Links extension for marked
 *
 * Renders links with the shared Markdown link contract of `@k2b/ui`: a
 * reference to Cloud content (a relative URL) is a calm pill with a type icon,
 * a web link is prose text with a thin accent underline and a small arrow, and
 * a mail link has no arrow.
 */

import { markdownLinkReference, renderMarkdownLink } from "@k2b/ui";
import type { MarkedExtension, Tokens } from "marked";

export type LinksExtensionOptions = {
  /** Open external links in a new tab by default. */
  externalTarget?: "_blank" | "_self";
  /** Existing content keeps `_blank`; help opts into in-app navigation. */
  internalTarget?: "_blank" | "_self";
  /** Locale of the type name that starts a reference's accessible name. */
  locale?: string;
};

const isExternalHref = (href: string) => /^(?:https?:)?\/\//i.test(href);

export function linksExtension(options: LinksExtensionOptions = {}): MarkedExtension {
  return {
    renderer: {
      link(token: Tokens.Link): string {
        const target = isExternalHref(token.href) ? (options.externalTarget ?? "_blank") : (options.internalTarget ?? "_blank");
        return renderMarkdownLink({
          href: token.href,
          html: this.parser.parseInline(token.tokens),
          title: token.title ?? undefined,
          target: target === "_blank" ? "_blank" : undefined,
          reference: markdownLinkReference(token.href),
          locale: options.locale,
        });
      },
    },
  };
}
