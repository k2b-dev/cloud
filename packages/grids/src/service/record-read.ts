import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { type LookupTargetMeta, lookupTargetMeta } from "../lookup-display";
import { assertFederatedPublication, buildDslSqlRecordSource } from "../query-dsl/sql-record-source";
import { runBoundedQuery } from "./bounded-query";
import {
  applyComputedProjections,
  buildComputedProjections,
  buildFormulaSqlProjections,
  type ComputedProjection,
  readableComputedTargetTableIds,
} from "./computed-projections";
import { listByTable as listFields } from "./fields";
import { enrichRecordsWithHtmlTemplates } from "./html-template-fields";
import { withLookupTargetMetadata } from "./lookup-display";
import { liveRecordParentJoinSql } from "./parent-checks";
import { mapRecordRow } from "./record-persistence";
import { attachRelationExpansion, type ExpansionViewer, enrichRecordsWithFormulas, hydrateRelationsFromLinks } from "./relations";
import { get as getTable } from "./tables";
import type { Field, GridRecord } from "./types";

type DbRow = Record<string, unknown>;

export const findTableId = async (recordId: string): Promise<string | null> => {
  const [row] = await sql<Array<{ table_id: string }>>`
    SELECT r.table_id::text AS table_id
    FROM grids.records r
    ${liveRecordParentJoinSql("r", "rt", "rb")}
    WHERE r.id = ${recordId}::uuid AND r.deleted_at IS NULL
  `;
  return row?.table_id ?? null;
};

const relationIdsFor = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];

export const projectionFragmentsFor = (projections: ComputedProjection[]): unknown =>
  projections.length > 0
    ? projections.map((projection) => sql`, ${projection.fragment}`).reduce((acc, current) => sql`${acc}${current}`)
    : sql``;

type FormulaLookupSpec = {
  lookupField: Field;
  relationField: Field;
  target: LookupTargetMeta;
  targetTableId: string;
};

type FormulaLookupTargetPlan = {
  fields: Field[];
  projections: ComputedProjection[];
  projectionFragments: unknown;
  formulaFieldIds: Set<string>;
};

type FormulaLookupPlan = {
  specs: FormulaLookupSpec[];
  targets: Map<string, FormulaLookupTargetPlan>;
  viewer?: ExpansionViewer;
};

const prepareFormulaLookupPlan = async (
  fields: Field[],
  dateConfig?: DateContext,
  viewer?: ExpansionViewer,
  authorizeComputedTable?: (tableId: string) => Promise<boolean>,
): Promise<FormulaLookupPlan> => {
  const authorizedTargetTableIds = await readableComputedTargetTableIds(fields, viewer, authorizeComputedTable);
  const specs = fields
    .filter((field) => field.type === "lookup" && !field.deletedAt && lookupTargetMeta(field)?.type === "formula")
    .map((lookupField) => {
      const cfg = lookupField.config as { relationFieldId?: string };
      const relationField = cfg.relationFieldId
        ? fields.find((field) => field.id === cfg.relationFieldId && field.type === "relation")
        : undefined;
      const target = lookupTargetMeta(lookupField);
      const targetTableId = (relationField?.config as { targetTableId?: string } | undefined)?.targetTableId;
      return relationField && target && targetTableId ? { lookupField, relationField, target, targetTableId } : null;
    })
    .filter(
      (spec): spec is NonNullable<typeof spec> =>
        Boolean(spec) && (authorizedTargetTableIds === undefined || authorizedTargetTableIds.has(spec!.targetTableId)),
    );

  const targets = new Map<string, FormulaLookupTargetPlan>();
  for (const { targetTableId } of specs) {
    if (targets.has(targetTableId)) continue;
    const targetFields = await listFields(targetTableId);
    const authorizedNestedTableIds = await readableComputedTargetTableIds(targetFields, viewer, authorizeComputedTable);
    const targetComputed = await buildComputedProjections(targetFields, {
      authorizedTableIds: authorizedNestedTableIds,
    });
    const targetFormulaSql = buildFormulaSqlProjections(targetFields, { dateConfig });
    const targetProjections = [...targetComputed, ...targetFormulaSql];
    targets.set(targetTableId, {
      fields: targetFields,
      projections: targetProjections,
      projectionFragments: projectionFragmentsFor(targetProjections),
      formulaFieldIds: new Set(targetFormulaSql.map((projection) => projection.fieldId)),
    });
  }
  return { specs, targets, viewer };
};

