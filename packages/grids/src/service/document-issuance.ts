import { createHash } from "node:crypto";
import { type DateContext, err, fail, ok, type Result, type ServiceError } from "@k2b/stdlib";
import type { RenderHtmlToPdfResult } from "@valentinkolb/cloud/services";
import { sql as defaultSql, type SQL } from "bun";
import { z } from "zod";
import { type Document, type DocumentArtifact, type DocumentTemplate, DocumentTemplateSchema } from "../contracts";
import type { DocumentProfileSummary } from "../document-profile-contracts";
import { type DocumentArtifactDraft, type DocumentProfile, documentProfiles, profileKey, profileRegistry } from "../document-profiles";
import { logAudit } from "./audit";
import { documentNumberFor } from "./document-liquid";
import { type DocumentDbRow, hydrateDocuments } from "./document-mappers";
import { buildDocumentRenderData, renderDocumentPdf, renderDocumentProfileInput } from "./document-rendering";
import { persistRecordSnapshot, type RecordSnapshotDraft } from "./document-snapshots";
import { normalizeDocumentTags } from "./document-values";
import { createProtected } from "./files";
import { allocateNumberInTransaction, bindNumberAllocation } from "./number-series";
import { insertWithShortIdForDb } from "./short-id";

const MAX_ARTIFACTS = 8;
const MAX_TOTAL_ARTIFACT_BYTES = 100 * 1024 * 1024;
export const MAX_DOCUMENT_PROFILE_INPUT_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_HTML_RENDERER_VERSION = "grids-liquid-gotenberg-v1";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
): Promise<Result<DocumentArtifactContent>> => {
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
  if (!row) return fail(err.notFound("Document artifact"));
  const sizeBytes = Number(row.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || row.bytes.byteLength !== sizeBytes || sha256Hex(row.bytes) !== row.sha256) {
    return fail(err.internal("Stored Document artifact failed its integrity check."));
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
  tags?: string[];
  workflowRunId?: string | null;
  workflowStepKey?: string | null;
  dateConfig?: DateContext;
  filename?: string | null;
  renderPdf?: (document: Pick<Document, "templateSnapshot" | "renderData" | "filename">) => Promise<Result<RenderHtmlToPdfResult>>;
};

const actorUserId = (actor: DocumentIssuanceActor): string | null =>
  actor.kind === "user" ? actor.userId : actor.kind === "service_account" ? actor.delegatedUserId : null;

const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const canonicalJsonValue = (value: unknown, path = "$", seen = new Set<object>()): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value.includes("\0")) throw err.badInput(`${path} must not contain NUL`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw err.badInput(`${path} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== "object") throw err.badInput(`${path} must contain only JSON values`);
  if (seen.has(value)) throw err.badInput(`${path} must not contain circular values`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw err.badInput(`${path} must contain only plain JSON objects`);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => {
          if (key.includes("\0")) throw err.badInput(`${path} contains a key with NUL`);
          return [key, canonicalJsonValue(item, `${path}.${key}`, seen)];
        }),
    );
  } finally {
    seen.delete(value);
  }
};

const canonicalJson = (value: Record<string, unknown>): { value: Record<string, JsonValue>; json: string; sha256: string } => {
  const canonical = canonicalJsonValue(value);
  if (!canonical || Array.isArray(canonical) || typeof canonical !== "object") throw err.badInput("Document JSON must be an object");
  const json = JSON.stringify(canonical);
  return { value: canonical, json, sha256: sha256Hex(json) };
};

export const canonicalDocumentJson = (
  value: Record<string, unknown>,
): { value: Record<string, JsonValue>; json: string; sha256: string } => {
  const canonical = canonicalJson(value);
  if (new TextEncoder().encode(canonical.json).byteLength > MAX_DOCUMENT_PROFILE_INPUT_BYTES) {
    throw err.badInput(`Document JSON exceeds the ${MAX_DOCUMENT_PROFILE_INPUT_BYTES} byte limit`);
  }
  return canonical;
};

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

const validateIdempotencyKey = (key: string): Result<void> =>
  key === key.trim() && key.length >= 1 && key.length <= 200 && !key.includes("\0")
    ? ok()
    : fail(err.badInput("Document idempotency key is invalid."));

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
      canonicalJson({
        template: input.template,
        binding: semanticSnapshot(input.snapshot),
        renderData: semanticRenderData(input.renderData),
        actor: input.actor,
        tags: normalizeDocumentTags(input.tags),
        workflowRunId: input.workflowRunId ?? null,
        workflowStepKey: input.workflowStepKey ?? null,
        dateConfig: input.dateConfig ? { locale: input.dateConfig.locale ?? null, timeZone: input.dateConfig.timeZone ?? null } : null,
        filename: input.filename?.trim() || null,
      }).sha256,
    );
  } catch (error) {
    return fail(serviceError(error) ?? err.badInput("Document request contains invalid JSON."));
  }
};

const validateRecordRevision = (input: IssueDocumentInput): Result<void> => {
  const record = input.renderData.record;
  if (!record || typeof record !== "object" || Array.isArray(record))
    return fail(err.badInput("Document render data has no record revision."));
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
    return fail(err.badInput("Document snapshot binding is invalid."));
  }
  if (
    typeof value.id !== "string" ||
    typeof value.version !== "number" ||
    !Number.isInteger(value.version) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(new Date(value.updatedAt).getTime())
  )
    return fail(err.badInput("Document render data has an invalid record revision."));
  const snapshotVersion = root.version;
  const graphVersion = (graphRoot as Record<string, unknown>).version;
  if (typeof snapshotVersion !== "number" || snapshotVersion !== value.version || graphVersion !== snapshotVersion) {
    return fail(err.conflict("Record changed while the Document input was being frozen. Retry generation."));
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

const validateArtifactDrafts = (
  drafts: DocumentArtifactDraft[],
  minimum: number,
): Result<Array<DocumentArtifactDraft & { sha256: string }>> => {
  if (drafts.length < minimum || drafts.length > MAX_ARTIFACTS) {
    return fail(err.badInput(`A Document renderer must produce between ${minimum} and ${MAX_ARTIFACTS} artifacts.`));
  }
  const keys = new Set<string>();
  let totalBytes = 0;
  for (const artifact of drafts) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(artifact.key) || keys.has(artifact.key)) {
      return fail(err.badInput("Document artifact keys must be unique lowercase identifiers."));
    }
    keys.add(artifact.key);
    if (
      !artifact.filename.trim() ||
      artifact.filename !== artifact.filename.trim() ||
      artifact.filename.length > 255 ||
      /[\\/\u0000-\u001f\u007f]/.test(artifact.filename)
    ) {
      return fail(err.badInput(`Document artifact ${artifact.key} has an invalid filename.`));
    }
    if (!artifact.mediaType.trim() || artifact.mediaType.length > 255 || artifact.mediaType.includes("\0")) {
      return fail(err.badInput(`Document artifact ${artifact.key} has an invalid media type.`));
    }
    if (artifact.bytes.byteLength === 0) return fail(err.badInput(`Document artifact ${artifact.key} is empty.`));
    totalBytes += artifact.bytes.byteLength;
  }
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES)
    return fail(err.badInput(`Document artifacts exceed the ${MAX_TOTAL_ARTIFACT_BYTES} byte limit.`));
  const pdf = drafts.find((artifact) => artifact.key === "pdf");
  if (!pdf || pdf.mediaType !== "application/pdf" || new TextDecoder().decode(pdf.bytes.subarray(0, 4)) !== "%PDF") {
    return fail(err.badInput('A Document renderer must produce a valid "pdf" artifact.'));
  }
  return ok(drafts.map((artifact) => ({ ...artifact, sha256: sha256Hex(artifact.bytes) })));
};

const profileInputFor = async (template: DocumentTemplate, renderData: Record<string, unknown>) => {
  if (template.renderer.kind !== "profile") return ok(null);
  const input = await renderDocumentProfileInput(template, renderData);
  return input.ok ? ok(input.data) : input;
};

export const createDocumentIssuanceService = (options: { profiles?: readonly DocumentProfile[]; db?: SQL } = {}) => {
  const db = options.db ?? defaultSql;
  const profiles = profileRegistry(options.profiles ?? documentProfiles);

  const summaries = (): DocumentProfileSummary[] =>
    [...profiles.values()]
      .map(({ id, version, title, description, rendererVersion, validatorVersion }) => ({
        id,
        version,
        title,
        description,
        rendererVersion,
        validatorVersion,
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);

  const preview = async (input: {
    profileId: string;
    profileVersion: number;
    snapshot: Record<string, unknown>;
    issuedAt?: Date;
  }): Promise<Result<DocumentArtifactDraft[]>> => {
    const profile = profiles.get(profileKey(input.profileId, input.profileVersion));
    if (!profile) return fail(err.badInput(`Unknown Document profile ${input.profileId}@${input.profileVersion}.`));
    const parsed = profile.input.safeParse(input.snapshot);
    if (!parsed.success)
      return fail(
        err.badInput(
          parsed.error.issues
            .slice(0, 10)
            .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
            .join("; "),
        ),
      );
    try {
      const rendered = await profile.issue(parsed.data, {
        number: "PREVIEW",
        issuedAt: input.issuedAt ?? new Date(),
      });
      const artifacts = validateArtifactDrafts(rendered.artifacts, 1);
      return artifacts.ok ? ok(artifacts.data) : artifacts;
    } catch (error) {
      const known = serviceError(error);
      return known ? fail(known) : fail(err.badInput(error instanceof Error ? error.message : "Document profile preview failed."));
    }
  };

  const getDocument = async (id: string): Promise<Document | null> => {
    const rows = await db<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${id}::uuid`;
    const [document] = await hydrateDocuments(rows, db);
    return document ?? null;
  };

  const issueDocument = async (
    input: IssueDocumentInput,
  ): Promise<Result<{ document: Document; artifacts: DocumentArtifact[]; replayed: boolean }>> => {
    const idempotency = validateIdempotencyKey(input.idempotencyKey);
    if (!idempotency.ok) return idempotency;
    const actor = DocumentIssuanceActorSchema.safeParse(input.actor);
    if (!actor.success) return fail(err.badInput("Document actor is invalid."));
    if (!input.template.enabled) return fail(err.badInput("Document template is disabled."));
    if (input.template.tableId !== input.snapshot.tableId)
      return fail(err.badInput("Document template does not belong to the snapshot table."));
    if ((input.workflowRunId == null) !== (input.workflowStepKey == null))
      return fail(err.badInput("Document workflow binding is incomplete."));
    const revision = validateRecordRevision(input);
    if (!revision.ok) return revision;
    const renderer = input.template.renderer;
    const profile = renderer.kind === "profile" ? profiles.get(profileKey(renderer.id, renderer.version)) : null;
    if (renderer.kind === "profile" && !profile) {
      return fail(err.badInput(`Unknown Document profile ${renderer.id}@${renderer.version}.`));
    }
    const requestHash = requestHashFor(input);
    if (!requestHash.ok) return requestHash;
    const operationKeyHash = sha256Hex(input.idempotencyKey);

    try {
      const receipt = await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:document-issuance:${input.snapshot.baseId}:${operationKeyHash}`}, 0))`;
        const [existing] = await tx<IssuanceRow[]>`
          SELECT id::text, base_id::text, request_hash, document_short_id, frozen_request, document_id::text, created_at
          FROM grids.document_issuances
          WHERE base_id = ${input.snapshot.baseId}::uuid AND operation_key_hash = ${operationKeyHash}
        `;
        if (existing) {
          if (existing.request_hash !== requestHash.data)
            throw err.conflict("Idempotency key was already used for a different Document request.");
          return existing;
        }
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
          if (!binding) throw err.badInput("Document binding does not identify a live template record.");
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
            ? canonicalJson({
                id: binding.short_id,
                name: binding.name,
                description: binding.description,
                source: binding.source,
                renderer: bindingRenderer,
              }).sha256
            : null;
          if (
            !binding.enabled ||
            binding.updated_at.toISOString() !== input.template.updatedAt ||
            bindingTemplateRevision !== canonicalJson(templateSnapshot(input.template)).sha256 ||
            binding.renderer_kind !== input.template.renderer.kind ||
            (binding.renderer_kind === "profile" &&
              renderer.kind === "profile" &&
              (binding.profile_id !== renderer.id || binding.profile_version !== renderer.version))
          )
            throw err.conflict("Document template changed while generation was being prepared.");
          if (
            binding.record_id !== input.snapshot.recordId ||
            binding.record_id !== input.snapshot.root.id ||
            binding.record_short_id !== renderRecord.id ||
            binding.record_version !== input.snapshot.root.version ||
            binding.record_version !== renderRecord.version ||
            binding.record_updated_at.toISOString() !== input.snapshot.root.updatedAt ||
            binding.record_updated_at.toISOString() !== new Date(String(renderRecord.updatedAt)).toISOString()
          ) {
            throw err.conflict("Record changed while the Document input was being frozen. Retry generation.");
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
            if (!Number.isSafeInteger(value) || value < 1) throw err.internal("Document number series is exhausted.");
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
            const renderedProfileInput = await profileInputFor(input.template, frozenRenderData);
            if (!renderedProfileInput.ok) throw renderedProfileInput.error;
            if (!renderedProfileInput.data) throw err.internal("Document profile input was not rendered.");
            const parsed = profile!.input.safeParse(renderedProfileInput.data);
            if (!parsed.success) {
              throw err.badInput(
                parsed.error.issues
                  .slice(0, 10)
                  .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
                  .join("; "),
              );
            }
            profileInput = renderedProfileInput.data;
          }
          const frozen: FrozenDocumentRequest = {
            template: input.template,
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
          INSERT INTO grids.document_issuances (base_id, operation_key_hash, request_hash, document_short_id, frozen_request)
          VALUES (${input.snapshot.baseId}::uuid, ${operationKeyHash}, ${requestHash.data}, ${documentShortId}, ${canonicalJson({ ...frozen }).value}::jsonb)
          RETURNING id::text, base_id::text, request_hash, document_short_id, frozen_request, document_id::text, created_at
        `;
          if (!created) throw err.internal("Document issuance receipt could not be created.");
          return created;
        });
      });

      if (receipt.document_id) {
        const replay = await getDocument(receipt.document_id);
        return replay
          ? ok({ document: replay, artifacts: replay.artifacts, replayed: true })
          : fail(err.internal("Completed Document receipt could not be read."));
      }
      const frozen = parseFrozenRequest(receipt.frozen_request);
      let rendered: {
        artifacts: DocumentArtifactDraft[];
        validationStatus: "valid" | "warning" | null;
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
        rendered = { artifacts: output.artifacts, validationStatus: output.validationStatus, validationReport: output.validationReport };
      } else {
        const output = await (input.renderPdf ?? renderDocumentPdf)({
          templateSnapshot: templateSnapshot(frozen.template),
          renderData: frozen.renderData,
          filename: frozen.filename ?? `${frozen.documentNumber}.pdf`,
        });
        if (!output.ok) return output;
        if (output.data.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/pdf") {
          return fail(err.badInput("Document renderer did not return a PDF."));
        }
        rendered = {
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
      const artifactDrafts = validateArtifactDrafts(rendered.artifacts, 1);
      if (!artifactDrafts.ok) return artifactDrafts;
      const pdf = artifactDrafts.data.find((artifact) => artifact.key === "pdf")!;
      const snapshotHash = frozen.profileInput ? canonicalDocumentJson(frozen.profileInput).sha256 : null;
      const templateData = templateSnapshot(frozen.template);
      const templateRevision = canonicalDocumentJson(templateData).sha256;
      const finalized = await db.begin(async (tx) => {
        const [locked] = await tx<IssuanceRow[]>`
          SELECT id::text, base_id::text, request_hash, document_short_id, frozen_request, document_id::text, created_at
          FROM grids.document_issuances WHERE id = ${receipt.id}::uuid FOR UPDATE
        `;
        if (!locked) throw err.internal("Document issuance receipt disappeared.");
        if (locked.document_id) {
          const replayRows = await tx<DocumentDbRow[]>`SELECT * FROM grids.documents WHERE id = ${locked.document_id}::uuid`;
          const [replay] = await hydrateDocuments(replayRows, tx);
          if (!replay) throw err.internal("Completed Document receipt could not be read.");
          return { document: replay, replayed: true };
        }
        const persisted = await persistRecordSnapshot(frozen.snapshot, tx);
        if (!persisted.ok) throw persisted.error;
        const documentId = Bun.randomUUIDv7();
        const files: Array<{ draft: (typeof artifactDrafts.data)[number]; fileId: string }> = [];
        for (const draft of artifactDrafts.data) {
          const file = await createProtected(
            {
              ownerKind: "document_artifact",
              ownerId: documentId,
              baseId: frozen.snapshot.baseId,
              tableId: frozen.snapshot.tableId,
              recordId: frozen.snapshot.recordId,
              userId: actorUserId(frozen.actor),
              filename: draft.filename,
              mimeType: draft.mediaType,
              bytes: draft.bytes,
            },
            tx,
          );
          if (!file.ok) throw file.error;
          files.push({ draft, fileId: file.data.id });
        }
        const selectedProfile =
          frozen.template.renderer.kind === "profile"
            ? profiles.get(profileKey(frozen.template.renderer.id, frozen.template.renderer.version))!
            : null;
        const [row] = await tx<DocumentDbRow[]>`
          INSERT INTO grids.documents (
            id, short_id, template_id, workflow_run_id, workflow_step_key, snapshot_id, base_id, table_id, record_id,
            document_number, filename, tags, template_snapshot, render_data, renderer_kind, renderer_version, template_revision,
            profile_id, profile_version, profile_snapshot, snapshot_sha256,
            validator_version, validation_status, validation_report, issued_actor, created_by, created_at
          ) VALUES (
            ${documentId}::uuid, ${receipt.document_short_id}, ${frozen.template.id}::uuid, ${frozen.workflowRunId}::uuid, ${frozen.workflowStepKey},
            ${frozen.snapshot.id}::uuid, ${frozen.snapshot.baseId}::uuid, ${frozen.snapshot.tableId}::uuid, ${frozen.snapshot.recordId}::uuid,
            ${frozen.documentNumber}, ${pdf.filename}, ${tx.array(frozen.tags, "TEXT")}, ${templateData}::jsonb,
            ${frozen.renderData}::jsonb, ${frozen.template.renderer.kind},
            ${selectedProfile?.rendererVersion ?? DOCUMENT_HTML_RENDERER_VERSION}, ${templateRevision},
            ${selectedProfile?.id ?? null}, ${selectedProfile?.version ?? null},
            ${frozen.profileInput}::jsonb, ${snapshotHash},
            ${selectedProfile?.validatorVersion ?? null}, ${rendered.validationStatus}, ${rendered.validationReport}::jsonb,
            ${frozen.actor}::jsonb, ${actorUserId(frozen.actor)}::uuid, ${frozen.issuedAt}
          ) RETURNING *
        `;
        if (!row) throw err.internal("Document insert returned no row.");
        for (const file of files)
          await tx`
          INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
          VALUES (${documentId}::uuid, ${file.draft.key}, ${file.fileId}::uuid)
        `;
        if (frozen.allocationId) await bindNumberAllocation(tx, frozen.allocationId, { kind: "document", id: documentId });
        await tx`
          UPDATE grids.document_issuances
          SET document_id = ${documentId}::uuid, completed_at = now(), frozen_request = NULL
          WHERE id = ${receipt.id}::uuid
        `;
        await logAudit(
          {
            baseId: frozen.snapshot.baseId,
            tableId: frozen.snapshot.tableId,
            recordId: frozen.snapshot.recordId,
            userId: actorUserId(frozen.actor),
            action: "document.created",
            diff: { documentId: { old: null, new: receipt.document_short_id }, documentNumber: { old: null, new: frozen.documentNumber } },
          },
          tx,
        );
        const [document] = await hydrateDocuments([row], tx);
        if (!document) throw err.internal("Created Document could not be read.");
        return { document, replayed: false };
      });
      return ok({ document: finalized.document, artifacts: finalized.document.artifacts, replayed: finalized.replayed });
    } catch (error) {
      const known = serviceError(error);
      if (known) return fail(known);
      throw error;
    }
  };

  const getDocumentArtifact = (documentId: string, key: string): Promise<Result<DocumentArtifactContent>> =>
    readDocumentArtifact(documentId, key, db);

  return { profiles: summaries, preview, issueDocument, getDocumentArtifact };
};

export const documentIssuanceService = createDocumentIssuanceService();
