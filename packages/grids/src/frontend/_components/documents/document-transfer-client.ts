type PreviewDocumentTemplateInput = {
  templateId: string;
  recordId: string;
  signal?: AbortSignal;
};

type GenerateDocumentTemplateInput = PreviewDocumentTemplateInput & {
  filename?: string;
  tags?: string[];
  idempotencyKey?: string;
};

type DocumentTemplateDraftPreviewInput = {
  source: string;
  html?: string | null;
  headerHtml?: string | null;
  footerHtml?: string | null;
  pageCss?: string | null;
  numberTemplate?: string;
  filenameTemplate?: string;
  profile?: { id: string; version: number; inputTemplate: string } | null;
  recordId: string;
};

const documentTemplateActionUrl = (templateId: string, action: "preview-pdf" | "generate") =>
  `/api/grids/documents/templates/${encodeURIComponent(templateId)}/${action}`;

export const requestDocumentTemplatePreview = (input: PreviewDocumentTemplateInput): Promise<Response> =>
  fetch(documentTemplateActionUrl(input.templateId, "preview-pdf"), {
    method: "POST",
    signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordId: input.recordId }),
  });

export const requestDocumentTemplateGeneration = (input: GenerateDocumentTemplateInput): Promise<Response> =>
  fetch(documentTemplateActionUrl(input.templateId, "generate"), {
    method: "POST",
    signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recordId: input.recordId,
      filename: input.filename,
      tags: input.tags,
      idempotencyKey: input.idempotencyKey,
    }),
  });

export const requestDocumentDownload = (documentId: string, signal?: AbortSignal): Promise<Response> =>
  fetch(`/api/grids/documents/${encodeURIComponent(documentId)}/download`, signal ? { signal } : undefined);

export const requestDocumentTemplateDraftPreview = (input: {
  tableId: string;
  templateId?: string;
  draft: DocumentTemplateDraftPreviewInput;
  signal?: AbortSignal;
}): Promise<Response> => {
  const scope = input.templateId
    ? `/templates/${encodeURIComponent(input.templateId)}`
    : `/templates/by-table/${encodeURIComponent(input.tableId)}`;
  return fetch(`/api/grids/documents${scope}/preview-draft`, {
    method: "POST",
    signal: input.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input.draft),
  });
};

export const requestWorkflowDocumentsDownload = (workflowRunId: string, signal?: AbortSignal): Promise<Response> =>
  fetch(`/api/grids/workflows/runs/${encodeURIComponent(workflowRunId)}/documents/download`, signal ? { signal } : undefined);

export const isPdfResponse = (response: Response): boolean =>
  response.ok && (response.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf");
