import { err, fail, ok, type Result } from "@k2b/stdlib";
import { TRACE_STUCK_AFTER_MS, type TraceCategory, type TraceSourceGroup } from "@valentinkolb/cloud/services";
import { syncOpsService } from "../sync/runtime";
import type { SyncOpsCredentials, SyncScheduleRow } from "../sync/service";

export type ScheduleMetadata = {
  appId: string | null;
  family: string;
  label: string;
  source: string;
  resourceKind: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  detailHref: string | null;
};

export type ScheduleOverviewRow = ScheduleMetadata & {
  kind: "schedule";
  schedulerId: string;
  scheduleId: string;
  cron: string;
  tz: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  runNumber: number;
  failureCount: number;
  state: "available" | "unavailable";
  lastError: string | null;
  trace: TraceSourceGroup | null;
};

export type TraceOnlyOverviewRow = {
  kind: "trace";
  schedulerId: null;
  scheduleId: null;
  cron: null;
  tz: null;
  createdAt: null;
  updatedAt: null;
  nextRunAt: null;
  runNumber: null;
  failureCount: null;
  state: "trace-only";
  lastError: null;
  appId: string | null;
  family: string;
  label: string;
  source: string;
  resourceKind: null;
  resourceId: null;
  resourceLabel: null;
  detailHref: null;
  trace: TraceSourceGroup;
};

export type BackgroundJobOverviewRow = ScheduleOverviewRow | TraceOnlyOverviewRow;

export type BackgroundJobOverviewFilter = {
  source?: string | null;
  search?: string;
  type?: "all" | TraceCategory;
  health?: "all" | "failed" | "stuck" | "running" | "healthy";
  requireTraceMatch?: boolean;
};

export type RunScheduleNowInput = {
  schedulerId: string;
  scheduleId: string;
  requestId?: string;
  timeoutMs?: number;
};

export type RunScheduleNowAccepted = {
  message: string;
  schedulerId: string;
  scheduleId: string;
  acceptedAt: string;
};

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const cleanDetailHref = (value: unknown): string | null => {
  const href = clean(value);
  if (!href) return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  return href;
};

export const normalizeScheduleMetadata = (schedule: Pick<SyncScheduleRow, "id" | "schedulerId" | "meta" | "appId">): ScheduleMetadata => {
  const meta = schedule.meta && typeof schedule.meta === "object" ? schedule.meta : {};
  const source = clean(meta.source) ?? schedule.id;
  return {
    appId: schedule.appId ?? clean(meta.appId),
    family: clean(meta.family) ?? source,
    label: clean(meta.label) ?? schedule.id,
    source,
    resourceKind: clean(meta.resourceKind),
    resourceId: clean(meta.resourceId),
    resourceLabel: clean(meta.resourceLabel),
    detailHref: cleanDetailHref(meta.detailHref),
  };
};

const traceOnlyLabel = (group: TraceSourceGroup): string => group.latestName ?? group.names[0] ?? group.source;

export const buildBackgroundJobRows = (schedules: SyncScheduleRow[], groups: TraceSourceGroup[]): BackgroundJobOverviewRow[] => {
  const groupsBySource = new Map(groups.map((group) => [group.source, group]));
  const scheduledSources = new Set<string>();

  const rows: BackgroundJobOverviewRow[] = schedules.map((schedule) => {
    const meta = normalizeScheduleMetadata(schedule);
    scheduledSources.add(meta.source);
    return {
      kind: "schedule",
      schedulerId: schedule.schedulerId,
      scheduleId: schedule.id,
      cron: schedule.cron,
      tz: schedule.timezone,
      createdAt: Date.parse(schedule.createdAt),
      updatedAt: Date.parse(schedule.updatedAt),
      nextRunAt: Date.parse(schedule.nextRunAt),
      runNumber: schedule.runNumber,
      failureCount: schedule.failureCount,
      state: schedule.handlerAvailable ? "available" : "unavailable",
      lastError: schedule.lastError ?? null,
      trace: groupsBySource.get(meta.source) ?? null,
      ...meta,
    };
  });

  for (const group of groups) {
    if (scheduledSources.has(group.source)) continue;
    rows.push({
      kind: "trace",
      schedulerId: null,
      scheduleId: null,
      cron: null,
      tz: null,
      createdAt: null,
      updatedAt: null,
      nextRunAt: null,
      runNumber: null,
      failureCount: null,
      state: "trace-only",
      lastError: null,
      appId: group.appId,
      family: group.source,
      label: traceOnlyLabel(group),
      source: group.source,
      resourceKind: null,
      resourceId: null,
      resourceLabel: null,
      detailHref: null,
      trace: group,
    });
  }

  return rows.sort((a, b) => {
    const app = (a.appId ?? "").localeCompare(b.appId ?? "");
    if (app !== 0) return app;
    const family = a.family.localeCompare(b.family);
    if (family !== 0) return family;
    const label = a.label.localeCompare(b.label);
    if (label !== 0) return label;
    return `${a.schedulerId ?? ""}:${a.scheduleId ?? ""}`.localeCompare(`${b.schedulerId ?? ""}:${b.scheduleId ?? ""}`);
  });
};

const rowMatchesSearch = (row: BackgroundJobOverviewRow, search: string): boolean => {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.appId,
    row.family,
    row.label,
    row.resourceKind,
    row.resourceId,
    row.resourceLabel,
    row.detailHref,
    row.source,
    row.schedulerId,
    row.scheduleId,
    row.trace?.latestName,
    row.trace?.names.join(" "),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
};

