import { createHash } from "node:crypto";
import type { RenderHtmlToPdfResult } from "@k2b/cloud/services";
import { notifyWorkflowWorker, wakeWorkflowRunsWaitingOn } from "@k2b/cloud/workflows/store";
import { type DateContext, err, fail, ok, type Result, type ServiceError } from "@k2b/stdlib";
import { sql as defaultSql, type SQL } from "bun";
import { z } from "zod";
import { type Document, type DocumentArtifact, type DocumentTemplate, DocumentTemplateSchema } from "../contracts";
import type { DocumentProfileReference, PrimaryDocumentArtifact } from "../document-profile-contracts";
import { type DocumentArtifactDraft, type DocumentProfile, documentProfiles, profileKey, profileRegistry } from "../document-profiles";
import { financialQueryProfiles } from "../document-profiles/financial";
import { documentProfileInputMessage } from "../document-profiles/input-diagnostics";
import { validateDocumentArtifactDrafts } from "./document-artifact-drafts";
import { reserveDocumentExportClaims } from "./document-export-claims";
import { normalizeFinancialDocumentOutput } from "./document-financial-output";
import { persistIssuedDocument } from "./document-issuance-storage";
import { canonicalDocumentJson, canonicalJson } from "./document-json";
import { documentNumberFor } from "./document-liquid";
import { type DocumentDbRow, hydrateDocuments } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { validateDocumentProfileInput } from "./document-profile-validation";
import { DocumentQueryOutputSchema, validateDocumentQueryOutput } from "./document-query-output";
import { capturedDocumentRecords, resolveCapturedDocumentRecords } from "./document-record-sources";
import { buildDocumentRenderData, renderDocumentPdf, renderDocumentProfileInput } from "./document-rendering";
import { persistRecordSnapshot, type RecordSnapshotDraft, type SnapshotTableReadAuthorizer } from "./document-snapshots";
import {
  DocumentSourceVersionsInputSchema,
  DocumentSourceVersionsSchema,
  requireDocumentSourceVersions,
  sourceVersionsFromData,
} from "./document-source-versions";
import { normalizeDocumentTags } from "./document-values";
import { allocateNumberInTransaction } from "./number-series";
import { insertWithShortIdForDb } from "./short-id";
import { loadWorkflowQueryData, WorkflowDocumentDataReferenceSchema } from "./workflow-query-store";

const DOCUMENT_HTML_RENDERER_VERSION = "grids-liquid-gotenberg-v1";

export type DocumentIssuanceActor =
  | { kind: "user"; userId: string }
  | { kind: "service_account"; serviceAccountId: string; delegatedUserId: string | null; credentialId: string | null }
  | { kind: "system" };

const DocumentIssuanceActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.uuid() }).strict(),
  z
    .object({
      kind: z.literal("service_account"),
      serviceAccountId: z.uuid(),
      delegatedUserId: z.uuid().nullable(),
      credentialId: z.uuid().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("system") }).strict(),
]);

type FrozenDocumentRequest = {
  template: DocumentTemplate;
  snapshot: RecordSnapshotDraft;
  renderData: Record<string, unknown>;
  actor: DocumentIssuanceActor;
  tags: string[];
  workflowRunId: string | null;
  workflowStepKey: string | null;
  issuedAt: string;
  documentNumber: string;
  filename: string | null;
  allocationId: string | null;
  profileInput: Record<string, unknown> | null;
};

const JsonObjectSchema = z.record(z.string(), z.unknown());
const QueryDocumentRequestSchema = z
  .object({
    baseId: z.uuid(),
    runId: z.uuid(),
    stepKey: z.string().min(1),
    data: WorkflowDocumentDataReferenceSchema,
    associatedData: WorkflowDocumentDataReferenceSchema.optional(),
    output: DocumentQueryOutputSchema,
    sourceVersions: DocumentSourceVersionsSchema.optional(),
    filename: z.string().trim().min(1).max(255).nullable(),
    tags: z.array(z.string().trim().min(1)).max(20),
    actor: DocumentIssuanceActorSchema,
  })
  .strict();
const FrozenQueryDocumentSchema = QueryDocumentRequestSchema.extend({
  kind: z.literal("query"),
  issuedAt: z.iso.datetime(),
  number: z.string().min(1).max(200),
  financial: z
    .object({
      identifiers: z.object({ messageId: z.string(), paymentInformationId: z.string() }).strict(),
      normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/),
      runBindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .optional(),
});

const QueryDocumentInputSchema = QueryDocumentRequestSchema.extend({ sourceVersions: DocumentSourceVersionsInputSchema.optional() });

type QueryDocumentConfirmationRequired = { kind: "confirmationRequired"; receiptId: string; sha256: string };
type QueryDocumentConfirmationInput = {
  baseId: string;
  runId: string;
  receiptId: string;
  actor: DocumentIssuanceActor;
  locale?: string;
  /** The authenticated caller must still be allowed to execute this run and
   * read every source table; never derive this from the request's actor value. */
  authorize: (tableIds: readonly string[], client: SQL) => Promise<void>;
};
const validateConfirmationInput = (input: QueryDocumentConfirmationInput) => {
  if (
    !z.uuid().safeParse(input.baseId).success ||
    !z.uuid().safeParse(input.runId).success ||
    !/^[A-Za-z0-9]{6}$/.test(input.receiptId) ||
    !DocumentIssuanceActorSchema.safeParse(input.actor).success
  )
    throw err.badInput(documentServiceText(input.locale).requestInvalidJson);
};
type QueryIssuanceRow = IssuanceRow & {
  confirmation_hash: string | null;
  confirmed_actor: DocumentIssuanceActor | null;
  confirmed_at: Date | null;
};

/** Pin the manual invocation, revision and authorization snapshot. Current
 * permissions are checked separately by the caller at every boundary. */
const financialRunBinding = async (baseId: string, runId: string, client: SQL, locale?: string, lock = true) => {
  const [run] = await client<Array<{ workflow_version_id: string; authorization_snapshot: unknown; channel: string }>>`
    SELECT run.workflow_version_id::text, run.authorization_snapshot, profile.channel
    FROM workflows.run run
    JOIN grids.workflow_run_profile profile ON profile.run_id = run.id
    JOIN workflows.workflow workflow ON workflow.id = run.workflow_id
    WHERE run.id = ${runId}::uuid AND profile.base_id = ${baseId}::uuid AND run.app_id = 'grids'
      AND run.mode = 'execute' AND run.state IN ('queued', 'running', 'waiting') AND run.cancel_requested_at IS NULL
      AND profile.channel NOT IN ('schedule', 'recordEvent')
      AND workflow.active_version_id = run.workflow_version_id
    ${lock ? client`FOR UPDATE OF run FOR SHARE OF workflow` : client``}
  `;
  if (!run) throw err.conflict(documentServiceText(locale).financialRunChanged);
  return { baseId, runId, ...run };
};
const FrozenDocumentRequestSchema = z
  .object({
    template: DocumentTemplateSchema,
    snapshot: z
      .object({
        id: z.uuid(),
        baseId: z.uuid(),
        tableId: z.uuid(),
        recordId: z.uuid(),
        root: JsonObjectSchema,
        graph: JsonObjectSchema,
        createdBy: z.uuid().nullable(),
        createdAt: z.iso.datetime(),
      })
      .strict(),
    renderData: JsonObjectSchema,
    actor: DocumentIssuanceActorSchema,
    tags: z.array(z.string().trim().min(1)).max(20),
    workflowRunId: z.uuid().nullable(),
    workflowStepKey: z.string().min(1).nullable(),
    issuedAt: z.iso.datetime(),
    documentNumber: z.string().min(1).max(200),
    filename: z.string().min(1).max(255).nullable(),
    allocationId: z.uuid().nullable(),
    profileInput: JsonObjectSchema.nullable(),
  })
  .strict()
  .refine((value) => (value.workflowRunId === null) === (value.workflowStepKey === null), "workflow binding must be complete");

type IssuanceRow = {
  id: string;
  base_id: string;
  request_hash: string;
  request_identity_hash: string | null;
  document_short_id: string;
  frozen_request: unknown;
  document_id: string | null;
  created_at: Date;
};

export type DocumentArtifactContent = DocumentArtifact & { bytes: Uint8Array };

export const readDocumentArtifact = async (
  documentId: string,
  key: string,
  db: SQL = defaultSql,
  locale?: string,
): Promise<Result<DocumentArtifactContent>> => {
  const t = documentServiceText(locale);
  const [row] = await db<
    Array<{
      file_id: string;
      filename: string;
      mime_type: string;
      size_bytes: number | string;
      sha256: string;
      bytes: Uint8Array;
    }>
  >`
    SELECT artifact.file_id::text, file.filename, file.mime_type, file.size_bytes, file.sha256, file.bytes
    FROM grids.document_artifacts artifact
    JOIN grids.files file ON file.id = artifact.file_id
    JOIN grids.file_protected_references protected
      ON protected.file_id = file.id AND protected.owner_kind = 'document_artifact' AND protected.owner_id = artifact.document_id
    WHERE artifact.document_id = ${documentId}::uuid AND artifact.artifact_key = ${key}
  `;
  if (!row) return fail(err.notFound(t.documentArtifactNotFound));
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || row.bytes.byteLength !== sizeBytes || sha256Hex(row.bytes) !== row.sha256) {
    return fail(err.internal(t.artifactIntegrityFailed));
  }
  return ok({
    key,
    fileId: row.file_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes,
    sha256: row.sha256,
    bytes: row.bytes,
  });
};

