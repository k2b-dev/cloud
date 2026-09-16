import type { DateContext } from "@k2b/stdlib";
import { sql } from "bun";
import { type LookupTargetMeta, lookupTargetMeta } from "../lookup-display";
import { assertFederatedPublication, buildDslSqlRecordSource } from "../query-dsl/sql-record-source";
import type { SqlClient } from "./audit";
import { runBoundedQuery } from "./bounded-query";
import {
  applyComputedProjections,
  buildComputedFieldSqlMap,
  buildComputedProjections,
  buildFormulaSqlProjections,
  type ComputedProjection,
  readableComputedTargetTableIds,
} from "./computed-projections";
import { listByTable as listFields } from "./fields";
import { enrichRecordsWithHtmlTemplates } from "./html-template-fields";
import { withLookupTargetMetadata } from "./lookup-display";
import { liveRecordParentJoinSql } from "./parent-checks";
import { applyFinalizedComputedAccess, mapRecordRow } from "./record-persistence";
import { attachRelationExpansion, type ExpansionViewer, enrichRecordsWithFormulas, hydrateRelationsFromLinks } from "./relations";
import { get as getTable } from "./tables";
import type { DocumentTemplateAppData } from "./template-context";
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

/** Identity-only read after the caller authorizes the table. Combined tables
 * still use their published source and its revision guard, not raw source IDs. */
