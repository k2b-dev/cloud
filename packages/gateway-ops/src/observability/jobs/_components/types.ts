import type { TraceCategory, TraceWindow } from "@k2b/cloud/services";

export type JobsHealthFilter = "all" | "failed" | "stuck" | "running" | "healthy";
export type JobsTypeFilter = "all" | TraceCategory;
export type JobsDurationFilter = "all" | "20" | "100" | "1000" | "10000";

export type JobsFilterState = {
  window: TraceWindow;
  health: JobsHealthFilter;
  type: JobsTypeFilter;
  duration: JobsDurationFilter;
  search: string;
  source: string | null;
  run: string | null;
  page: number;
};

export const defaultJobsFilter: JobsFilterState = {
  window: "24h",
  health: "all",
  type: "all",
  duration: "all",
  search: "",
  source: null,
  run: null,
  page: 1,
};

export const jobsWindowOptions: Array<{ value: TraceWindow; label: string; seconds: number }> = [
  { value: "10m", label: "10 min", seconds: 10 * 60 },
  { value: "1h", label: "1 hour", seconds: 60 * 60 },
  { value: "12h", label: "12 hours", seconds: 12 * 60 * 60 },
  { value: "24h", label: "24 hours", seconds: 24 * 60 * 60 },
  { value: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { value: "30d", label: "30 days", seconds: 30 * 24 * 60 * 60 },
];

export const jobsDurationOptions: Array<{ value: JobsDurationFilter; label: string; minMs: number | null }> = [
  { value: "all", label: "All durations", minMs: null },
  { value: "20", label: ">20ms", minMs: 20 },
  { value: "100", label: ">100ms", minMs: 100 },
  { value: "1000", label: ">1s", minMs: 1000 },
  { value: "10000", label: ">10s", minMs: 10000 },
];

const windows = new Set(jobsWindowOptions.map((option) => option.value));
const healthFilters = new Set<JobsHealthFilter>(["all", "failed", "stuck", "running", "healthy"]);
const typeFilters = new Set<JobsTypeFilter>(["all", "job", "schedule", "backfill", "ai", "http", "notification", "sync", "custom"]);
const durationFilters = new Set(jobsDurationOptions.map((option) => option.value));

const parsePage = (value: string | null): number => {
  const page = Number(value ?? "1");
  return Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
};

export const parseJobsFilterFromUrl = (url: URL): JobsFilterState => {
  const params = url.searchParams;
  const window = params.get("window");
  const health = params.get("health");
  const type = params.get("type");
  const duration = params.get("duration");
  const source = params.get("source")?.trim() || null;
  const run = params.get("run")?.trim() || null;
  return {
    window: window && windows.has(window as TraceWindow) ? (window as TraceWindow) : defaultJobsFilter.window,
    health: health && healthFilters.has(health as JobsHealthFilter) ? (health as JobsHealthFilter) : defaultJobsFilter.health,
    type: type && typeFilters.has(type as JobsTypeFilter) ? (type as JobsTypeFilter) : defaultJobsFilter.type,
    duration:
      duration && durationFilters.has(duration as JobsDurationFilter) ? (duration as JobsDurationFilter) : defaultJobsFilter.duration,
    search: params.get("search")?.trim() ?? defaultJobsFilter.search,
    source,
    run,
    page: parsePage(params.get("page")),
  };
};

export const minDurationFromFilter = (duration: JobsDurationFilter): number | undefined =>
  jobsDurationOptions.find((option) => option.value === duration)?.minMs ?? undefined;

export const buildJobsFilterUrl = (baseUrl: string, updates: Partial<JobsFilterState>, current: JobsFilterState): string => {
  const merged = { ...current, ...updates };
  const params = new URLSearchParams();

  if (merged.window !== defaultJobsFilter.window) params.set("window", merged.window);
  if (merged.health !== defaultJobsFilter.health) params.set("health", merged.health);
  if (merged.type !== defaultJobsFilter.type) params.set("type", merged.type);
  if (merged.duration !== defaultJobsFilter.duration) params.set("duration", merged.duration);
  if (merged.search) params.set("search", merged.search);
  if (merged.source) params.set("source", merged.source);
  if (merged.run) params.set("run", merged.run);
  if (merged.page > 1) params.set("page", String(merged.page));

  const query = params.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
};

export const hasActiveJobsFilters = (filter: JobsFilterState): boolean =>
  filter.window !== defaultJobsFilter.window ||
  filter.health !== defaultJobsFilter.health ||
  filter.type !== defaultJobsFilter.type ||
  filter.duration !== defaultJobsFilter.duration ||
  filter.search.length > 0;
