import { arg, type CloudCliContext, command, flag } from "@k2b/cloud/cli";
import type {
  PulseCurrentState,
  PulseInventory,
  PulseMetricSummary,
  PulseRecordedEvent,
  PulseResourceMetric,
  PulseResourceSummary,
} from "../contracts";
import {
  listDashboards,
  listSources,
  requireRestArg,
  resolveBaseFromCommand,
  resolveSourceFilter,
  type SourceFilterFlags,
} from "./context";
import { baseFlag, metricTypeFlag, sourceFilterFlags } from "./flags";
import {
  eventRows,
  inventoryMetricRows,
  metricRows,
  overviewRows,
  resourceDetailRows,
  resourceRows,
  resourceSummaryRows,
  signalFieldRows,
  stateRows,
} from "./inventory";
import { dashboardRows, sourceRows } from "./rows";
import { exactMatch, printJsonOrTable, queryString, readApi } from "./shared";

const resourceListFlags = {
  ...baseFlag,
  q: flag.string({ description: "Search resources" }),
  type: flag.string({ description: "Resource type" }),
  ...sourceFilterFlags,
  limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
  offset: flag.int({ min: 0, description: "Row offset" }),
};

const listResources = async (
  ctx: CloudCliContext,
  baseId: string,
  params: { q?: string; ref?: string; type?: string; sourceId?: string; limit?: number; offset?: number } = {},
): Promise<PulseResourceSummary[]> =>
  readApi<PulseResourceSummary[]>(ctx, `/bases/${encodeURIComponent(baseId)}/resources${queryString(params)}`);

const readResource = async (ctx: CloudCliContext, baseId: string, ref: string): Promise<PulseResourceSummary> => {
  const resources = await listResources(ctx, baseId, { ref, limit: 20 });
  return exactMatch(resources, ref, [(resource) => resource.key, (resource) => resource.id, (resource) => resource.label], "resource");
};

const listResourcesForCommand = async (
  ctx: CloudCliContext,
  args: string[],
  flags: SourceFilterFlags & { q?: string; type?: string; limit?: number; offset?: number },
) => {
  const { base } = await resolveBaseFromCommand(ctx, args, 0);
  const sourceId = await resolveSourceFilter(ctx, base.id, flags);
  const resources = await listResources(ctx, base.id, {
    q: flags.q,
    type: flags.type,
    sourceId,
    limit: flags.limit ?? 100,
    offset: flags.offset,
  });
  const rows = resourceSummaryRows(resources);
  printJsonOrTable(ctx, { resources }, rows, [
    { key: "type" },
    { key: "label" },
    { key: "metrics" },
    { key: "states" },
    { key: "events" },
    { key: "sources" },
    { key: "lastSeenAt" },
  ]);
};

