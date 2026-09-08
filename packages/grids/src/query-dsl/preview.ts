import { createHash } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { DslQueryPreviewColumn, DslQueryPreviewDiagnostic, DslQueryPreviewResponse } from "../contracts";
import { decimalStringToCanonical } from "../formula/numeric";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "../service/audit";
import { runBoundedQuery } from "../service/bounded-query";
import { buildComputedFieldSqlMap } from "../service/computed-projections";
import { type FederatedRevisionScope, verifyRevisionScope } from "../service/federated-tables";
import { isMultiSelectField, storageOf } from "../service/field-storage";
import { buildPrincipalLabelCache, principalReferencesFromValue } from "../service/principal-values";
import { createReader } from "../service/record-read";
import { buildRelationLabelCacheForIds, type ExpansionViewer } from "../service/relations";
import { compileSearchClause } from "../service/search";
import type { DocumentTemplateAppData } from "../service/template-context";
import type { Field } from "../service/types";
import { type DslResolvedSqlQueryPlan, isDslAggregateOnlyPlan } from "./resolver";
import { type DslResultCursor, encodeDslResultCursor } from "./result-cursor";
import { collectDslPlanTableIds } from "./source-plan";
import type { DslSqlAggregateOutputColumn, DslSqlGroupOutputColumn, DslSqlOutputColumn } from "./sql-compiler";
import {
  compileDslAggregateQueryPlanToSql,
  compileDslDerivedViewSourcePlanToSql,
  compileDslGroupedQueryPlanToSql,
  compileDslQueryPlanToSql,
  dslDerivedJoinRecordAlias,
  dslJoinRecordAlias,
} from "./sql-compiler";
import type { DslSqlRecordSource } from "./sql-compiler-types";
import { buildDslSqlRecordSource } from "./sql-record-source";

type DslQueryPreviewSuccess = Extract<DslQueryPreviewResponse, { ok: true }>;
type DslQueryPreviewRow = DslQueryPreviewSuccess["rows"][number];

type DslQueryPreviewOptions = {
  client?: SqlClient;
  templateApp?: DocumentTemplateAppData;
  fieldsByTableId: Record<string, Field[]>;
  timeZone?: string;
  limit?: number;
  pageSize?: number;
  cursor?: DslResultCursor | null;
  cursorFingerprint?: string;
  cursorSigningKey?: string;
  maxRows?: number;
  /** Additional reader-controlled search compiled as a parameterized SQL
   * predicate after the published query plan has been verified. */
  runtimeSearch?: {
    q: string;
    primaryFieldIds: string[];
    joined: Array<{ tableId: string; joinAlias: string; fieldIds: string[] }>;
  };
  /** Optional serialized response budget used by bounded public consumers. */
  maxResultBytes?: number;
  /** Viewer for `search` over relation fields (target-table read scoping). */
  viewer?: ExpansionViewer;
  /** Records-table consumers need raw relation ids and build their existing
   * label cache separately. Query-style consumers default to display labels. */
  labelRelationValues?: boolean;
  /** Pins multi-page/internal consumers to the exact Combined revisions used
   * by their first statement. */
  expectedFederatedRevisionScope?: FederatedRevisionScope;
  onFederatedRevisionScope?: (scope: FederatedRevisionScope) => void;
  signal?: AbortSignal;
  /** Authorized tables reachable by this plan. Supplying the set makes a
   * missing table fail closed; omission is reserved for trusted internal calls. */
  authorizedTableIds?: ReadonlySet<string>;
  /** Explicit primary-source authorization, including saved-view access. */
  primaryTableAuthorized?: boolean;
};

const MAX_PREVIEW_ROWS = 500;
// Hard wall-clock cap for a single preview statement. A user can author an
// arbitrarily expensive query; cancellation keeps one slow query from holding
// a connection. 100k-row aggregates run well under it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATEMENT_TIMEOUT_CODE = "57014";
const FEDERATED_REVISION_ERROR_CODE = "P0001";
const GQL_RESULT_TOO_LARGE_MESSAGE = "GQL result is too large. Select fewer fields or use a smaller pageSize, then retry.";

const revisionScopeKey = (scope: FederatedRevisionScope): string =>
  scope
    .map((entry) => `${entry.tableId}:${entry.revisionId}:${entry.revisionToken}`)
    .sort()
    .join(",");

