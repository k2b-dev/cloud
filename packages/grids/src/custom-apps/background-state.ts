/** Presentation derived from durable runs and stored documents. */
export type BackgroundDocumentState = {
  status: "draft" | "running" | "ready" | "failed" | "missing" | "attention";
  document?: { id: string; number: string; blockId: string };
  downloadUrl?: string;
};
