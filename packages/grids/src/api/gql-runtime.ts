import type { DateContext } from "@k2b/stdlib";
import { type AuthContext, getDateConfig, type PermissionLevel } from "@valentinkolb/cloud/server";
import type { Context } from "hono";
import type { DslQueryPreviewBody, DslQueryPreviewDiagnostic, DslQueryPreviewResponse, DslQuerySurface, RecordQuery } from "../contracts";
import { canonicalizeDslQuery } from "../query-dsl/canonical";
import { bindDslQueryContext, type DslQueryContextInput } from "../query-dsl/parameters";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { dslPreviewDiagnosticForCompilerError, previewDslQuery } from "../query-dsl/preview";
import {
  type DslResolvedSqlQueryPlan,
  type DslResolverContext,
  type DslTableSource,
  type DslViewSource,
  resolveDslQueryToQueryPlan,
  resolveDslQueryToRecordQuery,
} from "../query-dsl/resolver";
import { type DslResultCursor, decodeDslResultCursor, gqlResultFingerprint } from "../query-dsl/result-cursor";
import {
  collectDslFieldTableIds,
  collectDslPlanExtraFieldTableIds,
  collectDslPlanTableIds,
  needsDslViewCatalog,
} from "../query-dsl/source-plan";
import type { DslQueryAst } from "../query-dsl/types";
import { gridsService } from "../service";
import type { FederatedRevisionScope } from "../service/federated-tables";
import { buildTrustedGqlResolverContext, hydrateDslViewQueries } from "../service/gql-resolver-context";
import { ALL_RECORD_ACCESS, type AuthorizedRecordAccess } from "../service/record-access";
import type { Field, Table } from "../service/types";
import { type GqlRuntimeOperation, type GqlRuntimeTracer, traceGqlRuntime } from "./gql-observability";
import { actorViewerFor, type GridsAccessContext, gateBaseAtAccess, gridsAccessContext } from "./permissions";
import { runWithQueryAdmission, runWithQueryAdmissionSignal } from "./query-admission";

export type DslCurrentSource = { kind: "table"; tableId: string } | { kind: "view"; viewId: string } | undefined;

type ResolverContextOptions = {
  loadViews?: boolean;
  loadAllFields?: boolean;
};

export type GridsGqlRuntimeContext = {
  access: GridsAccessContext;
  dateConfig: DateContext;
  signal: AbortSignal;
};

export type PermissionedGqlResolverContext = DslResolverContext & {
  tablePermissionsById: Record<string, PermissionLevel>;
  recordAccessByTableId: Map<string, AuthorizedRecordAccess>;
  recordAccessByViewId: Map<string, AuthorizedRecordAccess>;
};

const httpGqlRuntimeContext = (c: Context<AuthContext>, signal: AbortSignal): GridsGqlRuntimeContext => ({
  access: gridsAccessContext(c),
  dateConfig: getDateConfig(c),
  signal,
});

const withViewPresentation = (query: RecordQuery, presentation: RecordQuery | undefined): RecordQuery => {
  if (!presentation) return query;
  return {
    ...query,
    ...(presentation.columns ? { columns: presentation.columns } : {}),
    ...(presentation.groupBy ? { groupBy: presentation.groupBy } : {}),
    ...(presentation.aggregations ? { aggregations: presentation.aggregations } : {}),
    ...(presentation.groupedColumnOrder ? { groupedColumnOrder: presentation.groupedColumnOrder } : {}),
    ...(presentation.hiddenGroupedColumns ? { hiddenGroupedColumns: presentation.hiddenGroupedColumns } : {}),
  };
};

export const emptyDslAst = (): DslQueryAst => ({
  joins: [],
  select: [],
  groupBy: [],
  aggregations: [],
  sort: [],
});

