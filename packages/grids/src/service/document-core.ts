import { GotenbergRenderError, mergePdfs, type RenderHtmlToPdfResult } from "@k2b/cloud/services";
import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { Document, DocumentArtifact, DocumentTemplate } from "../contracts";
import { type DocumentReadAuthorizer, loadReadableWorkflowRunDocumentScopes, workflowRunDocumentAccessWhere } from "./document-browse";
import { type DocumentArtifactContent, type DocumentIssuanceActor, documentIssuanceService } from "./document-issuance";
import { type DocumentDbRow, hydrateDocuments, loadDocumentArtifacts } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { buildLiveRenderData } from "./document-rendering";
import { captureRecordSnapshotDraft, type SnapshotTableReadAuthorizer } from "./document-snapshots";
import { getStoredTemplate } from "./document-templates";
import type { ExpansionViewer } from "./relation-access";
import { get as getTable } from "./tables";
import { buildTemplateAppData } from "./template-context";
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
  if (params.template.tableId !== params.table.id) return fail(err.badInput(t.templateWrongTable));
  if (!(await params.canReadTable({ baseId: params.table.baseId, tableId: params.table.id }))) {
    return fail(err.notFound(t.recordNotFound));
  }
  return documentIssuanceService.issueRecordDocument(
    {
      ...params,
      baseId: params.table.baseId,
      tableId: params.table.id,
      templateId: params.template.id,
    },
    async () => {
      // Settings use their own cache/pool. Read them before reserving the
      // capture connection, then share this context with every HTML field.
      const templateApp = await buildTemplateAppData();
      return sql
        .begin(async (client) => {
          await client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
          const template = await getStoredTemplate(params.template.id, client);
          const table = await getTable(params.table.id, { client });
          if (!template || !table) return fail(err.notFound(t.tableNotFound));
          if (!template.enabled || template.deletedAt) return fail(err.badInput(t.templateDisabled));

          const captured = await captureRecordSnapshotDraft({
            client,
            templateApp,
            baseId: params.table.baseId,
            tableId: params.table.id,
            recordId: params.recordId,
            actorId: params.actor.kind === "user" ? params.actor.userId : null,
            canReadTable: params.canReadTable,
            viewer: params.viewer,
            dateConfig: params.dateConfig,
          });
          if (!captured.ok) return captured;
          const { snapshot, record } = captured.data;

          const rendered = await buildLiveRenderData({
            client,
            app: templateApp,
            template,
            table,
            record,
            dateConfig: params.dateConfig,
            createdAt: new Date(record.updatedAt),
          });
          if (!rendered.ok) return rendered;

          return ok({
            template,
            snapshot,
            renderData: { ...rendered.data.data, snapshot },
          });
        })
        .catch((error: unknown) => {
          // Concurrent first captures can race on the Record's scan-code row.
          // Roll back the whole snapshot and expose a retryable domain conflict,
          // never a partially refreshed capture or an unhandled database error.
          if (error instanceof Error && (("errno" in error && error.errno === "40001") || ("code" in error && error.code === "40001"))) {
            return fail(err.conflict(t.recordChanged));
          }
          throw error;
        });
    },
  );
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

export const getDocumentPrimaryArtifact = async (document: Document, locale?: string): Promise<Result<DocumentArtifactContent>> => {
  const t = documentServiceText(locale);
  const primary = document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey);
  if (!primary) return fail(err.internal(t.artifactMetadataIntegrityFailed));
  const stored = await getDocumentArtifact(document.id, primary.key, locale);
  if (!stored.ok) return stored;
  if (
    stored.data.fileId !== primary.fileId ||
    stored.data.filename !== primary.filename ||
    stored.data.mimeType !== primary.mimeType ||
    stored.data.sizeBytes !== primary.sizeBytes ||
    stored.data.sha256 !== primary.sha256
  )
    return fail(err.internal(t.artifactMetadataIntegrityFailed));
  return stored;
};

/** PDF-only consumers (merge and PDF sharing) keep an explicit format check. */
export const getDocumentPdf = async (document: Document, locale?: string): Promise<Result<RenderHtmlToPdfResult>> => {
  const stored = await getDocumentPrimaryArtifact(document, locale);
  if (!stored.ok) return stored;
  if (stored.data.mimeType !== "application/pdf") return fail(err.badInput(documentServiceText(locale).noCanonicalPdf));
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
