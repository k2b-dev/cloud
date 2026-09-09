import { arg, command, flag } from "@k2b/cloud/cli";
import type {
  MetricType,
  PulseCurrentState,
  PulseMetricSeries,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSummary,
} from "../contracts";
import { requireRestArg, resolveBaseFromCommand, resolveSourceFilter } from "./context";
import { baseFlag, metricTypeFlag, resourceFilterFlags } from "./flags";
import { eventRows, inventoryMetricRows, metricRows, metricSummariesFromInventory, seriesRows, sliceRows, stateRows } from "./inventory";
import { exactMatch, printJsonOrTable, queryString, readApi } from "./shared";

const readResource = async (ctx: Parameters<typeof readApi>[0], baseId: string, ref: string): Promise<PulseResourceSummary> => {
  const resources = await readApi<PulseResourceSummary[]>(
    ctx,
    `/bases/${encodeURIComponent(baseId)}/resources${queryString({ ref, limit: 20 })}`,
  );
  return exactMatch(resources, ref, [(resource) => resource.key, (resource) => resource.id, (resource) => resource.label], "resource");
};

const readResourceMetrics = async (
  ctx: Parameters<typeof readApi>[0],
  baseId: string,
  params: { resourceKey: string; q?: string; sourceId?: string; type?: MetricType; limit?: number; offset?: number },
): Promise<PulseResourceMetric[]> =>
  readApi<PulseResourceMetric[]>(ctx, `/bases/${encodeURIComponent(baseId)}/resource-metrics${queryString(params)}`);

const readResourceStates = async (
  ctx: Parameters<typeof readApi>[0],
  baseId: string,
  params: { resourceKey: string; q?: string; sourceId?: string; key?: string; limit?: number; offset?: number },
): Promise<PulseCurrentState[]> =>
  readApi<PulseCurrentState[]>(ctx, `/bases/${encodeURIComponent(baseId)}/resource-states${queryString(params)}`);

const readResourceEvents = async (
  ctx: Parameters<typeof readApi>[0],
  baseId: string,
  params: { resourceKey: string; q?: string; sourceId?: string; kind?: string; limit?: number; offset?: number },
): Promise<PulseRecordedEvent[]> =>
  readApi<PulseRecordedEvent[]>(ctx, `/bases/${encodeURIComponent(baseId)}/resource-events${queryString(params)}`);

export const signalCommands = [
  command("metrics", {
    summary: "List metric definitions",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search metric names" }),
      type: metricTypeFlag,
      ...resourceFilterFlags,
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      if (flags.resource) {
        const resource = await readResource(ctx, base.id, flags.resource);
        const metrics = sliceRows(
          metricSummariesFromInventory(
            await readResourceMetrics(ctx, base.id, {
              resourceKey: resource.key,
              q: flags.q,
              type: flags.type as MetricType | undefined,
              sourceId,
              limit: 500,
            }),
          ),
          flags.limit,
          flags.offset,
        );
        printJsonOrTable(ctx, metrics, metricRows(metrics), [
          { key: "metric" },
          { key: "type" },
          { key: "unit" },
          { key: "series" },
          { key: "lastSeenAt" },
        ]);
        return;
      }
      const metrics = await readApi<PulseMetricSummary[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/metrics${queryString({
          q: flags.q,
          sourceId,
          entityId: flags.entity,
          entityType: flags.entityType,
          type: flags.type as MetricType | undefined,
          limit: flags.limit,
          offset: flags.offset,
        })}`,
      );
      printJsonOrTable(ctx, metrics, metricRows(metrics), [
        { key: "metric" },
        { key: "type" },
        { key: "unit" },
        { key: "series" },
        { key: "lastSeenAt" },
      ]);
    },
  }),
  command("states", {
    summary: "List current states",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search states" }),
      ...resourceFilterFlags,
      key: flag.string({ description: "State key" }),
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      if (flags.resource) {
        const resource = await readResource(ctx, base.id, flags.resource);
        const states = await readResourceStates(ctx, base.id, {
          resourceKey: resource.key,
          q: flags.q,
          key: flags.key,
          sourceId,
          limit: flags.limit,
          offset: flags.offset,
        });
        printJsonOrTable(ctx, states, stateRows(states), [
          { key: "key" },
          { key: "value" },
          { key: "source" },
          { key: "entity" },
          { key: "updatedAt" },
        ]);
        return;
      }
      const states = await readApi<PulseCurrentState[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/states${queryString({
          q: flags.q,
          key: flags.key,
          sourceId,
          entityId: flags.entity,
          entityType: flags.entityType,
          limit: flags.limit,
          offset: flags.offset,
        })}`,
      );
      printJsonOrTable(ctx, states, stateRows(states), [
        { key: "key" },
        { key: "value" },
        { key: "source" },
        { key: "entity" },
        { key: "updatedAt" },
      ]);
    },
  }),
  command("events", {
    summary: "List recent events",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search events" }),
      kind: flag.string({ description: "Event kind" }),
      ...resourceFilterFlags,
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      if (flags.resource) {
        const resource = await readResource(ctx, base.id, flags.resource);
        const events = await readResourceEvents(ctx, base.id, {
          resourceKey: resource.key,
          q: flags.q,
          kind: flags.kind,
          sourceId,
          limit: flags.limit,
          offset: flags.offset,
        });
        printJsonOrTable(ctx, events, eventRows(events), [
          { key: "kind" },
          { key: "value" },
          { key: "source" },
          { key: "entity" },
          { key: "ts" },
        ]);
        return;
      }
      const events = await readApi<PulseRecordedEvent[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/recent-events${queryString({
          q: flags.q,
          kind: flags.kind,
          sourceId,
          entityId: flags.entity,
          entityType: flags.entityType,
          limit: flags.limit,
          offset: flags.offset,
        })}`,
      );
      printJsonOrTable(ctx, events, eventRows(events), [
        { key: "kind" },
        { key: "value" },
        { key: "source" },
        { key: "entity" },
        { key: "ts" },
      ]);
    },
  }),
  command("series", {
    summary: "List metric variants/series",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search series dimensions" }),
      ...resourceFilterFlags,
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: {
      args: arg.rest({ valueLabel: "base metric", required: true }),
    },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const metric = requireRestArg(rest, 0, "metric");
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      if (flags.resource) {
        const resource = await readResource(ctx, base.id, flags.resource);
        const series = sliceRows(
          (
            await readResourceMetrics(ctx, base.id, {
              resourceKey: resource.key,
              q: flags.q ?? metric,
              sourceId,
              limit: 500,
            })
          ).filter((item) => item.metric === metric),
          flags.limit,
          flags.offset,
        );
        printJsonOrTable(ctx, series, inventoryMetricRows(series), [
          { key: "metric" },
          { key: "value" },
          { key: "type" },
          { key: "unit" },
          { key: "source" },
          { key: "lastSeenAt" },
        ]);
        return;
      }
      const series = await readApi<PulseMetricSeries[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/series${queryString({
          metric,
          q: flags.q,
          sourceId,
          entityId: flags.entity,
          entityType: flags.entityType,
          limit: flags.limit,
          offset: flags.offset,
        })}`,
      );
      printJsonOrTable(ctx, series, seriesRows(series), [
        { key: "metric" },
        { key: "source" },
        { key: "entity" },
        { key: "value" },
        { key: "lastSeenAt" },
      ]);
    },
  }),
];