const enrichFormulaLookupsWithPlan = async (
  records: GridRecord[],
  plan: FormulaLookupPlan,
  options: { dateConfig?: DateContext; signal?: AbortSignal; queryTimeoutMs?: number } = {},
): Promise<void> => {
  if (records.length === 0 || plan.specs.length === 0) return;

  const idsByTable = new Map<string, Set<string>>();
  for (const spec of plan.specs) {
    const ids = idsByTable.get(spec.targetTableId) ?? new Set<string>();
    for (const record of records) {
      for (const id of relationIdsFor(record.data[spec.relationField.id])) ids.add(id);
    }
    idsByTable.set(spec.targetTableId, ids);
  }

  const targetsByTable = new Map<string, Map<string, GridRecord>>();
  for (const [tableId, ids] of idsByTable) {
    if (ids.size === 0) continue;
    const target = plan.targets.get(tableId);
    if (!target) continue;
    options.signal?.throwIfAborted();
    const query = sql<DbRow[]>`
      SELECT r.*${target.projectionFragments}
      FROM grids.records r
      ${liveRecordParentJoinSql("r", "rt", "rb")}
      WHERE r.table_id = ${tableId}::uuid
        AND r.id = ANY(${sql.array([...ids], "UUID")})
        AND r.deleted_at IS NULL
    `;
    const rows =
      options.queryTimeoutMs !== undefined || options.signal
        ? await runBoundedQuery<DbRow>(query, options.queryTimeoutMs ?? 5_000, options.signal)
        : await query;
    options.signal?.throwIfAborted();
    const targetRecords = rows.map(mapRecordRow);
    await hydrateRelationsFromLinks(targetRecords, target.fields, plan.viewer, options);
    const recordsById = new Map(targetRecords.map((record) => [record.id, record]));
    applyComputedProjections(rows as Array<Record<string, unknown>>, recordsById, target.projections);
    enrichRecordsWithFormulas(targetRecords, target.fields, {
      dateConfig: options.dateConfig,
      skipFormulaFieldIds: target.formulaFieldIds,
    });
    targetsByTable.set(tableId, recordsById);
  }

  for (const spec of plan.specs) {
    const targetRecords = targetsByTable.get(spec.targetTableId);
    for (const record of records) {
      const firstId = relationIdsFor(record.data[spec.relationField.id])[0];
      record.data[spec.lookupField.id] = firstId ? (targetRecords?.get(firstId)?.data[spec.target.fieldId] ?? null) : null;
    }
  }
};

export const enrichFormulaLookups = async (
  records: GridRecord[],
  fields: Field[],
  options: {
    dateConfig?: DateContext;
    viewer?: ExpansionViewer;
    authorizeComputedTable?: (tableId: string) => Promise<boolean>;
  } = {},
): Promise<void> => {
  if (records.length === 0) return;
  const plan = await prepareFormulaLookupPlan(fields, options.dateConfig, options.viewer, options.authorizeComputedTable);
  await enrichFormulaLookupsWithPlan(records, plan, options);
};

type RecordReadOptions = {
  includeRelations?: boolean;
  viewer?: ExpansionViewer;
  authorizeComputedTable?: (tableId: string) => Promise<boolean>;
  dateConfig?: DateContext;
  fields?: Field[];
  deleted?: "live" | "include" | "only";
  htmlTemplateFieldIds?: readonly string[];
  signal?: AbortSignal;
  queryTimeoutMs?: number;
};

export type RecordReader = {
  fields: Field[];
  get: (recordId: string) => Promise<GridRecord | null>;
  getMany: (recordIds: string[]) => Promise<GridRecord[]>;
};

const createFederatedReader = async (tableId: string, fields: Field[], opts: RecordReadOptions): Promise<RecordReader> => {
  const recordSource = await buildDslSqlRecordSource(
    tableId,
    { [tableId]: fields },
    {
      includeDeleted: opts.deleted === "include",
      deletedOnly: opts.deleted === "only",
    },
  );
  if (!recordSource) throw new Error("Combined table source is not available");
  const formulaSql = buildFormulaSqlProjections(fields, { dateConfig: opts.dateConfig });
  const projectionFragments = projectionFragmentsFor(formulaSql);
  const formulaFieldIds = new Set(formulaSql.map((projection) => projection.fieldId));
  const fieldsWithLookupMeta = await withLookupTargetMetadata(fields);

  const getMany = async (recordIds: string[]): Promise<GridRecord[]> => {
    if (recordIds.length === 0) return [];
    opts.signal?.throwIfAborted();
    // Per read, not per reader: the reader outlives the publication it captured.
    await assertFederatedPublication(recordSource);
    opts.signal?.throwIfAborted();
    const query = sql<DbRow[]>`
      SELECT r.*${projectionFragments}
      FROM ${recordSource.relation} r
      WHERE r.id = ANY(${sql.array(recordIds, "UUID")}::uuid[])
    `;
    const rows =
      opts.queryTimeoutMs !== undefined || opts.signal
        ? await runBoundedQuery<DbRow>(query, opts.queryTimeoutMs ?? 5_000, opts.signal)
        : await query;
    opts.signal?.throwIfAborted();
    const records = rows.map(mapRecordRow);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    applyComputedProjections(rows as Array<Record<string, unknown>>, recordsById, formulaSql);
    enrichRecordsWithFormulas(records, fieldsWithLookupMeta, {
      dateConfig: opts.dateConfig,
      skipFormulaFieldIds: formulaFieldIds,
    });
    if (opts.includeRelations) await attachRelationExpansion(records, fieldsWithLookupMeta, opts.viewer);
    return recordIds.flatMap((id) => {
      const record = recordsById.get(id);
      return record ? [record] : [];
    });
  };

  return {
    fields,
    get: async (recordId) => (await getMany([recordId]))[0] ?? null,
    getMany,
  };
};

