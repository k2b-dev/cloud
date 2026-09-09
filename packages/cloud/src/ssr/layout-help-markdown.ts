import type { HelpDocumentManifest, HelpDocumentPayload } from "@k2b/cloud/shared";

type MarkdownHelpDocument = Pick<HelpDocumentManifest, "title" | "description"> & Pick<HelpDocumentPayload, "markdown">;

export const formatHelpDocumentMarkdown = (document: MarkdownHelpDocument) =>
  [`# ${document.title.trim()}`, document.description?.trim(), document.markdown.trim()].filter(Boolean).join("\n\n") + "\n";

export const formatHelpBundleMarkdown = (documents: readonly MarkdownHelpDocument[]) =>
  documents.map((document) => formatHelpDocumentMarkdown(document).trimEnd()).join("\n\n") + "\n";
