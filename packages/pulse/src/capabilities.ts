import { err, fail, ok } from "@k2b/stdlib";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityExecutionContext,
  type CloudResourceRef,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
import type { z } from "zod";
import {
  BaseDataSchema,
  BaseListDataSchema,
  BaseListInputSchema,
  BaseReadInputSchema,
  FieldSearchDataSchema,
  FieldSearchInputSchema,
  MetricSearchDataSchema,
  MetricSearchInputSchema,
  QueryCompileDataSchema,
  QueryExecutionDataSchema,
  QueryTextInputSchema,
  ResourceDataSchema,
  ResourceReadInputSchema,
  SavedQueryDataSchema,
  SavedQueryExecuteInputSchema,
  SavedQueryListDataSchema,
  SavedQueryListInputSchema,
  SavedQueryReadInputSchema,
  SourceDataSchema,
  SourceListDataSchema,
  SourceListInputSchema,
  SourceReadInputSchema,
} from "./capability-contracts";
import { pulseCapabilityPresentation } from "./capability-presentation";
import type { PulseBase, PulseCurrentState, PulseRecordedEvent, PulseSavedQuery, PulseSource } from "./contracts";
import { pulseBaseHref, pulseExplorerHref, pulseResourceHref, pulseSignalHref, pulseSourceHref } from "./resource-hrefs";
import { resolvePulseMessages } from "./messages";
import { pulseService } from "./service";
import { accessScopeFor } from "./service/access-control";
import {
  buildResourceRefId,
  parseResourceRefId,
  projectBases,
  projectPublicRelations,
  projectSavedQueries,
  projectSources,
  requireShortId,
  resolveBasePublicId,
  resolvePublicId,
  shortIds,
} from "./service/public-resources";

const QUERY_ROW_LIMIT = 100;
const QUERY_POINT_LIMIT = 500;
const QUERY_RESULT_BUDGET_BYTES = CAPABILITY_MAX_RESULT_BYTES - 16 * 1024;

const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");

const decodeCursor = (cursor: string | undefined, locale?: string) => {
  const { t } = resolvePulseMessages(locale);
  if (!cursor) return ok(0);
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown; offset?: unknown };
    return value.v === 1 && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0
      ? ok(Number(value.offset))
      : fail(err.badInput(t.invalidCursor));
  } catch {
    return fail(err.badInput(t.invalidCursor));
  }
};

const scopeFor = (context: CapabilityExecutionContext) => accessScopeFor(context.actor, context.accessSubject);

const internalId = async (table: "bases" | "sources" | "saved_queries", id: string, locale?: string) => {
  const value = await resolvePublicId(table, id);
  return value ? ok(value) : fail(err.notFound(resolvePulseMessages(locale).t.pulseResource));
};

const mapBase = (base: PulseBase) => ({
  id: base.id,
  name: base.name.slice(0, 120),
  description: base.description?.slice(0, 1_000) ?? null,
  createdAt: base.createdAt,
  updatedAt: base.updatedAt,
});

const mapSource = (source: PulseSource) => ({
  id: source.id,
  baseId: source.baseId,
  kind: source.kind,
  name: source.name.slice(0, 120),
  enabled: source.enabled,
  lastSeenAt: source.lastSeenAt,
  lastError: source.lastError?.slice(0, 2_000) ?? null,
  lastErrorAt: source.lastErrorAt,
  updatedAt: source.updatedAt,
  links: [{ rel: "open" as const, href: pulseSourceHref(source.baseId, source.id) }],
});

const mapSavedQuery = (query: PulseSavedQuery) => ({
  id: query.id,
  baseId: query.baseId,
  name: query.name.slice(0, 120),
  description: query.description?.slice(0, 1_000) ?? null,
  query: query.query.slice(0, 2_000),
  createdAt: query.createdAt,
  updatedAt: query.updatedAt,
});

const pageResult = <T>(items: T[], offset: number, limit: number) => {
  const data = items.slice(0, limit);
  const hasMore = items.length > limit;
  return { data, page: capabilityPage(hasMore ? encodeCursor(offset + data.length) : undefined) };
};

const runBaseSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const { t } = resolvePulseMessages(context.locale);
  const scope = scopeFor(context);
  if (!scope.ok) return ok({ data: [] });
  const result = await pulseService.base.list(scope.data, { query: input.query, limit: input.limit });
  if (!result.ok) return result;
  const bases = await projectBases(result.data);
  const data: CloudResourceView[] = bases.map((base) => ({
    ref: { type: "pulse.base", id: base.id },
    title: base.name.slice(0, 500),
    preview: base.description?.slice(0, 2_000),
    icon: "ti ti-activity-heartbeat",
    priority: 7,
    metadata: [{ label: t.typeMetadata, value: t.pulseBase }],
    links: [{ rel: "open", href: pulseBaseHref(base.id) }],
  }));
  return ok({ data });
};

const runBaseList = async (input: z.infer<typeof BaseListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const result = await pulseService.base.list(scope.data, { query: input.query, limit: input.limit + 1, offset: cursor.data });
  if (!result.ok) return result;
  const page = pageResult(
    (await projectBases(result.data)).map((base) => ({
      ...mapBase(base),
      ref: { type: "pulse.base" as const, id: base.id },
      links: [{ rel: "open" as const, href: pulseBaseHref(base.id) }],
    })),
    cursor.data,
    input.limit,
  );
  return ok({
    ...page,
    refs: page.data.map((base) => ({ type: "pulse.base" as const, id: base.id })),
  });
};

const runBaseRead = async (input: z.infer<typeof BaseReadInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const id = await internalId("bases", input.id, context.locale);
  if (!id.ok) return id;
  const result = await pulseService.base.get(id.data, scope.data);
  if (!result.ok) return result;
  const [base] = await projectBases([result.data]);
  return ok({
    data: mapBase(base!),
    summary: resolvePulseMessages(context.locale).t.readBase({ name: base!.name }),
    refs: [{ type: "pulse.base", id: base!.id }],
    links: [{ rel: "open" as const, href: pulseBaseHref(base!.id) }],
  });
};