export const createReader = async (tableId: string, opts: RecordReadOptions = {}): Promise<RecordReader> => {
  const fields = opts.fields ?? (await listFields(tableId));
  const table = await getTable(tableId);
  if (table?.kind === "federated") return createFederatedReader(tableId, fields, opts);
  const fieldsWithLookupMeta = await withLookupTargetMetadata(fields);
  const authorizedTargetTableIds = await readableComputedTargetTableIds(fields, opts.viewer, opts.authorizeComputedTable);
  const computed = await buildComputedProjections(fields, { authorizedTableIds: authorizedTargetTableIds });
  const formulaSql = buildFormulaSqlProjections(fields, { dateConfig: opts.dateConfig });
  const projections = [...computed, ...formulaSql];
  const projectionFragments = projectionFragmentsFor(projections);
  const formulaFieldIds = new Set(formulaSql.map((projection) => projection.fieldId));
  const formulaLookupPlan = await prepareFormulaLookupPlan(fieldsWithLookupMeta, opts.dateConfig, opts.viewer, opts.authorizeComputedTable);

  const getMany = async (recordIds: string[]): Promise<GridRecord[]> => {
    if (recordIds.length === 0) return [];
    opts.signal?.throwIfAborted();
    const deletedClause =
      opts.deleted === "include" ? sql`TRUE` : opts.deleted === "only" ? sql`r.deleted_at IS NOT NULL` : sql`r.deleted_at IS NULL`;
    const query = sql<DbRow[]>`
      SELECT r.*${projectionFragments}
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE r.id = ANY(${sql.array(recordIds, "UUID")}::uuid[])
        AND r.table_id = ${tableId}::uuid
        AND ${deletedClause}
    `;
    const rows =
      opts.queryTimeoutMs !== undefined || opts.signal
        ? await runBoundedQuery<DbRow>(query, opts.queryTimeoutMs ?? 5_000, opts.signal)
        : await query;
    opts.signal?.throwIfAborted();
    const records = rows.map(mapRecordRow);
    await hydrateRelationsFromLinks(records, fields, opts.viewer, {
      signal: opts.signal,
      queryTimeoutMs: opts.queryTimeoutMs,
    });
    opts.signal?.throwIfAborted();
    const recordsById = new Map(records.map((record) => [record.id, record]));
    applyComputedProjections(rows as Array<Record<string, unknown>>, recordsById, projections);
    await enrichFormulaLookupsWithPlan(records, formulaLookupPlan, {
      dateConfig: opts.dateConfig,
      signal: opts.signal,
      queryTimeoutMs: opts.queryTimeoutMs,
    });
    opts.signal?.throwIfAborted();
    enrichRecordsWithFormulas(records, fieldsWithLookupMeta, {
      dateConfig: opts.dateConfig,
      skipFormulaFieldIds: formulaFieldIds,
    });
    await enrichRecordsWithHtmlTemplates(records, fieldsWithLookupMeta, {
      dateConfig: opts.dateConfig,
      ...(opts.htmlTemplateFieldIds ? { fieldIds: new Set(opts.htmlTemplateFieldIds) } : {}),
      signal: opts.signal,
    });
    opts.signal?.throwIfAborted();
    if (opts.includeRelations) {
      await attachRelationExpansion(records, fieldsWithLookupMeta, opts.viewer);
    }
    return recordIds.flatMap((id) => {
      const record = recordsById.get(id);
      return record ? [record] : [];
    });
  };

  return {
    fields,
    get: async (recordId) => (await getMany([recordId]))[0] ?? null,
    getMany,
  };
};

export const get = async (tableId: string, recordId: string, opts: RecordReadOptions = {}): Promise<GridRecord | null> =>
  (await createReader(tableId, opts)).get(recordId);
