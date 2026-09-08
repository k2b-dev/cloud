import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { ComputedColumnSpec, FilterTree, GroupBySpec, GroupSortSpec, RecordMetaQuery, SearchSpec, SortSpec } from "../contracts";
import type { Expr } from "../formula/types";
import { defaultTableAggregations } from "../table-defaults";
import { type AggregateRequest, compileAggregates } from "./aggregate-compiler";
import { runBoundedQuery } from "./bounded-query";
import {
  applyComputedProjections,
  buildComputedColumnSqlProjections,
  buildComputedProjections,
  buildFormulaSqlProjections,
  readableComputedTargetTableIds,
} from "./computed-projections";
import { getGridsCrudMessages } from "./crud-messages";
import { isMultiSelectField, storageOf } from "./field-storage";
import { listByTable as listFields } from "./fields";
import { listFirstImagePreviews } from "./files";
import { compileFilter, renderClause } from "./filter-compiler";
import { compileFormulaPredicateAstToSql } from "./formula-sql-compiler";
import { compileGroupQuery, type GroupAggregationSpec, type GroupBucket, type GroupHavingRef } from "./group-compiler";
import { enrichRecordsWithHtmlTemplates, type HtmlTemplateRenderBudget } from "./html-template-fields";
import { parseJsonbRow } from "./jsonb";
import { withLookupTargetMetadata } from "./lookup-display";
import { cleanRecordMeta, compileRecordMetaFilter, listRecordActors, recordMetaRequiresDeletedRows } from "./record-metadata";
import { mapRecordRow } from "./record-persistence";
import { enrichFormulaLookups, findTableId, get, projectionFragmentsFor } from "./record-read";
import {
  attachRelationExpansion,
  type ExpansionViewer,
  enrichRecordsWithComputedColumns,
  enrichRecordsWithFormulas,
  hydrateRelationsFromLinks,
} from "./relations";
import { compileSearchClause } from "./search";
import { compileSort, decodeCursor } from "./sort-compiler";
import type { Field, RecordList } from "./types";

type DbRow = Record<string, unknown>;
const RECORD_QUERY_TIMEOUT_MS = 5_000;

/** Resolves the only public record identifier to a live internal record. */
export const getByShortId = async (shortId: string) => {
  const [row] = await sql<Array<{ id: string; table_id: string }>>`
    SELECT r.id::text, r.table_id::text
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE r.short_id = ${shortId} AND r.deleted_at IS NULL
  `;
  return row ? get(row.table_id, row.id) : null;
};

export const countByTable = async (tableIds: readonly string[]): Promise<Record<string, number>> => {
  if (tableIds.length === 0) return {};
  const queries = tableIds.map(
    (tableId) => sql`
      SELECT ${tableId}::uuid AS table_id, COUNT(*)::int AS record_count
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE r.table_id = ${tableId}::uuid
        AND r.deleted_at IS NULL
    `,
  );
  const query = queries.slice(1).reduce((combined, current) => sql`${combined} UNION ALL ${current}`, queries[0]!);
  const rows = await sql<Array<{ table_id: string; record_count: number | string | null }>>`${query}`;
  return Object.fromEntries(rows.map((row) => [row.table_id, Number(row.record_count ?? 0)]));
};

const defaultListAggregates = (fields: Field[]): AggregateRequest[] =>
  defaultTableAggregations(fields).map((a) => ({ fieldId: a.fieldId, agg: a.agg }));