const queryExecutionKey = (
  mode: "aggregate" | "derived" | "grouped" | "rows",
  options: DslQueryPreviewOptions,
  revisionScope: FederatedRevisionScope,
  bounds: ReturnType<typeof pageBoundsForPlan>,
): string | undefined => {
  if (!options.cursorFingerprint) return undefined;
  const viewer = options.viewer;
  const payload = JSON.stringify(
    {
      bounds,
      cursor: options.cursor,
      fields: Object.entries(options.fieldsByTableId).sort(([left], [right]) => left.localeCompare(right)),
      fingerprint: options.cursorFingerprint,
      mode,
      revisions: revisionScopeKey(revisionScope),
      authorizedTableIds: options.authorizedTableIds ? [...options.authorizedTableIds].sort() : null,
      primaryTableAuthorized: options.primaryTableAuthorized ?? null,
      runtimeSearch: options.runtimeSearch ?? null,
      timeZone: options.timeZone ?? null,
      viewer: viewer
        ? {
            groups: [...viewer.userGroups].sort(),
            isAdmin: viewer.isAdmin ?? false,
            readableTableIds: viewer.readableTableIds ? [...viewer.readableTableIds].sort() : null,
            serviceAccountId: viewer.serviceAccountId ?? null,
            userId: viewer.userId,
          }
        : null,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  return createHash("sha256").update(payload).digest("base64url");
};

const asOptionalUuid = (value: string | undefined): string | undefined => (value && UUID_RE.test(value) ? value : undefined);

const asIso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const normalizeValue = (value: unknown, column?: { sqlType?: string }): unknown => {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && column?.sqlType === "numeric") return decimalStringToCanonical(value) ?? value;
  return value;
};

const rowValue = (row: Record<string, unknown>, column: { key: string; sqlType?: string }): unknown =>
  normalizeValue(row[column.key], column);

const rowColumns = (columns: DslSqlOutputColumn[]): DslQueryPreviewColumn[] =>
  columns.map((column) => ({
    key: column.key,
    label: column.label,
    ...(asOptionalUuid(column.tableId) ? { tableId: column.tableId } : {}),
    ...(asOptionalUuid(column.fieldId) ? { fieldId: column.fieldId } : {}),
    ...(column.joinAlias ? { joinAlias: column.joinAlias } : {}),
    type: column.type,
    sqlType: column.type === "relation" ? "uuid[]" : column.sqlType,
  }));

const groupColumns = (columns: DslSqlGroupOutputColumn[], tableId?: string): DslQueryPreviewColumn[] =>
  columns.map((column) => ({
    key: column.key,
    label: column.label,
    ...(column.kind === "group" && asOptionalUuid(column.tableId ?? tableId) ? { tableId: column.tableId ?? tableId } : {}),
    ...(asOptionalUuid(column.fieldId) ? { fieldId: column.fieldId } : {}),
    type: column.kind === "group" ? column.type : "aggregate",
    sqlType: column.kind === "group" && column.type === "relation" ? "uuid" : column.sqlType,
    ...(column.kind === "aggregate" ? { aggregate: column.agg } : {}),
  }));

const aggregateColumns = (columns: DslSqlAggregateOutputColumn[]): DslQueryPreviewColumn[] =>
  columns.map((column) => ({
    key: column.key,
    label: column.label,
    ...(asOptionalUuid(column.fieldId) ? { fieldId: column.fieldId } : {}),
    type: "aggregate",
    sqlType: column.sqlType,
    aggregate: column.agg,
  }));

const isGroupedPlan = (plan: DslResolvedSqlQueryPlan): boolean =>
  (plan.query.groupBy?.length ?? 0) > 0 ||
  (plan.sqlGroupBy?.length ?? 0) > 0 ||
  ((plan.joins?.length ?? 0) > 0 && ((plan.sqlAggregations?.length ?? 0) > 0 || (plan.formulaAggregations?.length ?? 0) > 0)) ||
  Boolean(plan.formulaHaving);

/** True when any group key is a multi-select / relation field, so one record
 *  contributes to several buckets (bucket totals can exceed record count). */
const groupExplodes = (plan: DslResolvedSqlQueryPlan, fieldsByTableId: Record<string, Field[]>): boolean => {
  const groups =
    (plan.sqlGroupBy?.length ?? 0) > 0
      ? (plan.sqlGroupBy ?? []).map((group) => ({ fieldId: group.fieldId, tableId: group.tableId }))
      : (plan.query.groupBy ?? []).map((group) => ({ fieldId: group.fieldId, tableId: plan.tableId }));

  return groups.some((group) => {
    const byId = new Map((fieldsByTableId[group.tableId] ?? []).map((field) => [field.id, field]));
    const field = byId.get(group.fieldId);
    if (!field) return false;
    const kind = storageOf(field).kind;
    return kind === "relationLink" || (kind === "jsonbArray" && isMultiSelectField(field));
  });
};

export const resolveDslPreviewLimit = (plan: DslResolvedSqlQueryPlan, requested: number | undefined, maxRows = MAX_PREVIEW_ROWS): number =>
  Math.min(Math.max(requested ?? plan.query.limit ?? 100, 1), maxRows);

const pageBoundsForPlan = (
  plan: DslResolvedSqlQueryPlan,
  options: DslQueryPreviewOptions,
): { pageSize: number; visibleLimit: number; start: number; fetchLimit: number; offset: number; cursorOffset?: number } => {
  const maxRows = options.maxRows ?? MAX_PREVIEW_ROWS;
  const requestedPageSize = options.pageSize ?? options.limit;
  const cursorPageSize = options.cursor?.pageSize;
  const pageSize = Math.min(
    Math.max(
      cursorPageSize === undefined
        ? (requestedPageSize ?? 100)
        : requestedPageSize === undefined
          ? cursorPageSize
          : Math.min(cursorPageSize, requestedPageSize),
      1,
    ),
    maxRows,
  );
  const start = options.cursor?.start ?? 0;
  const sourceLimit = plan.query.limit;
  const remaining = sourceLimit === undefined ? pageSize + 1 : Math.max(sourceLimit - start, 0);
  const visibleLimit = Math.min(pageSize, remaining);
  const fetchLimit = Math.min(visibleLimit + (sourceLimit === undefined || remaining > visibleLimit ? 1 : 0), maxRows + 1);
  const baseOffset = Math.max(plan.offset ?? 0, 0);
  const cursorOffset = options.cursor?.values === null ? baseOffset + start : undefined;
  return {
    pageSize,
    visibleLimit,
    start,
    fetchLimit: Math.max(fetchLimit, 1),
    offset: options.cursor ? 0 : baseOffset,
    ...(cursorOffset !== undefined ? { cursorOffset } : {}),
  };
};

const pageForRows = (
  rows: Record<string, unknown>[],
  bounds: ReturnType<typeof pageBoundsForPlan>,
  options: DslQueryPreviewOptions,
  cursorValuesFromRow?: (row: Record<string, unknown>) => unknown[],
  visibleCount = bounds.visibleLimit,
): { visible: Record<string, unknown>[]; page: NonNullable<DslQueryPreviewSuccess["page"]>; truncated: boolean } => {
  const visible = rows.slice(0, Math.min(bounds.visibleLimit, Math.max(0, visibleCount)));
  const hasNext = visible.length > 0 && rows.length > visible.length;
  const fingerprint = options.cursorFingerprint;
  const boundary = visible.at(-1);
  const nextCursor =
    fingerprint && hasNext && boundary && cursorValuesFromRow
      ? encodeDslResultCursor(
          {
            fingerprint,
            pageSize: bounds.pageSize,
            start: bounds.start + visible.length,
            values: cursorValuesFromRow(boundary),
          },
          options.cursorSigningKey ?? "",
        )
      : null;
  return {
    visible,
    truncated: hasNext,
    page: {
      size: bounds.pageSize,
      start: bounds.start,
      returned: visible.length,
      nextCursor,
    },
  };
};

const jsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const fitPagedResponse = (
  rows: Record<string, unknown>[],
  previewRows: DslQueryPreviewRow[],
  bounds: ReturnType<typeof pageBoundsForPlan>,
  options: DslQueryPreviewOptions,
  cursorValuesFromRow: ((row: Record<string, unknown>) => unknown[]) | undefined,
  build: (rows: DslQueryPreviewRow[], page: NonNullable<DslQueryPreviewSuccess["page"]>, truncated: boolean) => DslQueryPreviewSuccess,
): Result<DslQueryPreviewSuccess> => {
  const responseFor = (count: number): DslQueryPreviewSuccess => {
    const page = pageForRows(rows, bounds, options, cursorValuesFromRow, count);
    return build(previewRows.slice(0, page.visible.length), page.page, page.truncated);
  };
  const budget = options.maxResultBytes;
  if (budget === undefined) return ok(responseFor(previewRows.length));

  const full = responseFor(previewRows.length);
  if (jsonBytes(full) <= budget) return ok(full);
  if (previewRows.length === 0 || jsonBytes(responseFor(1)) > budget) {
    return fail(err.badInput(GQL_RESULT_TOO_LARGE_MESSAGE));
  }

  let low = 1;
  let high = previewRows.length - 1;
  let fitted = 1;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    if (jsonBytes(responseFor(count)) <= budget) {
      fitted = count;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return ok(responseFor(fitted));
};

const withPlanSpan = (message: string, span: { line: number; column: number; length: number } | undefined): DslQueryPreviewDiagnostic => ({
  ...(span ? { line: span.line, column: span.column, length: span.length } : {}),
  message,
});

const firstSpan = (spans: Array<{ line: number; column: number; length: number }> | undefined) => spans?.[0];

const spanForSelectError = (plan: DslResolvedSqlQueryPlan, message: string) => {
  const match = message.match(/^select "(.+?)":/);
  if (!match) return undefined;
  const key = normalizeRefKey(match[1]!);
  return plan.diagnosticSpans?.select?.find((item) => normalizeRefKey(item.label) === key)?.span;
};

const spanForAggregateError = (plan: DslResolvedSqlQueryPlan, message: string) => {
  const formulaMatch = message.match(/^formula aggregate "(.+?)":/);
  if (formulaMatch) {
    const key = normalizeRefKey(formulaMatch[1]!);
    return plan.diagnosticSpans?.aggregations?.find((item) => normalizeRefKey(item.alias) === key)?.span;
  }
  if (message.startsWith("query has no aggregate output") || message.includes("aggregate")) {
    return plan.diagnosticSpans?.aggregations?.[0]?.span;
  }
  return undefined;
};

const spanForGroupError = (plan: DslResolvedSqlQueryPlan, message: string) => {
  const fieldMatch = message.match(/^field "(.+?)"/);
  if (fieldMatch) {
    const key = normalizeRefKey(fieldMatch[1]!);
    return plan.diagnosticSpans?.groupBy?.find((item) => normalizeRefKey(item.label) === key)?.span;
  }
  if (message.toLowerCase().includes("group")) return plan.diagnosticSpans?.groupBy?.[0]?.span;
  return undefined;
};

export const dslPreviewDiagnosticForCompilerError = (plan: DslResolvedSqlQueryPlan, message: string): DslQueryPreviewDiagnostic => {
  const spans = plan.diagnosticSpans;
  const normalizedMessage = message.toLowerCase();
  const span =
    (normalizedMessage.startsWith("where:") ? spans?.where : undefined) ??
    (normalizedMessage.startsWith("having:") ? spans?.having : undefined) ??
    spanForSelectError(plan, message) ??
    spanForAggregateError(plan, message) ??
    spanForGroupError(plan, message) ??
    (normalizedMessage.includes("sort") || normalizedMessage.includes("order") ? firstSpan(spans?.sort) : undefined) ??
    (normalizedMessage.includes("search") ? spans?.search : undefined) ??
    (normalizedMessage.includes("source") ? spans?.source : undefined);
  return withPlanSpan(message, span);
};

const isTimeout = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("code" in error && (error as { code?: unknown }).code === STATEMENT_TIMEOUT_CODE) ||
    ("message" in error && String((error as { message?: unknown }).message).includes("statement timeout")));

const federatedRevisionMessage = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  if ((error as { code?: unknown }).code !== FEDERATED_REVISION_ERROR_CODE) return null;
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return message || "This combined table is unavailable because its published sources changed.";
};

