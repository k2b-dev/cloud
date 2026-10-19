import {
  type CapabilityExecutionContext,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  UniversalSearchDataSchema,
  type UniversalSearchInput,
  UniversalSearchInputSchema,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import type { z } from "zod";
import {
  BaseDataSchema,
  BaseListDataSchema,
  BaseListInputSchema,
  BaseReadInputSchema,
  SourceDataSchema,
  SourceListDataSchema,
  SourceListInputSchema,
  SourceReadInputSchema,
} from "./capability-contracts";
import { pulseCapabilityPresentation } from "./capability-presentation";
import type { PulseBase, PulseSource } from "./contracts";
import { resolvePulseMessages } from "./messages";
import { pulseBaseHref, pulseSourceHref } from "./resource-hrefs";
import { pulseService } from "./service";
import { accessScopeFor } from "./service/access-control";
import { projectBases, projectSources, resolvePublicId } from "./service/public-resources";
import { PULSE_NOT_CONFIGURED } from "./store/gate";
import { pulseStoreConfigured } from "./store/service";

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

const internalId = async (table: "bases" | "sources", id: string, locale?: string) => {
  const value = await resolvePublicId(table, id);
  return value ? ok(value) : fail(err.notFound(resolvePulseMessages(locale).t.pulseResource));
};

const mapBase = (base: PulseBase) => ({
  store: base.store,
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

const pageResult = <T>(items: T[], offset: number, limit: number) => {
  const data = items.slice(0, limit);
  const hasMore = items.length > limit;
  return { data, page: capabilityPage(hasMore ? encodeCursor(offset + data.length) : undefined) };
};

const runBaseSearch = async (input: UniversalSearchInput, context: CapabilityExecutionContext) => {
  if (!(await pulseStoreConfigured())) return fail({ ...PULSE_NOT_CONFIGURED, status: 500 });
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
  if (!(await pulseStoreConfigured())) return fail({ ...PULSE_NOT_CONFIGURED, status: 500 });
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
  if (!(await pulseStoreConfigured())) return fail({ ...PULSE_NOT_CONFIGURED, status: 500 });
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
  if (!(await pulseStoreConfigured())) return fail({ ...PULSE_NOT_CONFIGURED, status: 500 });
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
  if (!(await pulseStoreConfigured())) return fail({ ...PULSE_NOT_CONFIGURED, status: 500 });
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
    links: [{ rel: "open" as const, href: pulseSourceHref(source!.baseId, source!.id) }],
  });
};

export const pulseCapabilities = defineCapabilities({
  protocolVersion: 2,
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
  },
  queries: {
    "base.search": {
      title: "Search Pulse Bases",
      description:
        "Find an accessible Pulse Base by name or description when its ID is unknown. Use returned pulse.base refs with base.read or their IDs with source.list.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: { tags: [{ tag: "pulse", title: "Pulse", description: "Show Pulse Bases only.", aliases: ["telemetry"] }] },
      run: runBaseSearch,
    },
    "base.list": {
      title: "List Pulse Bases",
      description:
        "Normal entry for Base-scoped telemetry work. List accessible Pulse Bases and use returned pulse.base refs or IDs with base.read and source.list.",
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
  },
});