export const sourceAst = (ast: DslQueryAst, source: DslCurrentSource, ctx: DslResolverContext): DslQueryAst => {
  if (ast.source || !source) return ast;
  if (source.kind === "table") {
    const table = ctx.tables.find((item) => item.id === source.tableId);
    return table ? { ...ast, source: { kind: "table", ref: table.shortId } } : ast;
  }
  const view = (ctx.views ?? []).find((item) => item.id === source.viewId);
  return view ? { ...ast, source: { kind: "view", ref: view.shortId } } : ast;
};

export const buildPermissionedGqlResolverContextForAccess = async (
  access: GridsAccessContext,
  baseId: string,
  currentTableId: string | undefined,
  currentSource: DslCurrentSource,
  ast: DslQueryAst,
  options: ResolverContextOptions = {},
): Promise<PermissionedGqlResolverContext> => {
  const viewer = actorViewerFor(access);
  const [tables, baseGate] = await Promise.all([gridsService.table.listByBase(baseId), gateBaseAtAccess(access, baseId, "read")]);
  const tablePermissionsById = Object.fromEntries(tables.map((table) => [table.id, baseGate.ok ? baseGate.data : "none"])) as Record<
    string,
    PermissionLevel
  >;
  const readableTables: Table[] = tables.filter((table) =>
    gridsService.permission.hasAtLeast(tablePermissionsById[table.id] ?? "none", "read"),
  );
  const recordAccessByTableId = new Map<string, AuthorizedRecordAccess>(readableTables.map((table) => [table.id, ALL_RECORD_ACCESS]));

  const dslTables: DslTableSource[] = readableTables.map((table) => ({
    kind: "table",
    id: table.id,
    shortId: table.shortId,
    name: table.name,
  }));
  const currentTable = currentTableId ? dslTables.find((table) => table.id === currentTableId) : undefined;
  const views: DslViewSource[] = [];

  if (options.loadViews || needsDslViewCatalog(ast) || currentSource?.kind === "view") {
    const visibleViews = await gridsService.view.listForTables({
      tableIds: readableTables.map((table) => table.id),
      ...viewer,
    });
    views.push(
      ...visibleViews.map((view) => ({
        kind: "view" as const,
        id: view.id,
        shortId: view.shortId,
        name: view.name,
        tableId: view.tableId,
        source: view.source,
        query: {},
      })),
    );
  }

  const effectiveAst = sourceAst(ast, currentSource, {
    ...(currentTable ? { currentTable } : {}),
    tables: dslTables,
    views,
    fieldsByTableId: {},
  });
  const effectiveCurrentTableId = currentSource?.kind === "table" ? currentSource.tableId : currentTableId;
  const fieldTableIds =
    options.loadAllFields || views.length > 0
      ? dslTables.map((table) => table.id)
      : collectDslFieldTableIds({ ast: effectiveAst, currentTableId: effectiveCurrentTableId, tables: dslTables, views });
  const fieldGroups = await gridsService.field.listByTables(fieldTableIds);
  const fieldsByTableId = Object.fromEntries(fieldTableIds.map((tableId) => [tableId, fieldGroups.get(tableId) ?? []])) as Record<
    string,
    Field[]
  >;
  const hydratedViews = hydrateDslViewQueries({ tables: dslTables, views, fieldsByTableId });
  const recordAccessByViewId = new Map<string, AuthorizedRecordAccess>(hydratedViews.map((view) => [view.id, ALL_RECORD_ACCESS]));

  return {
    ...(currentTable ? { currentTable } : {}),
    tables: dslTables,
    views: hydratedViews,
    fieldsByTableId,
    tablePermissionsById,
    recordAccessByTableId,
    recordAccessByViewId,
  };
};

export const buildPermissionedGqlResolverContext = (
  c: Context<AuthContext>,
  baseId: string,
  currentTableId: string | undefined,
  currentSource: DslCurrentSource,
  ast: DslQueryAst,
  options: ResolverContextOptions = {},
): Promise<DslResolverContext> =>
  buildPermissionedGqlResolverContextForAccess(gridsAccessContext(c), baseId, currentTableId, currentSource, ast, options);