const relationTargetTableId = (field: Field): string | undefined => {
  if (field.type !== "relation") return undefined;
  const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
  return typeof targetTableId === "string" && UUID_RE.test(targetTableId) ? targetTableId : undefined;
};

const relationIdsFromValue = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && UUID_RE.test(item));
  return typeof value === "string" && UUID_RE.test(value) ? [value] : [];
};

const labelRelationPreviewValues = async (
  rows: DslQueryPreviewRow[],
  columns: DslQueryPreviewColumn[],
  options: DslQueryPreviewOptions,
): Promise<{ rows: DslQueryPreviewRow[]; labeledColumnKeys: ReadonlySet<string> }> => {
  const relationColumnKeys = new Set<string>();
  const idsByTargetTable = new Map<string, Set<string>>();

  for (const column of columns) {
    if (column.type !== "relation" || !column.tableId || !column.fieldId) continue;
    const field = (options.fieldsByTableId[column.tableId] ?? []).find((candidate) => candidate.id === column.fieldId);
    if (!field) continue;
    const targetTableId = relationTargetTableId(field);
    if (!targetTableId) continue;

    relationColumnKeys.add(column.key);
    const ids = idsByTargetTable.get(targetTableId) ?? new Set<string>();
    for (const row of rows) {
      for (const id of relationIdsFromValue(row.values[column.key])) ids.add(id);
    }
    if (ids.size > 0) idsByTargetTable.set(targetTableId, ids);
  }

  if (idsByTargetTable.size === 0) return { rows, labeledColumnKeys: relationColumnKeys };
  const labels = await buildRelationLabelCacheForIds(idsByTargetTable, options.viewer, options.client);

  return {
    rows: rows.map((row) => {
      let values: Record<string, unknown> | undefined;
      for (const key of relationColumnKeys) {
        const value = row.values[key];
        const ids = relationIdsFromValue(value);
        if (ids.length === 0) continue;
        values ??= { ...row.values };
        values[key] = Array.isArray(value) ? ids.map((id) => labels[id] ?? "Unknown record") : (labels[ids[0]!] ?? "Unknown record");
      }
      return values ? { ...row, values } : row;
    }),
    labeledColumnKeys: relationColumnKeys,
  };
};

