/**
 * Structured application logs — listing, aggregation, and the correlation
 * helpers (`problems`, `explain`) that turn one entry into context.
 */
import { arg, type CloudCliContext, type CloudCliTableColumn, command, confirmFlag, flag, paginationFlags } from "../index";
import type { GatewayHealth } from "./gateway";
import {
  apiGet,
  type Pagination,
  pageQuery,
  parseLookbackHours,
  printJsonOrTable,
  queryString,
  safeCollect,
  sleep,
  sortByTimeDesc,
  truncate,
} from "./shared";
import type { TelemetryEvent } from "./telemetry";

export type LogEntry = {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type LogSummary = {
  total: number;
  errors24h: number;
  warnings24h: number;
  total24h: number;
  sources: number;
  lastErrorAt: string | null;
};

export type LogStatsResponse = {
  groupBy: "source" | "level";
  items: { key: string; count: number }[];
};

export const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

export const parseLogId = (value: string): string => {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Log id must be a positive integer.");
  if (BigInt(value) > PG_BIGINT_MAX) throw new Error("Log id must fit into a Postgres BIGINT.");
  return value;
};

export const logRows = (entries: LogEntry[], messageLength = 120) =>
  entries.map((entry) => ({
    time: entry.createdAt,
    level: entry.level,
    source: entry.source,
    message: truncate(entry.message, messageLength),
    metadata: entry.metadata ? "yes" : "",
    id: entry.id,
  }));

export const logColumns = [
  { key: "time" },
  { key: "level" },
  { key: "source" },
  { key: "message" },
  { key: "metadata" },
  { key: "id" },
] satisfies CloudCliTableColumn<ReturnType<typeof logRows>[number]>[];

export const getLogs = async (
  ctx: CloudCliContext,
  params: {
    search?: string;
    source?: string;
    level?: "debug" | "info" | "warn" | "error";
    sinceHours?: number;
    page?: number;
    perPage?: number;
  },
): Promise<{ entries: LogEntry[]; pagination: Pagination }> =>
  apiGet(
    ctx,
    `/api/logging${queryString({
      search: params.search,
      source: params.source,
      level: params.level,
      since_hours: params.sinceHours,
      ...pageQuery(params),
    })}`,
  );

export const trimLogMessages = <T extends { entries: LogEntry[] }>(result: T, messageLength: number): T => ({
  ...result,
  entries: result.entries.map((entry) => ({ ...entry, message: truncate(entry.message, messageLength) })),
});

export const logCommands = [
  command("logs list", {
    summary: "List log entries with source, level, and free-text filters",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Free-text log search" }),
      source: flag.string({ description: "Log source filter" }),
      level: flag.enum(["debug", "info", "warn", "error"], { description: "Log level filter" }),
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d (default: 24h)" }),
      messageLength: flag.int({ name: "message-length", default: 140, min: 40, max: 1000, description: "Table message preview length" }),
      ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
    },
    run: async ({ ctx, flags }) => {
      const result = await getLogs(ctx, { ...flags, sinceHours: parseLookbackHours(flags.since ?? "24h") });
      printJsonOrTable(
        ctx,
        { ...result, sinceHours: parseLookbackHours(flags.since ?? "24h") },
        logRows(result.entries, flags.messageLength),
        logColumns,
      );
    },
  }),
  command("logs summary", {
    summary: "Show log volume and recent error summary",
    run: async ({ ctx }) => {
      const result = await apiGet<LogSummary>(ctx, "/api/logging/summary");
      printJsonOrTable(
        ctx,
        result,
        [result],
        [{ key: "total" }, { key: "total24h" }, { key: "errors24h" }, { key: "warnings24h" }, { key: "sources" }, { key: "lastErrorAt" }],
      );
    },
  }),
  command("logs stats", {
    summary: "Group log volume by source or level",
    flags: {
      groupBy: flag.enum(["source", "level"], { name: "group-by", default: "source", description: "Stats dimension" }),
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d" }),
      limit: flag.int({ default: 50, min: 1, max: 200, description: "Maximum groups" }),
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<LogStatsResponse>(
        ctx,
        `/api/logging/stats${queryString({
          group_by: flags.groupBy,
          since_hours: parseLookbackHours(flags.since),
          limit: flags.limit,
        })}`,
      );
      printJsonOrTable(ctx, result, result.items, [
        { key: "key", label: flags.groupBy === "level" ? "level" : "source" },
        { key: "count" },
      ]);
    },
  }),
  command("logs errors", {
    summary: "List recent error logs for incident debugging",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Free-text log search" }),
      source: flag.string({ description: "Log source filter" }),
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d" }),
      messageLength: flag.int({ name: "message-length", default: 180, min: 40, max: 1000, description: "Table message preview length" }),
      ...paginationFlags({ defaultPerPage: 25, maxPerPage: 100 }),
    },
    run: async ({ ctx, flags }) => {
      const result = await getLogs(ctx, { ...flags, level: "error", sinceHours: parseLookbackHours(flags.since) });
      printJsonOrTable(
        ctx,
        { ...result, sinceHours: parseLookbackHours(flags.since ?? "24h") },
        logRows(result.entries, flags.messageLength),
        logColumns,
      );
    },
  }),
  command("logs problems", {
    summary: "List recent warn and error logs together",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Free-text log search" }),
      source: flag.string({ description: "Log source filter" }),
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d" }),
      limit: flag.int({ default: 50, min: 1, max: 100, description: "Maximum combined rows" }),
      messageLength: flag.int({ name: "message-length", default: 160, min: 40, max: 1000, description: "Table message preview length" }),
    },
    run: async ({ ctx, flags }) => {
      const perPage = flags.limit ?? 50;
      const sinceHours = parseLookbackHours(flags.since);
      const [errors, warnings] = await Promise.all([
        getLogs(ctx, { search: flags.search, source: flags.source, level: "error", sinceHours, perPage }),
        getLogs(ctx, { search: flags.search, source: flags.source, level: "warn", sinceHours, perPage }),
      ]);
      const entries = sortByTimeDesc([...errors.entries, ...warnings.entries]).slice(0, perPage);
      const result = { entries, totals: { errors: errors.pagination.total, warnings: warnings.pagination.total } };
      printJsonOrTable(ctx, result, logRows(entries, flags.messageLength), logColumns);
    },
  }),
  command("logs show", {
    summary: "Show one log entry with full message and metadata",
    args: { id: arg.required({ valueLabel: "id" }) },
    run: async ({ ctx, args }) => {
      const id = parseLogId(args.id);
      const result = await apiGet<LogEntry>(ctx, `/api/logging/${id}`);
      if (ctx.options.output === "json") {
        ctx.json(result);
        return;
      }
      const metadata = result.metadata ? `\nmetadata:\n${JSON.stringify(result.metadata, null, 2)}` : "";
      ctx.print(`[${result.createdAt}] ${result.level} ${result.source} #${result.id}\n${result.message}${metadata}`);
    },
  }),
  command("logs explain", {
    summary: "Collect one log entry with nearby diagnostic context",
    args: { id: arg.required({ valueLabel: "id" }) },
    flags: {
      since: flag.string({ default: "24h", description: "Context lookback window like 30m, 6h, or 7d" }),
      limit: flag.int({ default: 20, min: 1, max: 50, description: "Context rows per section" }),
      messageLength: flag.int({ name: "message-length", default: 500, min: 40, max: 5000, description: "Context log message length" }),
    },
    run: async ({ ctx, args, flags }) => {
      const id = parseLogId(args.id);
      const log = await apiGet<LogEntry>(ctx, `/api/logging/${id}`);
      const sinceHours = parseLookbackHours(flags.since);
      const limit = flags.limit ?? 20;
      const [sameSource, recentProblems, telemetryErrors, appHealth] = await Promise.all([
        safeCollect("same source logs", () => getLogs(ctx, { source: log.source, sinceHours, perPage: limit })),
        safeCollect("recent warn/error logs", async () => {
          const [errors, warnings] = await Promise.all([
            getLogs(ctx, { level: "error", sinceHours, perPage: limit }),
            getLogs(ctx, { level: "warn", sinceHours, perPage: limit }),
          ]);
          return sortByTimeDesc([...errors.entries, ...warnings.entries]).slice(0, limit);
        }),
        safeCollect("telemetry errors", () =>
          apiGet<{ items: TelemetryEvent[]; total: number }>(
            ctx,
            `/api/gateway/telemetry/events${queryString({ errors: "1", hours: sinceHours, page: 1, per_page: limit })}`,
          ),
        ),
        safeCollect("app health", async () => {
          const health = await apiGet<GatewayHealth>(ctx, "/api/gateway/health");
          return health.apps.find((app) => app.id === log.source || app.name === log.source) ?? null;
        }),
      ]);
      const trimEntry = (entry: LogEntry) => ({ ...entry, message: truncate(entry.message, flags.messageLength ?? 500) });
      const bundle = {
        log,
        lookbackHours: sinceHours,
        sameSource:
          sameSource.ok && flags.messageLength
            ? { ...sameSource, data: trimLogMessages(sameSource.data, flags.messageLength) }
            : sameSource,
        recentProblems: recentProblems.ok ? { ...recentProblems, data: recentProblems.data.map(trimEntry) } : recentProblems,
        telemetryErrors,
        appHealth,
      };
      if (ctx.options.output === "json") {
        ctx.json(bundle);
        return;
      }
      const lines = [
        `[${log.createdAt}] ${log.level} ${log.source} #${log.id}`,
        log.message,
        "",
        `same-source logs: ${sameSource.ok ? sameSource.data.entries.length : `unavailable (${sameSource.error})`}`,
        `recent problems: ${recentProblems.ok ? recentProblems.data.length : `unavailable (${recentProblems.error})`}`,
        `telemetry errors: ${telemetryErrors.ok ? telemetryErrors.data.items.length : `unavailable (${telemetryErrors.error})`}`,
        `app health: ${appHealth.ok ? (appHealth.data ? `${appHealth.data.status} (${appHealth.data.id})` : "no matching app") : `unavailable (${appHealth.error})`}`,
      ];
      ctx.print(lines.join("\n"));
    },
  }),
  command("logs tail", {
    summary: "Show latest logs, optionally filtered",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Free-text log search" }),
      source: flag.string({ description: "Log source filter" }),
      level: flag.enum(["debug", "info", "warn", "error"], { description: "Log level filter" }),
      since: flag.string({ default: "24h", description: "Lookback window like 30m, 6h, or 7d (default: 24h)" }),
      lines: flag.int({ default: 20, min: 1, max: 100, description: "Rows to show" }),
      follow: flag.boolean({ aliases: ["f"], description: "Poll and print new rows until interrupted" }),
      interval: flag.int({ default: 2, min: 1, max: 60, description: "Follow poll interval in seconds" }),
      messageLength: flag.int({ name: "message-length", default: 180, min: 40, max: 1000, description: "Table message preview length" }),
    },
    run: async ({ ctx, flags }) => {
      const load = () =>
        getLogs(ctx, {
          search: flags.search,
          source: flags.source,
          level: flags.level,
          sinceHours: parseLookbackHours(flags.since ?? "24h"),
          perPage: flags.lines ?? 20,
        });
      const result = await load();
      printJsonOrTable(
        ctx,
        { ...result, sinceHours: parseLookbackHours(flags.since ?? "24h") },
        logRows(result.entries, flags.messageLength),
        logColumns,
      );
      if (!flags.follow) return;
      const seen = new Set(result.entries.map((entry) => entry.id));
      while (true) {
        await sleep((flags.interval ?? 2) * 1000);
        const next = await load();
        const fresh = next.entries.filter((entry) => !seen.has(entry.id)).reverse();
        for (const entry of fresh) seen.add(entry.id);
        if (fresh.length === 0) continue;
        if (ctx.options.output === "json") {
          for (const entry of fresh) ctx.json(entry);
        } else {
          ctx.table(logRows(fresh, flags.messageLength), logColumns);
        }
      }
    },
  }),
  command("logs sources", {
    summary: "List log sources",
    run: async ({ ctx }) => {
      const result = await apiGet<{ sources: string[] }>(ctx, "/api/logging/sources");
      printJsonOrTable(
        ctx,
        result,
        result.sources.map((source) => ({ source })),
        [{ key: "source" }],
      );
    },
  }),
  command("logs cleanup", {
    summary: "Delete old retained logs",
    flags: {
      days: flag.int({ default: 30, min: 1, description: "Delete logs older than this many days" }),
      yes: confirmFlag("Confirm log cleanup"),
    },
    run: async ({ ctx, flags }) => {
      if (!flags.yes) throw new Error("Refusing to clean logs without --yes.");
      const result = await ctx.readJson<{ deleted: number }>(
        await ctx.fetch(`/api/logging/cleanup${queryString({ days: flags.days })}`, { method: "DELETE" }),
      );
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Deleted ${result.deleted} log entries.`);
    },
  }),
];
