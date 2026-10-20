import { keyboardPlatform } from "@k2b/ui";
import { helpAgentMarkdown } from "../_internal/help-catalog";
import type { HelpArticle } from "../services/help/types";
import { type HelpDocumentPayload, parseHelpReference } from "../shared/help";
import { renderHelpMarkdown } from "../shared/markdown";

/** The same authorized article presentation for the API and the server's first frame. */
export const buildHelpDocumentPayload = (
  document: HelpArticle,
  userAgent: string,
  renderMarkdown: typeof renderHelpMarkdown = renderHelpMarkdown,
): HelpDocumentPayload => {
  const links = (reference: { appId?: string; documentId: string }) =>
    document.links[`${reference.appId ?? document.appId}/${reference.documentId}`];
  const resolve = (reference: string) => {
    const ref = parseHelpReference(reference);
    return ref ? links(ref) : undefined;
  };
  const payload: HelpDocumentPayload = {
    locale: document.locale,
    id: document.documentId,
    title: document.title,
    markdown: helpAgentMarkdown(document),
    kind: document.kind,
    needs: document.needs,
    next: document.next ? resolve(document.next) : undefined,
    related: document.related.flatMap((reference) => {
      const target = resolve(reference);
      return target ? [target] : [];
    }),
    html: renderMarkdown(document.markdown, {
      locale: document.locale,
      platform: keyboardPlatform(userAgent),
      links,
    }),
  };
  return payload;
};
