import { Marked } from "marked";
import { MAX_MESSAGE_LINK_LENGTH, MAX_MESSAGE_LINKS } from "./contracts";

const markdown = new Marked({ gfm: true, breaks: true });

/** Extract rendered Markdown links, never image sources, code, HTML or non-web schemes. */
export const extractMessageLinks = (body: string): string[] => {
  const links = new Set<string>();
  markdown.walkTokens(markdown.lexer(body), (token) => {
    if (token.type !== "link" || links.size >= MAX_MESSAGE_LINKS) return;
    const href = token.href;
    if (href.length > MAX_MESSAGE_LINK_LENGTH) return;
    try {
      const url = new URL(href);
      if (url.protocol === "https:" || url.protocol === "http:") links.add(href);
    } catch {
      // Invalid destinations do not become shared links.
    }
  });
  return [...links];
};