export const publicIdsForRecords = async (
  tableId: string,
  recordIds: readonly string[],
  client: SqlClient = sql,
): Promise<Map<string, string>> => {
  if (recordIds.length === 0) return new Map();
  const source = await buildDslSqlRecordSource(tableId, {}, undefined, client);
  if (source) await assertFederatedPublication(source, client);
  const rows = await client<Array<{ id: string; short_id: string }>>`
    SELECT r.id::text, r.short_id FROM ${source?.relation ?? sql`grids.records`} r
    ${liveRecordParentJoinSql("r", "rt", "rb")}
    WHERE r.table_id = ${tableId}::uuid
      AND r.id = ANY(${sql.array([...new Set(recordIds)], "UUID")}::uuid[])
      AND r.deleted_at IS NULL
  `;
  return new Map(rows.map((row) => [row.id, row.short_id]));
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
  authorizedTableIds?: ReadonlySet<string>;
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
  client?: SqlClient,
  projectedFieldIds?: ReadonlySet<string>,
): Promise<FormulaLookupPlan> => {
  const authorizedTargetTableIds = await readableComputedTargetTableIds(fields, viewer, authorizeComputedTable, client);
  const specs = fields
    .filter(
      (field) =>
        field.type === "lookup" && !field.deletedAt && !projectedFieldIds?.has(field.id) && lookupTargetMeta(field)?.type === "formula",
    )
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
    const targetFields = await listFields(targetTableId, false, client);
    const authorizedNestedTableIds = await readableComputedTargetTableIds(targetFields, viewer, authorizeComputedTable, client);
    const targetComputed = await buildComputedProjections(targetFields, {
      useStoredLocalValues: true,
      client,
      authorizedTableIds: authorizedNestedTableIds,
    });
    const computedFieldSql = await buildComputedFieldSqlMap(targetFields, {
      client,
      dateConfig,
      authorizedTableIds: authorizedNestedTableIds,
      useStoredLocalValues: true,
    });
    const targetFormulaSql = buildFormulaSqlProjections(targetFields, {
      dateConfig,
      authorizedTableIds: authorizedNestedTableIds,
      computedFieldSql,
    });
    const targetProjections = [...targetComputed, ...targetFormulaSql];
    targets.set(targetTableId, {
      authorizedTableIds: authorizedNestedTableIds,
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
  options: { dateConfig?: DateContext; signal?: AbortSignal; queryTimeoutMs?: number; client?: SqlClient } = {},
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
    const client = options.client ?? sql;
    const query = client<DbRow[]>`
      SELECT r.*${target.projectionFragments}
      FROM grids.records r
      ${liveRecordParentJoinSql("r", "rt", "rb")}
      WHERE r.table_id = ${tableId}::uuid
        AND r.id = ANY(${sql.array([...ids], "UUID")})
        AND r.deleted_at IS NULL
    `;
    const rows =
      options.queryTimeoutMs !== undefined || options.signal
        ? await runBoundedQuery<DbRow>(query, options.queryTimeoutMs ?? 5_000, options.signal, undefined, options.client)
        : await query;
    options.signal?.throwIfAborted();
    const targetRecords = rows.map((row) => mapRecordRow(row));
    await hydrateRelationsFromLinks(targetRecords, target.fields, plan.viewer, options);
    const recordsById = new Map(targetRecords.map((record) => [record.id, record]));
    applyComputedProjections(rows as Array<Record<string, unknown>>, recordsById, target.projections, options.dateConfig?.locale);
    applyFinalizedComputedAccess(rows, recordsById, target.authorizedTableIds, target.fields, options.dateConfig?.locale);
    enrichRecordsWithFormulas(targetRecords, target.fields, {
      dateConfig: options.dateConfig,
      skipFormulaFieldIds: target.formulaFieldIds,
      skipObjectListFieldIds: target.formulaFieldIds,
    });
    targetsByTable.set(tableId, recordsById);
  }

  for (const spec of plan.specs) {
    const targetRecords = targetsByTable.get(spec.targetTableId);
    for (const record of records) {
      if (record.finalizedAt) continue;
      const firstId = relationIdsFor(record.data[spec.relationField.id])[0];
      record.data[spec.lookupField.id] = firstId ? (targetRecords?.get(firstId)?.data[spec.target.fieldId] ?? null) : null;
    }
  }
};

export const enrichFormulaLookups = async (
  records: GridRecord[],
  fields: Field[],
  options: {
    client?: SqlClient;
    dateConfig?: DateContext;
    viewer?: ExpansionViewer;
    authorizeComputedTable?: (tableId: string) => Promise<boolean>;
    projectedFieldIds?: ReadonlySet<string>;
  } = {},
): Promise<void> => {
  if (records.length === 0) return;
  const plan = await prepareFormulaLookupPlan(
    fields,
    options.dateConfig,
    options.viewer,
    options.authorizeComputedTable,
    options.client,
    options.projectedFieldIds,
  );
  await enrichFormulaLookupsWithPlan(records, plan, options);
};

type RecordReadOptions = {
  client?: SqlClient;
  templateApp?: DocumentTemplateAppData;
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
    opts.client,
  );
  if (!recordSource) throw new Error("Combined table source is not available");
  const formulaSql = buildFormulaSqlProjections(fields, { dateConfig: opts.dateConfig, useFinalizedFormulaValues: false });
  const projectionFragments = projectionFragmentsFor(formulaSql);
  const formulaFieldIds = new Set(formulaSql.map((projection) => projection.fieldId));
  const fieldsWithLookupMeta = await withLookupTargetMetadata(fields, opts.client);

  const getMany = async (recordIds: string[]): Promise<GridRecord[]> => {
    if (recordIds.length === 0) return [];
    opts.signal?.throwIfAborted();
    // Per read, not per reader: the reader outlives the publication it captured.
    await assertFederatedPublication(recordSource, opts.client);
    opts.signal?.throwIfAborted();
    const client = opts.client ?? sql;
    const query = client<DbRow[]>`
      SELECT r.*${projectionFragments}
      FROM ${recordSource.relation} r
      WHERE r.id = ANY(${sql.array(recordIds, "UUID")}::uuid[])
    `;
    const rows =
      opts.queryTimeoutMs !== undefined || opts.signal
        ? await runBoundedQuery<DbRow>(query, opts.queryTimeoutMs ?? 5_000, opts.signal, undefined, opts.client)
        : await query;
    opts.signal?.throwIfAborted();
    const records = rows.map((row) => mapRecordRow(row));
    const recordsById = new Map(records.map((record) => [record.id, record]));
    applyComputedProjections(rows as Array<Record<string, unknown>>, recordsById, formulaSql, opts.dateConfig?.locale);
    enrichRecordsWithFormulas(records, fieldsWithLookupMeta, {
      dateConfig: opts.dateConfig,
      skipFormulaFieldIds: formulaFieldIds,
      useFinalizedFormulaValues: false,
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
  const client = opts.client ?? sql;
  const fields = opts.fields ?? (await listFields(tableId, false, client));
  const table = await getTable(tableId, { client });
  if (table?.kind === "federated") return createFederatedReader(tableId, fields, opts);
  const fieldsWithLookupMeta = await withLookupTargetMetadata(fields, client);
  const authorizedTargetTableIds = await readableComputedTargetTableIds(fields, opts.viewer, opts.authorizeComputedTable, client);
  const buildLivePlan = async () => {
    const computed = await buildComputedProjections(fields, {
      useStoredLocalValues: true,
      authorizedTableIds: authorizedTargetTableIds,
      client,
      dateConfig: opts.dateConfig,
    });
    const computedFieldSql = await buildComputedFieldSqlMap(fields, {
      client,
      dateConfig: opts.dateConfig,
      authorizedTableIds: authorizedTargetTableIds,
      useStoredLocalValues: true,
    });
    const formulaSql = buildFormulaSqlProjections(fields, {
      dateConfig: opts.dateConfig,
      authorizedTableIds: authorizedTargetTableIds,
      computedFieldSql,
    });
    const projections = [...computed, ...formulaSql];
    const projectionFragments = projectionFragmentsFor(projections);
    const formulaFieldIds = new Set(formulaSql.map((projection) => projection.fieldId));
    const formulaLookupPlan = await prepareFormulaLookupPlan(
      fieldsWithLookupMeta,
      opts.dateConfig,
      opts.viewer,
      opts.authorizeComputedTable,
      client,
      new Set(computed.map((projection) => projection.fieldId)),
    );
    return { projections, projectionFragments, formulaFieldIds, formulaLookupPlan };
  };
  let livePlan: ReturnType<typeof buildLivePlan> | undefined;

  const getMany = async (recordIds: string[]): Promise<GridRecord[]> => {
    if (recordIds.length === 0) return [];
    opts.signal?.throwIfAborted();
    const deletedClause =
      opts.deleted === "include" ? sql`TRUE` : opts.deleted === "only" ? sql`r.deleted_at IS NOT NULL` : sql`r.deleted_at IS NULL`;
    const readRows = async (ids: string[], fragments: unknown): Promise<DbRow[]> => {
      const query = client<DbRow[]>`
      SELECT r.*${fragments}
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE r.id = ANY(${sql.array(ids, "UUID")}::uuid[])
        AND r.table_id = ${tableId}::uuid
        AND ${deletedClause}
    `;
      return opts.queryTimeoutMs !== undefined || opts.signal
        ? await runBoundedQuery<DbRow>(query, opts.queryTimeoutMs ?? 5_000, opts.signal, undefined, opts.client)
        : await query;
    };
    // This is the authoritative frozen row, not a metadata preflight. Captured
    // values are immutable and need no live SQL plan. Drafts are read again in
    // full with projections; their existing CASE guards handle finalization
    // between the two statements without combining different row versions.
    const initialRows = await readRows(recordIds, sql``);
    const draftIds = initialRows.flatMap((row) => (!row.finalized_at && typeof row.id === "string" ? [row.id] : []));
    if (draftIds.length > 0 && !livePlan)
      livePlan = buildLivePlan().catch((error) => {
        livePlan = undefined;
        throw error;
      });
    const plan = draftIds.length > 0 && livePlan ? await livePlan : null;
    const projectedRows = plan ? await readRows(draftIds, plan.projectionFragments) : [];
    const rows = [...initialRows.filter((row) => row.finalized_at), ...projectedRows];
    opts.signal?.throwIfAborted();
    const records = rows.map((row) => mapRecordRow(row));
    await hydrateRelationsFromLinks(records, fields, opts.viewer, {
      client,
      signal: opts.signal,
      queryTimeoutMs: opts.queryTimeoutMs,
    });
    opts.signal?.throwIfAborted();
    const recordsById = new Map(records.map((record) => [record.id, record]));
    if (plan) applyComputedProjections(projectedRows, recordsById, plan.projections, opts.dateConfig?.locale);
    applyFinalizedComputedAccess(rows, recordsById, authorizedTargetTableIds, fields, opts.dateConfig?.locale);
    const liveRecords = records.filter((record) => !record.finalizedAt);
    if (plan)
      await enrichFormulaLookupsWithPlan(liveRecords, plan.formulaLookupPlan, {
        client,
        dateConfig: opts.dateConfig,
        signal: opts.signal,
        queryTimeoutMs: opts.queryTimeoutMs,
      });
    opts.signal?.throwIfAborted();
    if (plan)
      enrichRecordsWithFormulas(liveRecords, fieldsWithLookupMeta, {
        dateConfig: opts.dateConfig,
        skipFormulaFieldIds: plan.formulaFieldIds,
        skipObjectListFieldIds: plan.formulaFieldIds,
      });
    await enrichRecordsWithHtmlTemplates(records, fieldsWithLookupMeta, {
      client,
      app: opts.templateApp,
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
