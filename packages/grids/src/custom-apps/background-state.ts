/** Presentation derived from durable runs and stored documents. */
export type BackgroundDocumentState = {
  status: "draft" | "running" | "ready" | "failed" | "missing" | "attention";
  finalized?: boolean;
  message?: string;
  document?: { id: string; number: string; blockId: string };
  downloadUrl?: string;
};
