import type { DocumentArtifact } from "./contracts";

/** Bearer links expose only a document's primary PDF, never arbitrary exports. */
export const documentAllowsPublicLinks = (document: {
  primaryArtifactKey: string;
  artifacts: readonly Pick<DocumentArtifact, "key" | "mimeType">[];
}): boolean => document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType === "application/pdf";
