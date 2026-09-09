import { toPgUuidArray } from "@k2b/cloud/services";
import { type SQL, sql } from "bun";
import type {
  Document,
  DocumentArtifact,
  DocumentLink,
  DocumentSummary,
  DocumentTemplate,
  DocumentTemplateSummary,
  RecordSnapshot,
  RecordSnapshotSummary,
} from "../contracts";

export type DocumentDbRow = Record<string, unknown>;

type DocumentArtifactDbRow = {
  document_id: string;
  artifact_key: string;
  file_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  sha256: string;
};

const strictJsonObject = (value: unknown, field: string): Record<string, unknown> => {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`${field} contains invalid JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${field} must be a JSON object`);
  return parsed as Record<string, unknown>;
};

const mapDocumentArtifact = (row: DocumentArtifactDbRow): DocumentArtifact => ({
  key: row.artifact_key,
  fileId: row.file_id,
  filename: row.filename,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  sha256: row.sha256,
});

export const loadDocumentArtifacts = async (documentIds: readonly string[], db: SQL = sql): Promise<Map<string, DocumentArtifact[]>> => {
  if (documentIds.length === 0) return new Map();
  const rows = await db<DocumentArtifactDbRow[]>`
    SELECT artifact.document_id::text, artifact.artifact_key, artifact.file_id::text,
      file.filename, file.mime_type, file.size_bytes, file.sha256
    FROM grids.document_artifacts artifact
    JOIN grids.files file ON file.id = artifact.file_id
    JOIN grids.file_protected_references protected
      ON protected.file_id = file.id AND protected.owner_kind = 'document_artifact' AND protected.owner_id = artifact.document_id
    WHERE artifact.document_id = ANY(${toPgUuidArray([...documentIds])}::uuid[])
    ORDER BY artifact.document_id, artifact.artifact_key
  `;
  const result = new Map<string, DocumentArtifact[]>();
  for (const row of rows) result.set(row.document_id, [...(result.get(row.document_id) ?? []), mapDocumentArtifact(row)]);
  return result;
};