const labelPrincipalPreviewValues = async (
  rows: DslQueryPreviewRow[],
  columns: DslQueryPreviewColumn[],
  options: DslQueryPreviewOptions,
): Promise<DslQueryPreviewRow[]> => {
  const keys = columns.filter((column) => column.type === "principal").map((column) => column.key);
  if (keys.length === 0) return rows;
  const references = rows.flatMap((row) => keys.flatMap((key) => principalReferencesFromValue(row.values[key])));
  if (references.length === 0) return rows;
  const labels = await buildPrincipalLabelCache(references, options.viewer?.userId ?? null);
  return rows.map((row) => ({
    ...row,
    values: Object.fromEntries(
      Object.entries(row.values).map(([key, value]) => {
        if (!keys.includes(key)) return [key, value];
        const principals = principalReferencesFromValue(value);
        return [key, principals.map((principal) => labels[principal.id] ?? (principal.type === "user" ? "Private user" : "Private group"))];
      }),
    ),
  }));
};

const labelPreviewValues = async (
  rows: DslQueryPreviewRow[],
  columns: DslQueryPreviewColumn[],
  options: DslQueryPreviewOptions,
): Promise<{ rows: DslQueryPreviewRow[]; columns: DslQueryPreviewColumn[] }> => {
  const relations = await labelRelationPreviewValues(rows, columns, options);
  return {
    rows: await labelPrincipalPreviewValues(relations.rows, columns, options),
    columns: columns.map((column) =>
      relations.labeledColumnKeys.has(column.key) ? { ...column, sqlType: column.sqlType === "uuid[]" ? "text[]" : "text" } : column,
    ),
  };
};

