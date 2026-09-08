import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { RecordAuditContextSchema } from "../contracts";
import { assertFederatedPublication, buildDslSqlRecordSource } from "../query-dsl/sql-record-source";
import { getActive, type LoadedFederatedRevision, verifyRevisionScope } from "./federated-tables";
import { listByTables } from "./field-read";
import { listByTable as listFields } from "./fields";
import { parseJsonbRow } from "./jsonb";
import { serviceMessagesFor } from "./messages";
import { get as getTable } from "./tables";
import type { AuditAction, AuditEntry, Field } from "./types";

type DbRow = Record<string, unknown>;

const RECORD_ACTIONS = ["created", "updated", "deleted", "restored", "imported"] as const satisfies readonly AuditAction[];
type CombinedRecordAuditAction = (typeof RECORD_ACTIONS)[number];

type CombinedAuditSource = {
  ref: string;
  baseName: string;
  tableName: string;
};

type CombinedAuditContext = {
  operation: "delete" | "restore" | "update";
  answers: Array<{
    label: string;
    type: "text" | "longtext" | "select";
    required: boolean;
    value: string;
    optionLabel?: string;
  }>;
};

export type CombinedAuditEntry = Omit<AuditEntry, "context"> & {
  context: CombinedAuditContext | null;
  userDisplayName: string | null;
  userAvatarHash: string | null;
  source: CombinedAuditSource;
  recordDeletedAt: string | null;
};

export type CombinedAuditPage = {
  items: CombinedAuditEntry[];
  sources: CombinedAuditSource[];
  nextCursor: string | null;
};

export type CombinedRecordOrigin = {
  source: CombinedAuditSource;
  deletedAt: string | null;
};

export type CombinedAuditProjectionMapping = {
  targetFieldId: string;
  targetField: Field;
  sourceFieldId: string;
  sourceField: Field;
  config: Record<string, unknown>;
};

type ProjectionSource = {
  tableId: string;
  descriptor: CombinedAuditSource;
  mappings: CombinedAuditProjectionMapping[];
};

type Projection = {
  targetBaseId: string;
  targetTableId: string;
  revisionId: string;
  revisionToken: string;
  fingerprint: string;
  sources: ProjectionSource[];
};

type SourceRow = { table_id: string; table_name: string; base_name: string };
type AuditRow = DbRow & { cursor_created_at: string };

type CombinedAuditListParams = {
  tableId: string;
  recordId?: string;
  fieldIds?: readonly string[];
  sourceRef?: string;
  action?: CombinedRecordAuditAction;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
  locale?: string;
};

const AuditCursorSchema = z.object({
  fingerprint: z.string().min(1).max(200),
  createdAt: z.string().min(1).max(100),
  id: z.string().uuid(),
});

type AuditCursor = z.infer<typeof AuditCursorSchema>;

const AUDIT_CURSOR_SIGNATURE_DOMAIN = "grids:combined-audit-cursor:v1\0";

const auditCursorSigningKey = (): string => {
  const key = process.env.APP_SECRET?.trim();
  if (!key) throw new Error("APP_SECRET is required for Combined audit pagination");
  return key;
};

const cursorSignature = (payload: string): string =>
  createHmac("sha256", auditCursorSigningKey()).update(AUDIT_CURSOR_SIGNATURE_DOMAIN).update(payload).digest("base64url");

const encodeCursor = (cursor: AuditCursor): string => {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  return `${payload}.${cursorSignature(payload)}`;
};

const decodeCursor = (value: string | null | undefined): AuditCursor | null => {
  if (!value || value.length > 2_000) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(cursorSignature(payload), "utf8");
    const received = Buffer.from(signature, "utf8");
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const parsed = AuditCursorSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());

const auditCursorFingerprint = (
  projectionFingerprint: string,
  filters: {
    recordId?: string;
    fieldIds?: readonly string[];
    sourceRef?: string;
    action?: CombinedRecordAuditAction;
    from?: string;
    to?: string;
  },
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        publication: projectionFingerprint,
        recordId: filters.recordId ?? null,
        fieldIds: filters.fieldIds ? [...filters.fieldIds].sort() : null,
        sourceRef: filters.sourceRef ?? null,
        action: filters.action ?? null,
        from: filters.from ?? null,
        to: filters.to ?? null,
      }),
    )
    .digest("base64url");