export const mapDocumentTemplate = (row: DocumentDbRow): DocumentTemplate => {
  const renderer =
    row.renderer_kind === "html" &&
    typeof row.html === "string" &&
    typeof row.number_template === "string" &&
    typeof row.filename_template === "string"
      ? {
          kind: "html" as const,
          body: row.html,
          ...(typeof row.header_html === "string" ? { header: row.header_html } : {}),
          ...(typeof row.footer_html === "string" ? { footer: row.footer_html } : {}),
          ...(typeof row.page_css === "string" ? { css: row.page_css } : {}),
          numberTemplate: row.number_template,
          filenameTemplate: row.filename_template,
        }
      : row.renderer_kind === "profile" &&
          typeof row.profile_id === "string" &&
          typeof row.profile_version === "number" &&
          typeof row.profile_input_template === "string"
        ? { kind: "profile" as const, id: row.profile_id, version: row.profile_version, inputTemplate: row.profile_input_template }
        : null;
  if (!renderer) throw new Error("document template renderer invariant violated");
  return {
    id: row.id as string,
    shortId: row.short_id as string,
    tableId: row.table_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    source: row.source as string,
    renderer,
    enabled: row.enabled as boolean,
    position: row.position as number,
    createdBy: (row.created_by as string | null) ?? null,
    updatedBy: (row.updated_by as string | null) ?? null,
    deletedAt: row.deleted_at ? (row.deleted_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
};

export const mapRecordSnapshot = (row: DocumentDbRow): RecordSnapshot => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  tableId: row.table_id as string,
  recordId: row.record_id as string,
  root: strictJsonObject(row.root, "record snapshot root"),
  graph: strictJsonObject(row.graph, "record snapshot graph"),
  createdBy: (row.created_by as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
});

export const mapRecordSnapshotSummary = (row: DocumentDbRow): RecordSnapshotSummary => ({
  id: row.id as string,
  shortId: row.short_id as string,
  baseId: row.base_id as string,
  tableId: row.table_id as string,
  recordId: row.record_id as string,
  createdBy: (row.created_by as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
});

export const mapDocumentSummary = (row: DocumentDbRow, artifacts: DocumentArtifact[]): DocumentSummary => {
  const pdf = artifacts.find((artifact) => artifact.key === "pdf");
  if (!pdf || pdf.mimeType !== "application/pdf" || pdf.filename !== row.filename) throw new Error("document artifact invariant violated");
  return {
    id: row.id as string,
    shortId: row.short_id as string,
    templateId: row.template_id as string,
    workflowRunId: (row.workflow_run_id as string | null) ?? null,
    snapshotId: row.snapshot_id as string,
    baseId: row.base_id as string,
    tableId: row.table_id as string,
    recordId: row.record_id as string,
    documentNumber: row.document_number as string,
    filename: (row.filename as string | null) ?? `${row.document_number as string}.pdf`,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    artifacts,
    profile:
      typeof row.profile_id === "string" && typeof row.profile_version === "number"
        ? { id: row.profile_id, version: row.profile_version }
        : null,
    validationStatus: row.validation_status === "valid" || row.validation_status === "warning" ? row.validation_status : null,
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
};

export const mapDocument = (row: DocumentDbRow, artifacts: DocumentArtifact[]): Document => ({
  ...mapDocumentSummary(row, artifacts),
  templateSnapshot: strictJsonObject(row.template_snapshot, "Document template snapshot"),
  renderData: strictJsonObject(row.render_data, "Document render data"),
});

export const hydrateDocumentSummaries = async (rows: DocumentDbRow[], db: SQL = sql): Promise<DocumentSummary[]> => {
  const artifacts = await loadDocumentArtifacts(
    rows.map((row) => String(row.id)),
    db,
  );
  return rows.map((row) => mapDocumentSummary(row, artifacts.get(String(row.id)) ?? []));
};

export const hydrateDocuments = async (rows: DocumentDbRow[], db: SQL = sql): Promise<Document[]> => {
  const artifacts = await loadDocumentArtifacts(
    rows.map((row) => String(row.id)),
    db,
  );
  return rows.map((row) => mapDocument(row, artifacts.get(String(row.id)) ?? []));
};

export const mapDocumentLink = (row: DocumentDbRow): DocumentLink => ({
  id: row.id as string,
  shortId: row.short_id as string,
  documentId: row.document_id as string,
  baseId: row.base_id as string,
  tableId: row.table_id as string,
  recordId: row.record_id as string,
  comment: (row.comment as string | null) ?? null,
  createdBy: (row.created_by as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
  expiresAt: (row.expires_at as Date).toISOString(),
  revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
  revokedBy: (row.revoked_by as string | null) ?? null,
  lastAccessedAt: row.last_accessed_at ? (row.last_accessed_at as Date).toISOString() : null,
  accessCount: Number(row.access_count ?? 0),
});

export const summarizeDocumentTemplate = (template: DocumentTemplate): DocumentTemplateSummary => ({
  id: template.id,
  shortId: template.shortId,
  tableId: template.tableId,
  name: template.name,
  description: template.description,
  renderer:
    template.renderer.kind === "html"
      ? { kind: "html" }
      : { kind: "profile", id: template.renderer.id, version: template.renderer.version },
  enabled: template.enabled,
  position: template.position,
  createdAt: template.createdAt,
  updatedAt: template.updatedAt,
});

export const summarizeDocument = (document: Document): DocumentSummary => ({
  id: document.id,
  shortId: document.shortId,
  templateId: document.templateId,
  workflowRunId: document.workflowRunId,
  snapshotId: document.snapshotId,
  baseId: document.baseId,
  tableId: document.tableId,
  recordId: document.recordId,
  documentNumber: document.documentNumber,
  filename: document.filename,
  tags: document.tags,
  artifacts: document.artifacts,
  profile: document.profile,
  validationStatus: document.validationStatus,
  createdBy: document.createdBy,
  createdAt: document.createdAt,
});