export type IssueDocumentInput = {
  template: DocumentTemplate;
  snapshot: RecordSnapshotDraft;
  renderData: Record<string, unknown>;
  actor: DocumentIssuanceActor;
  idempotencyKey: string;
  canReadTable?: SnapshotTableReadAuthorizer;
  tags?: string[];
  workflowRunId?: string | null;
  workflowStepKey?: string | null;
  dateConfig?: DateContext;
  filename?: string | null;
  renderPdf?: (document: Pick<Document, "templateSnapshot" | "renderData" | "filename">) => Promise<Result<RenderHtmlToPdfResult>>;
};

type RecordDocumentRequest = Pick<
  IssueDocumentInput,
  "actor" | "idempotencyKey" | "tags" | "workflowRunId" | "workflowStepKey" | "dateConfig" | "filename" | "renderPdf" | "canReadTable"
> & { baseId: string; tableId: string; recordId: string; templateId: string };

const recordRequestIdentityHash = (input: RecordDocumentRequest): string =>
  canonicalJson(
    {
      baseId: input.baseId,
      tableId: input.tableId,
      recordId: input.recordId,
      templateId: input.templateId,
      actor: input.actor,
      tags: normalizeDocumentTags(input.tags),
      workflowRunId: input.workflowRunId ?? null,
      workflowStepKey: input.workflowStepKey ?? null,
      filename: input.filename?.trim() || null,
    },
    input.dateConfig?.locale,
  ).sha256;

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const serviceError = (error: unknown): ServiceError | null => {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "status" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.status === "number"
  )
    return error as ServiceError;
  return null;
};

const validateIdempotencyKey = (key: string, locale?: string): Result<void> =>
  key === key.trim() && key.length >= 1 && key.length <= 200 && !key.includes("\0")
    ? ok()
    : fail(err.badInput(documentServiceText(locale).idempotencyInvalid));

const semanticSnapshot = (snapshot: RecordSnapshotDraft) => ({
  baseId: snapshot.baseId,
  tableId: snapshot.tableId,
  recordId: snapshot.recordId,
  root: snapshot.root,
  graph: snapshot.graph,
  createdBy: snapshot.createdBy,
});

const semanticRenderData = (renderData: Record<string, unknown>) => {
  const { date: _date, document: _document, snapshot: _snapshot, ...stable } = renderData;
  return stable;
};

const requestHashFor = (input: IssueDocumentInput): Result<string> => {
  try {
    return ok(
      canonicalJson(
        {
          template: input.template,
          binding: semanticSnapshot(input.snapshot),
          renderData: semanticRenderData(input.renderData),
          actor: input.actor,
          tags: normalizeDocumentTags(input.tags),
          workflowRunId: input.workflowRunId ?? null,
          workflowStepKey: input.workflowStepKey ?? null,
          dateConfig: input.dateConfig ? { locale: input.dateConfig.locale ?? null, timeZone: input.dateConfig.timeZone ?? null } : null,
          filename: input.filename?.trim() || null,
        },
        input.dateConfig?.locale,
      ).sha256,
    );
  } catch (error) {
    return fail(serviceError(error) ?? err.badInput(documentServiceText(input.dateConfig?.locale).requestInvalidJson));
  }
};

const validateRecordRevision = (input: IssueDocumentInput): Result<void> => {
  const t = documentServiceText(input.dateConfig?.locale);
  const record = input.renderData.record;
  if (!record || typeof record !== "object" || Array.isArray(record)) return fail(err.badInput(t.revisionMissing));
  const value = record as Record<string, unknown>;
  const root = input.snapshot.root;
  const graph = input.snapshot.graph as { rootId?: unknown; records?: unknown };
  const rootKey = `${input.snapshot.tableId}:${input.snapshot.recordId}`;
  const graphRecords =
    graph.records && typeof graph.records === "object" && !Array.isArray(graph.records) ? (graph.records as Record<string, unknown>) : null;
  const graphRoot = graphRecords?.[rootKey];
  const rootTable = root.table && typeof root.table === "object" && !Array.isArray(root.table) ? root.table : null;
  const graphRootTable =
    graphRoot && typeof graphRoot === "object" && !Array.isArray(graphRoot) ? (graphRoot as Record<string, unknown>).table : null;
  if (
    root.id !== input.snapshot.recordId ||
    !rootTable ||
    (rootTable as Record<string, unknown>).id !== input.snapshot.tableId ||
    graph.rootId !== rootKey ||
    !graphRoot ||
    typeof graphRoot !== "object" ||
    Array.isArray(graphRoot) ||
    (graphRoot as Record<string, unknown>).id !== input.snapshot.recordId ||
    !graphRootTable ||
    typeof graphRootTable !== "object" ||
    Array.isArray(graphRootTable) ||
    (graphRootTable as Record<string, unknown>).id !== input.snapshot.tableId
  ) {
    return fail(err.badInput(t.snapshotBindingInvalid));
  }
  if (
    typeof value.id !== "string" ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(new Date(value.updatedAt).getTime())
  )
    return fail(err.badInput(t.revisionInvalid));
  const snapshotVersion = root.version;
  const graphVersion = (graphRoot as Record<string, unknown>).version;
  if (typeof snapshotVersion !== "number" || snapshotVersion !== value.version || graphVersion !== snapshotVersion) {
    return fail(err.conflict(t.recordChanged));
  }
  return ok();
};

const templateSnapshot = (template: DocumentTemplate): Record<string, unknown> => ({
  id: template.shortId,
  name: template.name,
  description: template.description,
  source: template.source,
  renderer: template.renderer,
});

const parseFrozenRequest = (value: unknown): FrozenDocumentRequest => {
  const parsed = FrozenDocumentRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Document issuance receipt contains invalid JSON: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
};

const profileInputFor = async (template: DocumentTemplate, renderData: Record<string, unknown>, locale?: string) => {
  if (template.renderer.kind !== "profile") return ok(null);
  const input = await renderDocumentProfileInput(template, renderData, locale);
  return input.ok ? ok(input.data) : input;
};