const mappedSelectValue = (value: unknown, config: Record<string, unknown>, targetField: Field): unknown => {
  if (value === null || value === undefined) return value;
  const optionMap = (config.optionMap ?? {}) as Record<string, unknown>;
  const targetOptions = new Map(
    ((targetField.config as { options?: Array<{ id?: unknown; label?: unknown }> }).options ?? []).flatMap((option) =>
      typeof option.id === "string" && typeof option.label === "string" ? [[option.id, option.label] as const] : [],
    ),
  );
  const mapOne = (item: unknown): unknown => {
    if (typeof item !== "string") return "Unavailable in current Combined mapping";
    const targetOptionId = optionMap[item];
    return typeof targetOptionId === "string"
      ? (targetOptions.get(targetOptionId) ?? "Unavailable in current Combined mapping")
      : "Unavailable in current Combined mapping";
  };
  return Array.isArray(value) ? value.map(mapOne) : mapOne(value);
};

const countedValue = (value: unknown, singular: string, plural: string): unknown => {
  if (value === null || value === undefined) return value;
  const count = Array.isArray(value) ? value.length : 1;
  return `${count} ${count === 1 ? singular : plural}`;
};

const projectMappedValue = (value: unknown, mapping: CombinedAuditProjectionMapping): unknown => {
  if (mapping.sourceField.type === "select") return mappedSelectValue(value, mapping.config, mapping.targetField);
  if (mapping.targetField.type === "relation") return countedValue(value, "related record", "related records");
  if (mapping.targetField.type === "file") return countedValue(value, "file", "files");
  return value;
};

export const projectCombinedAuditContext = (value: unknown): CombinedAuditContext | null => {
  if (value === null || value === undefined) return null;
  const parsed = RecordAuditContextSchema.safeParse(value);
  if (!parsed.success) throw new Error("Combined audit history contains invalid mutation context");
  if (parsed.data.answers.some((answer) => answer.type === "select" && !answer.optionLabel)) {
    throw new Error("Combined audit history contains an unlabeled select answer");
  }
  return {
    operation: parsed.data.operation,
    answers: parsed.data.answers.map(({ label, type, required, value: answer, optionLabel }) => ({
      label,
      type,
      required,
      value: type === "select" && optionLabel ? optionLabel : answer,
      ...(optionLabel ? { optionLabel } : {}),
    })),
  };
};

export const projectCombinedAuditDiff = (
  diff: AuditEntry["diff"],
  mappings: readonly CombinedAuditProjectionMapping[],
): AuditEntry["diff"] => {
  if (!diff) return null;
  const projected: NonNullable<AuditEntry["diff"]> = {};
  for (const mapping of mappings) {
    const change = diff[mapping.sourceFieldId];
    if (!change) continue;
    projected[mapping.targetFieldId] = {
      old: projectMappedValue(change.old, mapping),
      new: projectMappedValue(change.new, mapping),
    };
  }
  return Object.keys(projected).length > 0 ? projected : null;
};

const loadSourceRows = (sourceTableIds: readonly string[]) => sql<SourceRow[]>`
  SELECT source_table.id::text AS table_id,
         source_table.name AS table_name,
         source_base.name AS base_name
  FROM grids.tables source_table
  JOIN grids.bases source_base
    ON source_base.id = source_table.base_id
   AND source_base.deleted_at IS NULL
  WHERE source_table.id = ANY(${toPgUuidArray([...sourceTableIds])}::uuid[])
    AND source_table.kind = 'stored'
    AND source_table.deleted_at IS NULL
`;

type ProjectionSourceBuildContext = {
  revision: LoadedFederatedRevision;
  targetFieldsById: ReadonlyMap<string, Field>;
  sourceFieldsByTable: ReadonlyMap<string, Field[]>;
  sourceLabels: ReadonlyMap<string, SourceRow>;
  allowedTargetFieldIds: ReadonlySet<string> | null;
};

