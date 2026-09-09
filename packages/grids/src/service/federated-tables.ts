import { isDeepStrictEqual } from "node:util";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { escapeLikePattern, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  FederatedDiagnostic,
  FederatedDraftInput,
  FederatedFieldMapping,
  FederatedRevision,
  FederatedRevisionStatus,
  FederatedSource,
  FederatedSourceCandidatePage,
  FederatedSourcePublication,
  FederatedValidation,
} from "../contracts";
import { type BaseAdminAuthorization, hasTransactionalBaseAdmin, lockBaseAuthorization } from "./access";
import { logAudit, type SqlClient } from "./audit";
import { buildComputedProjections, buildFormulaSqlProjections } from "./computed-projections";
import { mapFieldRow } from "./field-read";
import { outputSqlTypeForField } from "./field-storage";
import { parseJsonbRow } from "./jsonb";
import { serviceMessagesFor } from "./messages";
import { emitTableMetadataEvent } from "./metadata-events";
import { hasAtLeast } from "./permission-resolver";
import type { Field } from "./types";

type DbRow = Record<string, unknown>;

const MAX_FEDERATED_SOURCES = 50;
const MAX_FEDERATED_FIELDS = 200;

type FederatedPublicationAuthorization = BaseAdminAuthorization;

export const lockFederatedSchemaTables = async (tableIds: readonly string[], client: SqlClient): Promise<void> => {
  for (const tableId of [...new Set(tableIds)].sort()) {
    await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:federated-schema:${tableId}`}, 0))`;
  }
};

export const listSourceCandidates = async (params: {
  targetTableId: string;
  authorization: FederatedPublicationAuthorization;
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<FederatedSourceCandidatePage> => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  if (!hasAtLeast(params.authorization.permissionCap, "admin") || params.authorization.resourceBoundBaseId === null) {
    return { items: [], total: 0, limit, offset };
  }
  const query = params.q?.trim().toLowerCase();
  const pattern = query ? `%${escapeLikePattern(query)}%` : null;
  const principalMatch = buildAccessPrincipalCondition({
    subject: params.authorization.subject,
    columns: {
      userId: sql`access.user_id`,
      groupId: sql`access.group_id`,
      serviceAccountId: sql`access.service_account_id`,
      authenticatedOnly: sql`access.authenticated_only`,
    },
  });
  const candidateRelation = sql`
    WITH matching_access AS (
      SELECT base_access.base_id,
             CASE
               WHEN access.service_account_id IS NOT NULL THEN 1
               WHEN access.user_id IS NOT NULL THEN 2
               WHEN access.group_id IS NOT NULL THEN 3
               WHEN access.authenticated_only = TRUE THEN 4
               ELSE 5
             END AS principal_rank,
             access.permission
      FROM grids.base_access base_access
      JOIN auth.access access ON access.id = base_access.access_id
      WHERE ${principalMatch}
    ), tier_permissions AS (
      SELECT base_id, principal_rank,
             CASE
               WHEN bool_or(permission = 'none') THEN 0
               ELSE max(CASE permission WHEN 'read' THEN 1 WHEN 'write' THEN 2 WHEN 'admin' THEN 3 ELSE 0 END)
             END AS permission_rank
      FROM matching_access
      GROUP BY base_id, principal_rank
    ), effective_permissions AS (
      SELECT DISTINCT ON (base_id) base_id, permission_rank
      FROM tier_permissions
      ORDER BY base_id, principal_rank
    ), draft_sources AS (
      SELECT source.source_table_id
      FROM grids.federated_table_revisions revision
      JOIN grids.federated_table_sources source ON source.revision_id = revision.id
      WHERE revision.table_id = ${params.targetTableId}::uuid
        AND revision.status = 'draft'
    )
    SELECT base.id::text AS base_id, base.short_id AS base_short_id, base.name AS base_name,
           source.id::text AS table_id, source.short_id AS table_short_id, source.name AS table_name,
           source.description AS table_description, source.icon AS table_icon,
           count(field.id)::int AS field_count,
           (draft_source.source_table_id IS NOT NULL) AS selected
    FROM grids.tables source
    JOIN grids.bases base ON base.id = source.base_id AND base.deleted_at IS NULL
    JOIN effective_permissions permission ON permission.base_id = base.id AND permission.permission_rank >= 3
    LEFT JOIN grids.fields field ON field.table_id = source.id AND field.deleted_at IS NULL
    LEFT JOIN draft_sources draft_source ON draft_source.source_table_id = source.id
    WHERE source.kind = 'stored'
      AND source.deleted_at IS NULL
      AND (${params.authorization.resourceBoundBaseId ?? null}::uuid IS NULL OR base.id = ${params.authorization.resourceBoundBaseId ?? null}::uuid)
      AND (
        ${pattern}::text IS NULL
        OR lower(base.name) LIKE ${pattern} ESCAPE '\\'
        OR lower(base.short_id) LIKE ${pattern} ESCAPE '\\'
        OR lower(source.name) LIKE ${pattern} ESCAPE '\\'
        OR lower(source.short_id) LIKE ${pattern} ESCAPE '\\'
        OR lower(coalesce(source.description, '')) LIKE ${pattern} ESCAPE '\\'
      )
    GROUP BY base.id, source.id, draft_source.source_table_id
  `;
  const [countRow] = await sql<Array<{ total: number }>>`
    SELECT count(*)::int AS total FROM (${candidateRelation}) candidate
  `;
  const rows = await sql<
    Array<{
      base_id: string;
      base_short_id: string;
      base_name: string;
      table_id: string;
      table_short_id: string;
      table_name: string;
      table_description: string | null;
      table_icon: string | null;
      field_count: number;
    }>
  >`
    SELECT * FROM (${candidateRelation}) candidate
    ORDER BY selected DESC, lower(base_name), base_id, lower(table_name), table_id
    LIMIT ${limit} OFFSET ${offset}
  `;
  return {
    items: rows.map((row) => ({
      base: { id: row.base_id, shortId: row.base_short_id, name: row.base_name },
      table: {
        id: row.table_id,
        shortId: row.table_short_id,
        baseId: row.base_id,
        name: row.table_name,
        description: row.table_description,
        icon: row.table_icon,
      },
      fieldCount: row.field_count,
    })),
    total: countRow?.total ?? 0,
    limit,
    offset,
  };
};

const COMPUTED_TYPES = new Set(["formula", "lookup", "rollup"]);

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const nullableIso = (value: unknown): string | null => (value ? iso(value) : null);

export type LoadedFederatedRevision = FederatedRevision & { revisionToken: string };

const mapSource = (row: DbRow): FederatedSource => ({
  id: row.id as string,
  revisionId: row.revision_id as string,
  sourceTableId: row.source_table_id as string,
  position: row.position as number,
  authorizedBy: (row.authorized_by as string | null) ?? null,
  authorizedAt: nullableIso(row.authorized_at),
  revokedBy: (row.revoked_by as string | null) ?? null,
  revokedAt: nullableIso(row.revoked_at),
});

const mapMapping = (row: DbRow): FederatedFieldMapping => ({
  revisionId: row.revision_id as string,
  targetFieldId: row.target_field_id as string,
  sourceTableId: row.source_table_id as string,
  sourceFieldId: row.source_field_id as string,
  config: parseJsonbRow<Record<string, unknown>>(row.config, {}),
});

const loadRevision = async (client: SqlClient, row: DbRow): Promise<LoadedFederatedRevision> => {
  const revisionId = row.id as string;
  const [sources, mappings] = await Promise.all([
    client<DbRow[]>`
      SELECT id::text, revision_id::text, source_table_id::text, position,
             authorized_by::text, authorized_at, revoked_by::text, revoked_at
      FROM grids.federated_table_sources
      WHERE revision_id = ${revisionId}::uuid
      ORDER BY position, source_table_id
    `,
    client<DbRow[]>`
      SELECT revision_id::text, target_field_id::text, source_table_id::text,
             source_field_id::text, config
      FROM grids.federated_field_mappings
      WHERE revision_id = ${revisionId}::uuid
      ORDER BY target_field_id, source_table_id
    `,
  ]);
  return {
    id: revisionId,
    tableId: row.table_id as string,
    revision: row.revision as number,
    status: row.status as FederatedRevisionStatus,
    diagnostics: parseJsonbRow<FederatedDiagnostic[]>(row.diagnostics, []),
    createdBy: (row.created_by as string | null) ?? null,
    publishedBy: (row.published_by as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revisionToken: row.revision_token as string,
    publishedAt: nullableIso(row.published_at),
    sources: sources.map(mapSource),
    mappings: mappings.map(mapMapping),
  };
};

const getRevisionByStatus = async (
  tableId: string,
  statuses: readonly FederatedRevisionStatus[],
  client: SqlClient = sql,
  lock = false,
): Promise<LoadedFederatedRevision | null> => {
  const statusArray = `{${statuses.join(",")}}`;
  const lockSql = lock ? sql`FOR UPDATE` : sql``;
  const [row] = await client<DbRow[]>`
    SELECT id::text, table_id::text, revision, status, diagnostics,
           created_by::text, published_by::text, created_at, updated_at, published_at,
           extract(epoch FROM updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions
    WHERE table_id = ${tableId}::uuid
      AND status = ANY(${statusArray}::text[])
    ORDER BY revision DESC
    LIMIT 1
    ${lockSql}
  `;
  return row ? loadRevision(client, row) : null;
};

export const getDraft = (tableId: string): Promise<LoadedFederatedRevision | null> => getRevisionByStatus(tableId, ["draft"]);

export const getCurrent = (tableId: string): Promise<LoadedFederatedRevision | null> =>
  getRevisionByStatus(tableId, ["active", "degraded"]);

const localizedDiagnostics = (diagnostics: FederatedDiagnostic[], locale?: string): FederatedDiagnostic[] => {
  const t = serviceMessagesFor(locale);
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: t.federatedDiagnostic({ code: diagnostic.code, fallback: diagnostic.message }),
  }));
};