const fieldsWithPlanExtras = async (
  fieldsByTableId: Record<string, Field[]>,
  plan: DslResolvedSqlQueryPlan,
): Promise<Record<string, Field[]>> => {
  const missing = collectDslPlanExtraFieldTableIds(plan).filter((tableId) => fieldsByTableId[tableId] === undefined);
  if (missing.length === 0) return fieldsByTableId;
  const groups = await gridsService.field.listByTables(missing);
  return {
    ...fieldsByTableId,
    ...Object.fromEntries(missing.map((tableId) => [tableId, groups.get(tableId) ?? []])),
  };
};

const previewResolvedGqlPlan = async (
  runtime: GridsGqlRuntimeContext,
  plan: DslResolvedSqlQueryPlan,
  fieldsByTableId: Record<string, Field[]>,
  options: {
    limit?: number;
    pageSize?: number;
    maxRows?: number;
    maxResultBytes?: number;
    cursor?: DslResultCursor | null;
    cursorFingerprint?: string;
    cursorSigningKey?: string;
    labelRelationValues?: boolean;
    expectedFederatedRevisionScope?: FederatedRevisionScope;
    onFederatedRevisionScope?: (scope: FederatedRevisionScope) => void;
    signal?: AbortSignal;
    authorizedRecordAccessByTableId?: ReadonlyMap<string, AuthorizedRecordAccess>;
    primaryRecordAccess?: AuthorizedRecordAccess | null;
  },
): Promise<DslQueryPreviewResponse> => {
  const result = await previewDslQuery(plan, {
    fieldsByTableId: await fieldsWithPlanExtras(fieldsByTableId, plan),
    timeZone: runtime.dateConfig.timeZone,
    limit: options.limit,
    pageSize: options.pageSize,
    cursor: options.cursor,
    cursorFingerprint: options.cursorFingerprint,
    cursorSigningKey: options.cursorSigningKey,
    labelRelationValues: options.labelRelationValues,
    expectedFederatedRevisionScope: options.expectedFederatedRevisionScope,
    onFederatedRevisionScope: options.onFederatedRevisionScope,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
    viewer: actorViewerFor(runtime.access),
    authorizedRecordAccessByTableId: options.authorizedRecordAccessByTableId,
    ...(Object.hasOwn(options, "primaryRecordAccess") ? { primaryRecordAccess: options.primaryRecordAccess } : {}),
  });
  return result.ok ? result.data : { ok: false, diagnostics: [dslPreviewDiagnosticForCompilerError(plan, result.error.message)] };
};

const decodeRuntimeCursor = (
  token: string | undefined,
  fingerprint: string,
  signingKey: string,
): { ok: true; cursor: DslResultCursor | null } | { ok: false; diagnostics: DslQueryPreviewDiagnostic[] } => {
  if (!token) return { ok: true, cursor: null };
  const cursor = decodeDslResultCursor(token, signingKey);
  if (!cursor || cursor.fingerprint !== fingerprint) {
    return { ok: false, diagnostics: [{ message: "The result cursor is invalid or no longer matches this query." }] };
  }
  return { ok: true, cursor };
};

const gqlCursorSigningKey = (): string => {
  const key = process.env.APP_SECRET?.trim();
  if (!key) throw new Error("APP_SECRET is required for GQL result pagination");
  return key;
};

const cursorScopeForPlan = async (
  scope: string,
  plan: DslResolvedSqlQueryPlan,
  fieldsByTableId: Record<string, Field[]>,
): Promise<string> => {
  const tableIds = collectDslPlanTableIds(plan, fieldsByTableId);
  const revisions = (await gridsService.table.federation.captureRevisionScope(tableIds)).map(
    (revision) => `${revision.tableId}:${revision.revisionId}:${revision.revisionToken}`,
  );
  return revisions.length > 0 ? `${scope}:federation:${revisions.join(",")}` : scope;
};