const rowMatchesHealth = (row: BackgroundJobOverviewRow, health: BackgroundJobOverviewFilter["health"]): boolean => {
  if (!health || health === "all") return true;
  const trace = row.trace;
  if (!trace) return false;
  // "stuck" is about abandoned spans anywhere in the window, not about the
  // latest run, because the latest run of a source can look fine while older
  // ones hang forever.
  if (health === "stuck") return trace.stuck > 0;
  if (health === "running") return trace.running > 0;
  if (health === "failed") return trace.latestStatus === "error";
  if (health === "healthy") return trace.latestStatus === "ok";
  return true;
};

const rowMatchesType = (row: BackgroundJobOverviewRow, type: BackgroundJobOverviewFilter["type"]): boolean => {
  if (!type || type === "all") return true;
  if (row.kind === "schedule") return type === "schedule";
  return row.trace.categories.includes(type);
};

export const filterBackgroundJobRows = (
  rows: BackgroundJobOverviewRow[],
  filter: BackgroundJobOverviewFilter,
): BackgroundJobOverviewRow[] =>
  rows.filter((row) => {
    if (filter.source && row.source !== filter.source) return false;
    if (filter.requireTraceMatch && !row.trace) return false;
    if (!rowMatchesSearch(row, filter.search ?? "")) return false;
    if (!rowMatchesType(row, filter.type)) return false;
    if (!rowMatchesHealth(row, filter.health)) return false;
    return true;
  });

export const jobsObservabilityService = {
  listSchedules: async (credentials: SyncOpsCredentials): Promise<{ schedules: SyncScheduleRow[]; warnings: string[] }> => {
    const overview = await syncOpsService.overview(credentials);
    return {
      schedules: overview.schedules,
      warnings: overview.apps
        .filter((app) => app.status === "unavailable")
        .map((app) => `${app.appName}: ${app.error ?? "Sync operations unavailable"}`),
    };
  },
  runScheduleNow: async (
    input: RunScheduleNowInput & { appId: string },
    credentials: SyncOpsCredentials,
  ): Promise<Result<RunScheduleNowAccepted>> => {
    if (!input.appId.trim() || !input.schedulerId.trim() || !input.scheduleId.trim()) {
      return fail(err.badInput("App, scheduler and schedule IDs are required"));
    }
    const result = await syncOpsService.runScheduleNow(input, credentials);
    if (!result.ok) return result;
    return ok({
      message: "Schedule run accepted",
      schedulerId: input.schedulerId,
      scheduleId: input.scheduleId,
      acceptedAt: new Date().toISOString(),
    });
  },
};

/**
 * Lanes for the run timeline.
 *
 * A to-scale timeline does not work for this data: the busiest job in a
 * six-hour window occupies half a percent of it, and a 22ms run is a subpixel
 * at any readable zoom. Marks are therefore positioned to scale on the time
 * axis but given a floor width so they stay visible — the x position says
 * *when*, the width says nothing. Duration is answered by the runtime columns
 * instead.
 */
export const TIMELINE_LANES = 12;
const TIMELINE_RUNS_PER_LANE = 300;
/** Each mark spans at least this fraction of the window so it can be seen. */
const TIMELINE_MIN_MARK_FRACTION = 0.0025;

export type JobTimelineInterval = {
  from: number;
  to: number;
  state: "ok" | "error" | "running" | "stuck";
  label?: string;
  traceId: string;
  spanId: string;
  name: string;
  startedAt: string;
  durationMs: number | null;
  statusMessage: string | null;
};
export type JobTimelineRow = { source: string; label: string; intervals: JobTimelineInterval[] };

export const buildJobTimelineRows = (
  spans: {
    traceId: string;
    spanId: string;
    name: string;
    source: string;
    status: string;
    statusMessage: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
  }[],
  window: { fromMs: number; toMs: number },
): JobTimelineRow[] => {
  const spanMs = Math.max(1, window.toMs - window.fromMs);
  const minMark = spanMs * TIMELINE_MIN_MARK_FRACTION;
  const bySource = new Map<string, JobTimelineInterval[]>();

  for (const span of spans) {
    if (!span.startedAt) continue;
    const startedAt = new Date(span.startedAt).getTime();
    if (!Number.isFinite(startedAt)) continue;
    const lane = bySource.get(span.source) ?? [];
    if (lane.length >= TIMELINE_RUNS_PER_LANE) continue;

    const open = !span.endedAt;
    const state: JobTimelineInterval["state"] = open
      ? window.toMs - startedAt >= TRACE_STUCK_AFTER_MS
        ? "stuck"
        : "running"
      : span.status === "error"
        ? "error"
        : "ok";
    const from = Math.max(window.fromMs, startedAt);
    const naturalTo = open ? window.toMs : new Date(span.endedAt as string).getTime();
    const to = Math.min(window.toMs, Math.max(from + minMark, Number.isFinite(naturalTo) ? naturalTo : from));

    lane.push({
      from,
      to,
      state,
      label: span.durationMs === null ? undefined : `${span.durationMs}ms`,
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      statusMessage: span.statusMessage,
    });
    bySource.set(span.source, lane);
  }

  return [...bySource.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, TIMELINE_LANES)
    .map(([source, intervals]) => ({ source, label: source, intervals }));
};
