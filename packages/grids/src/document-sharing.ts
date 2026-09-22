import type { DocumentArtifact } from "./contracts";

/**
 * Media types a public bearer link may serve. The list is the set of primary
 * artifact formats Grids renderers produce (HTML/PDF, table CSV/JSON/XML and
 * the financial profiles); `document-sharing.test.ts` checks that derivation.
 * Everything else, in particular HTML, SVG and other browser-renderable
 * types, never leaves through an anonymous link.
 */
export const PUBLIC_DOCUMENT_LINK_MEDIA_TYPES = ["application/pdf", "text/csv", "application/json", "application/xml", "application/zip"] as const;

export const documentMediaTypeAllowsPublicLinks = (mimeType: unknown): mimeType is (typeof PUBLIC_DOCUMENT_LINK_MEDIA_TYPES)[number] =>
  typeof mimeType === "string" && (PUBLIC_DOCUMENT_LINK_MEDIA_TYPES as readonly string[]).includes(mimeType);

/** Bearer links expose only a document's primary artifact, and only in a supported document format. */
export const documentAllowsPublicLinks = (document: {
  primaryArtifactKey: string;
  artifacts: readonly Pick<DocumentArtifact, "key" | "mimeType">[];
}): boolean =>
  documentMediaTypeAllowsPublicLinks(document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType);