export const getActive = async (tableId: string, locale?: string, client: SqlClient = sql): Promise<Result<LoadedFederatedRevision>> => {
  const t = serviceMessagesFor(locale);
  const current = await getRevisionByStatus(tableId, ["active", "degraded"], client);
  if (!current) return fail(err.badInput(t.combinedNoPublication));
  if (current.status === "degraded" || current.diagnostics.length > 0) {
    return fail(err.conflict(localizedDiagnostics(current.diagnostics, locale)[0]?.message ?? t.combinedDegraded));
  }
  if (current.sources.some((source) => source.revokedAt !== null)) {
    return fail(err.forbidden(t.combinedRevoked));
  }
  return ok(current);
};

export type FederatedRevisionScope = Array<{ tableId: string; revisionId: string; revisionToken: string }>;

/** Captures all active Combined-table revisions in one round-trip. Stored
 * tables are intentionally absent from the returned scope. */
export const captureRevisionScope = async (tableIds: string[]): Promise<FederatedRevisionScope> => {
  const uniqueTableIds = [...new Set(tableIds)];
  if (uniqueTableIds.length === 0) return [];
  const rows = await sql<Array<{ table_id: string; revision_id: string; revision_token: string }>>`
    SELECT table_id::text, id::text AS revision_id,
           extract(epoch FROM updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions
    WHERE table_id = ANY(${toPgUuidArray(uniqueTableIds)}::uuid[])
      AND status = 'active'
    ORDER BY table_id
  `;
  return rows.map((row) => ({
    tableId: row.table_id,
    revisionId: row.revision_id,
    revisionToken: row.revision_token,
  }));
};

/** Verifies a previously captured query scope in one round-trip. This is used
 * after relation/file expansion and between export pages, where one SQL
 * statement alone cannot protect the complete response. */
export const verifyRevisionScope = async (
  scope: FederatedRevisionScope,
  locale?: string,
  client: SqlClient = sql,
): Promise<Result<void>> => {
  const t = serviceMessagesFor(locale);
  if (scope.length === 0) return ok();
  const expected = new Map(scope.map((entry) => [entry.tableId, `${entry.revisionId}:${entry.revisionToken}`]));
  if (expected.size !== scope.length) return fail(err.internal(t.revisionScopeDuplicate));
  const rows = await client<Array<{ table_id: string; revision_id: string; revision_token: string }>>`
    SELECT table_id::text, id::text AS revision_id,
           extract(epoch FROM updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions
    WHERE table_id = ANY(${toPgUuidArray([...expected.keys()])}::uuid[])
      AND status = 'active'
  `;
  if (rows.length !== expected.size || rows.some((row) => expected.get(row.table_id) !== `${row.revision_id}:${row.revision_token}`)) {
    return fail(err.conflict(t.publicationChangedQuery));
  }
  return ok();
};

/**
 * Returns the source tables whose published data scope would be created or
 * broadened by the input. Existing unrevoked mappings can be retained or
 * removed without re-authorizing the persistent publication grant.
 */
export const sourceIdsRequiringAuthorization = (current: FederatedRevision | null, input: FederatedDraftInput): string[] => {
  const currentSources = new Map((current?.sources ?? []).map((source) => [source.sourceTableId, source]));
  const currentMappings = new Map(
    (current?.mappings ?? []).map((mapping) => [`${mapping.sourceTableId}:${mapping.targetFieldId}`, mapping]),
  );
  const required = new Set<string>();
  for (const sourceTableId of input.sourceTableIds) {
    const source = currentSources.get(sourceTableId);
    if (!source || source.revokedAt !== null) {
      required.add(sourceTableId);
      continue;
    }
    for (const mapping of input.mappings.filter((item) => item.sourceTableId === sourceTableId)) {
      const existing = currentMappings.get(`${sourceTableId}:${mapping.targetFieldId}`);
      if (!existing || existing.sourceFieldId !== mapping.sourceFieldId || !isDeepStrictEqual(existing.config, mapping.config ?? {})) {
        required.add(sourceTableId);
        break;
      }
    }
  }
  return [...required];
};

type TableInfo = {
  id: string;
  baseId: string;
  kind: "stored" | "federated";
  name: string;
  deletedAt: string | null;
  baseDeletedAt: string | null;
};

const loadTables = async (ids: string[], client: SqlClient): Promise<Map<string, TableInfo>> => {
  if (ids.length === 0) return new Map();
  const rows = await client<DbRow[]>`
    SELECT table_row.id::text, table_row.base_id::text, table_row.kind, table_row.name,
           table_row.deleted_at, base.deleted_at AS base_deleted_at
    FROM grids.tables table_row
    JOIN grids.bases base ON base.id = table_row.base_id
    WHERE table_row.id = ANY(${toPgUuidArray(ids)}::uuid[])
  `;
  return new Map(
    rows.map((row) => [
      row.id as string,
      {
        id: row.id as string,
        baseId: row.base_id as string,
        kind: row.kind === "federated" ? "federated" : "stored",
        name: row.name as string,
        deletedAt: nullableIso(row.deleted_at),
        baseDeletedAt: nullableIso(row.base_deleted_at),
      },
    ]),
  );
};