export const canonicalGqlSource = async (
  c: Context<AuthContext>,
  baseId: string,
  body: { query: string; currentTableId?: string; currentSource?: DslCurrentSource },
): Promise<
  { ok: true; source: string; tableId: string; plan: DslResolvedSqlQueryPlan } | { ok: false; diagnostics: DslQueryPreviewDiagnostic[] }
> => {
  const parsed = parseGridsQueryDsl(body.query);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const bound = bindDslQueryContext(parsed.ast);
  if (!bound.ok) return { ok: false, diagnostics: [{ line: 1, message: bound.error }] };

  const ctx = await buildPermissionedGqlResolverContext(c, baseId, body.currentTableId, body.currentSource, bound.ast);
  const ast = sourceAst(bound.ast, body.currentSource, ctx);
  const canonical = canonicalizeDslQuery(ast, ctx);
  if (!canonical.ok) return { ok: false, diagnostics: canonical.diagnostics };
  return { ok: true, source: canonical.source, tableId: canonical.plan.tableId, plan: canonical.plan };
};

type ExecuteGqlSourceOptions = {
  maxRows?: number;
  maxResultBytes?: number;
  operation?: GqlRuntimeOperation;
  tracer?: GqlRuntimeTracer;
  labelRelationValues?: boolean;
  expectedFederatedRevisionScope?: FederatedRevisionScope;
  context?: DslQueryContextInput;
};