const hydrateHtmlTemplatePreviewValues = async (
  rows: DslQueryPreviewRow[],
  columns: DslQueryPreviewColumn[],
  plan: DslResolvedSqlQueryPlan,
  options: DslQueryPreviewOptions,
): Promise<DslQueryPreviewRow[]> => {
  const templateColumns = columns.filter(
    (column) => column.type === "html_template" && !column.joinAlias && column.tableId === plan.tableId && column.fieldId,
  );
  if (templateColumns.length === 0) return rows;
  const ids = [...new Set(rows.flatMap((row) => (row.recordId ? [row.recordId] : [])))];
  if (ids.length === 0) return rows;
  const reader = await createReader(plan.tableId, {
    client: options.client,
    templateApp: options.templateApp,
    fields: options.fieldsByTableId[plan.tableId] ?? [],
    dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
    viewer: options.viewer,
    htmlTemplateFieldIds: templateColumns.map((column) => column.fieldId!),
    signal: options.signal,
    queryTimeoutMs: 5_000,
  });
  const records = new Map((await reader.getMany(ids)).map((record) => [record.id, record]));
  return rows.map((row) => {
    const record = row.recordId ? records.get(row.recordId) : undefined;
    if (!record) return row;
    return {
      ...row,
      values: {
        ...row.values,
        ...Object.fromEntries(templateColumns.map((column) => [column.key, record.data[column.fieldId!] ?? null])),
      },
    };
  });
};

const joinOr = (parts: unknown[]): unknown => parts.slice(1).reduce((acc, part) => sql`${acc} OR ${part}`, parts[0]!);

const compileDslSearchClause = async (
  plan: DslResolvedSqlQueryPlan,
  options: DslQueryPreviewOptions,
  relationSource: "links" | "recordData",
  recordSourcesByTableId: Map<string, DslSqlRecordSource>,
): Promise<{ clause: unknown } | undefined> => {
  const clauses: unknown[] = [];
  if (plan.query.search) {
    clauses.push(
      (
        await compileSearchClause({
          client: options.client,
          search: plan.query.search,
          fields: options.fieldsByTableId[plan.tableId] ?? [],
          viewer: options.viewer,
          relationSource,
          recordSourcesByTableId,
        })
      ).clause,
    );
  }

  for (const search of plan.sqlSearch ?? []) {
    const joinIndex = (plan.joins ?? []).findIndex((join) => join.alias === search.joinAlias);
    if (joinIndex < 0) return { clause: sql`FALSE` };
    clauses.push(
      (
        await compileSearchClause({
          client: options.client,
          search: { q: search.q, fieldIds: search.fieldIds },
          fields: options.fieldsByTableId[search.tableId] ?? [],
          alias: dslJoinRecordAlias(joinIndex),
          viewer: options.viewer,
          relationSource: recordSourcesByTableId.has(search.tableId) ? "recordData" : "links",
          recordSourcesByTableId,
        })
      ).clause,
    );
  }

  const derived = plan.derivedViewSource;
  if (derived) {
    for (const search of derived.joinedSearch ?? []) {
      const derivedJoinIndex = (derived.joins ?? []).findIndex((join) => join.alias === search.joinAlias);
      const relationJoinIndex = (derived.relationJoins ?? []).findIndex((join) => join.alias === search.joinAlias);
      const alias =
        derivedJoinIndex >= 0
          ? dslDerivedJoinRecordAlias(derivedJoinIndex)
          : relationJoinIndex >= 0
            ? dslJoinRecordAlias(relationJoinIndex)
            : null;
      if (!alias) return { clause: sql`FALSE` };
      clauses.push(
        (
          await compileSearchClause({
            client: options.client,
            search: { q: search.q, fieldIds: search.fieldIds },
            fields: options.fieldsByTableId[search.tableId] ?? [],
            alias,
            viewer: options.viewer,
            relationSource: recordSourcesByTableId.has(search.tableId) ? "recordData" : "links",
            recordSourcesByTableId,
          })
        ).clause,
      );
    }
  }

  if (clauses.length === 0) return undefined;
  return { clause: sql`(${joinOr(clauses)})` };
};