const loadFields = async (ids: string[], client: SqlClient): Promise<Map<string, Field>> => {
  if (ids.length === 0) return new Map();
  const rows = await client<DbRow[]>`
    SELECT *
    FROM grids.fields
    WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])
  `;
  return new Map(rows.map((row) => [row.id as string, mapFieldRow(row)]));
};

const selectOptions = (field: Field): { multiple: boolean; ids: Set<string> } => {
  const config = field.config as { multiple?: boolean; options?: Array<{ id?: unknown }> };
  return {
    multiple: config.multiple ?? false,
    ids: new Set((config.options ?? []).flatMap((option) => (typeof option.id === "string" ? [option.id] : []))),
  };
};

const mappingDiagnostic = (mapping: FederatedDraftInput["mappings"][number], code: string, message: string): FederatedDiagnostic => ({
  code,
  message,
  sourceTableId: mapping.sourceTableId,
  targetFieldId: mapping.targetFieldId,
  sourceFieldId: mapping.sourceFieldId,
});

const diagnosticsForTargetAudit = (diagnostics: FederatedDiagnostic[]): FederatedDiagnostic[] =>
  diagnostics.map(({ sourceTableId: _sourceTableId, sourceFieldId: _sourceFieldId, ...diagnostic }) => diagnostic);

const validateSelectMapping = (target: Field, source: Field, mapping: FederatedDraftInput["mappings"][number]): FederatedDiagnostic[] => {
  const targetOptions = selectOptions(target);
  const sourceOptions = selectOptions(source);
  if (targetOptions.multiple !== sourceOptions.multiple) {
    return [
      mappingDiagnostic(
        mapping,
        "select_cardinality_mismatch",
        `Mapped source field has incompatible select cardinality for "${target.name}"`,
      ),
    ];
  }
  const optionMap = (mapping.config?.optionMap ?? {}) as Record<string, unknown>;
  const diagnostics: FederatedDiagnostic[] = [];
  for (const sourceId of sourceOptions.ids) {
    const targetId = typeof optionMap[sourceId] === "string" ? (optionMap[sourceId] as string) : null;
    if (!targetId) {
      diagnostics.push(
        mappingDiagnostic(mapping, "select_option_unmapped", `A source option is not mapped to a canonical option for "${target.name}"`),
      );
      continue;
    }
    if (!targetOptions.ids.has(targetId)) {
      diagnostics.push(
        mappingDiagnostic(mapping, "select_option_unmapped", `A source option is not mapped to a canonical option for "${target.name}"`),
      );
    }
  }
  return diagnostics;
};

const validateCompatibleFields = (
  target: Field,
  source: Field,
  mapping: FederatedDraftInput["mappings"][number],
  sourceComputedOutput?: string,
  relationTargetCompatible = false,
): FederatedDiagnostic[] => {
  if (COMPUTED_TYPES.has(target.type)) {
    return [
      mappingDiagnostic(
        mapping,
        "computed_target_mapping",
        "Computed fields are defined on the combined table and cannot receive source mappings",
      ),
    ];
  }
  if (COMPUTED_TYPES.has(source.type)) {
    if (!sourceComputedOutput) {
      return [
        mappingDiagnostic(
          mapping,
          "computed_source_not_sql_stable",
          `Mapped computed source for "${target.name}" cannot be compiled to stable SQL`,
        ),
      ];
    }
    const targetOutput = outputSqlTypeForField(target);
    const compatible =
      (targetOutput === "numeric" && ["numeric", "decimal", "int"].includes(sourceComputedOutput)) ||
      (targetOutput === "datetime" && ["datetime", "timestamptz"].includes(sourceComputedOutput)) ||
      targetOutput === sourceComputedOutput;
    return compatible
      ? []
      : [
          mappingDiagnostic(
            mapping,
            "computed_source_type_mismatch",
            `Mapped computed source does not produce the SQL type required by "${target.name}"`,
          ),
        ];
  }
  if (target.type !== source.type) {
    return [
      mappingDiagnostic(mapping, "field_type_mismatch", `Mapped source field is not compatible with canonical field "${target.name}"`),
    ];
  }
  if (target.type === "date") {
    const targetTime = (target.config as { includeTime?: boolean }).includeTime ?? false;
    const sourceTime = (source.config as { includeTime?: boolean }).includeTime ?? false;
    if (targetTime !== sourceTime) {
      return [
        mappingDiagnostic(mapping, "date_precision_mismatch", `Mapped source field has incompatible date precision for "${target.name}"`),
      ];
    }
  }
  if (target.type === "percent") {
    const targetRange = (target.config as { range?: "percent" | "fraction" }).range ?? "percent";
    const sourceRange = (source.config as { range?: "percent" | "fraction" }).range ?? "percent";
    if (targetRange !== sourceRange) {
      return [
        mappingDiagnostic(mapping, "percent_range_mismatch", `Mapped source field uses an incompatible percent scale for "${target.name}"`),
      ];
    }
  }
  if (target.type === "select") return validateSelectMapping(target, source, mapping);
  if (target.type === "relation") {
    const targetConfig = target.config as { targetTableId?: string; cardinality?: "single" | "multiple" };
    const sourceConfig = source.config as { targetTableId?: string; cardinality?: "single" | "multiple" };
    const targetTableId = targetConfig.targetTableId;
    const sourceTableId = sourceConfig.targetTableId;
    if (!targetTableId || (targetTableId !== sourceTableId && !relationTargetCompatible)) {
      return [
        mappingDiagnostic(
          mapping,
          "relation_target_mismatch",
          `Mapped relation does not target the canonical relation table for "${target.name}"`,
        ),
      ];
    }
    if ((targetConfig.cardinality ?? "multiple") !== (sourceConfig.cardinality ?? "multiple")) {
      return [
        mappingDiagnostic(mapping, "relation_cardinality_mismatch", `Mapped relation has incompatible cardinality for "${target.name}"`),
      ];
    }
  }
  return [];
};