const executeGqlSourceUnadmitted = async (
  runtime: GridsGqlRuntimeContext,
  baseId: string,
  body: DslQueryPreviewBody,
  options: ExecuteGqlSourceOptions = {},
) => {
  const operation = options.operation ?? "preview";
  const startedAt = performance.now();
  const timings: NonNullable<Parameters<Awaited<ReturnType<GqlRuntimeTracer>>["end"]>[0]["timings"]> = {};
  const trace = await (options.tracer ?? traceGqlRuntime)({
    baseId,
    operation,
    surface: body.surface ?? (operation === "initial-preview" ? "ssr" : operation === "preview" ? "query-explorer" : "api"),
    ...(body.currentTableId ? { currentTableId: body.currentTableId } : {}),
    ...(body.currentSource ? { currentSource: body.currentSource } : {}),
    ...(body.limit !== undefined ? { limit: body.limit } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
  });
  const endTrace = (event: Omit<Parameters<typeof trace.end>[0], "timings">) =>
    trace.end({
      ...event,
      timings: {
        ...timings,
        totalMs: performance.now() - startedAt,
      },
    });

  try {
    const parseStartedAt = performance.now();
    const parsed = parseGridsQueryDsl(body.query);
    timings.parseMs = performance.now() - parseStartedAt;
    if (!parsed.ok) {
      const response = { ok: false as const, diagnostics: parsed.diagnostics };
      await endTrace({ stage: "parse", outcome: "diagnostic", response });
      return { ok: true as const, response };
    }
    const bound = bindDslQueryContext(parsed.ast, options.context);
    if (!bound.ok) {
      const response = { ok: false as const, diagnostics: [{ line: 1, message: bound.error }] };
      await endTrace({ stage: "parse", outcome: "diagnostic", response });
      return { ok: true as const, response };
    }

    const contextStartedAt = performance.now();
    const ctx = await buildPermissionedGqlResolverContextForAccess(
      runtime.access,
      baseId,
      body.currentTableId,
      body.currentSource,
      bound.ast,
    );
    timings.contextMs = performance.now() - contextStartedAt;
    const resolveStartedAt = performance.now();
    const ast = sourceAst(bound.ast, body.currentSource, ctx);
    const canonical = canonicalizeDslQuery(ast, ctx);
    if (!canonical.ok) {
      const response = { ok: false as const, diagnostics: canonical.diagnostics };
      timings.resolveMs = performance.now() - resolveStartedAt;
      await endTrace({ stage: "resolve", outcome: "diagnostic", response });
      return { ok: true as const, response };
    }
    const resolved = resolveDslQueryToQueryPlan(ast, ctx);
    if (!resolved.ok) {
      const response = { ok: false as const, diagnostics: resolved.diagnostics };
      timings.resolveMs = performance.now() - resolveStartedAt;
      await endTrace({ stage: "resolve", outcome: "diagnostic", response });
      return { ok: true as const, response };
    }
    const cursorSigningKey = gqlCursorSigningKey();
    const sourceScope = body.currentSource
      ? `${body.currentSource.kind}:${body.currentSource.kind === "table" ? body.currentSource.tableId : body.currentSource.viewId}`
      : body.currentTableId
        ? `table:${body.currentTableId}`
        : "base";
    const cursorFingerprint = gqlResultFingerprint({
      baseId,
      canonicalSource: canonical.source,
      scope: await cursorScopeForPlan(sourceScope, resolved.plan, ctx.fieldsByTableId),
    });
    const decodedCursor = decodeRuntimeCursor(body.cursor, cursorFingerprint, cursorSigningKey);
    if (!decodedCursor.ok) {
      const response = { ok: false as const, diagnostics: decodedCursor.diagnostics };
      timings.resolveMs = performance.now() - resolveStartedAt;
      await endTrace({ stage: "resolve", outcome: "diagnostic", response });
      return { ok: true as const, response };
    }
    timings.resolveMs = performance.now() - resolveStartedAt;

    let revisionScope: FederatedRevisionScope = [];
    const executeStartedAt = performance.now();
    const response = await previewResolvedGqlPlan(runtime, resolved.plan, ctx.fieldsByTableId, {
      limit: body.limit,
      pageSize: body.pageSize,
      cursor: decodedCursor.cursor,
      cursorFingerprint,
      cursorSigningKey,
      maxRows: options.maxRows,
      maxResultBytes: options.maxResultBytes,
      labelRelationValues: options.labelRelationValues,
      expectedFederatedRevisionScope: options.expectedFederatedRevisionScope,
      signal: runtime.signal,
      authorizedRecordAccessByTableId: ctx.recordAccessByTableId,
      primaryRecordAccess:
        resolved.plan.source.kind === "view"
          ? (ctx.recordAccessByViewId.get(resolved.plan.source.id) ?? null)
          : (ctx.recordAccessByTableId.get(resolved.plan.tableId) ?? null),
      onFederatedRevisionScope: (scope) => {
        revisionScope = scope;
      },
    });
    timings.executeMs = performance.now() - executeStartedAt;
    await endTrace({ stage: "execute", outcome: response.ok ? "success" : "diagnostic", plan: resolved.plan, response });
    return { ok: true as const, response, revisionScope };
  } catch (error) {
    await endTrace({ stage: "runtime", outcome: "error", error });
    throw error;
  }
};

export const executeGqlSource = (
  c: Context<AuthContext>,
  baseId: string,
  body: DslQueryPreviewBody,
  options: ExecuteGqlSourceOptions = {},
) => runWithQueryAdmission(c, (signal) => executeGqlSourceUnadmitted(httpGqlRuntimeContext(c, signal), baseId, body, options));

export const executeGqlSourceForContext = (
  runtime: GridsGqlRuntimeContext,
  baseId: string,
  body: DslQueryPreviewBody,
  options: ExecuteGqlSourceOptions = {},
) => runWithQueryAdmissionSignal(runtime.signal, () => executeGqlSourceUnadmitted(runtime, baseId, body, options));

/** Executes the exact stored source of an authorized saved view. View read is
 * deliberately a data-product boundary: it grants the stored result, including
 * joins chosen by the view admin, without granting navigation to source tables.
 * Callers cannot substitute arbitrary GQL on this trusted resolver path. */
type ExecuteSavedViewSourceOptions = {
  maxRows?: number;
  maxResultBytes?: number;
  pageSize?: number;
  cursor?: string;
  recordId?: string;
  operation?: GqlRuntimeOperation;
  surface?: NonNullable<DslQuerySurface>;
  tracer?: GqlRuntimeTracer;
  labelRelationValues?: boolean;
};

const executeSavedViewSourceUnadmitted = async (
  runtime: GridsGqlRuntimeContext,
  baseId: string,
  viewId: string,
  options: ExecuteSavedViewSourceOptions = {},
) => {
  const trace = await (options.tracer ?? traceGqlRuntime)({
    baseId,
    operation: options.operation ?? "execute",
    surface: options.surface ?? "api",
    currentSource: { kind: "view", viewId },
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
  });

  try {
    const inaccessibleView = async () => {
      const response = {
        ok: false as const,
        diagnostics: [{ message: "View not found or you do not have permission to access it." }],
      };
      await trace.end({ stage: "resolve", outcome: "diagnostic", response });
      return response;
    };
    const view = await gridsService.view.get(viewId);
    const table = view ? await gridsService.table.get(view.tableId) : null;
    if (!view || !table || table.baseId !== baseId) return inaccessibleView();
    const access = await gateBaseAtAccess(runtime.access, baseId, "read");
    if (!access.ok) return inaccessibleView();
    const parsed = parseGridsQueryDsl(view.source);
    if (!parsed.ok) {
      const response = { ok: false as const, diagnostics: parsed.diagnostics };
      await trace.end({ stage: "parse", outcome: "diagnostic", response });
      return response;
    }
    const bound = bindDslQueryContext(parsed.ast);
    if (!bound.ok) {
      const response = { ok: false as const, diagnostics: [{ line: 1, message: bound.error }] };
      await trace.end({ stage: "parse", outcome: "diagnostic", response });
      return response;
    }
    const context = await buildTrustedGqlResolverContext({
      baseId,
      currentTableId: table.id,
      ast: bound.ast,
      purpose: "saved-view-render",
    });
    const resolved = resolveDslQueryToQueryPlan(bound.ast, context);
    if (!resolved.ok) {
      const response = { ok: false as const, diagnostics: resolved.diagnostics };
      await trace.end({ stage: "resolve", outcome: "diagnostic", response });
      return response;
    }
    if (options.recordId) {
      const scopedIds = resolved.plan.query.recordMeta?.ids;
      if (scopedIds?.length && !scopedIds.includes(options.recordId)) {
        const response = {
          ok: true as const,
          mode: "rows" as const,
          columns: [],
          rows: [],
          limit: 1,
          truncated: false,
          page: { size: 1, start: 0, returned: 0, nextCursor: null },
        };
        await trace.end({ stage: "execute", outcome: "success", plan: resolved.plan, response });
        return response;
      }
      resolved.plan = {
        ...resolved.plan,
        query: {
          ...resolved.plan.query,
          recordMeta: {
            ...(resolved.plan.query.recordMeta ?? {}),
            ids: [options.recordId],
          },
        },
      };
    }
    const cursorSigningKey = gqlCursorSigningKey();
    const cursorFingerprint = gqlResultFingerprint({
      baseId,
      canonicalSource: options.recordId ? `${view.source}\n# record:${options.recordId}` : view.source,
      scope: await cursorScopeForPlan(`view:${view.id}`, resolved.plan, context.fieldsByTableId),
    });
    const decodedCursor = decodeRuntimeCursor(options.cursor, cursorFingerprint, cursorSigningKey);
    if (!decodedCursor.ok) {
      const response = { ok: false as const, diagnostics: decodedCursor.diagnostics };
      await trace.end({ stage: "resolve", outcome: "diagnostic", response });
      return response;
    }
    const response = await previewResolvedGqlPlan(runtime, resolved.plan, context.fieldsByTableId, {
      maxRows: options.maxRows,
      maxResultBytes: options.maxResultBytes,
      pageSize: options.pageSize,
      cursor: decodedCursor.cursor,
      cursorFingerprint,
      cursorSigningKey,
      labelRelationValues: options.labelRelationValues,
      signal: runtime.signal,
      primaryRecordAccess: ALL_RECORD_ACCESS,
    });
    await trace.end({ stage: "execute", outcome: response.ok ? "success" : "diagnostic", plan: resolved.plan, response });
    return response;
  } catch (error) {
    await trace.end({ stage: "runtime", outcome: "error", error });
    throw error;
  }
};

export const executeSavedViewSource = (
  c: Context<AuthContext>,
  baseId: string,
  viewId: string,
  options: ExecuteSavedViewSourceOptions = {},
) => runWithQueryAdmission(c, (signal) => executeSavedViewSourceUnadmitted(httpGqlRuntimeContext(c, signal), baseId, viewId, options));

export const executeSavedViewSourceForContext = (
  runtime: GridsGqlRuntimeContext,
  baseId: string,
  viewId: string,
  options: ExecuteSavedViewSourceOptions = {},
) => runWithQueryAdmissionSignal(runtime.signal, () => executeSavedViewSourceUnadmitted(runtime, baseId, viewId, options));

export const compileGqlViewWrite = async (
  c: Context<AuthContext>,
  params: { baseId: string; tableId: string; source?: string },
): Promise<{ ok: true; source: string } | { ok: false; diagnostics: DslQueryPreviewDiagnostic[] }> => {
  const source = params.source?.trim() ?? "";

  const parsed = parseGridsQueryDsl(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };

  const currentSource: DslCurrentSource = { kind: "table", tableId: params.tableId };
  const ctx = await buildPermissionedGqlResolverContext(c, params.baseId, params.tableId, currentSource, parsed.ast);
  const ast = sourceAst(parsed.ast, currentSource, ctx);
  const canonical = canonicalizeDslQuery(ast, ctx);
  if (!canonical.ok) return { ok: false, diagnostics: canonical.diagnostics };
  if (canonical.plan.tableId !== params.tableId) {
    return { ok: false, diagnostics: [{ message: "view source must resolve to this view's table" }] };
  }

  return {
    ok: true,
    source: canonical.source,
  };
};

export const compileGqlToRecordQuery = async (
  c: Context<AuthContext>,
  params: { baseId: string; tableId: string; source: string; presentation?: RecordQuery },
): Promise<
  | { ok: true; source: string; query: RecordQuery; fields: Field[]; readableTableIds?: readonly string[] }
  | { ok: false; diagnostics: DslQueryPreviewDiagnostic[] }
> => {
  const parsed = parseGridsQueryDsl(params.source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const bound = bindDslQueryContext(parsed.ast);
  if (!bound.ok) return { ok: false, diagnostics: [{ line: 1, message: bound.error }] };

  const currentSource: DslCurrentSource = { kind: "table", tableId: params.tableId };
  const ctx = await buildPermissionedGqlResolverContext(c, params.baseId, params.tableId, currentSource, bound.ast);
  const ast = sourceAst(bound.ast, currentSource, ctx);
  const canonical = canonicalizeDslQuery(ast, ctx);
  if (!canonical.ok) return { ok: false, diagnostics: canonical.diagnostics };
  if (canonical.plan.tableId !== params.tableId) {
    return { ok: false, diagnostics: [{ message: "query source must resolve to this table" }] };
  }

  const resolved = resolveDslQueryToRecordQuery(ast, ctx);
  if (!resolved.ok) return { ok: false, diagnostics: resolved.diagnostics };
  return {
    ok: true,
    source: canonical.source,
    query: withViewPresentation(resolved.plan.query, params.presentation),
    fields: ctx.fieldsByTableId[params.tableId] ?? [],
    readableTableIds: ctx.tables.map((table) => table.id),
  };
};
