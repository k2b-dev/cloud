import { err } from "@k2b/stdlib";
import type { SQL } from "bun";
import type { Document } from "../contracts";
import type { DocumentProfileArtifactDraft } from "../document-profiles";
import { logAudit } from "./audit";
import type { DocumentIssuanceActor } from "./document-issuance";
import { type DocumentDbRow, hydrateDocuments } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { type capturedDocumentRecords, persistDocumentRecordSources } from "./document-record-sources";
import { createProtected, createProtectedStreamed } from "./files";
import { bindNumberAllocation } from "./number-series";

/** One transactional storage path for every issued document. The issuance
 * owner locks its receipt before calling this; artifact bytes are already
 * validated and detached from renderer-owned buffers. */
export const persistIssuedDocument = async (
  input: {
    receiptId: string;
    shortId: string;
    baseId: string;
    queryDataId: string | null;
    associatedQueryDataId?: string;
    sources?: ReturnType<typeof capturedDocumentRecords>;
    record: { templateId: string; snapshotId: string; tableId: string; recordId: string } | null;
    workflowRunId: string | null;
    workflowStepKey: string | null;
    number: string;
    tags: string[];
    templateSnapshot: Record<string, unknown>;
    templateRevision: string;
    renderData: Record<string, unknown>;
    rendererVersion: string;
    profile: {
      id: string;
      version: number;
      input: Record<string, unknown>;
      output?: Record<string, unknown>;
      sha256: string;
      validatorVersion: string;
      validationStatus: "valid" | "warning" | "unchecked";
      validationReport: Record<string, unknown>;
    } | null;
    primary: DocumentProfileArtifactDraft;
    artifacts: readonly DocumentProfileArtifactDraft[];
    actor: DocumentIssuanceActor;
    issuedAt: string;
    allocationId: string | null;
    locale?: string;
  },
  tx: SQL,
): Promise<Document> => {
  const t = documentServiceText(input.locale);
  const documentId = Bun.randomUUIDv7();
  const actorId =
    input.actor.kind === "user" ? input.actor.userId : input.actor.kind === "service_account" ? input.actor.delegatedUserId : null;
  const tableId = input.record?.tableId ?? null;
  const recordId = input.record?.recordId ?? null;
  const files: { key: string; fileId: string }[] = [];
  for (const draft of input.artifacts) {
    const owner = {
      ownerKind: "document_artifact" as const,
      ownerId: documentId,
      baseId: input.baseId,
      tableId,
      recordId,
      userId: actorId,
    };
    const file =
      "bytes" in draft
        ? await createProtected({ ...owner, filename: draft.filename, mimeType: draft.mediaType, bytes: draft.bytes }, tx)
        : await createProtectedStreamed(
            { ...owner, filename: draft.filename, mimeType: draft.mediaType, stream: draft.stream, locale: input.locale },
            tx,
          );
    if (!file.ok) throw file.error;
    files.push({ key: draft.key, fileId: file.data.id });
  }
  const [row] = await tx<DocumentDbRow[]>`
    INSERT INTO grids.documents (
      id, short_id, template_id, workflow_run_id, workflow_step_key, snapshot_id, base_id, table_id, record_id, query_data_id, associated_query_data_id,
      document_number, filename, primary_artifact_key, record_sources_complete, tags, template_snapshot, render_data, renderer_kind, renderer_version, template_revision,
      profile_id, profile_version, profile_snapshot, profile_output, snapshot_sha256,
      validator_version, validation_status, validation_report, issued_actor, created_by, created_at
    ) VALUES (
      ${documentId}::uuid, ${input.shortId}, ${input.record?.templateId ?? null}::uuid, ${input.workflowRunId}::uuid, ${input.workflowStepKey},
      ${input.record?.snapshotId ?? null}::uuid, ${input.baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, ${input.queryDataId}::uuid, ${input.associatedQueryDataId ?? null}::uuid,
      ${input.number}, ${input.primary.filename}, ${input.primary.key}, ${input.record !== null || input.sources != null}, ${tx.array(input.tags, "TEXT")}, ${input.templateSnapshot}::jsonb,
      ${input.renderData}::jsonb, ${input.profile ? "profile" : "html"}, ${input.rendererVersion}, ${input.templateRevision},
      ${input.profile?.id ?? null}, ${input.profile?.version ?? null}, ${input.profile?.input ?? null}::jsonb,
      ${input.profile?.output ?? null}::jsonb, ${input.profile?.sha256 ?? null},
      ${input.profile?.validatorVersion ?? null}, ${input.profile?.validationStatus ?? null}, ${input.profile?.validationReport ?? null}::jsonb,
      ${input.actor}::jsonb, ${actorId}::uuid, ${input.issuedAt}
    ) RETURNING *
  `;
  if (!row) throw err.internal(t.documentInsertFailed);
  if (input.record) {
    await tx`INSERT INTO grids.document_record_sources (document_id, table_id, record_id, version)
      SELECT ${documentId}::uuid, table_id, record_id, (root->>'version')::bigint
      FROM grids.record_snapshots WHERE id = ${input.record.snapshotId}::uuid`;
  } else {
    await persistDocumentRecordSources({ documentId, baseId: input.baseId, sources: input.sources ?? null, locale: input.locale }, tx);
  }
  for (const file of files)
    await tx`
    INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
    VALUES (${documentId}::uuid, ${file.key}, ${file.fileId}::uuid)
  `;
  if (input.allocationId) await bindNumberAllocation(tx, input.allocationId, { kind: "document", id: documentId });
  await tx`
    UPDATE grids.document_issuances SET document_id = ${documentId}::uuid, completed_at = now(), frozen_request = NULL
    WHERE id = ${input.receiptId}::uuid
  `;
  await logAudit(
    {
      baseId: input.baseId,
      tableId,
      recordId,
      userId: actorId,
      action: "document.created",
      diff: { documentId: { old: null, new: input.shortId }, documentNumber: { old: null, new: input.number } },
    },
    tx,
  );
  const [document] = await hydrateDocuments([row], tx);
  if (!document) throw err.internal(t.createdDocumentReadFailed);
  return document;
};