const relationTargetAcceptsSource = async (target: Field, source: Field, client: SqlClient): Promise<boolean> => {
  if (target.type !== "relation" || source.type !== "relation") return false;
  const targetTableId = (target.config as { targetTableId?: string }).targetTableId;
  const sourceTableId = (source.config as { targetTableId?: string }).targetTableId;
  if (!targetTableId || !sourceTableId) return false;
  if (targetTableId === sourceTableId) return true;
  const [row] = await client<{ matches: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM grids.tables target_table
      JOIN grids.federated_table_revisions revision
        ON revision.table_id = target_table.id
       AND revision.status = 'active'
      JOIN grids.federated_table_sources federated_source
        ON federated_source.revision_id = revision.id
       AND federated_source.source_table_id = ${sourceTableId}::uuid
       AND federated_source.revoked_at IS NULL
      WHERE target_table.id = ${targetTableId}::uuid
        AND target_table.kind = 'federated'
        AND target_table.deleted_at IS NULL
    ) AS matches
  `;
  return row?.matches ?? false;
};

type ValidationContext = {
  table: TableInfo;
  sourceTables: Map<string, TableInfo>;
  targetFields: Map<string, Field>;
  sourceFields: Map<string, Field>;
};

const validateInput = async (
  tableId: string,
  input: FederatedDraftInput,
  client: SqlClient,
): Promise<{ diagnostics: FederatedDiagnostic[]; context: ValidationContext | null }> => {
  const diagnostics: FederatedDiagnostic[] = [];
  const duplicateSourceIds = input.sourceTableIds.filter((id, index) => input.sourceTableIds.indexOf(id) !== index);
  if (duplicateSourceIds.length > 0) diagnostics.push({ code: "duplicate_source", message: "Each source table may only be added once" });
  if (input.sourceTableIds.length === 0)
    diagnostics.push({ code: "source_required", message: "Add at least one source table before publishing" });
  if (input.sourceTableIds.length > MAX_FEDERATED_SOURCES) {
    diagnostics.push({ code: "source_limit", message: `Combined tables support at most ${MAX_FEDERATED_SOURCES} source tables` });
  }

  const tableIds = [...new Set([tableId, ...input.sourceTableIds])];
  const tables = await loadTables(tableIds, client);
  const table = tables.get(tableId);
  if (!table || table.deletedAt || table.baseDeletedAt) {
    return { diagnostics: [{ code: "table_missing", message: "Combined table not found" }], context: null };
  }
  if (table.kind !== "federated")
    return { diagnostics: [{ code: "not_federated", message: "Table is not a combined table" }], context: null };

  const sourceTables = new Map<string, TableInfo>();
  for (const sourceTableId of input.sourceTableIds) {
    const source = tables.get(sourceTableId);
    if (!source || source.deletedAt || source.baseDeletedAt) {
      diagnostics.push({ code: "source_missing", message: "Source table or base is unavailable", sourceTableId });
      continue;
    }
    if (source.id === tableId) diagnostics.push({ code: "self_source", message: "A combined table cannot source itself", sourceTableId });
    if (source.kind !== "stored") {
      diagnostics.push({
        code: "nested_federation",
        message: "Combined tables cannot use another combined table as a source",
        sourceTableId,
      });
    }
    sourceTables.set(sourceTableId, source);
  }

  const targetFieldIds = [...new Set(input.mappings.map((mapping) => mapping.targetFieldId))];
  const sourceFieldIds = [...new Set(input.mappings.map((mapping) => mapping.sourceFieldId))];
  const [targetFields, sourceFields, targetFieldRows] = await Promise.all([
    loadFields(targetFieldIds, client),
    loadFields(sourceFieldIds, client),
    client<DbRow[]>`
      SELECT *
      FROM grids.fields
      WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL
    `,
  ]);
  const allTargetFields = targetFieldRows.map(mapFieldRow);
  const sourceFieldsByTable = new Map<string, Field[]>();
  if (input.sourceTableIds.length > 0) {
    const rows = await client<DbRow[]>`
      SELECT *
      FROM grids.fields
      WHERE table_id = ANY(${toPgUuidArray(input.sourceTableIds)}::uuid[])
        AND deleted_at IS NULL
    `;
    for (const row of rows) {
      const field = mapFieldRow(row);
      const fields = sourceFieldsByTable.get(field.tableId) ?? [];
      fields.push(field);
      sourceFieldsByTable.set(field.tableId, fields);
    }
  }
  const computedOutputs = new Map<string, string>();
  for (const fields of sourceFieldsByTable.values()) {
    const projections = [...(await buildComputedProjections(fields)), ...buildFormulaSqlProjections(fields)];
    for (const projection of projections) computedOutputs.set(projection.fieldId, projection.outputType);
  }
  if (allTargetFields.length > MAX_FEDERATED_FIELDS) {
    diagnostics.push({ code: "field_limit", message: `Combined tables support at most ${MAX_FEDERATED_FIELDS} canonical fields` });
  }
  const canonicalFormulaIds = new Set(buildFormulaSqlProjections(allTargetFields).map((projection) => projection.fieldId));
  for (const field of allTargetFields) {
    if (field.required || field.defaultValue !== null || field.indexed || field.uniqueConstraint) {
      diagnostics.push({
        code: "canonical_field_write_constraint",
        message: `Canonical field "${field.name}" cannot define write constraints, defaults, or storage indexes`,
        targetFieldId: field.id,
      });
    }
    if (field.type === "formula" && !canonicalFormulaIds.has(field.id)) {
      diagnostics.push({
        code: "canonical_formula_not_sql_stable",
        message: `Formula field "${field.name}" cannot be compiled to stable SQL`,
        targetFieldId: field.id,
      });
    }
    if (field.type === "lookup" || field.type === "rollup") {
      diagnostics.push({
        code: "canonical_computed_unsupported",
        message: `Combined tables do not support canonical ${field.type} fields; map a SQL-stable source field or use a formula instead`,
        targetFieldId: field.id,
      });
    }
  }

  const seenMappings = new Set<string>();
  for (const mapping of input.mappings) {
    const key = `${mapping.targetFieldId}:${mapping.sourceTableId}`;
    if (seenMappings.has(key)) {
      diagnostics.push(mappingDiagnostic(mapping, "duplicate_mapping", "A source table can map to each canonical field only once"));
      continue;
    }
    seenMappings.add(key);
    if (!sourceTables.has(mapping.sourceTableId)) {
      diagnostics.push(mappingDiagnostic(mapping, "mapping_source_missing", "Mapping references a table that is not an active source"));
      continue;
    }
    const target = targetFields.get(mapping.targetFieldId);
    const source = sourceFields.get(mapping.sourceFieldId);
    if (!target || target.deletedAt || target.tableId !== tableId) {
      diagnostics.push(mappingDiagnostic(mapping, "target_field_missing", "Canonical field not found on the combined table"));
      continue;
    }
    if (!source || source.deletedAt || source.tableId !== mapping.sourceTableId) {
      diagnostics.push(mappingDiagnostic(mapping, "source_field_missing", "Source field not found on the selected source table"));
      continue;
    }
    const relationCompatible = await relationTargetAcceptsSource(target, source, client);
    diagnostics.push(...validateCompatibleFields(target, source, mapping, computedOutputs.get(source.id), relationCompatible));
  }

  return { diagnostics, context: { table, sourceTables, targetFields, sourceFields } };
};

export const validateDraft = async (tableId: string, input: FederatedDraftInput, locale?: string): Promise<FederatedValidation> => {
  const resolved = await resolveDraftInput(tableId, input, sql, locale);
  if (!resolved.ok) return { valid: false, diagnostics: [{ code: "retained_source_invalid", message: resolved.error.message }] };
  const validation = await validateInput(tableId, resolved.data, sql);
  return { valid: validation.diagnostics.length === 0, diagnostics: localizedDiagnostics(validation.diagnostics, locale) };
};

const draftRow = async (tableId: string, client: SqlClient, lock = false): Promise<DbRow | null> => {
  const lockSql = lock ? sql`FOR UPDATE` : sql``;
  const [row] = await client<DbRow[]>`
    SELECT id::text, table_id::text, revision, status, diagnostics,
           created_by::text, published_by::text, created_at, updated_at, published_at,
           extract(epoch FROM updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions
    WHERE table_id = ${tableId}::uuid AND status = 'draft'
    ${lockSql}
  `;
  return row ?? null;
};

const writeDraftRows = async (
  revisionId: string,
  input: FederatedDraftInput,
  diagnostics: FederatedDiagnostic[],
  client: SqlClient,
): Promise<void> => {
  await client`DELETE FROM grids.federated_table_sources WHERE revision_id = ${revisionId}::uuid`;
  if (input.sourceTableIds.length > 0) {
    await client`
      INSERT INTO grids.federated_table_sources (revision_id, source_table_id, position)
      SELECT ${revisionId}::uuid, source_table_id, position::int
      FROM jsonb_to_recordset(${input.sourceTableIds.map((sourceTableId, position) => ({
        source_table_id: sourceTableId,
        position,
      }))}::jsonb)
        AS source(source_table_id uuid, position int)
    `;
  }
  if (input.mappings.length > 0) {
    await client`
      INSERT INTO grids.federated_field_mappings (
        revision_id, target_field_id, source_table_id, source_field_id, config
      )
      SELECT ${revisionId}::uuid, target_field_id, source_table_id, source_field_id, config
      FROM jsonb_to_recordset(${input.mappings.map((mapping) => ({
        target_field_id: mapping.targetFieldId,
        source_table_id: mapping.sourceTableId,
        source_field_id: mapping.sourceFieldId,
        config: mapping.config ?? {},
      }))}::jsonb) AS mapping(
        target_field_id uuid,
        source_table_id uuid,
        source_field_id uuid,
        config jsonb
      )
    `;
  }
  await client`
    UPDATE grids.federated_table_revisions
    SET diagnostics = ${diagnostics}::jsonb, updated_at = now()
    WHERE id = ${revisionId}::uuid
  `;
};

const resolveDraftInput = async (
  tableId: string,
  input: FederatedDraftInput,
  client: SqlClient = sql,
  locale?: string,
): Promise<Result<FederatedDraftInput>> => {
  const t = serviceMessagesFor(locale);
  const retainedIds = [...new Set(input.retainedSourceIds ?? [])];
  if (retainedIds.length === 0) return ok({ sourceTableIds: input.sourceTableIds, mappings: input.mappings });
  const row = await draftRow(tableId, client);
  if (!row) return fail(err.notFound(t.combinedDraft));
  const draft = await loadRevision(client, row);
  const retained = draft.sources.filter((source) => retainedIds.includes(source.id));
  if (retained.length !== retainedIds.length) return fail(err.badInput(t.retainedSourceInvalid));
  const explicitSourceIds = new Set(input.sourceTableIds);
  const retainedTableIds = retained.map((source) => source.sourceTableId).filter((sourceId) => !explicitSourceIds.has(sourceId));
  const retainedTableIdSet = new Set(retainedTableIds);
  return ok({
    sourceTableIds: [...input.sourceTableIds, ...retainedTableIds],
    mappings: [...input.mappings, ...draft.mappings.filter((mapping) => retainedTableIdSet.has(mapping.sourceTableId))],
  });
};

export const updateDraft = async (
  tableId: string,
  input: FederatedDraftInput,
  expectedDraftToken: string,
  actorId: string | null,
  authorization: FederatedPublicationAuthorization | null,
  locale?: string,
): Promise<Result<LoadedFederatedRevision>> => {
  const t = serviceMessagesFor(locale);
  const result = await sql.begin(async (tx): Promise<Result<LoadedFederatedRevision>> => {
    const initialRow = await draftRow(tableId, tx);
    if (!initialRow) return fail(err.notFound(t.combinedDraft));
    const initialResolved = await resolveDraftInput(tableId, input, tx, locale);
    if (!initialResolved.ok) return fail(initialResolved.error);
    await lockFederatedSchemaTables(await schemaTableIdsForInput(tableId, initialResolved.data, tx), tx);

    const row = await draftRow(tableId, tx, true);
    if (!row) return fail(err.notFound(t.combinedDraft));
    if (row.revision_token !== expectedDraftToken) {
      return fail(err.conflict(t.draftChangedSave));
    }
    const resolved = await resolveDraftInput(tableId, input, tx, locale);
    if (!resolved.ok) return fail(resolved.error);
    const validation = await validateInput(tableId, resolved.data, tx);
    if (!validation.context)
      return fail(err.badInput(localizedDiagnostics(validation.diagnostics, locale)[0]?.message ?? t.combinedInvalid));
    if (authorization) {
      const baseIds = [
        validation.context.table.baseId,
        ...input.sourceTableIds.flatMap((sourceTableId) => {
          const source = validation.context?.sourceTables.get(sourceTableId);
          return source ? [source.baseId] : [];
        }),
      ];
      await lockBaseAuthorization(baseIds, tx);
      for (const baseId of [...new Set(baseIds)]) {
        if (!(await hasTransactionalBaseAdmin(baseId, authorization, tx))) {
          return fail(err.forbidden(t.draftAdminLost));
        }
      }
    }
    await writeDraftRows(row.id as string, resolved.data, validation.diagnostics, tx);
    await logAudit(
      {
        baseId: validation.context.table.baseId,
        tableId,
        userId: actorId,
        action: "federation.draft.updated",
        diff: {
          revision: { old: row.revision, new: row.revision },
          diagnostics: { old: null, new: diagnosticsForTargetAudit(validation.diagnostics) },
        },
      },
      tx,
    );
    const updated = await draftRow(tableId, tx);
    if (!updated) return fail(err.internal(t.draftDisappeared));
    return ok(await loadRevision(tx, updated));
  });
  if (result.ok) {
    await emitTableMetadataEvent(tableId, {
      type: "table.updated",
      resource: { kind: "table", id: tableId },
      actorId,
    });
    await refreshRelationDependents([tableId], actorId);
  }
  return result;
};

const revisionInput = (revision: FederatedRevision): FederatedDraftInput => ({
  sourceTableIds: revision.sources.map((source) => source.sourceTableId),
  mappings: revision.mappings.map((mapping) => ({
    targetFieldId: mapping.targetFieldId,
    sourceTableId: mapping.sourceTableId,
    sourceFieldId: mapping.sourceFieldId,
    config: mapping.config,
  })),
});

const schemaTableIdsForInput = async (tableId: string, input: FederatedDraftInput, client: SqlClient): Promise<string[]> => {
  const fieldIds = [...new Set(input.mappings.flatMap((mapping) => [mapping.targetFieldId, mapping.sourceFieldId]))];
  const relationTargets =
    fieldIds.length === 0
      ? []
      : await client<Array<{ table_id: string }>>`
          SELECT DISTINCT config->>'targetTableId' AS table_id
          FROM grids.fields
          WHERE id = ANY(${toPgUuidArray(fieldIds)}::uuid[])
            AND type = 'relation'
            AND config->>'targetTableId' IS NOT NULL
        `;
  return [tableId, ...input.sourceTableIds, ...relationTargets.map((target) => target.table_id)];
};

export const publishDraft = async (
  tableId: string,
  actorId: string | null,
  authorization: FederatedPublicationAuthorization,
  expected: {
    draftId: string;
    draftToken: string;
    currentId: string | null;
    currentToken: string | null;
  },
  locale?: string,
): Promise<Result<LoadedFederatedRevision>> => {
  const t = serviceMessagesFor(locale);
  const result = await sql.begin(async (tx): Promise<Result<LoadedFederatedRevision>> => {
    const initialRow = await draftRow(tableId, tx);
    if (!initialRow) return fail(err.notFound(t.combinedDraft));
    const initialDraft = await loadRevision(tx, initialRow);
    await lockFederatedSchemaTables(await schemaTableIdsForInput(tableId, revisionInput(initialDraft), tx), tx);

    const row = await draftRow(tableId, tx, true);
    if (!row) return fail(err.notFound(t.combinedDraft));
    const draft = await loadRevision(tx, row);
    if (draft.id !== expected.draftId || draft.revisionToken !== expected.draftToken) {
      return fail(err.conflict(t.draftChangedPublish));
    }
    const currentRow = await getRevisionByStatus(tableId, ["active", "degraded"], tx, true);
    if (currentRow?.id !== expected.currentId || (currentRow?.revisionToken ?? null) !== expected.currentToken) {
      return fail(err.conflict(t.publicationChangedPublish));
    }
    const input = revisionInput(draft);
    const sourcesRequiringAuthorization = new Set(sourceIdsRequiringAuthorization(currentRow, input));
    const validation = await validateInput(tableId, input, tx);
    if (!validation.context)
      return fail(err.badInput(localizedDiagnostics(validation.diagnostics, locale)[0]?.message ?? t.combinedInvalid));
    await lockBaseAuthorization(
      [validation.context.table.baseId, ...[...validation.context.sourceTables.values()].map((source) => source.baseId)],
      tx,
    );
    if (!(await hasTransactionalBaseAdmin(validation.context.table.baseId, authorization, tx))) {
      return fail(err.forbidden(t.combinedBaseAdminLost));
    }
    const sourceBaseRows = await tx<Array<{ source_table_id: string; base_id: string }>>`
      SELECT source.id::text AS source_table_id, source.base_id::text
      FROM grids.tables source
      JOIN grids.bases source_base
        ON source_base.id = source.base_id
       AND source_base.deleted_at IS NULL
      WHERE source.id = ANY(${toPgUuidArray(input.sourceTableIds)}::uuid[])
        AND source.kind = 'stored'
        AND source.deleted_at IS NULL
      FOR SHARE OF source, source_base
    `;
    if (sourceBaseRows.length !== input.sourceTableIds.length) {
      return fail(err.badInput(t.sourcesUnavailable));
    }
    for (const source of sourceBaseRows) {
      if (!sourcesRequiringAuthorization.has(source.source_table_id)) continue;
      if (!(await hasTransactionalBaseAdmin(source.base_id, authorization, tx))) {
        return fail(err.forbidden(t.sourceBaseAdminLost));
      }
    }
    if (validation.diagnostics.length > 0) {
      await tx`
        UPDATE grids.federated_table_revisions
        SET diagnostics = ${validation.diagnostics}::jsonb, updated_at = now()
        WHERE id = ${draft.id}::uuid
      `;
      return fail(
        err.badInput(
          localizedDiagnostics(validation.diagnostics, locale)
            .map((diagnostic) => diagnostic.message)
            .join("; "),
        ),
      );
    }

    await tx`
      UPDATE grids.federated_table_revisions
      SET status = 'superseded', updated_at = now()
      WHERE table_id = ${tableId}::uuid AND status IN ('active', 'degraded')
    `;
    await tx`
      UPDATE grids.federated_table_revisions
      SET status = 'active', diagnostics = '[]'::jsonb,
          published_by = ${actorId}::uuid, published_at = now(), updated_at = now()
      WHERE id = ${draft.id}::uuid
    `;
    await tx`
      UPDATE grids.federated_table_sources draft_source
      SET authorized_by = CASE
            WHEN draft_source.source_table_id = ANY(${toPgUuidArray([...sourcesRequiringAuthorization])}::uuid[])
              THEN ${actorId}::uuid
            ELSE current_source.authorized_by
          END,
          authorized_at = CASE
            WHEN draft_source.source_table_id = ANY(${toPgUuidArray([...sourcesRequiringAuthorization])}::uuid[])
              THEN now()
            ELSE current_source.authorized_at
          END,
          revoked_by = NULL,
          revoked_at = NULL
      FROM grids.federated_table_sources current_source
      WHERE draft_source.revision_id = ${draft.id}::uuid
        AND current_source.revision_id = ${currentRow?.id ?? draft.id}::uuid
        AND current_source.source_table_id = draft_source.source_table_id
    `;
    if (sourcesRequiringAuthorization.size > 0) {
      await tx`
        UPDATE grids.federated_table_sources
        SET authorized_by = ${actorId}::uuid, authorized_at = now(), revoked_by = NULL, revoked_at = NULL
        WHERE revision_id = ${draft.id}::uuid
          AND source_table_id = ANY(${toPgUuidArray([...sourcesRequiringAuthorization])}::uuid[])
      `;
    }

    const nextRevision = draft.revision + 1;
    const [next] = await tx<{ id: string }[]>`
      INSERT INTO grids.federated_table_revisions (table_id, revision, status, created_by)
      VALUES (${tableId}::uuid, ${nextRevision}, 'draft', ${actorId}::uuid)
      RETURNING id::text
    `;
    if (!next) return fail(err.internal(t.nextDraftFailed));
    await writeDraftRows(next.id, input, [], tx);

    await logAudit(
      {
        baseId: validation.context.table.baseId,
        tableId,
        userId: actorId,
        action: "federation.published",
        diff: { revision: { old: null, new: draft.revision }, sourceCount: { old: null, new: draft.sources.length } },
      },
      tx,
    );
    const active = await getRevisionByStatus(tableId, ["active"], tx);
    return active ? ok(active) : fail(err.internal(t.publicationLoadFailed));
  });
  if (result.ok) {
    await emitTableMetadataEvent(tableId, {
      type: "table.updated",
      resource: { kind: "table", id: tableId },
      actorId,
    });
    await refreshRelationDependents([tableId], actorId);
  }
  return result;
};

export const revokeSource = async (
  targetTableId: string,
  sourceTableId: string,
  actorId: string | null,
  authorization: FederatedPublicationAuthorization,
  locale?: string,
): Promise<Result<void>> => {
  const t = serviceMessagesFor(locale);
  const result = await sql.begin(async (tx): Promise<Result<void>> => {
    const [row] = await tx<{ revision_id: string; base_id: string; source_base_id: string }[]>`
      SELECT r.id::text AS revision_id, target.base_id::text AS base_id, source_table.base_id::text AS source_base_id
      FROM grids.federated_table_revisions r
      JOIN grids.federated_table_sources source ON source.revision_id = r.id
      JOIN grids.tables target ON target.id = r.table_id
      JOIN grids.tables source_table ON source_table.id = source.source_table_id
      WHERE r.table_id = ${targetTableId}::uuid
        AND source.source_table_id = ${sourceTableId}::uuid
        AND r.status IN ('active', 'degraded')
      FOR UPDATE OF r, source
    `;
    if (!row) return fail(err.notFound(t.publishedSource));
    await lockBaseAuthorization([row.source_base_id], tx);
    if (!(await hasTransactionalBaseAdmin(row.source_base_id, authorization, tx))) {
      return fail(err.forbidden(t.sourceBaseAdminLostSingle));
    }
    const diagnostic: FederatedDiagnostic = {
      code: "source_access_revoked",
      message: "Access to a published source table has been revoked",
      sourceTableId,
    };
    await tx`
      UPDATE grids.federated_table_sources
      SET revoked_by = ${actorId}::uuid, revoked_at = now()
      WHERE revision_id = ${row.revision_id}::uuid AND source_table_id = ${sourceTableId}::uuid
    `;
    await tx`
      UPDATE grids.federated_table_revisions
      SET status = 'degraded', diagnostics = ${[diagnostic]}::jsonb, updated_at = now()
      WHERE id = ${row.revision_id}::uuid
    `;
    await logAudit(
      {
        baseId: row.base_id,
        tableId: targetTableId,
        userId: actorId,
        action: "federation.source.revoked",
        diff: { sourceAccess: { old: "authorized", new: "revoked" } },
      },
      tx,
    );
    return ok();
  });
  if (result.ok) {
    await emitTableMetadataEvent(targetTableId, {
      type: "table.updated",
      resource: { kind: "table", id: targetTableId },
      actorId,
    });
    await refreshRelationDependents([targetTableId], actorId);
  }
  return result;
};

export const listPublicationsForSource = async (sourceTableId: string): Promise<FederatedSourcePublication[]> => {
  const rows = await sql<
    Array<{
      target_base_id: string;
      target_base_short_id: string;
      target_base_name: string;
      target_table_id: string;
      target_table_short_id: string;
      target_table_name: string;
      revision: number;
      status: "active" | "degraded";
      published_at: Date | string | null;
      revoked_at: Date | string | null;
      source_field_id: string | null;
      source_field_name: string | null;
      target_field_id: string | null;
      target_field_name: string | null;
      target_field_type: string | null;
    }>
  >`
    SELECT target_base.id::text AS target_base_id,
           target_base.short_id AS target_base_short_id,
           target_base.name AS target_base_name,
           target.id::text AS target_table_id,
           target.short_id AS target_table_short_id,
           target.name AS target_table_name,
           revision.revision,
           revision.status,
           revision.published_at,
           source.revoked_at,
           source_field.id::text AS source_field_id,
           source_field.name AS source_field_name,
           target_field.id::text AS target_field_id,
           target_field.name AS target_field_name,
           target_field.type AS target_field_type
    FROM grids.federated_table_revisions revision
    JOIN grids.federated_table_sources source ON source.revision_id = revision.id
    JOIN grids.tables target ON target.id = revision.table_id
    JOIN grids.bases target_base ON target_base.id = target.base_id
    LEFT JOIN grids.federated_field_mappings mapping
      ON mapping.revision_id = revision.id
     AND mapping.source_table_id = source.source_table_id
    LEFT JOIN grids.fields source_field ON source_field.id = mapping.source_field_id
    LEFT JOIN grids.fields target_field ON target_field.id = mapping.target_field_id
    WHERE source.source_table_id = ${sourceTableId}::uuid
      AND revision.status IN ('active', 'degraded')
      AND target.deleted_at IS NULL
      AND target_base.deleted_at IS NULL
    ORDER BY target.name, target.id, target_field.position NULLS LAST
  `;

  const publications = new Map<string, FederatedSourcePublication>();
  for (const row of rows) {
    let publication = publications.get(row.target_table_id);
    if (!publication) {
      publication = {
        targetBaseId: row.target_base_id,
        targetBaseShortId: row.target_base_short_id,
        targetBaseName: row.target_base_name,
        targetTableId: row.target_table_id,
        targetTableShortId: row.target_table_short_id,
        targetTableName: row.target_table_name,
        revision: row.revision,
        status: row.status,
        publishedAt: nullableIso(row.published_at),
        revokedAt: nullableIso(row.revoked_at),
        mappings: [],
      };
      publications.set(row.target_table_id, publication);
    }
    if (row.source_field_id && row.source_field_name && row.target_field_id && row.target_field_name && row.target_field_type) {
      publication.mappings.push({
        sourceFieldId: row.source_field_id,
        sourceFieldName: row.source_field_name,
        targetFieldId: row.target_field_id,
        targetFieldName: row.target_field_name,
        targetFieldType: row.target_field_type,
      });
    }
  }
  return [...publications.values()];
};

const refreshRevision = async (
  revision: FederatedRevision,
  actorId: string | null,
  client: SqlClient,
): Promise<{ tableId: string; changed: boolean }> => {
  const validation = await validateInput(revision.tableId, revisionInput(revision), client);
  const revokedDiagnostics = revision.sources
    .filter((source) => source.revokedAt !== null)
    .map<FederatedDiagnostic>((source) => ({
      code: "source_access_revoked",
      message: "Access to a published source table has been revoked",
      sourceTableId: source.sourceTableId,
    }));
  const diagnostics = [...validation.diagnostics, ...revokedDiagnostics];
  if (revision.status === "draft") {
    await client`
      UPDATE grids.federated_table_revisions
      SET diagnostics = ${diagnostics}::jsonb, updated_at = now()
      WHERE id = ${revision.id}::uuid
    `;
    return { tableId: revision.tableId, changed: JSON.stringify(revision.diagnostics) !== JSON.stringify(diagnostics) };
  }
  const nextStatus: FederatedRevisionStatus = diagnostics.length > 0 ? "degraded" : "active";
  const changed = revision.status !== nextStatus || JSON.stringify(revision.diagnostics) !== JSON.stringify(diagnostics);
  if (!changed) return { tableId: revision.tableId, changed: false };
  await client`
    UPDATE grids.federated_table_revisions
    SET status = ${nextStatus}, diagnostics = ${diagnostics}::jsonb, updated_at = now()
    WHERE id = ${revision.id}::uuid
  `;
  if (validation.context) {
    await logAudit(
      {
        baseId: validation.context.table.baseId,
        tableId: revision.tableId,
        userId: actorId,
        action: nextStatus === "degraded" ? "federation.degraded" : "federation.repaired",
        diff: {
          diagnostics: {
            old: diagnosticsForTargetAudit(revision.diagnostics),
            new: diagnosticsForTargetAudit(diagnostics),
          },
        },
      },
      client,
    );
  }
  return { tableId: revision.tableId, changed: true };
};

const refreshRevisionRows = async (rows: DbRow[], actorId: string | null, schemaTableIds: readonly string[] = []): Promise<string[]> => {
  const changed = await sql.begin(async (tx) => {
    await lockFederatedSchemaTables(schemaTableIds, tx);
    const tableIds = new Set<string>();
    const revisionIds = [...new Set(rows.map((row) => row.id as string))].sort();
    for (const revisionId of revisionIds) {
      const [row] = await tx<DbRow[]>`
        SELECT id::text, table_id::text, revision, status, diagnostics,
               created_by::text, published_by::text, created_at, updated_at, published_at,
               extract(epoch FROM updated_at)::numeric::text AS revision_token
        FROM grids.federated_table_revisions
        WHERE id = ${revisionId}::uuid
          AND status IN ('draft', 'active', 'degraded')
        FOR UPDATE
      `;
      if (!row) continue;
      const revision = await loadRevision(tx, row);
      const refreshed = await refreshRevision(revision, actorId, tx);
      if (refreshed.changed) tableIds.add(refreshed.tableId);
    }
    return [...tableIds];
  });
  await Promise.all(
    changed.map((tableId) =>
      emitTableMetadataEvent(tableId, {
        type: "table.updated",
        resource: { kind: "table", id: tableId },
        actorId,
      }),
    ),
  );
  return [...changed];
};

const refreshRelationDependents = async (targetTableIds: string[], actorId: string | null): Promise<void> => {
  const visited = new Set(targetTableIds);
  let pending = [...visited];
  while (pending.length > 0) {
    const rows = await sql<DbRow[]>`
      SELECT DISTINCT revision.id::text, revision.table_id::text, revision.revision, revision.status,
             revision.diagnostics, revision.created_by::text, revision.published_by::text,
             revision.created_at, revision.updated_at, revision.published_at,
             extract(epoch FROM revision.updated_at)::numeric::text AS revision_token
      FROM grids.federated_table_revisions revision
      JOIN grids.fields target_field
        ON target_field.table_id = revision.table_id
       AND target_field.type = 'relation'
       AND target_field.deleted_at IS NULL
      WHERE target_field.config->>'targetTableId' = ANY(${sql.array(pending, "TEXT")}::text[])
        AND revision.status IN ('draft', 'active', 'degraded')
      ORDER BY revision.table_id::text, revision.revision
    `;
    const changed = await refreshRevisionRows(rows, actorId, pending);
    pending = changed.filter((tableId) => {
      if (visited.has(tableId)) return false;
      visited.add(tableId);
      return true;
    });
  }
};

export const refreshForField = async (fieldId: string, actorId: string | null): Promise<string[]> => {
  const [field] = await sql<Array<{ table_id: string }>>`
    SELECT table_id::text
    FROM grids.fields
    WHERE id = ${fieldId}::uuid
  `;
  const rows = await sql<DbRow[]>`
    SELECT DISTINCT revision.id::text, revision.table_id::text, revision.revision, revision.status,
           revision.diagnostics, revision.created_by::text, revision.published_by::text,
           revision.created_at, revision.updated_at, revision.published_at,
           extract(epoch FROM revision.updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions revision
    JOIN grids.federated_field_mappings mapping ON mapping.revision_id = revision.id
    WHERE (mapping.target_field_id = ${fieldId}::uuid OR mapping.source_field_id = ${fieldId}::uuid)
      AND revision.status IN ('draft', 'active', 'degraded')
    ORDER BY revision.table_id::text, revision.revision
  `;
  const changed = await refreshRevisionRows(rows, actorId, field ? [field.table_id] : []);
  await refreshRelationDependents(changed, actorId);
  return changed;
};

/** Closes the interval between a schema commit and full compatibility
 * validation. The changed table may be a physical source or the canonical
 * Combined target. Readers fail closed until refreshForTableSchemaChange has
 * revalidated the publication. */
const degradeForTableSchemaChanges = async (tableIds: readonly string[], actorId: string | null, client: SqlClient): Promise<void> => {
  const changedTableIds = [...new Set(tableIds)];
  if (changedTableIds.length === 0) return;
  await lockFederatedSchemaTables(changedTableIds, client);
  const rows = await client<Array<{ id: string; table_id: string; base_id: string; diagnostics: unknown }>>`
    WITH RECURSIVE seed_tables(table_id) AS (
      SELECT unnest(${toPgUuidArray(changedTableIds)}::uuid[])
      UNION
      SELECT revision.table_id
      FROM grids.federated_table_revisions revision
      WHERE revision.status = 'active'
        AND EXISTS (
          SELECT 1
          FROM grids.federated_table_sources source
          WHERE source.revision_id = revision.id
            AND source.source_table_id = ANY(${toPgUuidArray(changedTableIds)}::uuid[])
        )
    ), affected_tables(table_id) AS (
      SELECT table_id FROM seed_tables
      UNION
      SELECT revision.table_id
      FROM grids.federated_table_revisions revision
      JOIN grids.fields relation_field
        ON relation_field.table_id = revision.table_id
       AND relation_field.type = 'relation'
       AND relation_field.deleted_at IS NULL
      JOIN affected_tables affected
        ON relation_field.config->>'targetTableId' = affected.table_id::text
      WHERE revision.status = 'active'
    )
    UPDATE grids.federated_table_revisions revision
    SET status = 'degraded',
        diagnostics = ${[
          {
            code: "federation_schema_changing",
            message: "A source or canonical table schema changed and is being revalidated",
          },
        ]}::jsonb,
        updated_at = now()
    FROM grids.tables target
    WHERE target.id = revision.table_id
      AND revision.status = 'active'
      AND revision.table_id IN (SELECT affected.table_id FROM affected_tables affected)
    RETURNING revision.id::text, revision.table_id::text, target.base_id::text, revision.diagnostics
  `;
  for (const row of rows) {
    await logAudit(
      {
        baseId: row.base_id,
        tableId: row.table_id,
        userId: actorId,
        action: "federation.revalidating",
        diff: {
          diagnostics: {
            old: diagnosticsForTargetAudit(parseJsonbRow<FederatedDiagnostic[]>(row.diagnostics, [])),
            new: "federation_schema_changing",
          },
        },
      },
      client,
    );
  }
};

export const degradeForTableSchemaChange = async (tableId: string, actorId: string | null, client: SqlClient): Promise<void> =>
  degradeForTableSchemaChanges([tableId], actorId, client);

export const refreshForTableSchemaChange = async (tableId: string, actorId: string | null): Promise<string[]> => {
  const rows = await sql<DbRow[]>`
    SELECT DISTINCT revision.id::text, revision.table_id::text, revision.revision, revision.status,
           revision.diagnostics, revision.created_by::text, revision.published_by::text,
           revision.created_at, revision.updated_at, revision.published_at,
           extract(epoch FROM revision.updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions revision
    WHERE (
        revision.table_id = ${tableId}::uuid
        OR EXISTS (
          SELECT 1
          FROM grids.federated_table_sources source
          WHERE source.revision_id = revision.id
            AND source.source_table_id = ${tableId}::uuid
        )
      )
      AND revision.status IN ('draft', 'active', 'degraded')
    ORDER BY revision.table_id::text, revision.revision
  `;
  const changed = await refreshRevisionRows(rows, actorId, [tableId]);
  await refreshRelationDependents([tableId, ...changed], actorId);
  return changed;
};

export const refreshForSourceTable = async (sourceTableId: string, actorId: string | null): Promise<string[]> => {
  const rows = await sql<DbRow[]>`
    SELECT DISTINCT revision.id::text, revision.table_id::text, revision.revision, revision.status,
           revision.diagnostics, revision.created_by::text, revision.published_by::text,
           revision.created_at, revision.updated_at, revision.published_at,
           extract(epoch FROM revision.updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions revision
    JOIN grids.federated_table_sources source ON source.revision_id = revision.id
    WHERE source.source_table_id = ${sourceTableId}::uuid
      AND revision.status IN ('draft', 'active', 'degraded')
    ORDER BY revision.table_id::text, revision.revision
  `;
  const changed = await refreshRevisionRows(rows, actorId, [sourceTableId]);
  await refreshRelationDependents(changed, actorId);
  return changed;
};

export const refreshForSourceBase = async (sourceBaseId: string, actorId: string | null): Promise<string[]> => {
  const sourceTables = await sql<Array<{ id: string }>>`
    SELECT id::text
    FROM grids.tables
    WHERE base_id = ${sourceBaseId}::uuid
    ORDER BY id
  `;
  const rows = await sql<DbRow[]>`
    SELECT DISTINCT revision.id::text, revision.table_id::text, revision.revision, revision.status,
           revision.diagnostics, revision.created_by::text, revision.published_by::text,
           revision.created_at, revision.updated_at, revision.published_at,
           extract(epoch FROM revision.updated_at)::numeric::text AS revision_token
    FROM grids.federated_table_revisions revision
    JOIN grids.tables target_table ON target_table.id = revision.table_id
    WHERE (
        target_table.base_id = ${sourceBaseId}::uuid
        OR EXISTS (
          SELECT 1
          FROM grids.federated_table_sources source
          JOIN grids.tables source_table ON source_table.id = source.source_table_id
          WHERE source.revision_id = revision.id
            AND source_table.base_id = ${sourceBaseId}::uuid
        )
      )
      AND revision.status IN ('draft', 'active', 'degraded')
    ORDER BY revision.table_id::text, revision.revision
  `;
  const changed = await refreshRevisionRows(
    rows,
    actorId,
    sourceTables.map((table) => table.id),
  );
  await refreshRelationDependents([...sourceTables.map((table) => table.id), ...changed], actorId);
  return changed;
};

export const degradeForSourceBaseChange = async (sourceBaseId: string, actorId: string | null, client: SqlClient): Promise<void> => {
  const sourceTables = await client<Array<{ id: string }>>`
    SELECT id::text
    FROM grids.tables
    WHERE base_id = ${sourceBaseId}::uuid
    ORDER BY id
  `;
  await degradeForTableSchemaChanges(
    sourceTables.map((table) => table.id),
    actorId,
    client,
  );
};