const compileRuntimeSearchClause = async (
  plan: DslResolvedSqlQueryPlan,
  options: DslQueryPreviewOptions,
  relationSource: "links" | "recordData",
  recordSourcesByTableId: Map<string, DslSqlRecordSource>,
): Promise<{ clause: unknown } | undefined> => {
  const search = options.runtimeSearch;
  if (!search?.q.trim()) return undefined;
  const clauses: unknown[] = [];
  if (search.primaryFieldIds.length > 0) {
    clauses.push(
      (
        await compileSearchClause({
          client: options.client,
          search: { q: search.q, fieldIds: search.primaryFieldIds },
          fields: options.fieldsByTableId[plan.tableId] ?? [],
          viewer: options.viewer,
          relationSource,
          recordSourcesByTableId,
        })
      ).clause,
    );
  }
  for (const joined of search.joined) {
    const joinIndex = (plan.joins ?? []).findIndex((join) => join.alias === joined.joinAlias && join.tableId === joined.tableId);
    if (joinIndex < 0) continue;
    clauses.push(
      (
        await compileSearchClause({
          client: options.client,
          search: { q: search.q, fieldIds: joined.fieldIds },
          fields: options.fieldsByTableId[joined.tableId] ?? [],
          alias: dslJoinRecordAlias(joinIndex),
          viewer: options.viewer,
          relationSource: recordSourcesByTableId.has(joined.tableId) ? "recordData" : "links",
          recordSourcesByTableId,
        })
      ).clause,
    );
  }
  if (clauses.length === 0) return { clause: sql`FALSE` };
  return { clause: sql`(${joinOr(clauses)})` };
};

