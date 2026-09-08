import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { GotenbergRenderError, mergePdfs, type RenderHtmlToPdfResult } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { Document, DocumentArtifact, DocumentTemplate } from "../contracts";
import { type DocumentReadAuthorizer, loadReadableWorkflowRunDocumentScopes, workflowRunDocumentAccessWhere } from "./document-browse";
import { type DocumentArtifactContent, type DocumentIssuanceActor, documentIssuanceService } from "./document-issuance";
import { type DocumentDbRow, hydrateDocuments, loadDocumentArtifacts } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { buildLiveRenderData } from "./document-rendering";
import { createRecordSnapshotDraft, type SnapshotTableReadAuthorizer } from "./document-snapshots";
import { get as getRecord } from "./records";
import type { ExpansionViewer } from "./relation-access";
import type { Table } from "./types";

const WORKFLOW_RUN_DOWNLOAD_MAX_DOCUMENTS = 1_000;

type DocumentPdfRenderer = NonNullable<Parameters<typeof documentIssuanceService.issueDocument>[0]["renderPdf"]>;

export const createDocumentForRecord = async (params: {
  template: DocumentTemplate;
  table: Table;
  recordId: string;
  actor: DocumentIssuanceActor;
  idempotencyKey: string;
  canReadTable: SnapshotTableReadAuthorizer;
  viewer?: ExpansionViewer;
  dateConfig?: DateContext;
  filename?: string | null;
  tags?: string[];
  workflowRunId?: string | null;
  workflowStepKey?: string | null;
  renderPdf?: DocumentPdfRenderer;
}): Promise<Result<Document>> => {
  const t = documentServiceText(params.dateConfig?.locale);
  if (!params.template.enabled) return fail(err.badInput(t.templateDisabled));
  if (params.template.tableId !== params.table.id) return fail(err.badInput(t.templateWrongTable));

  const record = await getRecord(params.table.id, params.recordId, {
    dateConfig: params.dateConfig,
    viewer: params.viewer,
  });
  if (!record) return fail(err.notFound(t.recordNotFound));

  const rendered = await buildLiveRenderData({
    template: params.template,
    table: params.table,
    record,
    dateConfig: params.dateConfig,
    createdAt: new Date(record.updatedAt),
  });
  if (!rendered.ok) return rendered;

  const snapshot = await createRecordSnapshotDraft({
    baseId: params.table.baseId,
    tableId: params.table.id,
    recordId: params.recordId,
    actorId: params.actor.kind === "user" ? params.actor.userId : null,
    canReadTable: params.canReadTable,
    viewer: params.viewer,
    dateConfig: params.dateConfig,
  });
  if (!snapshot.ok) return snapshot;

  const issued = await documentIssuanceService.issueDocument({
    template: params.template,
    snapshot: snapshot.data,
    renderData: { ...rendered.data.data, snapshot: snapshot.data },
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    dateConfig: params.dateConfig,
    filename: params.filename,
    tags: params.tags,
    workflowRunId: params.workflowRunId,
    workflowStepKey: params.workflowStepKey,
    renderPdf: params.renderPdf,
  });
  return issued.ok ? ok(issued.data.document) : issued;
};

export const getDocument = async (documentId: string): Promise<Document | null> => {
  const rows = await sql<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${documentId}::uuid`;
  return (await hydrateDocuments(rows))[0] ?? null;
};

export const getDocumentByShortId = async (shortId: string): Promise<Document | null> => {
  const rows = await sql<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE short_id = ${shortId}`;
  return (await hydrateDocuments(rows))[0] ?? null;
};

export const getDocumentArtifacts = async (documentId: string): Promise<DocumentArtifact[]> =>
  (await loadDocumentArtifacts([documentId])).get(documentId) ?? [];

export const getDocumentArtifact = (documentId: string, key: string, locale?: string): Promise<Result<DocumentArtifactContent>> =>
  documentIssuanceService.getDocumentArtifact(documentId, key, locale);

export const getDocumentPdf = async (document: Document, locale?: string): Promise<Result<RenderHtmlToPdfResult>> => {
  const t = documentServiceText(locale);
  const pdf = document.artifacts.find((artifact) => artifact.key === "pdf");
  if (!pdf || pdf.mimeType !== "application/pdf") return fail(err.internal(t.noCanonicalPdf));
  const stored = await getDocumentArtifact(document.id, "pdf", locale);
  if (!stored.ok) return stored;
  if (
    stored.data.fileId !== pdf.fileId ||
    stored.data.filename !== pdf.filename ||
    stored.data.mimeType !== pdf.mimeType ||
    stored.data.sizeBytes !== pdf.sizeBytes ||
    stored.data.sha256 !== pdf.sha256
  )
    return fail(err.internal(t.artifactMetadataIntegrityFailed));
  return ok({ pdf: stored.data.bytes, contentType: "application/pdf" });
};

export const renderWorkflowDocumentsPdf = async (
  workflowRunId: string,
  canRead: DocumentReadAuthorizer,
  locale?: string,
): Promise<Result<RenderHtmlToPdfResult & { filename: string; documentCount: number }>> => {
  const t = documentServiceText(locale);
  const accessWhere = workflowRunDocumentAccessWhere(await loadReadableWorkflowRunDocumentScopes(workflowRunId, canRead));
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid AND (${accessWhere})
  `;
  if (count === 0) return fail(err.badInput(t.noWorkflowDocuments));
  if (count > WORKFLOW_RUN_DOWNLOAD_MAX_DOCUMENTS) {
    return fail(err.badInput(t.workflowDocumentLimit({ limit: WORKFLOW_RUN_DOWNLOAD_MAX_DOCUMENTS })));
  }
  const rows = await sql<DocumentDbRow[]>`
    SELECT * FROM grids.documents
    WHERE workflow_run_id = ${workflowRunId}::uuid AND (${accessWhere})
    ORDER BY created_at ASC, id ASC
  `;
  const documents = await hydrateDocuments(rows);
  const files: Array<{ pdf: Uint8Array; filename: string }> = [];
  for (const document of documents) {
    const pdf = await getDocumentPdf(document, locale);
    if (!pdf.ok) return pdf;
    files.push({ pdf: pdf.data.pdf, filename: document.filename });
  }
  if (files.length === 1) {
    return ok({ pdf: files[0]!.pdf, contentType: "application/pdf", filename: files[0]!.filename, documentCount: 1 });
  }
  try {
    const merged = await mergePdfs({ files });
    return ok({ ...merged, filename: `workflow-run-${workflowRunId.slice(0, 8)}.pdf`, documentCount: files.length });
  } catch (error) {
    if (error instanceof GotenbergRenderError) {
      return fail(
        error.code === "bad_input" || error.code === "not_configured" ? err.badInput(error.message) : err.internal(error.message),
      );
    }
    throw error;
  }
};