const buildProjectionSource = (
  source: LoadedFederatedRevision["sources"][number],
  context: ProjectionSourceBuildContext,
  locale?: string,
): Result<ProjectionSource> => {
  const t = serviceMessagesFor(locale);
  const label = context.sourceLabels.get(source.sourceTableId);
  if (!label) return fail(err.conflict(t.combinedSourceUnavailable));
  const sourceFields = new Map((context.sourceFieldsByTable.get(source.sourceTableId) ?? []).map((field) => [field.id, field]));
  const mappings: CombinedAuditProjectionMapping[] = [];

  for (const mapping of context.revision.mappings) {
    if (mapping.sourceTableId !== source.sourceTableId) continue;
    const targetField = context.targetFieldsById.get(mapping.targetFieldId);
    const sourceField = sourceFields.get(mapping.sourceFieldId);
    if (!targetField || !sourceField || sourceField.deletedAt) {
      return fail(err.conflict(t.combinedMappingUnavailable));
    }
    if (context.allowedTargetFieldIds?.has(mapping.targetFieldId) === false) continue;
    mappings.push({
      targetFieldId: mapping.targetFieldId,
      targetField,
      sourceFieldId: mapping.sourceFieldId,
      sourceField,
      config: mapping.config,
    });
  }

  return ok({
    tableId: source.sourceTableId,
    descriptor: { ref: String(source.position), baseName: label.base_name, tableName: label.table_name },
    mappings,
  });
};

const buildProjectionSources = (params: {
  revision: LoadedFederatedRevision;
  targetFields: readonly Field[];
  sourceFieldsByTable: ReadonlyMap<string, Field[]>;
  sourceRows: readonly SourceRow[];
  fieldIds?: readonly string[];
  locale?: string;
}): Result<ProjectionSource[]> => {
  if (params.sourceRows.length !== params.revision.sources.length) {
    return fail(err.conflict(serviceMessagesFor(params.locale).combinedSourceUnavailable));
  }
  const context: ProjectionSourceBuildContext = {
    revision: params.revision,
    targetFieldsById: new Map(params.targetFields.filter((field) => !field.deletedAt).map((field) => [field.id, field])),
    sourceFieldsByTable: params.sourceFieldsByTable,
    sourceLabels: new Map(params.sourceRows.map((row) => [row.table_id, row])),
    allowedTargetFieldIds: params.fieldIds ? new Set(params.fieldIds) : null,
  };
  const sources: ProjectionSource[] = [];
  for (const source of params.revision.sources) {
    const built = buildProjectionSource(source, context, params.locale);
    if (!built.ok) return built;
    sources.push(built.data);
  }
  return ok(sources);
};

const loadProjection = async (tableId: string, fieldIds?: readonly string[], locale?: string): Promise<Result<Projection>> => {
  const [table, active, targetFields] = await Promise.all([getTable(tableId), getActive(tableId, locale), listFields(tableId)]);
  if (!table || table.kind !== "federated") return fail(err.badInput(serviceMessagesFor(locale).combinedAuditTableRequired));
  if (!active.ok) return active;

  const revision = active.data;
  const sourceTableIds = revision.sources.map((source) => source.sourceTableId);
  const [sourceFieldsByTable, sourceRows] = await Promise.all([listByTables(sourceTableIds), loadSourceRows(sourceTableIds)]);
  const sources = buildProjectionSources({ revision, targetFields, sourceFieldsByTable, sourceRows, fieldIds, locale });
  if (!sources.ok) return sources;

  return ok({
    targetBaseId: table.baseId,
    targetTableId: table.id,
    revisionId: revision.id,
    revisionToken: revision.revisionToken,
    fingerprint: `${revision.id}:${revision.revisionToken}`,
    sources: sources.data,
  });
};