export const list = async (params: {
  tableId: string;
  cursor?: string | null;
  limit?: number;
  includeDeleted?: boolean;
  filter?: FilterTree | null;
  formulaWhere?: Expr | null;
  search?: SearchSpec | null;
  recordMeta?: RecordMetaQuery | null;
  sort?: SortSpec[];
  /**
   * When true, populate each returned record's `expanded` field with
   * the presentable-field subset of every record it links to via
   * relation cells. One extra page-level batch (`O(target-tables)`
   * roundtrips) — never N+1. Default false so callers must opt into
   * the heavier expanded shape explicitly.
   */
  includeRelations?: boolean;
  deletedOnly?: boolean;
  /**
   * Viewer for per-target-table permission gating on expansion. When
   * set together with `includeRelations: true`, relation links to
   * records in tables the viewer can't read are NOT expanded — the
   * renderer falls back to a neutral placeholder. Omit to expand unfiltered
   * (the call site has already gated access).
   */
  viewer?: ExpansionViewer;
  includeAggregates?: boolean;
  dateConfig?: DateContext;
  computedColumns?: ComputedColumnSpec[];
  filePreviewFieldIds?: string[];
  fields?: Field[];
  /** Undefined renders every HTML template field. An explicit list lets
   * bounded consumers such as export opt into only selected templates. */
  htmlTemplateFieldIds?: string[];
  htmlTemplateRenderBudget?: HtmlTemplateRenderBudget;
  signal?: AbortSignal;
  dedupeKey?: string;
  locale?: string;
}): Promise<Result<RecordList>> => {
  const messages = getGridsCrudMessages(params.locale);
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const fields = params.fields ?? (await listFields(params.tableId));
  const fieldsWithLookupMeta = await withLookupTargetMetadata(fields);

  // Filter compilation
  const filterCompiled = compileFilter(params.filter ?? null, fields, { timeZone: params.dateConfig?.timeZone });
  if (!filterCompiled.ok) return fail(err.badInput(messages.filterInvalid({ detail: filterCompiled.error })));
  const filterClause = renderClause(filterCompiled.clause);
  const formulaWhereCompiled = params.formulaWhere
    ? compileFormulaPredicateAstToSql(params.formulaWhere, {
        fields,
        recordAlias: "r",
        dateConfig: params.dateConfig,
      })
    : null;
  if (formulaWhereCompiled && !formulaWhereCompiled.ok)
    return fail(err.badInput(messages.formulaWhereInvalid({ detail: formulaWhereCompiled.error })));
  const searchCompiled = await compileSearchClause({
    search: params.search ?? null,
    fields,
    alias: "r",
    viewer: params.viewer,
  });
  const searchClause = searchCompiled.clause;
  const recordMetaClause = compileRecordMetaFilter(params.recordMeta ?? null);
  const needsDeletedRows = recordMetaRequiresDeletedRows(params.recordMeta ?? null);

  // Sort compilation (with cursor decoding when present). Cursor length
  // is validated against the active sort spec — a stale cursor from a
  // different sort length now returns 400 instead of misaligning page 2.
  const effectiveSort = params.sort ?? [];
  const expectedCursorLength = effectiveSort.length;
  const decodedCursor = params.cursor ? decodeCursor(params.cursor, expectedCursorLength) : null;
  if (params.cursor && !decodedCursor) {
    return fail(err.badInput(messages.invalidCursor));
  }
  const sortCompiled = compileSort(effectiveSort, fields, decodedCursor);
  if (!sortCompiled.ok) return fail(err.badInput(messages.sortInvalid({ detail: sortCompiled.error })));
  const { orderBy, cursorWhere, cursorSelect, encodeCursorFromRow } = sortCompiled.result;

  // table_id / deleted_at must be qualified — both `r.records`,
  // `t.tables`, and `b.bases` (joined for live-parent) carry these
  // column names. An unqualified ref raises 42702 (chunk: 1.2 JOIN
  // regression).
  const conditions: any[] = [sql`r.table_id = ${params.tableId}::uuid`];
  if (params.deletedOnly || needsDeletedRows) conditions.push(sql`r.deleted_at IS NOT NULL`);
  else if (!params.includeDeleted) conditions.push(sql`r.deleted_at IS NULL`);
  conditions.push(filterClause);
  if (formulaWhereCompiled?.ok) conditions.push(formulaWhereCompiled.expression.sql);
  conditions.push(searchClause);
  conditions.push(recordMetaClause);

  if (cursorWhere) conditions.push(cursorWhere);
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  // Lookup / rollup values are computed in the main query as correlated
  // subqueries over record_links. Single source of truth, single
  // round-trip.
  const computed = await buildComputedProjections(fields, {
    authorizedTableIds: await readableComputedTargetTableIds(fields, params.viewer),
  });
  const formulaSql = buildFormulaSqlProjections(fields, { dateConfig: params.dateConfig });
  // View computed columns evaluate in SQL when projectable (one semantics with
  // GQL preview + formula fields); the JS evaluator below only fills the rest.
  const computedColumnSql = buildComputedColumnSqlProjections(params.computedColumns, fields, { dateConfig: params.dateConfig });
  const projections = [...computed, ...formulaSql, ...computedColumnSql.projections];
  const projectionFragments = projectionFragmentsFor(projections);

  // Live-parent JOIN: records of a trashed table or base never list,
  // even when the caller passes a leaked tableId UUID. The filter's
  // predicate still pins r.table_id = ${tableId}, so the JOIN's table
  // row is uniquely identified — Postgres treats this as a cheap
  // semi-join.
  const rows = await runBoundedQuery<DbRow>(
    sql`
      SELECT r.*${projectionFragments}${cursorSelect}
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE ${where}
      ORDER BY ${orderBy} LIMIT ${limit + 1}
    `,
    RECORD_QUERY_TIMEOUT_MS,
    params.signal,
    params.dedupeKey ? `${params.dedupeKey}:rows` : undefined,
  );
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapRecordRow);

  // Hydrate relation fields from record_links so the UI sees the link
  // arrays. Lookup/rollup values are already in the row via the
  // projection — applyComputedProjections lifts them into
  // record.data[fieldId] alongside the JSONB-derived columns.
  await hydrateRelationsFromLinks(items, fields, params.viewer);
  const recordsById = new Map(items.map((r) => [r.id, r]));
  applyComputedProjections(rows.slice(0, limit) as Array<Record<string, unknown>>, recordsById, projections);
  await enrichFormulaLookups(items, fieldsWithLookupMeta, { dateConfig: params.dateConfig, viewer: params.viewer });

  let nextCursor: string | null = null;
  if (hasMore) {
    // Cursor encodes from the SQL `__sort_<i>` aliases (null-safe via
    // try_*) instead of `record.data[fieldId]` (raw JSONB) — so corrupt
    // values produce NULL in the cursor instead of crashing page 2.
    const lastRow = rows[limit - 1] as Record<string, unknown>;
    nextCursor = encodeCursorFromRow(lastRow);
  }
  // SQL-projectable formulas are already in record.data. Keep the JS
  // evaluator for formulas that need non-SQL values (relation/lookup/
  // rollup/select/file/other formula refs) so no existing formula loses
  // behavior while the query engine moves SQL-first.
  enrichRecordsWithFormulas(items, fieldsWithLookupMeta, {
    dateConfig: params.dateConfig,
    skipFormulaFieldIds: new Set(formulaSql.map((projection) => projection.fieldId)),
  });
  enrichRecordsWithComputedColumns(items, fields, params.computedColumns, {
    dateConfig: params.dateConfig,
    skipColumnIds: computedColumnSql.sqlColumnIds,
  });
  await enrichRecordsWithHtmlTemplates(items, fieldsWithLookupMeta, {
    dateConfig: params.dateConfig,
    ...(params.htmlTemplateFieldIds ? { fieldIds: new Set(params.htmlTemplateFieldIds) } : {}),
    budget: params.htmlTemplateRenderBudget,
    signal: params.signal,
  });

  // Optional relation expansion. Runs AFTER hydrateRelationsFromLinks
  // because it reads `record.data[fieldId]` to figure out which UUIDs
  // each record actually references. Mutates the records in place.
  // When a viewer is supplied, target tables the viewer can't read
  // are skipped — the renderer falls back to a neutral placeholder.
  if (params.includeRelations) {
    await attachRelationExpansion(items, fields, params.viewer);
  }

  const filePreviews =
    params.filePreviewFieldIds && params.filePreviewFieldIds.length > 0
      ? await listFirstImagePreviews({
          tableId: params.tableId,
          recordIds: items.map((record) => record.id),
          fieldIds: params.filePreviewFieldIds,
        })
      : undefined;

  const aggregatesResult = params.includeAggregates
    ? await aggregate({
        tableId: params.tableId,
        filter: params.filter ?? null,
        search: params.search ?? null,
        recordMeta: cleanRecordMeta(params.recordMeta),
        includeDeleted: params.includeDeleted,
        deletedOnly: params.deletedOnly,
        requests: defaultListAggregates(fields),
        formulaWhere: params.formulaWhere,
        viewer: params.viewer,
        dateConfig: params.dateConfig,
        fields,
        dedupeKey: params.dedupeKey ? `${params.dedupeKey}:default-aggregates` : undefined,
      })
    : ok<Record<string, unknown>>({});
  if (!aggregatesResult.ok) return aggregatesResult;

  // Echo fields back in the response — list is the table-page entry
  // point and consumers (records page, Grids App records block,
  // DatabaseTable) always need them to render. Saves a roundtrip vs
  // calling listFields separately.
  return ok({ items, fields: fieldsWithLookupMeta, nextCursor, aggregates: aggregatesResult.data, filePreviews });
};

