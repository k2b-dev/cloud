import type { PublicDocument } from "../documents/public-document-types";

export type WorkflowRunDocumentsState = {
  items: PublicDocument[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export const mergeRefreshedWorkflowRunDocuments = (
  current: WorkflowRunDocumentsState,
  refreshed: WorkflowRunDocumentsState,
): WorkflowRunDocumentsState => {
  if (current.items.length === 0) return refreshed;

  const seen = new Set(refreshed.items.map((document) => document.id));
  const items = [...refreshed.items, ...current.items.filter((document) => !seen.has(document.id))];
  const total = Math.max(refreshed.total, items.length);
  return {
    items,
    total,
    hasMore: items.length < total,
    nextOffset: items.length < total ? items.length : null,
  };
};

/**
 * What "download all" will deliver: the server merges PDFs only when every
 * primary file is a PDF, otherwise it returns a ZIP. Unloaded pages leave an
 * all-PDF prefix undecided.
 */
export const workflowRunDownloadFormat = (state: WorkflowRunDocumentsState): "pdf" | "zip" | "pdf-or-zip" => {
  const nonPdf = state.items.some(
    (document) => document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType !== "application/pdf",
  );
  if (nonPdf) return "zip";
  return state.hasMore ? "pdf-or-zip" : "pdf";
};