const resolveOrigin = async (projection: Projection, recordId: string, locale?: string): Promise<Result<CombinedRecordOrigin>> => {
  const fields = await listFields(projection.targetTableId);
  const recordSource = await buildDslSqlRecordSource(
    projection.targetTableId,
    { [projection.targetTableId]: fields },
    { includeDeleted: true },
  );
  if (!recordSource) return fail(err.notFound(serviceMessagesFor(locale).combinedRecord));
  await assertFederatedPublication(recordSource);
  const rows = await sql<Array<{ source_table_id: string; deleted_at: Date | null }>>`
    SELECT source_table_id::text, deleted_at
    FROM ${recordSource.relation} combined_record
    WHERE combined_record.id = ${recordId}::uuid
    LIMIT 2
  `;
  if (rows.length !== 1) return fail(err.notFound(serviceMessagesFor(locale).combinedRecord));
  const row = rows[0]!;
  const source = projection.sources.find((item) => item.tableId === row.source_table_id);
  if (!source) return fail(err.conflict(serviceMessagesFor(locale).combinedRecordSourceUnpublished));
  return ok({
    source: source.descriptor,
    deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
  });
};

const mapAuditRow = (row: DbRow, projection: Projection): CombinedAuditEntry | null => {
  const source = projection.sources.find((item) => item.tableId === row.table_id);
  if (!source) return null;
  return {
    id: row.id as string,
    baseId: projection.targetBaseId,
    tableId: projection.targetTableId,
    recordId: (row.record_id as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    userDisplayName: (row.user_display_name as string | null) ?? null,
    userAvatarHash: (row.user_avatar_hash as string | null) ?? null,
    action: row.action as CombinedRecordAuditAction,
    diff: projectCombinedAuditDiff(parseJsonbRow<AuditEntry["diff"]>(row.diff, null), source.mappings),
    context: projectCombinedAuditContext(parseJsonbRow<unknown>(row.context, null)),
    ip: null,
    userAgent: null,
    createdAt: iso(row.created_at),
    source: source.descriptor,
    recordDeletedAt: row.record_deleted_at ? iso(row.record_deleted_at) : null,
  };
};

const scopeProjectionSources = async (
  projection: Projection,
  params: Pick<CombinedAuditListParams, "recordId" | "sourceRef" | "locale">,
): Promise<Result<ProjectionSource[]>> => {
  let sources = projection.sources;
  if (params.recordId) {
    const origin = await resolveOrigin(projection, params.recordId, params.locale);
    if (!origin.ok) return origin;
    sources = sources.filter((source) => source.descriptor.ref === origin.data.source.ref);
  }
  if (params.sourceRef === undefined) return ok(sources);
  sources = sources.filter((source) => source.descriptor.ref === params.sourceRef);
  return sources.length > 0 ? ok(sources) : fail(err.badInput(serviceMessagesFor(params.locale).unknownCombinedSourceFilter));
};

const resolveListCursor = (
  projection: Projection,
  params: CombinedAuditListParams,
): Result<{ cursor: AuditCursor | null; fingerprint: string }> => {
  const cursor = decodeCursor(params.cursor);
  if (params.cursor && !cursor) return fail(err.badInput(serviceMessagesFor(params.locale).invalidAuditCursor));
  const fingerprint = auditCursorFingerprint(projection.fingerprint, params);
  if (cursor && cursor.fingerprint !== fingerprint) {
    return fail(err.conflict(serviceMessagesFor(params.locale).combinedAuditChanged));
  }
  return ok({ cursor, fingerprint });
};

const loadAuditRows = (
  params: CombinedAuditListParams,
  sources: readonly ProjectionSource[],
  cursor: AuditCursor | null,
  limit: number,
) => {
  const tableIds = sources.map((source) => source.tableId);
  const publishedSourceFieldIds = sources.flatMap((source) => source.mappings.map((mapping) => mapping.sourceFieldId));
  const actions = params.action ? [params.action] : [...RECORD_ACTIONS];
  const recordId = params.recordId ?? null;
  const from = params.from ?? null;
  const to = params.to ?? null;
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  return sql<AuditRow[]>`
    SELECT audit.id::text, audit.table_id::text, audit.record_id::text, audit.user_id::text,
           audit.action, audit.diff, audit.context, audit.created_at,
           audit.created_at::text AS cursor_created_at,
           COALESCE(auth_user.display_name, auth_user.uid) AS user_display_name,
           auth_user.avatar_hash AS user_avatar_hash,
           current_record.deleted_at AS record_deleted_at
    FROM grids.audit_log audit
    LEFT JOIN auth.users auth_user ON auth_user.id = audit.user_id
    LEFT JOIN grids.records current_record
      ON current_record.table_id = audit.table_id
     AND current_record.id = audit.record_id
    WHERE audit.table_id = ANY(${toPgUuidArray(tableIds)}::uuid[])
      AND audit.record_id IS NOT NULL
      AND audit.action = ANY(${`{${actions.join(",")}}`}::text[])
      AND (
        audit.action <> 'updated'
        OR COALESCE(audit.diff ?| ${toPgTextArray(publishedSourceFieldIds)}::text[], false)
      )
      AND (${recordId}::uuid IS NULL OR audit.record_id = ${recordId}::uuid)
      AND (${from}::timestamptz IS NULL OR audit.created_at >= ${from}::timestamptz)
      AND (${to}::timestamptz IS NULL OR audit.created_at < ${to}::timestamptz)
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (audit.created_at, audit.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid)
      )
    ORDER BY audit.created_at DESC, audit.id DESC
    LIMIT ${limit + 1}
  `;
};

const mapAuditRows = (rows: readonly AuditRow[], projection: Projection, locale?: string): Result<CombinedAuditEntry[]> => {
  try {
    const entries: CombinedAuditEntry[] = [];
    for (const row of rows) {
      const entry = mapAuditRow(row, projection);
      if (entry) entries.push(entry);
    }
    return ok(entries);
  } catch {
    return fail(err.conflict(serviceMessagesFor(locale).combinedAuditInvalidContext));
  }
};

export const describeRecord = async (tableId: string, recordId: string, locale?: string): Promise<Result<CombinedRecordOrigin>> => {
  const projection = await loadProjection(tableId, undefined, locale);
  if (!projection.ok) return projection;
  return resolveOrigin(projection.data, recordId, locale);
};

export const list = async (params: CombinedAuditListParams): Promise<Result<CombinedAuditPage>> => {
  const projectionResult = await loadProjection(params.tableId, params.fieldIds, params.locale);
  if (!projectionResult.ok) return projectionResult;
  const projection = projectionResult.data;
  const scopedSources = await scopeProjectionSources(projection, params);
  if (!scopedSources.ok) return scopedSources;
  const cursorResult = resolveListCursor(projection, params);
  if (!cursorResult.ok) return cursorResult;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const rows = await loadAuditRows(params, scopedSources.data, cursorResult.data.cursor, limit);
  const currentRevision = await verifyRevisionScope(
    [
      {
        tableId: projection.targetTableId,
        revisionId: projection.revisionId,
        revisionToken: projection.revisionToken,
      },
    ],
    params.locale,
  );
  if (!currentRevision.ok) return currentRevision;
  const mapped = mapAuditRows(rows, projection, params.locale);
  if (!mapped.ok) return mapped;
  const items = mapped.data.slice(0, limit);
  const lastRow = rows[items.length - 1];
  return ok({
    items,
    sources: projection.sources.map((source) => source.descriptor),
    nextCursor:
      rows.length > limit && lastRow
        ? encodeCursor({
            fingerprint: cursorResult.data.fingerprint,
            createdAt: lastRow.cursor_created_at,
            id: lastRow.id as string,
          })
        : null,
  });
};

export const listByRecord = async (
  tableId: string,
  recordId: string,
  limit = 50,
  fieldIds?: readonly string[],
  locale?: string,
): Promise<CombinedAuditEntry[]> => {
  const page = await list({ tableId, recordId, limit, fieldIds, locale });
  if (!page.ok) throw new Error(page.error.message);
  return page.data.items;
};