/**
 * Group-by + aggregations endpoint — classic SQL GROUP BY semantics.
 * Returns one row per (groupBy-key) tuple with the configured
 * aggregations attached. Cursor pagination on the group-key tuple.
 *
 * See group-compiler.ts for the SQL emission rules.
 */
export const group = async (params: {
  tableId: string;
  groupBy: GroupBySpec[];
  aggregations: GroupAggregationSpec[];
  groupSort?: GroupSortSpec[];
  formulaHaving?: { expression: Expr; refs: GroupHavingRef[] } | null;
  filter?: FilterTree | null;
  search?: SearchSpec | null;
  recordMeta?: RecordMetaQuery | null;
  cursor?: string | null;
  limit?: number;
  fromEnd?: boolean;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  viewer?: ExpansionViewer;
  dateConfig?: DateContext;
  fields?: Field[];
  signal?: AbortSignal;
  dedupeKey?: string;
  locale?: string;
}): Promise<Result<{ buckets: GroupBucket[]; nextCursor: string | null; explode: boolean }>> => {
  const messages = getGridsCrudMessages(params.locale);
  const fields = params.fields ?? (await listFields(params.tableId));

  // Cursor: keys-only (group rows have no id; the tuple itself is unique).
  let cursorKeys: { keys: unknown[] } | null = null;
  if (params.cursor) {
    try {
      const parsed = JSON.parse(params.cursor) as { k?: unknown[] };
      if (!Array.isArray(parsed.k)) return fail(err.badInput(messages.invalidCursor));
      cursorKeys = { keys: parsed.k };
    } catch {
      return fail(err.badInput(messages.invalidCursor));
    }
  }

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  const searchCompiled = await compileSearchClause({
    search: params.search ?? null,
    fields,
    alias: "r",
    viewer: params.viewer,
  });
  const searchClause = searchCompiled.clause;
  const recordMetaClause = compileRecordMetaFilter(params.recordMeta ?? null);
  const needsDeletedRows = recordMetaRequiresDeletedRows(params.recordMeta ?? null);
  const compiled = compileGroupQuery({
    tableId: params.tableId,
    groupBy: params.groupBy,
    aggregations: params.aggregations,
    groupSort: params.groupSort,
    having: params.formulaHaving?.expression,
    havingRefs: params.formulaHaving?.refs,
    filter: params.filter,
    searchClause,
    extraWhere: recordMetaClause,
    fields,
    cursor: cursorKeys,
    limit,
    fromEnd: params.fromEnd,
    includeDeleted: params.includeDeleted,
    deletedOnly: params.deletedOnly || needsDeletedRows,
    timeZone: params.dateConfig?.timeZone,
    dateConfig: params.dateConfig,
  });
  if (!compiled.ok) return fail(err.badInput(messages.groupInvalid({ detail: compiled.error })));

  const rows = await runBoundedQuery<DbRow>(compiled.query, RECORD_QUERY_TIMEOUT_MS, params.signal, params.dedupeKey);
  const hasMore = rows.length > limit;
  const visible = params.fromEnd && hasMore ? rows.slice(-limit) : rows.slice(0, limit);

  const cursorJsonValue = (value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    return value ?? null;
  };

  const buckets: GroupBucket[] = visible.map((row) => {
    const keys = compiled.resolvedGroups.map((group, i) => {
      const raw = row[`gk_${i}`];
      // Date keys come back as JS Date — normalize to ISO string for
      // a stable JSON envelope. Bigints (count-likes) become numbers.
      if (raw instanceof Date) return group.spec.granularity ? raw.toISOString().slice(0, 10) : raw.toISOString();
      if (typeof raw === "bigint") return Number(raw);
      if (typeof raw === "string" && storageOf(group.field).kind === "numeric" && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      return raw ?? null;
    });
    const values: Record<string, unknown> = {};
    for (const k of compiled.aggKeys) {
      const raw = row[k];
      if (raw === null || raw === undefined) {
        values[k] = null;
        continue;
      }
      // Aggregate columns are numeric or text. Normalize bigints/strings
      // to numbers when the column was a count-like; leave others raw.
      if (typeof raw === "bigint") values[k] = Number(raw);
      else if (typeof raw === "string" && k.endsWith("__count")) values[k] = Number(raw);
      else if (typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw)) values[k] = Number(raw);
      else values[k] = raw;
    }
    return { keys, values };
  });

  let nextCursor: string | null = null;
  if (hasMore && compiled.cursorable && !params.fromEnd) {
    const boundary = visible.at(-1);
    if (boundary) {
      nextCursor = JSON.stringify({ k: compiled.cursorValuesFromRow(boundary).map(cursorJsonValue) });
    }
  }
  // Explode-mode: at least one groupBy dimension is a relation or
  // multi-select field. The `*__count` aggregate then counts
  // (record × linked/selected value) pairs rather than unique records,
  // which the UI should surface as a hint.
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const explode = params.groupBy.some((g) => {
    const field = fieldsById.get(g.fieldId);
    return field?.type === "relation" || (field ? isMultiSelectField(field) : false);
  });
  return ok({ buckets, nextCursor, explode });
};

