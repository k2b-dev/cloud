import { createHash } from "node:crypto";
import { ok } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale, jsonResponse } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import type { ClientErrorStatusCode, ServerErrorStatusCode } from "hono/utils/http-status";
import { describeRoute } from "hono-openapi";
import type { infer as ZodInfer } from "zod";
import type { ComputedColumnSpec, DslQueryPreviewResponse, GridRecord, RecordQuery, TableQueryResponseSchema } from "../contracts";
import { gridsService } from "../service";
import { isBoundedQueryTimeoutError } from "../service/bounded-query";
import { verifyRevisionScope } from "../service/federated-tables";
import type { GroupAggregationSpec } from "../service/group-compiler";
import { buildPrincipalLabelCache, principalReferencesFromRecords } from "../service/principal-values";
import { projectPublicIds } from "../service/public-resources";
import { validateRecordQueryForFields } from "../service/query-validation";
import { compileGqlToRecordQuery, executeRecordQuery } from "./gql-runtime";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { PublicTableQueryResponseSchema, toPublicTableQueryResponse } from "./public-dto";
import { fromPublicRecordQuery, type PublicTableQueryBody, PublicTableQueryBodySchema } from "./public-query";
import { queryAdmissionMiddleware } from "./query-admission";
import { publicIdParam } from "./route-params";
import { v } from "./validator";

type TableQueryBody = Omit<PublicTableQueryBody, "query" | "filePreviewFieldIds"> & { query?: RecordQuery; filePreviewFieldIds?: string[] };
type TableQueryResponse = ZodInfer<typeof TableQueryResponseSchema>;
type RouteFailure = { ok: false; status: ClientErrorStatusCode | ServerErrorStatusCode; message: string };
type RouteSuccess<T> = { ok: true; data: T };
type ResolvedQuery = {
  query: RecordQuery;
  fields: Awaited<ReturnType<typeof gridsService.field.listByTable>> | null;
  readableTableIds: readonly string[] | null;
};
type QueryView = {
  id: string;
  tableId: string;
  ownerUserId: string | null;
  source: string;
  ui?: { columns?: RecordQuery["columns"]; groupedColumnOrder?: string[]; hiddenGroupedColumns?: string[] };
};
type QueryTarget = {
  table: { id: string; baseId: string; kind: "stored" | "federated" };
  view: QueryView | null;
};

type TableQueryRouteDeps = {
  service: typeof gridsService;
  compileGql: typeof compileGqlToRecordQuery;
  executeQuery: typeof executeRecordQuery;
  validateQuery: typeof validateRecordQueryForFields;
  dateConfig: typeof getDateConfig;
  gate: typeof gateAt;
  viewer: typeof currentActorViewer;
  verifyFederatedRevision: typeof verifyRevisionScope;
};

const defaultDeps: TableQueryRouteDeps = {
  service: gridsService,
  compileGql: compileGqlToRecordQuery,
  executeQuery: executeRecordQuery,
  validateQuery: validateRecordQueryForFields,
  dateConfig: getDateConfig,
  gate: gateAt,
  viewer: currentActorViewer,
  verifyFederatedRevision: verifyRevisionScope,
};

const withoutLimit = (query: RecordQuery): RecordQuery => {
  const { limit: _limit, ...rest } = query;
  return rest;
};

const withoutFooterAggregations = (query: RecordQuery): RecordQuery => {
  if ((query.groupBy?.length ?? 0) > 0) return query;
  const { aggregations: _aggregations, ...rest } = query;
  return rest;
};

