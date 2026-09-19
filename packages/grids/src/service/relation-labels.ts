import { sql } from "bun";
import type { FilterTree } from "../contracts";
import { compileFilter, renderClause } from "./filter-compiler";
import type { DslSqlFederatedRecordSource } from "../query-dsl/sql-compiler-types";
import { assertFederatedPublication, buildDslSqlRecordSource, buildFederatedFieldSqlMap } from "../query-dsl/sql-record-source";
import type { SqlClient } from "./audit";
import { applyComputedProjections, buildFormulaSqlProjections } from "./computed-projections";
import { listByTable as listFields } from "./fields";
import { storedLocalCalculationSqlMap } from "./local-calculation-storage";
import { liveRecordParentJoinSql } from "./parent-checks";
import { applyFinalizedComputedAccess, mapRecordCalculationData } from "./record-persistence";
import { type ExpansionViewer, resolveReadableTableIds } from "./relation-access";
import { enrichRecordsWithFormulas } from "./relation-formulas";
import { collectRelationTargetIds, loadRelationTargetsBatch, relationLabelFields } from "./relation-targets";
import { get as getTable } from "./tables";
import type { Field, GridRecord } from "./types";

export { relationLabelFields } from "./relation-targets";

type DbRow = Record<string, unknown>;
const LABEL_TEXT_TYPES = new Set(["text"]);

const formatLabelPart = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatLabelPart).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.label === "string") return object.label;
    if (typeof object.amount === "string") return object.amount;
    return "";
  }
  return String(value);
};

const resolveLabelsByTargetTable = async (
  idsByTargetTable: Map<string, Set<string>>,
  authorizedTableIds?: ReadonlySet<string>,
  labelFieldIdsByTableId?: ReadonlyMap<string, readonly string[]>,
  client?: SqlClient,
  viewer?: ExpansionViewer,
): Promise<Record<string, string>> => {
  const labels: Record<string, string> = {};
  const targetsByTable = await loadRelationTargetsBatch(idsByTargetTable, authorizedTableIds, labelFieldIdsByTableId, client, viewer);
  for (const targets of targetsByTable.values()) {
    for (const record of targets.records) {
      const parts = targets.fields.map((field) => formatLabelPart(record.data[field.id])).filter((part) => part.length > 0);
      labels[record.id] = parts.length > 0 ? parts.join(" · ") : "Untitled record";
    }
  }
  return labels;
};

const visibleTargets = async (
  idsByTargetTable: Map<string, Set<string>>,
  viewer?: ExpansionViewer,
  client?: SqlClient,
): Promise<{ ids: Map<string, Set<string>>; authorizedTableIds?: ReadonlySet<string> }> => {
  if (!viewer) return { ids: idsByTargetTable };
  const authorizedTableIds = await resolveReadableTableIds(idsByTargetTable.keys(), viewer, client);
  return { ids: new Map([...idsByTargetTable].filter(([tableId]) => authorizedTableIds.has(tableId))), authorizedTableIds };
};

export const buildRelationLabelCache = async (
  records: GridRecord[],
  fields: Field[],
  viewer?: ExpansionViewer,
): Promise<Record<string, string>> => {
  const idsByTargetTable = await collectRelationTargetIds(records, fields);
  const visible = await visibleTargets(idsByTargetTable, viewer);
  return resolveLabelsByTargetTable(visible.ids, visible.authorizedTableIds, undefined, undefined, viewer);
};

export const buildPinnedRelationLabelCache = async (
  records: GridRecord[],
  fields: Field[],
  labelFieldIdsByTableId: ReadonlyMap<string, readonly string[]>,
  viewer: ExpansionViewer,
): Promise<Record<string, string>> => {
  const idsByTargetTable = await collectRelationTargetIds(records, fields);
  const visible = await visibleTargets(idsByTargetTable, viewer);
  return resolveLabelsByTargetTable(visible.ids, visible.authorizedTableIds, labelFieldIdsByTableId, undefined, viewer);
};

export const buildLabelCacheForGroupedKeys = async (
  buckets: Array<{ keys: unknown[] }>,
  groupByFieldIds: string[],
  fields: Field[],
  viewer?: ExpansionViewer,
): Promise<Record<string, string>> => {
  if (buckets.length === 0) return {};
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const idsByTargetTable = new Map<string, Set<string>>();
  for (let index = 0; index < groupByFieldIds.length; index++) {
    const field = fieldsById.get(groupByFieldIds[index]!);
    if (!field || field.type !== "relation" || field.deletedAt) continue;
    const targetTableId = (field.config as { targetTableId?: string }).targetTableId;
    if (!targetTableId) continue;
    const ids = idsByTargetTable.get(targetTableId) ?? new Set<string>();
    for (const bucket of buckets) {
      const key = bucket.keys[index];
      if (typeof key === "string" && key.length > 0) ids.add(key);
    }
    idsByTargetTable.set(targetTableId, ids);
  }
  const visible = await visibleTargets(idsByTargetTable, viewer);
  return resolveLabelsByTargetTable(visible.ids, visible.authorizedTableIds, undefined, undefined, viewer);
};

export const buildRelationLabelCacheForIds = async (
  idsByTargetTable: Map<string, Set<string>>,
  viewer?: ExpansionViewer,
  client?: SqlClient,
  labelFieldIdsByTableId?: ReadonlyMap<string, readonly string[]>,
): Promise<Record<string, string>> => {
  const visible = await visibleTargets(idsByTargetTable, viewer, client);
  return resolveLabelsByTargetTable(visible.ids, visible.authorizedTableIds, labelFieldIdsByTableId, client, viewer);
};