const runSourceList = async (input: z.infer<typeof SourceListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.source.list(baseId.data, scope.data, {
    query: input.query,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  if (!result.ok) return result;
  const page = pageResult(
    (await projectSources(result.data)).map((source) => ({
      ...mapSource(source),
      ref: { type: "pulse.source" as const, id: source.id },
    })),
    cursor.data,
    input.limit,
  );
  return ok({
    ...page,
    refs: page.data.map((source) => ({ type: "pulse.source" as const, id: source.id })),
  });
};

const runSourceRead = async (input: z.infer<typeof SourceReadInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const id = await internalId("sources", input.id, context.locale);
  if (!id.ok) return id;
  const result = await pulseService.source.get(id.data, scope.data);
  if (!result.ok) return result;
  const [source] = await projectSources([result.data]);
  return ok({
    data: mapSource(source!),
    summary: resolvePulseMessages(context.locale).t.readSource({ name: source!.name }),
    refs: [{ type: "pulse.source", id: source!.id }],
  });
};

const runResourceSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  const { t } = resolvePulseMessages(context.locale);
  const scope = scopeFor(context);
  if (!scope.ok) return ok({ data: [] });
  const result = await pulseService.query.searchResources(scope.data, {
    query: input.query,
    limit: input.limit,
  });
  if (!result.ok) return result;
  const baseIds = await shortIds(
    "bases",
    result.data.map((resource) => resource.baseId),
  );
  const data: CloudResourceView[] = result.data.map((resource) => {
    const baseId = requireShortId(baseIds, resource.baseId);
    return {
      ref: { type: "pulse.resource", id: buildResourceRefId(baseId, resource.key) },
      title: resource.label.slice(0, 500),
      preview: [resource.type, resource.id].filter(Boolean).join(" · "),
      icon: "ti ti-box",
      priority: 6,
      metadata: [
        { label: t.baseMetadata, value: resource.baseName.slice(0, 1_000) },
        { label: t.baseIdMetadata, value: baseId },
        { label: t.resourceKeyMetadata, value: resource.key },
      ],
      links: [{ rel: "open", href: pulseResourceHref(baseId, resource.key) }],
    };
  });
  return ok({ data });
};

const runResourceRead = async (input: z.infer<typeof ResourceReadInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const ref = parseResourceRefId(input.id);
  if (!ref) return fail(err.badInput(resolvePulseMessages(context.locale).t.invalidPulseResourceId));
  const baseId = await resolvePublicId("bases", ref.baseShortId);
  if (!baseId) return fail(err.notFound(resolvePulseMessages(context.locale).t.pulseResource));
  const result = await pulseService.query.resource(baseId, ref.resourceKey, scope.data);
  if (!result.ok) return result;
  const resource = result.data;
  return ok({
    data: {
      id: input.id,
      baseId: ref.baseShortId,
      baseName: resource.baseName.slice(0, 120),
      key: resource.key.slice(0, 505),
      resourceId: resource.id.slice(0, 500),
      label: resource.label.slice(0, 500),
      type: resource.type?.slice(0, 120) ?? null,
      lastSeenAt: resource.lastSeenAt,
      links: [{ rel: "open" as const, href: pulseResourceHref(ref.baseShortId, resource.key) }],
    },
    summary: resolvePulseMessages(context.locale).t.readResource({ name: resource.label.slice(0, 500) }),
    refs: [{ type: "pulse.resource", id: input.id }],
  });
};

const runMetricSearch = async (input: z.infer<typeof MetricSearchInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.query.metrics(baseId.data, scope.data, {
    q: input.query,
    type: input.type,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  if (!result.ok) return result;
  const page = pageResult(
    result.data.map((metric) => ({
      ...metric,
      name: metric.name.slice(0, 240),
      unit: metric.unit?.slice(0, 120) ?? null,
      links: [{ rel: "open" as const, href: pulseSignalHref(input.baseId, "metric", metric.name) }],
    })),
    cursor.data,
    input.limit,
  );
  return ok({ ...page, refs: [{ type: "pulse.base", id: input.baseId }] });
};

const runSavedQueryRead = async (input: z.infer<typeof SavedQueryReadInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const id = await internalId("saved_queries", input.id, context.locale);
  if (!id.ok) return id;
  const result = await pulseService.savedQuery.read(id.data, scope.data);
  if (!result.ok) return result;
  const [query] = await projectSavedQueries([result.data]);
  return ok({
    data: mapSavedQuery(query!),
    summary: resolvePulseMessages(context.locale).t.readSavedQuery({ name: query!.name }),
    refs: [{ type: "pulse.saved_query", id: query!.id }],
  });
};

const runFieldSearch = async (input: z.infer<typeof FieldSearchInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.query.fields(baseId.data, scope.data, {
    q: input.query,
    scope: input.scope,
    role: input.role,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  if (!result.ok) return result;
  const fields = await projectPublicRelations(result.data);
  const page = pageResult(
    fields.map((field) => ({
      ...field,
      signalName: field.signalName.slice(0, 240),
      links: [{ rel: "open" as const, href: pulseSignalHref(input.baseId, field.scope, field.signalName) }],
    })),
    cursor.data,
    input.limit,
  );
  return ok({ ...page, refs: [{ type: "pulse.base", id: input.baseId }] });
};

const runQueryCompile = async (input: z.infer<typeof QueryTextInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.query.compileText({ ...input, baseId: baseId.data, user: scope.data });
  if (!result.ok) return result;
  const diagnostics = result.data.diagnostics.slice(0, 20).map((diagnostic) => ({
    ...diagnostic,
    message: diagnostic.message.slice(0, 1_000),
  }));
  return ok({
    data: {
      valid: result.data.ok,
      kind: result.data.compiled?.kind ?? null,
      diagnostics,
    },
    summary: result.data.ok
      ? resolvePulseMessages(context.locale).t.validQuery({ kind: result.data.compiled?.kind ?? "telemetry" })
      : resolvePulseMessages(context.locale).t.invalidQuery({ count: diagnostics.length }),
    refs: [{ type: "pulse.base", id: input.baseId }],
    links: [{ rel: "open" as const, href: pulseExplorerHref(input.baseId) }],
  });
};

const compactStateValue = (value: unknown): string | number | boolean | null => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return typeof value === "string" ? value.slice(0, 1_000) : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return String(value).slice(0, 1_000);
  }
};

const compactEvent = (event: PulseRecordedEvent) => ({
  id: event.id,
  kind: event.kind.slice(0, 240),
  ts: event.ts,
  value: event.value === null || Number.isFinite(event.value) ? event.value : null,
  sourceId: event.sourceId,
  entityId: event.entityId?.slice(0, 500) ?? null,
  entityType: event.entityType?.slice(0, 120) ?? null,
  dimensions: event.dimensions,
});

const compactState = (state: PulseCurrentState) => ({
  key: state.key.slice(0, 240),
  value: compactStateValue(state.value),
  sourceId: state.sourceId,
  entityId: state.entityId.slice(0, 500),
  entityType: state.entityType?.slice(0, 120) ?? null,
  dimensions: state.dimensions,
  updatedAt: state.updatedAt,
});

type QueryExecutionData = z.infer<typeof QueryExecutionDataSchema>;

const queryExecutionSummary = (data: QueryExecutionData, locale?: string, savedQueryName?: string) => {
  const { t } = resolvePulseMessages(locale);
  const key = data.kind === "metric" ? "points" : data.kind === "events" ? "events" : "states";
  const count = data[key].length;
  const countLabel = key === "points" ? t.kindPoint({ count }) : key === "events" ? t.kindEvent({ count }) : t.kindState({ count });
  const target = savedQueryName ? t.savedQueryTarget({ name: savedQueryName }) : `${data.kind} Pulse query`;
  return t.executedQuery({ target, count, kind: countLabel, truncated: data.truncated });
};

const queryCapabilityResult = (data: QueryExecutionData, refs: CloudResourceRef[], locale?: string, savedQueryName?: string) => ({
  data,
  summary: queryExecutionSummary(data, locale, savedQueryName),
  refs,
  links: [{ rel: "open" as const, href: pulseExplorerHref(refs[0]!.id) }],
});

const fitQueryResult = (data: QueryExecutionData, refs: CloudResourceRef[], locale?: string, savedQueryName?: string) => {
  const key = data.kind === "metric" ? "points" : data.kind === "events" ? "events" : "states";
  const values = data[key];
  const resultFor = (count: number) =>
    queryCapabilityResult(
      {
        ...data,
        [key]: values.slice(0, count),
        truncated: data.truncated || count < values.length,
      },
      refs,
      locale,
      savedQueryName,
    );
  const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const full = resultFor(values.length);
  if (jsonBytes(full) <= QUERY_RESULT_BUDGET_BYTES) return ok(full);
  if (values.length === 0 || jsonBytes(resultFor(1)) > QUERY_RESULT_BUDGET_BYTES) {
    return fail(err.badInput(resolvePulseMessages(locale).t.queryTooLarge));
  }

  let low = 1;
  let high = values.length - 1;
  let fitted = 1;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    if (jsonBytes(resultFor(candidate)) <= QUERY_RESULT_BUDGET_BYTES) {
      fitted = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  return ok(resultFor(fitted));
};

const executeQuery = async (
  input: z.infer<typeof QueryTextInputSchema>,
  context: CapabilityExecutionContext,
  extraRefs: CloudResourceRef[] = [],
  resolvedBaseId?: string,
  savedQueryName?: string,
) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = resolvedBaseId ? ok(resolvedBaseId) : await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.query.metricText(
    { ...input, baseId: baseId.data, user: scope.data },
    {
      maxMetricPoints: QUERY_POINT_LIMIT,
      maxAggregatePoints: QUERY_POINT_LIMIT,
      maxRows: QUERY_ROW_LIMIT + 1,
    },
  );
  if (!result.ok) return result;
  const rowQuery =
    result.data.compiled.kind === "events" && (result.data.compiled.aggregation ?? "rows") === "rows"
      ? result.data.compiled
      : result.data.compiled.kind === "states"
        ? result.data.compiled
        : null;
  const returnedRows = result.data.events.length + result.data.states.length;
  return fitQueryResult(
    {
      kind: result.data.compiled.kind,
      query: input.query,
      points: result.data.points.map((point) => ({
        ...point,
        value: point.value === null || Number.isFinite(point.value) ? point.value : null,
      })),
      events: (await projectPublicRelations(result.data.events.slice(0, QUERY_ROW_LIMIT))).map(compactEvent),
      states: (await projectPublicRelations(result.data.states.slice(0, QUERY_ROW_LIMIT))).map(compactState),
      limitApplied: rowQuery ? Math.min(rowQuery.limit, QUERY_ROW_LIMIT) : QUERY_POINT_LIMIT,
      truncated: Boolean(rowQuery && rowQuery.limit > QUERY_ROW_LIMIT && returnedRows > QUERY_ROW_LIMIT),
    },
    [{ type: "pulse.base", id: input.baseId }, ...extraRefs],
    context.locale,
    savedQueryName,
  );
};

const runSavedQueryList = async (input: z.infer<typeof SavedQueryListInputSchema>, context: CapabilityExecutionContext) => {
  const cursor = decodeCursor(input.cursor, context.locale);
  if (!cursor.ok) return cursor;
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const result = await pulseService.savedQuery.list(baseId.data, scope.data, {
    query: input.query,
    limit: input.limit + 1,
    offset: cursor.data,
  });
  if (!result.ok) return result;
  const page = pageResult(
    (await projectSavedQueries(result.data)).map((query) => ({
      ...mapSavedQuery(query),
      ref: { type: "pulse.saved_query" as const, id: query.id },
    })),
    cursor.data,
    input.limit,
  );
  return ok({
    ...page,
    refs: page.data.map((query) => ({ type: "pulse.saved_query" as const, id: query.id })),
    links: [{ rel: "open" as const, href: pulseExplorerHref(input.baseId) }],
  });
};

const runSavedQueryExecute = async (input: z.infer<typeof SavedQueryExecuteInputSchema>, context: CapabilityExecutionContext) => {
  const scope = scopeFor(context);
  if (!scope.ok) return scope;
  const baseId = await internalId("bases", input.baseId, context.locale);
  if (!baseId.ok) return baseId;
  const queryId = await resolveBasePublicId("saved_queries", baseId.data, input.queryId);
  if (!queryId) return fail(err.notFound(resolvePulseMessages(context.locale).t.savedQuery));
  const saved = await pulseService.savedQuery.get(baseId.data, queryId, scope.data);
  if (!saved.ok) return saved;
  return executeQuery(
    { baseId: input.baseId, query: saved.data.query },
    context,
    [{ type: "pulse.saved_query", id: input.queryId }],
    baseId.data,
    saved.data.name,
  );
};

export const pulseCapabilities = defineCapabilities({
  protocolVersion: 1,
  presentation: pulseCapabilityPresentation,
  types: {
    base: {
      title: "Pulse Base",
      description: "A permission-scoped Pulse telemetry workspace.",
      icon: "ti ti-activity-heartbeat",
      reader: "base.read",
    },
    source: {
      title: "Pulse Source",
      description: "A telemetry source and its current ingest or scrape health.",
      icon: "ti ti-plug",
      reader: "source.read",
    },
    resource: {
      title: "Pulse Resource",
      description: "An observed resource with metrics, events, or states.",
      icon: "ti ti-box",
      reader: "resource.read",
    },
    saved_query: {
      title: "Pulse Saved Query",
      description: "A named, validated Pulse query stored in a Base.",
      icon: "ti ti-code",
      reader: "saved_query.read",
    },
  },
  queries: {
    "base.search": {
      title: "Search Pulse Bases",
      description:
        "Find an accessible Pulse Base by name or description when its ID is unknown. Use returned pulse.base refs with base.read or their IDs with source.list, metric.search, field.search, and query tools.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "pulse", title: "Pulse", description: "Show Pulse Bases only.", aliases: ["telemetry"] }] },
      run: runBaseSearch,
    },
    "base.list": {
      title: "List Pulse Bases",
      description:
        "Normal entry for Base-scoped telemetry work. List accessible Pulse Bases and use returned pulse.base refs or IDs with readers, source and signal discovery, or query calls.",
      input: BaseListInputSchema,
      data: BaseListDataSchema,
      openWorld: false,
      run: runBaseList,
    },
    "base.read": {
      title: "Read Pulse Base",
      description: "Read one pulse.base ref returned by base.list or base.search.",
      input: BaseReadInputSchema,
      data: BaseDataSchema,
      openWorld: false,
      run: runBaseRead,
    },
    "source.list": {
      title: "List Pulse Sources",
      description:
        "List source health in one known Base without exposing credentials. Get baseId from base.list or base.search; use returned pulse.source refs with source.read.",
      input: SourceListInputSchema,
      data: SourceListDataSchema,
      openWorld: false,
      run: runSourceList,
    },
    "source.read": {
      title: "Read Pulse Source",
      description: "Read one pulse.source ref returned by source.list, including its current ingest or scrape health.",
      input: SourceReadInputSchema,
      data: SourceDataSchema,
      openWorld: false,
      run: runSourceRead,
    },
    "resource.search": {
      title: "Search Pulse Resources",
      description:
        "Direct cross-Base entry for finding observed resources. Use the returned composite pulse.resource ref unchanged with resource.read; use metric.search or field.search when authoring a query in one known Base.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [
          { tag: "pulse-resource", title: "Pulse resources", description: "Show observed Pulse resources only.", aliases: ["resource"] },
        ],
      },
      run: runResourceSearch,
    },
    "resource.read": {
      title: "Read Pulse Resource",
      description: "Read one observed Pulse Resource by passing the composite ID from a resource.search pulse.resource ref unchanged.",
      input: ResourceReadInputSchema,
      data: ResourceDataSchema,
      openWorld: false,
      run: runResourceRead,
    },
    "metric.search": {
      title: "Search Pulse Metrics",
      description:
        "Discover metric names and types before authoring a query in one known Base. Get baseId from base.list or base.search; validate the resulting DSL with query.compile before query.execute.",
      input: MetricSearchInputSchema,
      data: MetricSearchDataSchema,
      openWorld: false,
      run: runMetricSearch,
    },
    "field.search": {
      title: "Search Pulse Fields",
      description:
        "Discover dimension or attribute keys for metrics, events, and states in one known Base without exposing values. Use metric.search for metric names, then query.compile before query.execute.",
      input: FieldSearchInputSchema,
      data: FieldSearchDataSchema,
      openWorld: false,
      run: runFieldSearch,
    },
    "query.compile": {
      title: "Compile Pulse Query",
      description:
        "Validate Pulse query DSL for a baseId from base.list or base.search without reading telemetry rows. Use metric.search and field.search to discover valid names; execute valid DSL with query.execute.",
      input: QueryTextInputSchema,
      data: QueryCompileDataSchema,
      openWorld: false,
      run: runQueryCompile,
    },
    "query.execute": {
      title: "Execute telemetry query",
      description:
        "Execute Pulse query DSL for a baseId from base.list or base.search, normally after query.compile. Returns at most 500 points or 100 compact rows; raw event payloads are omitted and truncated reports omitted results.",
      input: QueryTextInputSchema,
      data: QueryExecutionDataSchema,
      openWorld: false,
      run: executeQuery,
    },
    "saved_query.list": {
      title: "List saved Pulse Queries",
      description:
        "List named queries in one known Base. Get baseId from base.list or base.search; use returned pulse.saved_query refs with saved_query.read or their IDs with saved_query.execute.",
      input: SavedQueryListInputSchema,
      data: SavedQueryListDataSchema,
      openWorld: false,
      run: runSavedQueryList,
    },
    "saved_query.read": {
      title: "Read saved Pulse Query",
      description: "Read one pulse.saved_query ref returned by saved_query.list, including its stored DSL and Base ID.",
      input: SavedQueryReadInputSchema,
      data: SavedQueryDataSchema,
      openWorld: false,
      run: runSavedQueryRead,
    },
    "saved_query.execute": {
      title: "Execute saved telemetry query",
      description:
        "Execute one stored query using baseId and queryId from saved_query.list. This skips query.compile because the stored DSL is already validated and returns the same bounded result as query.execute.",
      input: SavedQueryExecuteInputSchema,
      data: QueryExecutionDataSchema,
      openWorld: false,
      run: runSavedQueryExecute,
    },
  },
});