const tableQueryExecutionKey = (params: {
  target: QueryTarget;
  query: RecordQuery;
  body: TableQueryBody;
  tableFields: Awaited<ReturnType<typeof gridsService.field.listByTable>>;
  viewer: ReturnType<typeof currentActorViewer> & { readableTableIds?: ReadonlySet<string> };
  dateConfig: Awaited<ReturnType<typeof getDateConfig>>;
}): string => {
  const payload = JSON.stringify(
    {
      body: params.body,
      dateConfig: params.dateConfig,
      fields: params.tableFields,
      query: params.query,
      target: params.target,
      viewer: {
        groups: [...params.viewer.userGroups].sort(),
        readableTableIds: params.viewer.readableTableIds ? [...params.viewer.readableTableIds].sort() : null,
        serviceAccountId: params.viewer.serviceAccountId ?? null,
        userId: params.viewer.userId,
      },
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
  );
  return createHash("sha256").update(payload).digest("base64url");
};

const previewError = (response: DslQueryPreviewResponse): RouteFailure | null =>
  response.ok ? null : fail(400, response.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "invalid GQL query");

const gridRecordForPreviewRow = (
  row: Extract<DslQueryPreviewResponse, { ok: true }>["rows"][number],
  columns: Extract<DslQueryPreviewResponse, { ok: true }>["columns"],
  query: RecordQuery,
  tableId: string,
  recordPublicIds: ReadonlyMap<string, string>,
): GridRecord | null => {
  if (!row.recordId || !row.recordMeta) return null;
  const shortId = recordPublicIds.get(row.recordId);
  if (!shortId) return null;
  const data: Record<string, unknown> = {};
  for (const [index, column] of columns.entries()) {
    const queryColumn = query.columns?.[index];
    const key = column.fieldId ?? (queryColumn && "kind" in queryColumn && queryColumn.kind === "computed" ? queryColumn.id : undefined);
    if (key) data[key] = row.values[column.key];
  }
  return {
    id: row.recordId,
    shortId,
    tableId,
    data,
    ...row.recordMeta,
  };
};

const runFederatedQuery = async (
  c: Context<AuthContext>,
  deps: TableQueryRouteDeps,
  params: {
    target: QueryTarget;
    query: RecordQuery;
    body: TableQueryBody;
    tableFields: Awaited<ReturnType<typeof gridsService.field.listByTable>>;
    viewer: ReturnType<typeof currentActorViewer>;
  },
): Promise<RouteSuccess<TableQueryResponse> | RouteFailure> => {
  const { target, query, body, tableFields, viewer } = params;
  const pageQuery = withoutLimit(withoutFooterAggregations(query));
  const executed = await deps.executeQuery(
    c,
    target.table.baseId,
    {
      query: pageQuery,
      currentTableId: target.table.id,
      cursor: body.cursor,
      pageSize: Math.min(Math.max(query.limit ?? 100, 1), 1000),
      surface: "records-view",
    },
    { operation: "execute", labelRelationValues: false, maxRows: 1000 },
  );
  const response = executed.response;
  const error = previewError(response);
  if (error) return error;
  if (!response.ok) return fail(400, "invalid GQL query");
  const revisionScope = executed.revisionScope ?? [];

  const nextCursor = response.page?.nextCursor ?? null;
  if (response.mode === "groups") {
    const groupColumns = response.columns.filter((column) => column.aggregate === undefined);
    const aggregateColumns = response.columns.filter((column) => column.aggregate !== undefined);
    const buckets = response.rows.map((row) => ({
      keys: groupColumns.map((column) => row.values[column.key]),
      values: Object.fromEntries(aggregateColumns.map((column) => [column.key, row.values[column.key]])),
    }));
    const relationLabels = await deps.service.relations.buildLabelCacheForGroupedKeys(
      buckets,
      (query.groupBy ?? []).map((group) => group.fieldId),
      tableFields,
      viewer,
    );
    return {
      ok: true,
      data: {
        buckets,
        nextCursor,
        relationLabels,
        ...(response.explode ? { explode: true } : {}),
      },
    };
  }

  const recordPublicIds = await projectPublicIds(
    "record",
    response.rows.flatMap((row) => (row.recordId ? [row.recordId] : [])),
  );
  const items = response.rows.flatMap((row) => {
    const record = gridRecordForPreviewRow(row, response.columns, pageQuery, target.table.id, recordPublicIds);
    return record ? [record] : [];
  });
  const relationLabels = {
    ...(await deps.service.relations.buildLabelCache(items, tableFields, viewer)),
    ...(await buildPrincipalLabelCache(principalReferencesFromRecords(items, tableFields), viewer.userId)),
  };
  let aggregates: Record<string, unknown> | undefined;
  if ((query.aggregations?.length ?? 0) > 0) {
    const aggregateQuery = withoutLimit({
      ...query,
      columns: undefined,
      groupBy: undefined,
      groupSort: undefined,
      sort: undefined,
    });
    const aggregateExecution = await deps.executeQuery(
      c,
      target.table.baseId,
      {
        query: aggregateQuery,
        currentTableId: target.table.id,
        surface: "records-view",
      },
      {
        operation: "execute",
        labelRelationValues: false,
        maxRows: 1,
        expectedFederatedRevisionScope: revisionScope,
      },
    );
    const aggregateError = previewError(aggregateExecution.response);
    if (aggregateError) {
      const current = await deps.verifyFederatedRevision(revisionScope);
      if (!current.ok) return fail(409, current.error.message);
      return aggregateError;
    }
    if (aggregateExecution.response.ok) aggregates = aggregateExecution.response.rows[0]?.values ?? {};
  }
  let filePreviews: TableQueryResponse["filePreviews"];
  if (body.filePreviewFieldIds && body.filePreviewFieldIds.length > 0) {
    try {
      filePreviews = await deps.service.file.listFirstImagePreviews({
        tableId: target.table.id,
        recordIds: items.map((item) => item.id),
        fieldIds: body.filePreviewFieldIds,
        expectedFederatedRevisionScope: revisionScope,
      });
    } catch (error) {
      const current = await deps.verifyFederatedRevision(revisionScope);
      if (!current.ok) return fail(409, current.error.message);
      throw error;
    }
  }
  const currentRevision = await deps.verifyFederatedRevision(revisionScope);
  if (!currentRevision.ok) return fail(409, currentRevision.error.message);
  return { ok: true, data: { items, aggregates, nextCursor, relationLabels, filePreviews } };
};

const fail = (status: RouteFailure["status"], message: string): RouteFailure => ({ ok: false, status, message });

const viewUiPresentation = (view: QueryView): RecordQuery => ({
  ...(view.ui?.columns ? { columns: view.ui.columns } : {}),
  ...(view.ui?.groupedColumnOrder ? { groupedColumnOrder: view.ui.groupedColumnOrder } : {}),
  ...(view.ui?.hiddenGroupedColumns ? { hiddenGroupedColumns: view.ui.hiddenGroupedColumns } : {}),
});

const loadQueryTarget = async (
  c: Context<AuthContext>,
  deps: TableQueryRouteDeps,
  tablePublicId: string,
  viewPublicId: string | undefined,
): Promise<RouteSuccess<QueryTarget> | RouteFailure> => {
  const table = await deps.service.table.getByShortId(tablePublicId);
  if (!table) return fail(404, "Table not found");

  const view = viewPublicId ? await deps.service.view.getByShortIdForTable(table.id, viewPublicId) : null;
  if (viewPublicId && !view) return fail(404, "View not found");

  const gate = await deps.gate(c, { baseId: table.baseId }, "read");
  if (!gate.ok) return fail(403, gate.error.message);
  return { ok: true, data: { table, view } };
};

const resolveQuery = async (
  c: Context<AuthContext>,
  deps: TableQueryRouteDeps,
  target: QueryTarget,
  body: TableQueryBody,
): Promise<RouteSuccess<ResolvedQuery> | RouteFailure> => {
  const { table, view } = target;
  // The records UI sends its complete effective query, including view/URL
  // overrides. A view ID identifies the validated context, not a hidden filter.
  const source = body.source ?? (body.query === undefined ? view?.source : undefined);
  const compiled =
    source !== undefined
      ? await deps.compileGql(c, {
          baseId: table.baseId,
          tableId: table.id,
          source,
          ...(body.query ? { presentation: body.query } : view ? { presentation: viewUiPresentation(view) } : {}),
        })
      : null;
  if (compiled && !compiled.ok) {
    return fail(400, compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; ") || "invalid GQL source");
  }

  const query = compiled?.ok ? compiled.query : body.query;
  if (!query) return fail(400, "source or query is required");
  return {
    ok: true,
    data: {
      query,
      fields: compiled?.ok ? compiled.fields : null,
      readableTableIds: compiled?.ok ? (compiled.readableTableIds ?? null) : null,
    },
  };
};

const runGroupedQuery = async (
  deps: TableQueryRouteDeps,
  params: {
    target: QueryTarget;
    query: RecordQuery;
    body: TableQueryBody;
    tableFields: Awaited<ReturnType<typeof gridsService.field.listByTable>>;
    viewer: ReturnType<typeof currentActorViewer>;
    dateConfig: Awaited<ReturnType<typeof getDateConfig>>;
    signal: AbortSignal;
    dedupeKey: string;
  },
): Promise<RouteSuccess<TableQueryResponse> | RouteFailure> => {
  const { target, query, body, tableFields, viewer, dateConfig } = params;
  const unsupported = (query.aggregations ?? []).some((item) => item.agg === "median" || item.agg === "earliest" || item.agg === "latest");
  if (unsupported) {
    return fail(400, "grouped queries support count, countEmpty, countUnique, sum, avg, min, and max only");
  }

  const result = await deps.service.record.group({
    tableId: target.table.id,
    groupBy: query.groupBy!,
    aggregations: (query.aggregations ?? []) as GroupAggregationSpec[],
    groupSort: query.groupSort,
    filter: query.filter ?? null,
    search: query.search ?? null,
    recordMeta: query.recordMeta ?? null,
    cursor: body.cursor ?? null,
    limit: query.limit,
    includeDeleted: query.includeDeleted,
    deletedOnly: query.deletedOnly,
    viewer,
    dateConfig,
    fields: tableFields,
    signal: params.signal,
    dedupeKey: `${params.dedupeKey}:group`,
  });
  if (!result.ok) return fail(result.error.status, result.error.message);
  const relationLabels = await deps.service.relations.buildLabelCacheForGroupedKeys(
    result.data.buckets,
    query.groupBy!.map((group) => group.fieldId),
    tableFields,
    viewer,
  );
  return {
    ok: true,
    data: {
      buckets: result.data.buckets,
      nextCursor: result.data.nextCursor,
      explode: result.data.explode,
      relationLabels,
    },
  };
};

const runListQuery = async (
  deps: TableQueryRouteDeps,
  params: {
    target: QueryTarget;
    query: RecordQuery;
    body: TableQueryBody;
    tableFields: Awaited<ReturnType<typeof gridsService.field.listByTable>>;
    viewer: ReturnType<typeof currentActorViewer>;
    dateConfig: Awaited<ReturnType<typeof getDateConfig>>;
    signal: AbortSignal;
    dedupeKey: string;
  },
): Promise<RouteSuccess<TableQueryResponse> | RouteFailure> => {
  const { target, query, body, viewer, dateConfig } = params;
  const listResult = await deps.service.record.list({
    tableId: target.table.id,
    cursor: body.cursor ?? null,
    limit: query.limit,
    includeDeleted: query.includeDeleted,
    deletedOnly: query.deletedOnly,
    filter: query.filter ?? null,
    search: query.search ?? null,
    recordMeta: query.recordMeta ?? null,
    sort: query.sort,
    includeRelations: true,
    viewer,
    dateConfig,
    computedColumns: query.columns?.filter((column): column is ComputedColumnSpec => "kind" in column && column.kind === "computed"),
    filePreviewFieldIds: body.filePreviewFieldIds,
    fields: params.tableFields,
    signal: params.signal,
    dedupeKey: params.dedupeKey,
  });
  if (!listResult.ok) return fail(listResult.error.status, listResult.error.message);

  let aggregates: Record<string, unknown> | undefined = listResult.data.aggregates;
  if (query.aggregations && query.aggregations.length > 0) {
    const aggregateResult = await deps.service.record.aggregate({
      tableId: target.table.id,
      filter: query.filter ?? null,
      search: query.search ?? null,
      recordMeta: query.recordMeta ?? null,
      includeDeleted: query.includeDeleted,
      deletedOnly: query.deletedOnly,
      requests: query.aggregations.map((item) => ({ fieldId: item.fieldId, agg: item.agg })),
      viewer,
      dateConfig,
      fields: params.tableFields,
      signal: params.signal,
      dedupeKey: `${params.dedupeKey}:aggregates`,
    });
    if (aggregateResult.ok) aggregates = { ...aggregates, ...aggregateResult.data };
  }

  return {
    ok: true,
    data: {
      items: listResult.data.items,
      aggregates,
      nextCursor: listResult.data.nextCursor,
      filePreviews: listResult.data.filePreviews,
    },
  };
};

export const createTableQueryRoutes = (deps: TableQueryRouteDeps = defaultDeps) =>
  new Hono<AuthContext>().post(
    "/:tableId/query",
    queryAdmissionMiddleware(),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Unified query — list / aggregate / group based on RecordQuery body",
      responses: {
        200: jsonResponse(PublicTableQueryResponseSchema, "Query envelope"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Publication changed"),
        503: jsonResponse(ErrorResponseSchema, "Query capacity exhausted"),
      },
    }),
    v("json", PublicTableQueryBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      const tablePublicId = publicIdParam(c, "tableId");
      if (!tablePublicId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const target = await loadQueryTarget(c, deps, tablePublicId, body.viewId);
      if (!target.ok) return c.json({ message: target.message }, target.status);

      const tableFields = await deps.service.field.listByTable(target.data.table.id);
      const query = body.query
        ? await fromPublicRecordQuery(target.data.table.id, body.query, { listFields: async () => tableFields })
        : ok(undefined);
      if (!query.ok) return c.json({ message: query.error.message }, query.error.status);
      const fieldIds = new Map(tableFields.map((field) => [field.shortId, field.id]));
      const filePreviewFieldIds = body.filePreviewFieldIds?.map((id) => fieldIds.get(id));
      if (filePreviewFieldIds?.some((id) => !id)) return c.json({ message: apiMessages(c).unknownFieldId }, 400);
      const internalBody: TableQueryBody = {
        ...body,
        query: query.data,
        filePreviewFieldIds: filePreviewFieldIds?.filter((id): id is string => Boolean(id)),
      };

      const resolved = await resolveQuery(c, deps, target.data, internalBody);
      if (!resolved.ok) return c.json({ message: resolved.message }, resolved.status);

      const [resolvedFields, dateConfig] = await Promise.all([
        resolved.data.fields ? Promise.resolve(resolved.data.fields) : Promise.resolve(tableFields),
        deps.dateConfig(c),
      ]);
      const queryValid = deps.validateQuery(target.data.table.id, resolved.data.query, resolvedFields, getLocale(c));
      if (!queryValid.ok) return c.json({ message: queryValid.error.message }, queryValid.error.status);

      const viewer = {
        ...deps.viewer(c),
        ...(resolved.data.readableTableIds ? { readableTableIds: new Set(resolved.data.readableTableIds) } : {}),
      };
      const params = {
        target: target.data,
        query: resolved.data.query,
        body: internalBody,
        tableFields: resolvedFields,
        dateConfig,
        viewer,
        signal: c.req.raw.signal,
        dedupeKey: tableQueryExecutionKey({
          target: target.data,
          query: resolved.data.query,
          body: internalBody,
          tableFields: resolvedFields,
          viewer,
          dateConfig,
        }),
      };
      try {
        const result =
          target.data.table.kind === "federated"
            ? await runFederatedQuery(c, deps, params)
            : resolved.data.query.groupBy?.length
              ? await runGroupedQuery(deps, params)
              : await runListQuery(deps, params);
        return result.ok
          ? c.json(await toPublicTableQueryResponse(result.data, resolvedFields))
          : c.json({ message: result.message }, result.status);
      } catch (error) {
        if (isBoundedQueryTimeoutError(error)) {
          c.header("Retry-After", "1");
          return c.json({ message: apiMessages(c).queryTimeout }, 503);
        }
        throw error;
      }
    },
  );

export const tableQueryRoutes = createTableQueryRoutes();