export const lookupRecords = async (params: {
  targetTableId: string;
  q?: string | null;
  limit?: number;
  excludeIds?: string[];
  includeDeleted?: boolean;
  /** Internal publication snapshot: do not reload mutable label configuration after authorization. */
  labelSnapshot?: { fields: Field[]; presentable: Field[]; tableKind: string; recordSource: DslSqlFederatedRecordSource | null };
  recordIds?: string[];
  filter?: FilterTree;
  timeZone?: string;
  untitledLabel?: string;
}): Promise<{ items: { id: string; label: string }[] }> => {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const fields = params.labelSnapshot?.fields ?? (await listFields(params.targetTableId));
  const presentable = params.labelSnapshot?.presentable ?? relationLabelFields(fields);
  const searchTargets = presentable.filter((field) => LABEL_TEXT_TYPES.has(field.type));
  const presentableIds = new Set(presentable.filter((field) => field.type === "formula").map((field) => field.id));
  const tableKind = params.labelSnapshot?.tableKind ?? (await getTable(params.targetTableId))?.kind;
  const recordSource = params.labelSnapshot
    ? params.labelSnapshot.recordSource
    : tableKind === "federated"
      ? await buildDslSqlRecordSource(
          params.targetTableId,
          { [params.targetTableId]: fields },
          params.includeDeleted ? { includeDeleted: true } : undefined,
        )
      : null;
  const sourceFieldSql = recordSource ? buildFederatedFieldSqlMap(recordSource, fields) : storedLocalCalculationSqlMap(fields);
  const storedProjections = recordSource
    ? []
    : buildFormulaSqlProjections(
        fields.filter((field) => sourceFieldSql.has(field.id)),
        { computedFieldSql: sourceFieldSql },
      );
  const storedFragments = storedProjections.reduce((fragments, projection) => sql`${fragments}, ${projection.fragment}`, sql``);
  const formulaSearchTargets = buildFormulaSqlProjections(fields, {
    useFinalizedFormulaValues: tableKind !== "federated",
    computedFieldSql: sourceFieldSql,
  }).filter((projection) => presentableIds.has(projection.fieldId) && projection.expr);
  const conditions: any[] = [sql`TRUE`];
  if (params.filter) {
    const filter = compileFilter(params.filter, fields, { timeZone: params.timeZone });
    if (!filter.ok) throw new Error("Invalid relation selection filter");
    conditions.push(renderClause(filter.clause, { computedFieldSql: sourceFieldSql }));
  }
  if (!params.includeDeleted) conditions.push(sql`r.deleted_at IS NULL`);
  if (!recordSource) conditions.push(sql`r.table_id = ${params.targetTableId}::uuid`);
  const query = params.q?.trim();
  if (query && (searchTargets.length > 0 || formulaSearchTargets.length > 0)) {
    const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
    const search = [
      ...searchTargets.map((field) => sql`r.data->>${field.id} ILIKE ${pattern}`),
      ...formulaSearchTargets.map((projection) => sql`(${projection.expr})::text ILIKE ${pattern}`),
    ].reduce((left, right) => sql`${left} OR ${right}`);
    conditions.push(sql`(${search})`);
  }
  if (params.excludeIds && params.excludeIds.length > 0) {
    conditions.push(sql`r.id <> ALL(${sql.array(params.excludeIds, "UUID")})`);
  }
  if (params.recordIds) conditions.push(sql`r.id = ANY(${sql.array(params.recordIds, "UUID")})`);
  const where = conditions.reduce((left, right) => sql`${left} AND ${right}`);
  if (recordSource) await assertFederatedPublication(recordSource);
  const rows = recordSource
    ? await sql<DbRow[]>`
        SELECT r.id, r.data, r.calculation_errors, NULL::text AS finalized_at
        FROM ${recordSource.relation} r
        WHERE ${where}
        ORDER BY r.created_at DESC, r.source_table_id, r.id
        LIMIT ${limit}
      `
    : await sql<DbRow[]>`
        SELECT r.id, r.data, r.finalized_at::text, r.finalized_computed_types, r.finalized_computed_dependencies${storedFragments}
        FROM grids.records r
        ${liveRecordParentJoinSql("r", "rt", "rb")}
        WHERE ${where}
        ORDER BY r.created_at DESC
        LIMIT ${limit}
      `;
  const records = rows.map((row) => ({
    id: row.id as string,
    ...mapRecordCalculationData(row),
    finalizedAt: typeof row.finalized_at === "string" ? row.finalized_at : null,
  }));
  if (!recordSource) {
    const recordsById = new Map(records.map((record) => [record.id, record]));
    applyComputedProjections(rows, recordsById, storedProjections);
    applyFinalizedComputedAccess(rows, recordsById, undefined, fields);
  }
  enrichRecordsWithFormulas(records, fields, {
    useFinalizedFormulaValues: !recordSource,
    skipFormulaFieldIds: recordSource ? undefined : new Set(sourceFieldSql.keys()),
    skipObjectListFieldIds: new Set(sourceFieldSql.keys()),
  });
  return {
    items: records.map((record) => {
      const parts = presentable.map((field) => formatLabelPart(record.data[field.id])).filter((part) => part.length > 0);
      return { id: record.id, label: parts.length > 0 ? parts.join(" · ") : (params.untitledLabel ?? "Untitled record") };
    }),
  };
};