export const previewDslQuery = async (
  plan: DslResolvedSqlQueryPlan,
  options: DslQueryPreviewOptions,
): Promise<Result<DslQueryPreviewSuccess>> => {
  const bounds = pageBoundsForPlan(plan, options);

  try {
    const sourceTableIds = collectDslPlanTableIds(plan, options.fieldsByTableId);
    const recordSourcesByTableId = new Map(
      (
        await Promise.all(
          sourceTableIds.map(async (tableId) => {
            const physicalSource = await buildDslSqlRecordSource(
              tableId,
              options.fieldsByTableId,
              tableId === plan.tableId
                ? {
                    ...(plan.query.filter ? { filter: plan.query.filter } : {}),
                    ...(plan.wherePredicate ? { wherePredicate: plan.wherePredicate } : {}),
                    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
                    ...(plan.query.includeDeleted ? { includeDeleted: true } : {}),
                    ...(plan.query.deletedOnly ? { deletedOnly: true } : {}),
                  }
                : undefined,
              options.client,
            );
            const isPrimary = tableId === plan.tableId;
            const authorized =
              isPrimary && options.primaryTableAuthorized !== undefined
                ? options.primaryTableAuthorized
                : options.authorizedTableIds?.has(tableId);
            const authorizationRequired =
              (isPrimary && options.primaryTableAuthorized !== undefined) || options.authorizedTableIds !== undefined;
            if (!authorizationRequired || authorized === true) return [tableId, physicalSource] as const;

            const baseRelation = physicalSource?.relation ?? sql`grids.records`;
            const relation = sql`(
                SELECT access_record.*
                FROM ${baseRelation} access_record
                WHERE access_record.table_id = ${tableId}::uuid
                  AND FALSE
              )`;
            const source: DslSqlRecordSource = physicalSource
              ? { ...physicalSource, relation }
              : { kind: "stored", tableId, relation, relationMappings: [] };
            return [tableId, source] as const;
          }),
        )
      ).filter((entry): entry is readonly [string, DslSqlRecordSource] => entry[1] !== null),
    );
    const revisionScope = [...recordSourcesByTableId]
      .filter((entry) => entry[1].kind === "federated")
      .map(([tableId, source]) => ({
        tableId,
        revisionId: source.kind === "federated" ? source.revisionId : "",
        revisionToken: source.kind === "federated" ? source.revisionToken : "",
      }));
    if (
      options.expectedFederatedRevisionScope &&
      revisionScopeKey(revisionScope) !== revisionScopeKey(options.expectedFederatedRevisionScope)
    ) {
      return fail(err.conflict("combined table publication changed while the query was running; retry the query"));
    }
    options.onFederatedRevisionScope?.(revisionScope);
    const finish = async (response: DslQueryPreviewSuccess): Promise<Result<DslQueryPreviewSuccess>> => {
      if (options.maxResultBytes !== undefined && jsonBytes(response) > options.maxResultBytes) {
        return fail(err.badInput(GQL_RESULT_TOO_LARGE_MESSAGE));
      }
      const current = await verifyRevisionScope(revisionScope, undefined, options.client);
      return current.ok ? ok(response) : fail(current.error);
    };
    const recordSource = recordSourcesByTableId.get(plan.tableId);
    // Full-text search compiles async (relation search batch-reads target
    // labels with the viewer's read scope), so it's built once here and handed
    // to the synchronous SQL compilers as a ready predicate.
    const publishedSearchClause = (
      await compileDslSearchClause(plan, options, recordSource ? "recordData" : "links", recordSourcesByTableId)
    )?.clause;
    const runtimeSearchClause = (
      await compileRuntimeSearchClause(plan, options, recordSource ? "recordData" : "links", recordSourcesByTableId)
    )?.clause;
    const searchClause =
      publishedSearchClause && runtimeSearchClause
        ? sql`(${publishedSearchClause}) AND (${runtimeSearchClause})`
        : (publishedSearchClause ?? runtimeSearchClause);
    const viewSourceSearch = plan.viewSourceQuery?.search ?? plan.derivedViewSource?.query.search;
    const viewSourceSearchClause = viewSourceSearch
      ? (
          await compileSearchClause({
            client: options.client,
            search: viewSourceSearch,
            fields: options.fieldsByTableId[plan.tableId] ?? [],
            viewer: options.viewer,
            relationSource: recordSource ? "recordData" : "links",
            recordSourcesByTableId,
          })
        ).clause
      : undefined;
    // Lookup/rollup SQL (cross-table correlated subqueries) is built once and
    // handed to the compilers so those fields work in select / sort / filter /
    // formulas — same values as the records pipeline.
    const authorizedComputedTableIds = new Set(plan.readableTableIds.filter((tableId) => options.authorizedTableIds?.has(tableId) ?? true));
    const computedFieldSql = await buildComputedFieldSqlMap(options.fieldsByTableId[plan.tableId] ?? [], {
      client: options.client,
      authorizedTableIds: authorizedComputedTableIds,
    });
    const computedFieldSqlByJoinAlias = new Map<string, Awaited<ReturnType<typeof buildComputedFieldSqlMap>>>();
    for (const [index, join] of (plan.joins ?? []).entries()) {
      const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
        client: options.client,
        recordAlias: dslJoinRecordAlias(index),
        authorizedTableIds: authorizedComputedTableIds,
      });
      if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
    }
    for (const [index, join] of (plan.derivedViewSource?.joins ?? []).entries()) {
      const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
        client: options.client,
        recordAlias: dslDerivedJoinRecordAlias(index),
        authorizedTableIds: authorizedComputedTableIds,
      });
      if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
    }
    for (const [index, join] of (plan.derivedViewSource?.relationJoins ?? []).entries()) {
      const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
        client: options.client,
        recordAlias: dslJoinRecordAlias(index),
        authorizedTableIds: authorizedComputedTableIds,
      });
      if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
    }
    const compileInputs = {
      searchClause,
      computedFieldSql,
      computedFieldSqlByJoinAlias,
      viewSourceSearchClause,
      recordSourcesByTableId,
      ...(recordSource ? { recordSource } : {}),
    };

    if (plan.derivedViewSource) {
      const compiled = compileDslDerivedViewSourcePlanToSql(plan, {
        ...options,
        ...compileInputs,
        limit: bounds.fetchLimit,
        offset: bounds.offset,
        cursorOffset: bounds.cursorOffset,
        cursorValues: options.cursor?.values ?? undefined,
      });
      if (!compiled.ok) return fail(err.badInput(compiled.error));

      const rows = await runBoundedQuery<Record<string, unknown>>(
        compiled.query.sql,
        5_000,
        options.signal,
        queryExecutionKey("derived", options, revisionScope, bounds),
        options.client,
      );
      const { visible } = pageForRows(rows, bounds, options, compiled.query.cursorValuesFromRow);
      const columns = groupColumns(compiled.query.columns, plan.tableId);
      const previewRows = visible.map((row) => ({
        values: Object.fromEntries(columns.map((column) => [column.key, rowValue(row, column)])),
      }));
      const display =
        options.labelRelationValues === false ? { rows: previewRows, columns } : await labelPreviewValues(previewRows, columns, options);
      const bounded = fitPagedResponse(
        rows,
        display.rows,
        bounds,
        options,
        compiled.query.cursorValuesFromRow,
        (pageRows, page, truncated) => ({
          ok: true,
          mode: "groups",
          columns: display.columns,
          rows: pageRows,
          limit: bounds.pageSize,
          truncated,
          page,
        }),
      );
      return bounded.ok ? finish(bounded.data) : bounded;
    }

    if (isGroupedPlan(plan)) {
      const compiled = compileDslGroupedQueryPlanToSql(plan, {
        ...options,
        ...compileInputs,
        limit: bounds.fetchLimit,
        offset: bounds.offset,
        cursorOffset: bounds.cursorOffset,
        cursorValues: options.cursor?.values ?? undefined,
      });
      if (!compiled.ok) return fail(err.badInput(compiled.error));

      const rows = await runBoundedQuery<Record<string, unknown>>(
        compiled.query.sql,
        5_000,
        options.signal,
        queryExecutionKey("grouped", options, revisionScope, bounds),
        options.client,
      );
      const { visible } = pageForRows(rows, bounds, options, compiled.query.cursorValuesFromRow);
      const columns = groupColumns(compiled.query.columns, (plan.joins?.length ?? 0) === 0 ? plan.tableId : undefined);
      const previewRows = visible.map((row) => ({
        values: Object.fromEntries(columns.map((column) => [column.key, rowValue(row, column)])),
      }));
      const display =
        options.labelRelationValues === false ? { rows: previewRows, columns } : await labelPreviewValues(previewRows, columns, options);
      const bounded = fitPagedResponse(
        rows,
        display.rows,
        bounds,
        options,
        compiled.query.cursorValuesFromRow,
        (pageRows, page, truncated) => ({
          ok: true,
          mode: "groups",
          columns: display.columns,
          rows: pageRows,
          limit: bounds.pageSize,
          truncated,
          page,
          ...(groupExplodes(plan, options.fieldsByTableId) ? { explode: true } : {}),
        }),
      );
      return bounded.ok ? finish(bounded.data) : bounded;
    }

    if (isDslAggregateOnlyPlan(plan)) {
      const compiled = compileDslAggregateQueryPlanToSql(plan, { ...options, ...compileInputs, limit: 1 });
      if (!compiled.ok) return fail(err.badInput(compiled.error));

      const rows = await runBoundedQuery<{ result: Record<string, unknown> }>(
        compiled.query.sql,
        5_000,
        options.signal,
        queryExecutionKey("aggregate", options, revisionScope, bounds),
        options.client,
      );
      const columns = aggregateColumns(compiled.query.columns);
      return finish({
        ok: true,
        mode: "groups",
        columns,
        rows: [
          {
            values: Object.fromEntries(columns.map((column) => [column.key, normalizeValue(rows[0]?.result?.[column.key], column)])),
          },
        ],
        limit: 1,
        truncated: false,
        page: {
          size: 1,
          start: 0,
          returned: 1,
          nextCursor: null,
        },
      });
    }

    const compiled = compileDslQueryPlanToSql(plan, {
      ...options,
      ...compileInputs,
      limit: bounds.fetchLimit,
      offset: bounds.offset,
      cursorOffset: bounds.cursorOffset,
      cursorValues: options.cursor?.values ?? undefined,
    });
    if (!compiled.ok) return fail(err.badInput(compiled.error));

    const rows = await runBoundedQuery<Record<string, unknown>>(
      compiled.query.sql,
      5_000,
      options.signal,
      queryExecutionKey("rows", options, revisionScope, bounds),
      options.client,
    );
    const { visible } = pageForRows(rows, bounds, options, compiled.query.cursorValuesFromRow);
    const columns = rowColumns(compiled.query.columns);
    const previewRows = visible.map((row) => ({
      ...(typeof row.__record_id === "string" && UUID_RE.test(row.__record_id) ? { recordId: row.__record_id } : {}),
      ...(typeof row.__table_id === "string" && UUID_RE.test(row.__table_id) ? { tableId: row.__table_id } : {}),
      ...(typeof row.__record_version === "number" && asIso(row.__record_created_at) && asIso(row.__record_updated_at)
        ? {
            recordMeta: {
              version: row.__record_version,
              finalizedAt: asIso(row.__record_finalized_at),
              finalizedBy:
                typeof row.__record_finalized_by === "string" && UUID_RE.test(row.__record_finalized_by) ? row.__record_finalized_by : null,
              deletedAt: asIso(row.__record_deleted_at),
              createdBy:
                typeof row.__record_created_by === "string" && UUID_RE.test(row.__record_created_by) ? row.__record_created_by : null,
              updatedBy:
                typeof row.__record_updated_by === "string" && UUID_RE.test(row.__record_updated_by) ? row.__record_updated_by : null,
              createdAt: asIso(row.__record_created_at)!,
              updatedAt: asIso(row.__record_updated_at)!,
            },
          }
        : {}),
      values: Object.fromEntries(columns.map((column) => [column.key, rowValue(row, column)])),
    }));
    const hydratedRows = await hydrateHtmlTemplatePreviewValues(previewRows, columns, plan, options);
    const display =
      options.labelRelationValues === false ? { rows: hydratedRows, columns } : await labelPreviewValues(hydratedRows, columns, options);
    const bounded = fitPagedResponse(
      rows,
      display.rows,
      bounds,
      options,
      compiled.query.cursorValuesFromRow,
      (pageRows, page, truncated) => ({
        ok: true,
        mode: "rows",
        columns: display.columns,
        rows: pageRows,
        limit: bounds.pageSize,
        truncated,
        page,
      }),
    );
    return bounded.ok ? finish(bounded.data) : bounded;
  } catch (error) {
    if (isTimeout(error)) return fail(err.badInput("This query took too long (over 5s). Add a filter or a smaller limit and try again."));
    const revisionMessage = federatedRevisionMessage(error);
    if (revisionMessage) return fail(err.badInput(revisionMessage));
    throw error;
  }
};