export const createDocumentIssuanceService = (options: { profiles?: readonly DocumentProfile[]; db?: SQL } = {}) => {
  const db = options.db ?? defaultSql;
  const profiles = profileRegistry(options.profiles ?? documentProfiles);
  const queryProfiles = profileRegistry([...(options.profiles ?? documentProfiles), ...financialQueryProfiles]);

  const summaries = (): DocumentProfileReference[] =>
    [...profiles.values()]
      .map(({ id, version, title, description, rendererVersion, validatorVersion, primaryArtifact, input }) => ({
        id,
        version,
        title,
        description,
        rendererVersion,
        validatorVersion,
        primaryArtifact,
        inputSchema: z.toJSONSchema(input, { io: "input" }),
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);

  const preview = async (input: {
    profileId: string;
    profileVersion: number;
    snapshot: Record<string, unknown>;
    issuedAt?: Date;
    locale?: string;
  }): Promise<Result<DocumentArtifactDraft[]>> => {
    const t = documentServiceText(input.locale);
    const profile = profiles.get(profileKey(input.profileId, input.profileVersion));
    if (!profile) return fail(err.badInput(t.unknownProfile({ profile: `${input.profileId}@${input.profileVersion}` })));
    const parsed = profile.input.safeParse(input.snapshot);
    if (!parsed.success) {
      return fail(err.badInput(documentProfileInputMessage(profile.id, parsed.error.issues, input.locale)));
    }
    try {
      const rendered = await profile.issue(parsed.data, {
        number: "PREVIEW",
        issuedAt: input.issuedAt ?? new Date(),
      });
      const artifacts = validateDocumentArtifactDrafts(rendered.artifacts, profile.primaryArtifact, input.locale);
      return artifacts.ok ? ok(artifacts.data.artifacts) : artifacts;
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail({ ...known, message: t.profilePreviewFailed });
      return fail(err.badInput(t.profilePreviewFailed));
    }
  };

  const getDocument = async (id: string): Promise<Document | null> => {
    const rows = await db<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${id}::uuid`;
    const [document] = await hydrateDocuments(rows, db);
    return document ?? null;
  };

  // Policy is persisted and immutable through the template API. Caller-supplied
  // snapshots cannot opt out; a different run or actor cannot allocate again.
  const operationIdentity = async (
    request: Pick<RecordDocumentRequest, "baseId" | "tableId" | "recordId" | "templateId" | "idempotencyKey" | "dateConfig">,
    client: SQL = db,
  ) => {
    const t = documentServiceText(request.dateConfig?.locale);
    const [binding] = await client<
      Array<{ issuance_policy: DocumentTemplate["issuancePolicy"]; final_revision_id: string | null; live: boolean }>
    >`
      SELECT template.issuance_policy, record.final_revision_id::text,
        (base.deleted_at IS NULL AND table_.deleted_at IS NULL AND record.id IS NOT NULL AND record.deleted_at IS NULL) AS live
      FROM grids.document_templates template
      JOIN grids.tables table_ ON table_.id = template.table_id
      JOIN grids.bases base ON base.id = table_.base_id
      LEFT JOIN grids.records record ON record.table_id = table_.id AND record.id = ${request.recordId}::uuid
      WHERE template.id = ${request.templateId}::uuid AND table_.id = ${request.tableId}::uuid
        AND base.id = ${request.baseId}::uuid
    `;
    if (!binding) throw err.notFound(t.recordNotFound);
    if (binding.issuance_policy === "repeatable") return { hash: sha256Hex(request.idempotencyKey), once: false };
    if (binding.issuance_policy !== "oncePerFinalizedRecord") throw err.internal(t.receiptReadFailed);
    if (!binding.live) throw err.notFound(t.recordNotFound);
    if (!binding.final_revision_id) throw err.badInput(t.issuanceRequiresFinalization);
    return {
      // NUL is prohibited in caller keys, keeping the server namespace separate.
      hash: sha256Hex(`grids:finalized-document\0${request.baseId}:${request.templateId}:${request.recordId}:${binding.final_revision_id}`),
      once: true,
    };
  };

  const authorizeSnapshot = async (
    snapshot: Pick<RecordSnapshotDraft, "baseId" | "tableId" | "graph">,
    authorize: SnapshotTableReadAuthorizer | undefined,
    locale?: string,
    client: SQL = db,
  ) => {
    const t = documentServiceText(locale);
    if (!authorize) throw err.forbidden(t.workflowQueryAccessDenied);
    const graph = z.object({ records: z.record(z.string(), z.object({ table: z.object({ id: z.uuid() }) })) }).safeParse(snapshot.graph);
    if (!graph.success) throw err.internal(t.receiptReadFailed);
    const tableIds = new Set([snapshot.tableId, ...Object.values(graph.data.records).map((record) => record.table.id)]);
    for (const tableId of tableIds) {
      if (!(await authorize({ baseId: snapshot.baseId, tableId }, client))) throw err.forbidden(t.workflowQueryAccessDenied);
    }
  };

  const authorizeReceipt = async (
    receipt: IssuanceRow,
    authorize: SnapshotTableReadAuthorizer | undefined,
    locale?: string,
    client: SQL = db,
  ) => {
    if (!receipt.document_id) return authorizeSnapshot(parseFrozenRequest(receipt.frozen_request).snapshot, authorize, locale, client);
    // Completed receipts release their temporary request; the immutable snapshot
    // is now owned by the Document and remains the authority for replay access.
    const [snapshot] = await client<Array<{ baseId: string; tableId: string; graph: Record<string, unknown> }>>`
      SELECT snapshot.base_id::text AS "baseId", snapshot.table_id::text AS "tableId", snapshot.graph
      FROM grids.documents document JOIN grids.record_snapshots snapshot ON snapshot.id = document.snapshot_id
      WHERE document.id = ${receipt.document_id}::uuid AND document.base_id = ${receipt.base_id}::uuid
    `;
    if (!snapshot) throw err.internal(documentServiceText(locale).receiptReadFailed);
    return authorizeSnapshot(snapshot, authorize, locale, client);
  };

  const issueDocument = async (
    input: IssueDocumentInput,
    requestIdentity?: RecordDocumentRequest,
  ): Promise<Result<{ document: Document; artifacts: DocumentArtifact[]; replayed: boolean }>> => {
    const t = documentServiceText(input.dateConfig?.locale);
    const idempotency = validateIdempotencyKey(input.idempotencyKey, input.dateConfig?.locale);
    if (!idempotency.ok) return idempotency;
    const actor = DocumentIssuanceActorSchema.safeParse(input.actor);
    if (!actor.success) return fail(err.badInput(t.actorInvalid));
    if (!input.template.enabled) return fail(err.badInput(t.templateDisabled));
    if (input.template.tableId !== input.snapshot.tableId) return fail(err.badInput(t.templateWrongTable));
    if ((input.workflowRunId == null) !== (input.workflowStepKey == null)) return fail(err.badInput(t.workflowBindingIncomplete));
    const revision = validateRecordRevision(input);
    if (!revision.ok) return revision;
    const renderer = input.template.renderer;
    const profile = renderer.kind === "profile" ? profiles.get(profileKey(renderer.id, renderer.version)) : null;
    if (renderer.kind === "profile" && !profile) {
      return fail(err.badInput(t.unknownProfile({ profile: `${renderer.id}@${renderer.version}` })));
    }
    const requestHash = requestHashFor(input);
    if (!requestHash.ok) return requestHash;
    try {
      const receipt = await db.begin(async (tx) => {
        if (input.canReadTable) await authorizeSnapshot(input.snapshot, input.canReadTable, input.dateConfig?.locale, tx);
        const operation = await operationIdentity(
          {
            baseId: input.snapshot.baseId,
            tableId: input.snapshot.tableId,
            recordId: input.snapshot.recordId,
            templateId: input.template.id,
            idempotencyKey: input.idempotencyKey,
            dateConfig: input.dateConfig,
          },
          tx,
        );
        const operationKeyHash = operation.hash;
        if (operation.once) {
          if (!input.canReadTable || !(await input.canReadTable({ baseId: input.snapshot.baseId, tableId: input.snapshot.tableId }, tx)))
            throw err.forbidden(t.workflowQueryAccessDenied);
        }
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:document-issuance:${input.snapshot.baseId}:${operationKeyHash}`}, 0))`;
        const [existing] = await tx<IssuanceRow[]>`
          SELECT id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at
          FROM grids.document_issuances
          WHERE base_id = ${input.snapshot.baseId}::uuid AND operation_key_hash = ${operationKeyHash}
        `;
        if (existing) {
          if (operation.once) {
            await authorizeReceipt(existing, input.canReadTable, input.dateConfig?.locale, tx);
          } else if (
            existing.request_identity_hash
              ? !requestIdentity || existing.request_identity_hash !== recordRequestIdentityHash(requestIdentity)
              : existing.request_hash !== requestHash.data
          )
            throw err.conflict(t.idempotencyConflict);
          return existing;
        }
        if (operation.once) await authorizeSnapshot(input.snapshot, input.canReadTable, input.dateConfig?.locale, tx);
        return insertWithShortIdForDb(tx, "document_issuances_document_short_id_key", async (attempt, documentShortId) => {
          const [binding] = await attempt<
            Array<{
              renderer_kind: "html" | "profile";
              profile_id: string | null;
              profile_version: number | null;
              profile_input_template: string | null;
              short_id: string;
              name: string;
              description: string | null;
              source: string;
              html: string | null;
              header_html: string | null;
              footer_html: string | null;
              page_css: string | null;
              number_template: string | null;
              filename_template: string | null;
              enabled: boolean;
              updated_at: Date;
              record_id: string;
              record_short_id: string;
              record_version: number;
              record_updated_at: Date;
            }>
          >`
          SELECT template.renderer_kind, template.profile_id, template.profile_version, template.profile_input_template,
                 template.short_id, template.name, template.description, template.source,
                 template.html, template.header_html, template.footer_html, template.page_css,
                 template.number_template, template.filename_template, template.enabled, template.updated_at,
                 record.id::text AS record_id, record.short_id AS record_short_id,
                 record.version AS record_version, record.updated_at AS record_updated_at
          FROM grids.document_templates template
          JOIN grids.tables table_ ON table_.id = template.table_id AND table_.base_id = ${input.snapshot.baseId}::uuid
          JOIN grids.records record ON record.table_id = table_.id AND record.id = ${input.snapshot.recordId}::uuid
          WHERE template.id = ${input.template.id}::uuid AND table_.id = ${input.snapshot.tableId}::uuid
            AND template.deleted_at IS NULL AND table_.deleted_at IS NULL AND record.deleted_at IS NULL
          FOR SHARE OF template, table_, record
          `;
          if (!binding) throw err.badInput(t.liveBindingRequired);
          const renderRecord = input.renderData.record as Record<string, unknown>;
          const bindingRenderer =
            binding.renderer_kind === "html"
              ? binding.html && binding.number_template && binding.filename_template
                ? {
                    kind: "html" as const,
                    body: binding.html,
                    ...(binding.header_html === null ? {} : { header: binding.header_html }),
                    ...(binding.footer_html === null ? {} : { footer: binding.footer_html }),
                    ...(binding.page_css === null ? {} : { css: binding.page_css }),
                    numberTemplate: binding.number_template,
                    filenameTemplate: binding.filename_template,
                  }
                : null
              : binding.profile_id && binding.profile_version && binding.profile_input_template
                ? {
                    kind: "profile" as const,
                    id: binding.profile_id,
                    version: binding.profile_version,
                    inputTemplate: binding.profile_input_template,
                  }
                : null;
          const bindingTemplateRevision = bindingRenderer
            ? canonicalJson(
                {
                  id: binding.short_id,
                  name: binding.name,
                  description: binding.description,
                  source: binding.source,
                  renderer: bindingRenderer,
                },
                input.dateConfig?.locale,
              ).sha256
            : null;
          if (
            !binding.enabled ||
            binding.updated_at.toISOString() !== input.template.updatedAt ||
            bindingTemplateRevision !== canonicalJson(templateSnapshot(input.template), input.dateConfig?.locale).sha256 ||
            binding.renderer_kind !== input.template.renderer.kind ||
            (binding.renderer_kind === "profile" &&
              renderer.kind === "profile" &&
              (binding.profile_id !== renderer.id || binding.profile_version !== renderer.version))
          )
            throw err.conflict(t.templateChanged);
          if (
            binding.record_id !== input.snapshot.recordId ||
            binding.record_id !== input.snapshot.root.id ||
            binding.record_short_id !== renderRecord.id ||
            binding.record_version !== input.snapshot.root.version ||
            binding.record_version !== renderRecord.version ||
            binding.record_updated_at.toISOString() !== input.snapshot.root.updatedAt ||
            binding.record_updated_at.toISOString() !== new Date(String(renderRecord.updatedAt)).toISOString()
          ) {
            throw err.conflict(t.recordChanged);
          }

          const issuedAt = new Date();
          let documentNumber: string;
          let filename: string | null = null;
          let allocationId: string | null = null;
          let frozenRenderData = input.renderData;
          let profileInput: Record<string, unknown> | null = null;
          if (renderer.kind === "html") {
            const allocation = await allocateNumberInTransaction({
              client: attempt,
              owner: { kind: "document_template", id: input.template.id },
              now: issuedAt,
              dateConfig: input.dateConfig,
              renderDocument: (value, seriesShortId) => {
                const rendered = documentNumberFor({
                  template: { ...input.template, numberTemplate: renderer.numberTemplate },
                  documentShortId,
                  createdAt: issuedAt,
                  dateConfig: input.dateConfig,
                  data: input.renderData,
                  series: { id: seriesShortId, value },
                });
                if (!rendered.ok) throw rendered.error;
                return rendered.data;
              },
            });
            allocationId = allocation.id;
            const built = await buildDocumentRenderData({
              template: input.template,
              renderData: input.renderData,
              documentShortId,
              createdAt: issuedAt,
              dateConfig: input.dateConfig,
              filename: input.filename,
              tags: input.tags,
              documentNumber: allocation.renderedValue,
              numberSeries: { id: allocation.seriesShortId, value: allocation.value },
            });
            if (!built.ok) throw built.error;
            documentNumber = built.data.documentNumber;
            filename = built.data.filename;
            frozenRenderData = built.data.data;
          } else {
            await attempt`
            INSERT INTO grids.document_profile_counters (base_id, profile_id)
            VALUES (${input.snapshot.baseId}::uuid, ${profile!.id}) ON CONFLICT DO NOTHING
          `;
            const [counter] = await attempt<Array<{ next_value: number | string | bigint }>>`
            SELECT next_value FROM grids.document_profile_counters
            WHERE base_id = ${input.snapshot.baseId}::uuid AND profile_id = ${profile!.id}
            FOR UPDATE
          `;
            const value = Number(counter?.next_value);
            if (!Number.isSafeInteger(value) || value < 1) throw err.internal(t.seriesExhausted);
            documentNumber = profile!.formatNumber({ value, issuedAt });
            await attempt`
            UPDATE grids.document_profile_counters SET next_value = ${value + 1}
            WHERE base_id = ${input.snapshot.baseId}::uuid AND profile_id = ${profile!.id}
          `;
            const built = await buildDocumentRenderData({
              template: input.template,
              renderData: input.renderData,
              documentShortId,
              createdAt: issuedAt,
              dateConfig: input.dateConfig,
              tags: input.tags,
              documentNumber,
            });
            if (!built.ok) throw built.error;
            filename = built.data.filename;
            frozenRenderData = built.data.data;
            const renderedProfileInput = await profileInputFor(input.template, frozenRenderData, input.dateConfig?.locale);
            if (!renderedProfileInput.ok) throw renderedProfileInput.error;
            if (!renderedProfileInput.data) throw err.internal(t.profileInputMissing);
            const parsed = validateDocumentProfileInput(profile!, renderedProfileInput.data, input.dateConfig?.locale);
            if (!parsed.ok) throw parsed.error;
            profileInput = renderedProfileInput.data;
          }
          const frozen: FrozenDocumentRequest = {
            template: { ...input.template, issuancePolicy: operation.once ? "oncePerFinalizedRecord" : "repeatable" },
            snapshot: input.snapshot,
            renderData: frozenRenderData,
            actor: actor.data,
            tags: normalizeDocumentTags(input.tags),
            workflowRunId: input.workflowRunId ?? null,
            workflowStepKey: input.workflowStepKey ?? null,
            issuedAt: issuedAt.toISOString(),
            documentNumber,
            filename,
            allocationId,
            profileInput,
          };
          const [created] = await attempt<IssuanceRow[]>`
          INSERT INTO grids.document_issuances (base_id, operation_key_hash, request_hash, request_identity_hash, document_short_id, frozen_request)
          VALUES (${input.snapshot.baseId}::uuid, ${operationKeyHash}, ${requestHash.data}, ${requestIdentity ? recordRequestIdentityHash(requestIdentity) : null}, ${documentShortId}, ${canonicalJson({ ...frozen }, input.dateConfig?.locale).value}::jsonb)
          RETURNING id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at
        `;
          if (!created) throw err.internal(t.receiptCreateFailed);
          return created;
        });
      });

      if (receipt.document_id) {
        const replay = await getDocument(receipt.document_id);
        return replay ? ok({ document: replay, artifacts: replay.artifacts, replayed: true }) : fail(err.internal(t.receiptReadFailed));
      }
      const frozen = parseFrozenRequest(receipt.frozen_request);
      let rendered: {
        output?: Record<string, unknown>;
        primaryArtifact: PrimaryDocumentArtifact;
        artifacts: DocumentArtifactDraft[];
        validationStatus: "valid" | "warning" | "unchecked" | null;
        validationReport: Record<string, unknown> | null;
      };
      if (frozen.template.renderer.kind === "profile") {
        const selected = profiles.get(profileKey(frozen.template.renderer.id, frozen.template.renderer.version));
        if (!selected || !frozen.profileInput) throw new Error("Document issuance receipt references an unavailable profile");
        const parsed = selected.input.safeParse(frozen.profileInput);
        if (!parsed.success) throw new Error("Document issuance receipt contains invalid profile input");
        const output = await selected.issue(parsed.data, {
          number: frozen.documentNumber,
          issuedAt: new Date(frozen.issuedAt),
        });
        rendered = {
          ...(output.output === undefined ? {} : { output: canonicalDocumentJson(output.output, input.dateConfig?.locale).value }),
          primaryArtifact: selected.primaryArtifact,
          artifacts: output.artifacts,
          validationStatus: output.validationStatus,
          validationReport: output.validationReport,
        };
      } else {
        const renderInput = {
          templateSnapshot: templateSnapshot(frozen.template),
          renderData: frozen.renderData,
          filename: frozen.filename ?? `${frozen.documentNumber}.pdf`,
        };
        const output = await (input.renderPdf ? input.renderPdf(renderInput) : renderDocumentPdf(renderInput, input.dateConfig?.locale));
        if (!output.ok) return output;
        if (output.data.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
          return fail(err.badInput(t.rendererNoPdf));
        }
        rendered = {
          primaryArtifact: { key: "pdf", mediaType: "application/pdf" },
          artifacts: [
            {
              key: "pdf",
              filename: frozen.filename ?? `${frozen.documentNumber}.pdf`,
              mediaType: "application/pdf",
              bytes: output.data.pdf,
            },
          ],
          validationStatus: null,
          validationReport: null,
        };
      }
      const artifactDrafts = validateDocumentArtifactDrafts(rendered.artifacts, rendered.primaryArtifact, input.dateConfig?.locale);
      if (!artifactDrafts.ok) return artifactDrafts;
      const primary = artifactDrafts.data.primary;
      const snapshotHash = frozen.profileInput ? canonicalDocumentJson(frozen.profileInput, input.dateConfig?.locale).sha256 : null;
      const templateData = templateSnapshot(frozen.template);
      const templateRevision = canonicalDocumentJson(templateData, input.dateConfig?.locale).sha256;
      const finalized = await db.begin(async (tx) => {
        // Rendering runs outside the transaction. Re-check authority here;
        // workflow callers also fence and lock their run through this callback.
        // Take that lock before the receipt lock, as during reservation.
        if (input.canReadTable) await authorizeSnapshot(frozen.snapshot, input.canReadTable, input.dateConfig?.locale, tx);
        const [locked] = await tx<IssuanceRow[]>`
          SELECT id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at
          FROM grids.document_issuances WHERE id = ${receipt.id}::uuid FOR UPDATE
        `;
        if (!locked) throw err.internal(t.receiptMissing);
        if (locked.document_id) {
          const replayRows = await tx<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${locked.document_id}::uuid`;
          const [replay] = await hydrateDocuments(replayRows, tx);
          if (!replay) throw err.internal(t.receiptReadFailed);
          return { document: replay, replayed: true };
        }
        const persisted = await persistRecordSnapshot(frozen.snapshot, tx, input.dateConfig?.locale);
        if (!persisted.ok) throw persisted.error;
        const selectedProfile =
          frozen.template.renderer.kind === "profile"
            ? profiles.get(profileKey(frozen.template.renderer.id, frozen.template.renderer.version))!
            : null;
        if (selectedProfile && (!frozen.profileInput || !snapshotHash || !rendered.validationStatus || !rendered.validationReport)) {
          throw err.internal(t.profileInputMissing);
        }
        const document = await persistIssuedDocument(
          {
            receiptId: receipt.id,
            shortId: receipt.document_short_id,
            baseId: frozen.snapshot.baseId,
            queryDataId: null,
            record: {
              templateId: frozen.template.id,
              snapshotId: frozen.snapshot.id,
              tableId: frozen.snapshot.tableId,
              recordId: frozen.snapshot.recordId,
            },
            workflowRunId: frozen.workflowRunId,
            workflowStepKey: frozen.workflowStepKey,
            number: frozen.documentNumber,
            tags: frozen.tags,
            templateSnapshot: templateData,
            templateRevision,
            renderData: frozen.renderData,
            rendererVersion: selectedProfile?.rendererVersion ?? DOCUMENT_HTML_RENDERER_VERSION,
            profile:
              selectedProfile && frozen.profileInput && snapshotHash && rendered.validationStatus && rendered.validationReport
                ? {
                    id: selectedProfile.id,
                    version: selectedProfile.version,
                    input: frozen.profileInput,
                    ...(rendered.output === undefined ? {} : { output: rendered.output }),
                    sha256: snapshotHash,
                    validatorVersion: selectedProfile.validatorVersion,
                    validationStatus: rendered.validationStatus,
                    validationReport: rendered.validationReport,
                  }
                : null,
            primary,
            artifacts: artifactDrafts.data.artifacts,
            actor: frozen.actor,
            issuedAt: frozen.issuedAt,
            allocationId: frozen.allocationId,
            locale: input.dateConfig?.locale,
          },
          tx,
        );
        return { document, replayed: false };
      });
      return ok({ document: finalized.document, artifacts: finalized.document.artifacts, replayed: finalized.replayed });
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const issueQueryDocument = async (
    input: z.input<typeof QueryDocumentInputSchema> & {
      idempotencyKey: string;
      locale?: string;
      /** Recheck run execution, Base write and every source table's read access. */
      authorize: (tableIds: readonly string[], client: SQL) => Promise<void>;
    },
  ): Promise<Result<Document | QueryDocumentConfirmationRequired>> => {
    const t = documentServiceText(input.locale);
    const validKey = validateIdempotencyKey(input.idempotencyKey, input.locale);
    if (!validKey.ok) return validKey;
    const { idempotencyKey, authorize, locale, ...raw } = input;
    const parsed = QueryDocumentInputSchema.safeParse(raw);
    if (!parsed.success) return fail(err.badInput(t.requestInvalidJson));
    const pendingRequest = parsed.data;
    if (pendingRequest.sourceVersions && pendingRequest.output.kind !== "datev-csv" && pendingRequest.output.kind !== "sepa-xml")
      return fail(err.badInput(t.requestInvalidJson));
    const validOutput = validateDocumentQueryOutput(pendingRequest.output, input.locale);
    if (!validOutput.ok) return validOutput;
    const profile = queryProfiles.get(profileKey(`grids.${pendingRequest.output.kind}`, 1));
    if (!profile) return fail(err.badInput(t.unknownProfile({ profile: `grids.${pendingRequest.output.kind}@1` })));
    try {
      await authorize([], db);
      const captured = await loadWorkflowQueryData(
        {
          baseId: pendingRequest.baseId,
          runId: pendingRequest.runId,
          id: pendingRequest.data.id,
          sha256: pendingRequest.data.sha256,
          locale,
        },
        db,
      );
      if (!captured.ok) return captured;
      const request = QueryDocumentRequestSchema.parse({
        ...pendingRequest,
        ...(pendingRequest.sourceVersions === "data" ? { sourceVersions: sourceVersionsFromData(captured.data.payload, locale) } : {}),
      });
      if (canonicalJson(captured.data.reference, locale).sha256 !== canonicalJson(request.data, locale).sha256) {
        return fail(err.conflict(t.workflowQueryIntegrityFailed));
      }
      const tableIds = captured.data.payload.tableIds;
      await authorize(tableIds, db);
      if (request.associatedData) {
        const associated = await loadWorkflowQueryData(
          { baseId: request.baseId, runId: request.runId, id: request.associatedData.id, sha256: request.associatedData.sha256, locale },
          db,
        );
        if (!associated.ok) return associated;
        if (canonicalJson(associated.data.reference, locale).sha256 !== canonicalJson(request.associatedData, locale).sha256)
          return fail(err.conflict(t.workflowQueryIntegrityFailed));
        await authorize(associated.data.payload.tableIds, db);
        if (capturedDocumentRecords(associated.data.payload) === null) return fail(err.badInput(t.associatedDataNotRowQuery));
      }
      const operationHash = sha256Hex(idempotencyKey);
      const requestHash = canonicalJson(request, locale).sha256;
      const receipt = await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:document-issuance:${request.baseId}:${operationHash}`}, 0))`;
        await authorize(tableIds, tx);
        const [existing] = await tx<QueryIssuanceRow[]>`
          SELECT id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at,
            confirmation_hash, confirmed_actor, confirmed_at
          FROM grids.document_issuances WHERE base_id = ${request.baseId}::uuid AND operation_key_hash = ${operationHash}
        `;
        if (existing) {
          if (existing.request_hash !== requestHash || existing.request_identity_hash !== null) throw err.conflict(t.idempotencyConflict);
          return existing;
        }
        await requireDocumentSourceVersions({ ...request, authorize, locale }, tx);
        return insertWithShortIdForDb(tx, "document_issuances_document_short_id_key", async (attempt, shortId) => {
          await attempt`INSERT INTO grids.document_profile_counters (base_id, profile_id)
            VALUES (${request.baseId}::uuid, ${profile.id}) ON CONFLICT DO NOTHING`;
          const [counter] = await attempt<Array<{ next_value: number | string | bigint }>>`
            SELECT next_value FROM grids.document_profile_counters WHERE base_id = ${request.baseId}::uuid AND profile_id = ${profile.id} FOR UPDATE
          `;
          const value = Number(counter?.next_value);
          if (!Number.isSafeInteger(value) || value < 1) throw err.internal(t.seriesExhausted);
          const issuedAt = new Date();
          const number = profile.formatNumber({ value, issuedAt });
          let financial: z.infer<typeof FrozenQueryDocumentSchema>["financial"];
          if (request.output.kind === "datev-csv" || request.output.kind === "sepa-xml") {
            if (request.actor.kind === "system") throw err.forbidden(t.financialConfirmationRequired);
            const seed = Bun.randomUUIDv7().replaceAll("-", "");
            const identifiers = { messageId: `M${seed}`, paymentInformationId: `P${seed}` };
            const normalized = normalizeFinancialDocumentOutput(request.output, captured.data.payload, identifiers, locale);
            if (!normalized.ok) throw normalized.error;
            financial = {
              identifiers,
              normalizedSha256: normalized.data.sha256,
              runBindingHash: canonicalJson(await financialRunBinding(request.baseId, request.runId, attempt, locale), locale).sha256,
            };
          }
          const filename =
            request.filename ??
            (request.output.kind === "datev-csv"
              ? `EXTF_${number}.csv`
              : request.output.kind === "sepa-xml"
                ? `${number}.xml`
                : `${number}.${request.output.kind}`);
          if (
            (request.output.kind === "datev-csv" && !/^EXTF_.+\.csv$/.test(filename)) ||
            (request.output.kind === "sepa-xml" && !filename.endsWith(".xml"))
          )
            throw err.badInput(t.profileInputInvalid);
          const frozen = {
            ...request,
            kind: "query" as const,
            number,
            issuedAt: issuedAt.toISOString(),
            filename,
            ...(financial ? { financial } : {}),
          };
          const confirmationHash = financial ? canonicalJson(frozen, locale).sha256 : null;
          await attempt`UPDATE grids.document_profile_counters SET next_value = ${value + 1}
            WHERE base_id = ${request.baseId}::uuid AND profile_id = ${profile.id}`;
          const [created] = await attempt<QueryIssuanceRow[]>`
            INSERT INTO grids.document_issuances (base_id, operation_key_hash, request_hash, document_short_id, frozen_request, query_data_id, confirmation_hash)
            VALUES (${request.baseId}::uuid, ${operationHash}, ${requestHash}, ${shortId}, ${canonicalJson(frozen, locale).value}::jsonb, ${request.data.id}::uuid, ${confirmationHash})
            RETURNING id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at,
              confirmation_hash, confirmed_actor, confirmed_at
          `;
          if (!created) throw err.internal(t.receiptCreateFailed);
          return created;
        });
      });
      if (receipt.document_id) {
        const document = await getDocument(receipt.document_id);
        return document ? ok(document) : fail(err.internal(t.receiptReadFailed));
      }
      const frozen = FrozenQueryDocumentSchema.parse(receipt.frozen_request);
      const { kind: _kind, issuedAt: _issuedAt, number: _number, filename: _filename, financial, ...identity } = frozen;
      // filename may have been generated after reservation; the request hash
      // authenticates all caller-controlled inputs before frozen data is used.
      if (canonicalJson({ ...identity, filename: request.filename }, locale).sha256 !== receipt.request_hash)
        throw err.conflict(t.idempotencyConflict);
      const financialOutput = frozen.output.kind === "datev-csv" || frozen.output.kind === "sepa-xml" ? frozen.output : null;
      const normalized =
        financialOutput && financial
          ? normalizeFinancialDocumentOutput(financialOutput, captured.data.payload, financial.identifiers, locale)
          : null;
      if (financialOutput) {
        if (
          !financial ||
          !receipt.confirmation_hash ||
          !normalized?.ok ||
          normalized.data.sha256 !== financial.normalizedSha256 ||
          canonicalJson(frozen, locale).sha256 !== receipt.confirmation_hash
        )
          throw normalized && !normalized.ok ? normalized.error : err.conflict(t.workflowQueryIntegrityFailed);
        if (!receipt.confirmed_at)
          return ok({ kind: "confirmationRequired", receiptId: receipt.document_short_id, sha256: receipt.confirmation_hash });
        const concurrentDocument = await db.begin(async (tx) => {
          await authorize(tableIds, tx);
          if (canonicalJson(await financialRunBinding(frozen.baseId, frozen.runId, tx, locale), locale).sha256 !== financial.runBindingHash)
            throw err.conflict(t.financialConfirmationRequired);
          const [current] = await tx<Array<{ document_id: string | null }>>`SELECT document_id::text FROM grids.document_issuances
            WHERE id = ${receipt.id}::uuid FOR UPDATE`;
          if (!current) throw err.internal(t.receiptMissing);
          if (current.document_id) {
            const [document] = await hydrateDocuments(
              await tx<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${current.document_id}::uuid`,
              tx,
            );
            if (!document) throw err.internal(t.receiptReadFailed);
            return document;
          }
          await requireDocumentSourceVersions({ ...frozen, authorize, locale }, tx);
          return null;
        });
        if (concurrentDocument) return ok(concurrentDocument);
      } else if (financial || receipt.confirmation_hash) throw err.conflict(t.workflowQueryIntegrityFailed);
      const { kind: outputKind, ...outputOptions } = frozen.output;
      const profileInput = profile.input.safeParse(
        normalized?.ok
          ? { ...normalized.data.input, filename: frozen.filename }
          : {
              columns: captured.data.payload.columns,
              rows: captured.data.payload.rows,
              filename: frozen.filename,
              ...(outputKind === "csv" || outputKind === "json" ? { options: outputOptions } : {}),
              ...(outputKind === "pdf" ? { content: outputOptions } : {}),
              ...(outputKind === "xml" ? outputOptions : {}),
            },
      );
      if (!profileInput.success) return fail(err.badInput(documentProfileInputMessage(profile.id, profileInput.error.issues, locale)));
      const rendered = await profile.issue(profileInput.data, { number: frozen.number, issuedAt: new Date(frozen.issuedAt) });
      const profileOutput = rendered.output === undefined ? undefined : canonicalDocumentJson(rendered.output, locale).value;
      const checked = validateDocumentArtifactDrafts(rendered.artifacts, profile.primaryArtifact, locale);
      if (!checked.ok) return checked;
      const source = {
        data: frozen.data,
        ...(frozen.associatedData ? { associatedData: frozen.associatedData } : {}),
        output: frozen.output,
        filename: frozen.filename,
        ...(financial
          ? {
              financial,
              confirmation: { sha256: receipt.confirmation_hash, actor: receipt.confirmed_actor, at: receipt.confirmed_at?.toISOString() },
            }
          : {}),
      };
      const template = { renderer: { kind: "profile", id: profile.id, version: profile.version }, output: frozen.output };
      return await db.begin(async (tx) => {
        await authorize(tableIds, tx);
        let sources = await resolveCapturedDocumentRecords(captured.data.payload, frozen.baseId, tx);
        if (frozen.associatedData) {
          const associated = await loadWorkflowQueryData(
            { baseId: frozen.baseId, runId: frozen.runId, id: frozen.associatedData.id, sha256: frozen.associatedData.sha256, locale },
            tx,
          );
          if (!associated.ok) throw associated.error;
          await authorize(associated.data.payload.tableIds, tx);
          sources = capturedDocumentRecords(associated.data.payload);
          if (sources === null) throw err.badInput(t.associatedDataNotRowQuery);
        }
        if (
          financial &&
          canonicalJson(await financialRunBinding(frozen.baseId, frozen.runId, tx, locale), locale).sha256 !== financial.runBindingHash
        )
          throw err.conflict(t.financialConfirmationRequired);
        const [locked] = await tx<Array<{ document_id: string | null }>>`
          SELECT document_id::text FROM grids.document_issuances WHERE id = ${receipt.id}::uuid FOR UPDATE
        `;
        if (!locked) throw err.internal(t.receiptMissing);
        if (locked.document_id) {
          const [document] = await hydrateDocuments(
            await tx<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${locked.document_id}::uuid`,
            tx,
          );
          if (!document) throw err.internal(t.receiptReadFailed);
          return ok(document);
        }
        if (financial && normalized?.ok) {
          // Rendering happens outside this transaction. Approval/source state
          // must still match when the document and its claims become durable.
          await requireDocumentSourceVersions({ ...frozen, authorize, locale }, tx);
          await reserveDocumentExportClaims(
            tx,
            {
              baseId: frozen.baseId,
              receiptId: receipt.id,
              destinationKey: normalized.data.input.destinationKey,
              purpose: normalized.data.purpose,
              businessIds: normalized.data.input.rows.map((row) => row.businessId),
            },
            locale,
          );
        }
        const document = await persistIssuedDocument(
          {
            receiptId: receipt.id,
            shortId: receipt.document_short_id,
            baseId: frozen.baseId,
            queryDataId: frozen.data.id,
            associatedQueryDataId: frozen.associatedData?.id,
            sources,
            record: null,
            workflowRunId: frozen.runId,
            workflowStepKey: frozen.stepKey,
            number: frozen.number,
            tags: frozen.tags,
            templateSnapshot: template,
            templateRevision: canonicalJson(template, locale).sha256,
            renderData: { query: frozen.data },
            rendererVersion: profile.rendererVersion,
            profile: {
              id: profile.id,
              version: profile.version,
              input: source,
              ...(profileOutput === undefined ? {} : { output: profileOutput }),
              sha256: canonicalJson(source, locale).sha256,
              validatorVersion: profile.validatorVersion,
              validationStatus: rendered.validationStatus,
              validationReport: rendered.validationReport,
            },
            primary: checked.data.primary,
            artifacts: checked.data.artifacts,
            actor: frozen.actor,
            issuedAt: frozen.issuedAt,
            allocationId: null,
            locale,
          },
          tx,
        );
        return ok(document);
      });
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const loadQueryDocumentConfirmation = async (input: QueryDocumentConfirmationInput, tx: SQL, lock = true) => {
    const t = documentServiceText(input.locale);
    validateConfirmationInput(input);
    await input.authorize([], tx);
    const runBinding = await financialRunBinding(input.baseId, input.runId, tx, input.locale, lock);
    const [receipt] = await tx<QueryIssuanceRow[]>`
      SELECT receipt.id::text, receipt.base_id::text, receipt.request_hash, receipt.request_identity_hash,
        receipt.document_short_id, receipt.frozen_request, receipt.document_id::text, receipt.created_at,
        receipt.confirmation_hash, receipt.confirmed_actor, receipt.confirmed_at
      FROM grids.document_issuances receipt
      JOIN grids.workflow_query_data data ON data.id = receipt.query_data_id
      WHERE receipt.base_id = ${input.baseId}::uuid AND data.run_id = ${input.runId}::uuid
        AND receipt.document_short_id = ${input.receiptId} AND receipt.confirmation_hash IS NOT NULL
      ${lock ? tx`FOR UPDATE OF receipt` : tx``}
    `;
    if (!receipt?.confirmation_hash || receipt.document_id) throw err.notFound(t.receiptMissing);
    const parsed = FrozenQueryDocumentSchema.safeParse(receipt.frozen_request);
    if (!parsed.success) throw err.conflict(t.workflowQueryIntegrityFailed);
    const frozen = parsed.data;
    if (
      !frozen.financial ||
      (frozen.output.kind !== "datev-csv" && frozen.output.kind !== "sepa-xml") ||
      frozen.baseId !== input.baseId ||
      frozen.runId !== input.runId ||
      canonicalJson(frozen, input.locale).sha256 !== receipt.confirmation_hash
    )
      throw err.conflict(t.workflowQueryIntegrityFailed);
    if (
      input.actor.kind === "system" ||
      canonicalJson(input.actor, input.locale).sha256 !== canonicalJson(frozen.actor, input.locale).sha256
    )
      throw err.forbidden(t.financialActorMismatch);
    if (canonicalJson(runBinding, input.locale).sha256 !== frozen.financial.runBindingHash) throw err.conflict(t.financialRunChanged);
    const capture = await loadWorkflowQueryData(
      { baseId: input.baseId, runId: input.runId, id: frozen.data.id, sha256: frozen.data.sha256, locale: input.locale },
      tx,
    );
    if (!capture.ok) throw capture.error;
    await input.authorize(capture.data.payload.tableIds, tx);
    await requireDocumentSourceVersions({ ...frozen, authorize: input.authorize, locale: input.locale, lock }, tx);
    const normalized = normalizeFinancialDocumentOutput(frozen.output, capture.data.payload, frozen.financial.identifiers, input.locale);
    if (!normalized.ok) throw normalized.error;
    if (normalized.data.sha256 !== frozen.financial.normalizedSha256) throw err.conflict(t.workflowQueryIntegrityFailed);
    return {
      receipt,
      confirmationHash: receipt.confirmation_hash,
      frozen,
      version: frozen.output.version,
      normalized: normalized.data,
      capture: capture.data,
    };
  };

  const inspectQueryDocumentConfirmation = async (input: QueryDocumentConfirmationInput) => {
    try {
      return ok(
        await db.begin(async (tx) => {
          await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
          const { receipt, confirmationHash, frozen, version, normalized, capture } = await loadQueryDocumentConfirmation(input, tx, false);
          const preview = {
            receiptId: receipt.document_short_id,
            sha256: confirmationHash,
            confirmedAt: receipt.confirmed_at?.toISOString() ?? null,
            number: frozen.number,
            filename: frozen.filename,
            version,
            source: {
              capturedAt: capture.reference.capturedAt,
              rowCount: capture.reference.rowCount,
              selectionLimit: capture.payload.selectionLimit,
              kind:
                capture.payload.version === 1
                  ? ("query" as const)
                  : capture.payload.version === 2
                    ? ("values" as const)
                    : capture.payload.version === 3
                      ? ("documents" as const)
                      : capture.payload.version === 4
                        ? ("recordSnapshots" as const)
                        : ("file" as const),
              query: capture.payload.version === 1 ? capture.payload.source : null,
            },
          };
          return normalized.kind === "datev-csv"
            ? { ...preview, kind: normalized.kind, input: normalized.input }
            : { ...preview, kind: normalized.kind, input: normalized.input };
        }),
      );
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const confirmQueryDocument = async (input: QueryDocumentConfirmationInput & { sha256: string }): Promise<Result<void>> => {
    const t = documentServiceText(input.locale);
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) return fail(err.badInput(t.requestInvalidJson));
    try {
      validateConfirmationInput(input);
      await db.begin(async (tx) => {
        await input.authorize([], tx);
        // Same run-before-receipt lock order as the issuing worker, including
        // replay of a completed confirmation whose run is already terminal.
        await tx`SELECT id FROM workflows.run WHERE id = ${input.runId}::uuid FOR UPDATE`;
        const [completed] = await tx<
          Array<{ document_id: string | null; confirmation_hash: string; confirmed_actor: unknown; query_data_id: string; sha256: string }>
        >`
          SELECT receipt.document_id::text, receipt.confirmation_hash, receipt.confirmed_actor, receipt.query_data_id::text, data.sha256
          FROM grids.document_issuances receipt JOIN grids.workflow_query_data data ON data.id = receipt.query_data_id
          WHERE receipt.base_id = ${input.baseId}::uuid AND data.run_id = ${input.runId}::uuid
            AND receipt.document_short_id = ${input.receiptId}
            AND receipt.confirmation_hash IS NOT NULL
          FOR UPDATE OF receipt
        `;
        if (completed?.document_id) {
          const confirmedActor = DocumentIssuanceActorSchema.safeParse(completed.confirmed_actor);
          if (
            completed.confirmation_hash !== input.sha256 ||
            !confirmedActor.success ||
            canonicalJson(confirmedActor.data, input.locale).sha256 !== canonicalJson(input.actor, input.locale).sha256
          )
            throw err.conflict(t.financialConfirmationRequired);
          const capture = await loadWorkflowQueryData(
            { baseId: input.baseId, runId: input.runId, id: completed.query_data_id, sha256: completed.sha256, locale: input.locale },
            tx,
          );
          if (!capture.ok) throw capture.error;
          await input.authorize(capture.data.payload.tableIds, tx);
          // A lost confirmation response must not turn a completed export into
          // an error or wake its run again. The original actor/hash still bind it.
          return;
        }
        const { receipt } = await loadQueryDocumentConfirmation(input, tx);
        if (receipt.confirmation_hash !== input.sha256) throw err.conflict(t.financialConfirmationRequired);
        if (!receipt.confirmed_at) {
          await tx`UPDATE grids.document_issuances SET confirmed_actor = ${input.actor}::jsonb, confirmed_at = now()
            WHERE id = ${receipt.id}::uuid`;
        }
        // The kernel persists the signal even if confirmation races parking.
        await wakeWorkflowRunsWaitingOn({ appId: "grids", kind: "grids.document-confirmation", key: input.receiptId }, { db: tx });
      });
      notifyWorkflowWorker("grids");
      return ok();
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const getDocumentArtifact = (documentId: string, key: string, locale?: string): Promise<Result<DocumentArtifactContent>> =>
    readDocumentArtifact(documentId, key, db, locale);

  const issueRecordDocument = async (
    request: RecordDocumentRequest,
    capture: () => Promise<Result<Pick<IssueDocumentInput, "template" | "snapshot" | "renderData">>>,
  ): Promise<Result<Document>> => {
    const t = documentServiceText(request.dateConfig?.locale);
    const validKey = validateIdempotencyKey(request.idempotencyKey, request.dateConfig?.locale);
    if (!validKey.ok) return validKey;
    if (!DocumentIssuanceActorSchema.safeParse(request.actor).success) return fail(err.badInput(t.actorInvalid));
    try {
      recordRequestIdentityHash(request);
    } catch (error) {
      return fail(serviceError(error) ?? err.badInput(t.requestInvalidJson));
    }
    try {
      const operation = await operationIdentity(request);
      const [receipt] = await db<IssuanceRow[]>`
      SELECT id::text, base_id::text, request_hash, request_identity_hash, document_short_id, frozen_request, document_id::text, created_at
      FROM grids.document_issuances
      WHERE base_id = ${request.baseId}::uuid AND operation_key_hash = ${operation.hash}
    `;
      if (receipt && (operation.once || receipt.request_identity_hash)) {
        if (operation.once) await authorizeReceipt(receipt, request.canReadTable, request.dateConfig?.locale);
        else if (receipt.request_identity_hash !== recordRequestIdentityHash(request)) return fail(err.conflict(t.idempotencyConflict));
        if (receipt.document_id) {
          const document = await getDocument(receipt.document_id);
          return document ? ok(document) : fail(err.internal(t.receiptReadFailed));
        }
        const frozen = parseFrozenRequest(receipt.frozen_request);
        const resumed = await issueDocument(
          {
            ...request,
            template: frozen.template,
            snapshot: frozen.snapshot,
            renderData: frozen.renderData,
          },
          request,
        );
        return resumed.ok ? ok(resumed.data.document) : resumed;
      }
      const captured = await capture();
      if (!captured.ok) return captured;
      const issued = await issueDocument({ ...request, ...captured.data }, request);
      return issued.ok ? ok(issued.data.document) : issued;
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  return {
    profiles: summaries,
    preview,
    issueDocument,
    issueRecordDocument,
    issueQueryDocument,
    inspectQueryDocumentConfirmation,
    confirmQueryDocument,
    getDocumentArtifact,
  };
};

export const documentIssuanceService = createDocumentIssuanceService();