export const aggregate = async (params: {
  tableId: string;
  filter?: FilterTree | null;
  search?: SearchSpec | null;
  recordMeta?: RecordMetaQuery | null;
  formulaWhere?: Expr | null;
  requests: AggregateRequest[];
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  viewer?: ExpansionViewer;
  dateConfig?: DateContext;
  fields?: Field[];
  signal?: AbortSignal;
  dedupeKey?: string;
  locale?: string;
}): Promise<Result<Record<string, unknown>>> => {
  const messages = getGridsCrudMessages(params.locale);
  const fields = params.fields ?? (await listFields(params.tableId));

  const filterCompiled = compileFilter(params.filter ?? null, fields, { timeZone: params.dateConfig?.timeZone });
  if (!filterCompiled.ok) return fail(err.badInput(messages.filterInvalid({ detail: filterCompiled.error })));
  const filterClause = renderClause(filterCompiled.clause);
  const formulaWhereCompiled = params.formulaWhere
    ? compileFormulaPredicateAstToSql(params.formulaWhere, {
        fields,
        recordAlias: "r",
        dateConfig: params.dateConfig,
      })
    : null;
  if (formulaWhereCompiled && !formulaWhereCompiled.ok) {
    return fail(err.badInput(messages.formulaWhereInvalid({ detail: formulaWhereCompiled.error })));
  }
  const searchCompiled = await compileSearchClause({
    search: params.search ?? null,
    fields,
    alias: "r",
    viewer: params.viewer,
  });
  const searchClause = searchCompiled.clause;
  const recordMetaClause = compileRecordMetaFilter(params.recordMeta ?? null);
  const needsDeletedRows = recordMetaRequiresDeletedRows(params.recordMeta ?? null);

  const aggCompiled = compileAggregates(params.requests, fields);
  if (!aggCompiled.ok) return fail(err.badInput(messages.aggregateInvalid({ detail: aggCompiled.error })));

  if (aggCompiled.columns.length === 0) return ok({});

  // Aggregate query: a single SELECT with all expressions side-by-side,
  // assembled into a JSON object so the result row has one column we can
  // index by `<fieldId>__<agg>`. The `${col.key}::text` cast is what
  // unblocks Postgres from "could not determine data type of parameter" —
  // jsonb_build_object's variadic-any signature otherwise leaves the key
  // parameter untyped at parse time.
  const jsonPairs = aggCompiled.columns.map((col) => sql`${col.key}::text, ${col.expr}`).reduce((acc, cur) => sql`${acc}, ${cur}`);

  // Live-parent JOIN — see records.list comment for rationale.
  const rows = await runBoundedQuery<{ result: Record<string, unknown> }>(
    sql`
      SELECT jsonb_build_object(${jsonPairs}) AS result
      FROM grids.records r
      JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
      JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
      WHERE r.table_id = ${params.tableId}::uuid
        AND ${params.deletedOnly || needsDeletedRows ? sql`r.deleted_at IS NOT NULL` : params.includeDeleted ? sql`TRUE` : sql`r.deleted_at IS NULL`}
        AND ${filterClause}
        AND ${formulaWhereCompiled?.ok ? formulaWhereCompiled.expression.sql : sql`TRUE`}
        AND ${searchClause}
        AND ${recordMetaClause}
    `,
    RECORD_QUERY_TIMEOUT_MS,
    params.signal,
    params.dedupeKey,
  );
  return ok(parseJsonbRow<Record<string, unknown>>(rows[0]?.result, {}));
};

/**
 * Reads a single record. Live-parent invariant: parent table AND base
 * must be alive. Also enforces `r.deleted_at IS NULL` (a trashed record
 * never resolves through this path; trash listings are explicit).
 */
export { get };
export const listActors = listRecordActors;

export { recordEventOutboxStats, redriveRecordEventOutbox } from "./record-event-outbox";
export { create, createMany, restore, softDelete, update } from "./record-write";
export { findTableId };