export const inventoryCommands = [
  command("inventory", {
    summary: "Show Pulse inventory counts",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const inventory = await readApi<PulseInventory>(ctx, `/bases/${encodeURIComponent(base.id)}/inventory`);
      const summary = {
        resources: inventory.resources.length,
        metrics: inventory.metrics.length,
        events: inventory.events.length,
        states: inventory.states.length,
        fields: inventory.fields.length,
      };
      printJsonOrTable(
        ctx,
        { summary, inventory },
        [summary],
        [{ key: "resources" }, { key: "metrics" }, { key: "events" }, { key: "states" }, { key: "fields" }],
      );
    },
  }),
  command("fields list", {
    summary: "List observed telemetry fields",
    flags: {
      ...baseFlag,
      ...sourceFilterFlags,
      q: flag.string({ description: "Search signal and field names" }),
      scope: flag.enum(["metric", "event", "state"] as const, { description: "Signal scope" }),
      role: flag.enum(["dimension", "attribute", "sensitive"] as const, { description: "Field role" }),
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      const fields = await readApi<PulseInventory["fields"]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/fields${queryString({
          q: flags.q,
          sourceId,
          scope: flags.scope,
          role: flags.role,
          limit: flags.limit ?? 100,
        })}`,
      );
      printJsonOrTable(ctx, { fields }, signalFieldRows(fields), [
        { key: "scope" },
        { key: "signal" },
        { key: "role" },
        { key: "field" },
        { key: "type" },
        { key: "source" },
        { key: "observations" },
        { key: "lastSeenAt" },
      ]);
    },
  }),
  command("resources list", {
    summary: "List Pulse resources from inventory",
    flags: resourceListFlags,
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      await listResourcesForCommand(ctx, args.args, flags);
    },
  }),
  command("resources get", {
    summary: "Show one Pulse resource from inventory",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base resource", required: true }) },
    async run({ ctx, args }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const resource = await readResource(ctx, base.id, requireRestArg(rest, 0, "resource"));
      printJsonOrTable(ctx, resource, resourceDetailRows(resource), [{ key: "key" }, { key: "value" }]);
    },
  }),
  command("resources metrics", {
    summary: "List metrics for one Pulse resource",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search metric names or dimensions" }),
      ...sourceFilterFlags,
      type: metricTypeFlag,
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base resource", required: true }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      const resource = await readResource(ctx, base.id, requireRestArg(rest, 0, "resource"));
      const metrics = await readApi<PulseResourceMetric[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/resource-metrics${queryString({
          resourceKey: resource.key,
          q: flags.q,
          sourceId,
          type: flags.type,
          limit: flags.limit,
          offset: flags.offset,
        })}`,
      );
      printJsonOrTable(ctx, metrics, inventoryMetricRows(metrics), [
        { key: "metric" },
        { key: "value" },
        { key: "type" },
        { key: "unit" },
        { key: "source" },
        { key: "lastSeenAt" },
      ]);
    },
  }),
  command("resources states", {
    summary: "List current states for one Pulse resource",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search states" }),
      ...sourceFilterFlags,
      key: flag.string({ description: "State key" }),
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base resource", required: true }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      const resource = await readResource(ctx, base.id, requireRestArg(rest, 0, "resource"));
      const states = await readApi<PulseCurrentState[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/resource-states${queryString({
          resourceKey: resource.key,
          q: flags.q,
          sourceId,
          key: flags.key,
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
  command("resources events", {
    summary: "List recent events for one Pulse resource",
    flags: {
      ...baseFlag,
      q: flag.string({ description: "Search events" }),
      ...sourceFilterFlags,
      kind: flag.string({ description: "Event kind" }),
      limit: flag.int({ min: 1, max: 500, description: "Maximum rows" }),
      offset: flag.int({ min: 0, description: "Row offset" }),
    },
    args: { args: arg.rest({ valueLabel: "base resource", required: true }) },
    async run({ ctx, args, flags }) {
      const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
      const sourceId = await resolveSourceFilter(ctx, base.id, flags);
      const resource = await readResource(ctx, base.id, requireRestArg(rest, 0, "resource"));
      const events = await readApi<PulseRecordedEvent[]>(
        ctx,
        `/bases/${encodeURIComponent(base.id)}/resource-events${queryString({
          resourceKey: resource.key,
          q: flags.q,
          sourceId,
          kind: flags.kind,
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
  command("overview", {
    summary: "Summarize a Pulse base for dashboard planning",
    flags: {
      ...baseFlag,
      includeInventory: flag.boolean({ name: "include-inventory", description: "Include the full inventory payload in JSON output" }),
    },
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const [sources, inventory, metrics, dashboards] = await Promise.all([
        listSources(ctx, base.id),
        readApi<PulseInventory>(ctx, `/bases/${encodeURIComponent(base.id)}/inventory`),
        readApi<PulseMetricSummary[]>(ctx, `/bases/${encodeURIComponent(base.id)}/metrics${queryString({ limit: 500 })}`),
        listDashboards(ctx, base.id),
      ]);
      const topResources = [...inventory.resources]
        .sort((a, b) => b.metricCount + b.stateCount + b.eventCount - (a.metricCount + a.stateCount + a.eventCount))
        .slice(0, 20);
      const topMetrics = [...metrics].sort((a, b) => b.seriesCount - a.seriesCount).slice(0, 20);
      const summary = overviewRows(base, inventory, sources, metrics)[0]!;
      const overview = {
        base,
        summary,
        sources: sourceRows(sources),
        dashboards: dashboardRows(dashboards),
        topResources: resourceRows({ ...inventory, resources: topResources }, {}),
        topMetrics: metricRows(topMetrics),
        ...(flags.includeInventory ? { inventory, metrics } : {}),
      };
      printJsonOrTable(ctx, overview, overviewRows(base, inventory, sources, metrics), [
        { key: "base" },
        { key: "sources" },
        { key: "resources" },
        { key: "resourceTypes" },
        { key: "metrics" },
        { key: "metricSeries" },
        { key: "events" },
        { key: "states" },
        { key: "fields" },
      ]);
      if (ctx.options.output !== "text") return;
      if (topResources.length) {
        ctx.print("");
        ctx.print("Top resources:");
        ctx.table(resourceRows({ ...inventory, resources: topResources }, {}), [
          { key: "type" },
          { key: "label" },
          { key: "metrics" },
          { key: "states" },
          { key: "events" },
          { key: "lastSeenAt" },
        ]);
      }
      if (topMetrics.length) {
        ctx.print("");
        ctx.print("Top metrics:");
        ctx.table(metricRows(topMetrics), [{ key: "metric" }, { key: "type" }, { key: "unit" }, { key: "series" }, { key: "lastSeenAt" }]);
      }
    },
  }),
];
