/**
 * The log list's one declaration: its filters, groups and address. The SSR page, the list API and the browser read
 * and write the address only through it, so reload, back and a shared link show the same entries.
 *
 * Gateway Ops filters on the server (`service.ts`); the declaration only names fields, values and bounds.
 */
import {
  defineListQuery,
  field,
  type ListQueryIssue,
  type ListQueryStateOf,
  type LookupItem,
  type PeriodValue,
} from "@k2b/ui/v2/list-query";
import type { LogLevel } from "./contracts";
import { type LogsMessages, logsMessages } from "./messages";

export const LOGS_PAGE_PATH = "/admin/observability/logs";

/** Lookback of each time preset in minutes. */
export const LOG_TIME_PRESETS = {
  "last-15m": 15,
  "last-1h": 60,
  "last-6h": 6 * 60,
  "last-24h": 24 * 60,
  "last-7d": 7 * 24 * 60,
  "last-30d": 30 * 24 * 60,
} as const;
export type LogTimePreset = keyof typeof LOG_TIME_PRESETS;

/**
 * The window shown without a time filter. It stays 24 hours, as before v2: the dashboard widget and the overview
 * count "errors in the last 24 hours" and link here, so the list must show the same entries.
 */
export const DEFAULT_LOG_PRESET: LogTimePreset = "last-24h";
export const DEFAULT_LOG_TIME: PeriodValue<LogTimePreset> = { kind: "preset", preset: DEFAULT_LOG_PRESET };

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly LogLevel[];

/** Entries per page; the same as before v2. */
export const LOGS_PER_PAGE = 100;
/** Longest free search and request ID. A longer text is dropped and reported, never cut silently. */
export const LOG_SEARCH_MAX = 200;
export const LOG_REQUEST_MAX = 128;
/** Whether a request ID fits the request filter: the page and the API refuse a longer one, so no action offers it. */
export const fitsRequestFilter = (id: string) => id.trim() !== "" && id.length <= LOG_REQUEST_MAX;
/** Most sources one filter names. */
export const LOG_SOURCES_MAX = 20;
/** Longest custom range; the list API allowed 31 days of lookback before v2. */
export const LOG_RANGE_MAX_MS = 31 * 24 * 60 * 60 * 1000;
/** Last page the list opens; deeper pages are an offset scan nobody reads. */
export const LOG_PAGE_MAX = 1000;

const presetLabel = (t: LogsMessages, preset: LogTimePreset): string =>
  ({
    "last-15m": t.last15m,
    "last-1h": t.last1h,
    "last-6h": t.last6h,
    "last-24h": t.last24h,
    "last-7d": t.last7d,
    "last-30d": t.last30d,
  })[preset];

export type SourceLookup = {
  load: (query: string, context: { signal: AbortSignal; limit: number }) => Promise<{ items: readonly LookupItem[] }>;
};

/** Sources are their own names: a chosen source needs no lookup to show its label. */
const sourceItems = (values: readonly string[]): LookupItem[] => values.map((value) => ({ value, label: value }));

/** Builds the declaration in the request's language. `sources` loads source names in the browser. */
export const logsQuery = (locale: string, sources?: SourceLookup) => {
  const { t } = logsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.logs",
    fields: {
      time: field.timeRange({
        label: t.time,
        common: true,
        presets: (Object.keys(LOG_TIME_PRESETS) as LogTimePreset[]).map((preset) => ({ value: preset, label: presetLabel(t, preset) })),
        required: DEFAULT_LOG_TIME,
      }),
      level: field.choice({
        label: t.level,
        common: true,
        options: [
          { value: "debug", label: t.debug },
          { value: "info", label: t.info },
          { value: "warn", label: t.warn },
          { value: "error", label: t.error },
        ],
      }),
      source: field.lookup({
        label: t.source,
        common: true,
        limit: LOG_SOURCES_MAX,
        load: async (query, context) => (sources ? sources.load(query, context) : { items: [] }),
        resolve: async (values) => sourceItems(values),
      }),
      request: field.text({ label: t.request }),
    },
    search: { label: t.search },
    sort: { fixed: { field: "time", direction: "desc", label: t.newestFirst } },
    group: { minute: { label: t.byMinute }, source: { label: t.bySource } },
    pageParams: ["page", "entry", "live"],
  });
};

export type LogsQuery = ReturnType<typeof logsQuery>;
export type LogsState = ListQueryStateOf<LogsQuery>;

/** The views in code beside "All": their key in the address and their state. */
export const LOG_VIEWS = {
  errors: (query: LogsQuery): LogsState => {
    const start = query.reset();
    return { ...start, filters: { ...start.filters, level: ["error"] }, view: "errors" };
  },
};
export type LogView = keyof typeof LOG_VIEWS;
export const isLogView = (key: string | undefined): key is LogView => key !== undefined && Object.hasOwn(LOG_VIEWS, key);

/** What the page and the API read from an address: the list state, the page parameters and what was dropped. */
export type LogsAddress = {
  state: LogsState;
  page: number;
  /** The entry open beside the list: a positive BIGINT row id, or null. */
  entry: string | null;
  /** Whether the person turned live off; live runs only while the range ends now and page 1 shows. */
  liveOff: boolean;
  issues: readonly ListQueryIssue[];
};

const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;
const ENTRY_ID = /^[1-9]\d{0,18}$/;

/** Reads an address with the declaration and holds every value to the list's bounds. Never throws. */
export const parseLogsAddress = (query: LogsQuery, params: URLSearchParams, now: Date = new Date()): LogsAddress => {
  const parsed = query.parse(params);
  const issues: ListQueryIssue[] = [...parsed.issues];
  let state = parsed.state;
  const drop = (param: "q" | "request" | "source" | "time", value: string) => issues.push({ code: "invalid", param, value });

  if (state.search && state.search.length > LOG_SEARCH_MAX) {
    drop("q", state.search);
    state = { ...state, search: undefined };
  }
  const request = state.filters.request;
  if (request !== undefined && request.length > LOG_REQUEST_MAX) {
    drop("request", request);
    state = query.clear(state, "request");
  }
  const sources = state.filters.source;
  if (sources && sources.length > LOG_SOURCES_MAX) {
    drop("source", sources.join(","));
    state = query.clear(state, "source");
  }
  const time = state.filters.time;
  if (time.kind === "range") {
    const to = time.to ? Date.parse(time.to) + 60_000 : now.getTime();
    if (time.from && to - Date.parse(time.from) > LOG_RANGE_MAX_MS + 60_000) {
      drop("time", `${time.from ?? ""}..${time.to ?? ""}`);
      state = query.clear(state, "time");
    }
  }

  const pageRaw = params.get("page");
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const entryRaw = params.get("entry");
  return {
    state,
    page: Number.isSafeInteger(page) && page >= 1 && page <= LOG_PAGE_MAX ? page : 1,
    entry: entryRaw && ENTRY_ID.test(entryRaw) && BigInt(entryRaw) <= PG_BIGINT_MAX ? entryRaw : null,
    liveOff: params.get("live") === "off",
    issues,
  };
};

/** The time window a state asks for: `since` inclusive, `until` exclusive (absent: until now). */
export const logsWindow = (time: PeriodValue<LogTimePreset>, now: Date = new Date()): { since: Date; until?: Date } => {
  if (time.kind === "preset") return { since: new Date(now.getTime() - LOG_TIME_PRESETS[time.preset] * 60_000) };
  // A custom range names UTC minutes; its end minute counts whole. Without a start it reaches back the longest range.
  const until = time.to ? new Date(Date.parse(time.to) + 60_000) : undefined;
  const since = time.from ? new Date(time.from) : new Date((until ?? now).getTime() - LOG_RANGE_MAX_MS);
  return until ? { since, until } : { since };
};

/** What the log list asks for, read from its address by the declaration in `query.ts`. */
export type LogSearch = {
  since: Date;
  /** Exclusive; absent means until now. */
  until?: Date;
  levels?: readonly LogLevel[];
  sources?: readonly string[];
  /** Part of the message or of the metadata, as before v2. */
  search?: string;
  /** Part of the metadata, such as a request ID in `requestId` or `request_id`. */
  request?: string;
};

/** The search a list state asks for. */
export const logSearchOf = (state: LogsState, now: Date = new Date()): LogSearch => ({
  ...logsWindow(state.filters.time, now),
  levels: state.filters.level,
  sources: state.filters.source,
  search: state.search,
  request: state.filters.request,
});

/** Whether the range ends now, so new entries can still arrive. */
export const endsNow = (state: LogsState): boolean => state.filters.time.kind === "preset" || !state.filters.time.to;

/** The address of a state plus the page parameters the list keeps. */
export const logsHref = (
  query: LogsQuery,
  state: LogsState,
  extra: { page?: number; entry?: string | null; liveOff?: boolean } = {},
): string => {
  const params = query.serialize(state);
  if (extra.page && extra.page > 1) params.set("page", String(extra.page));
  if (extra.entry) params.set("entry", extra.entry);
  if (extra.liveOff) params.set("live", "off");
  const text = params.toString();
  return text ? `${LOGS_PAGE_PATH}?${text}` : LOGS_PAGE_PATH;
};

// Before v2 the address held `window=6h`, `search=…`, one `source=` per source and `level=all`. Links in other apps,
// bookmarks and the dashboard still use them, so the page answers them with a redirect to the same list.
const LEGACY_WINDOWS: Record<string, LogTimePreset> = {
  "1h": "last-1h",
  "6h": "last-6h",
  "24h": "last-24h",
  "7d": "last-7d",
  "30d": "last-30d",
};

const minute = (date: Date): string => `${date.toISOString().slice(0, 16)}Z`;

/**
 * The list parameters of an API request. The API also takes its pre-v2 names, `search` for `q` and `since_hours`
 * for a range that starts that many hours ago; `per_page` belongs to its pagination.
 */
export const logsApiParams = (params: URLSearchParams, now: Date = new Date()): URLSearchParams => {
  const next = new URLSearchParams(params);
  next.delete("per_page");
  const search = next.get("search");
  next.delete("search");
  if (search && !next.has("q")) next.set("q", search);
  const sinceHours = Number(next.get("since_hours"));
  next.delete("since_hours");
  if (sinceHours > 0 && !next.has("time")) next.set("time", `${minute(new Date(now.getTime() - sinceHours * 3_600_000))}..`);
  return next;
};

/** The v2 address for a pre-v2 one, or null when the address is already v2. */
export const legacyLogsHref = (params: URLSearchParams): string | null => {
  const sources = params.getAll("source");
  const legacy = params.has("window") || params.has("search") || sources.length > 1 || params.get("level") === "all";
  if (!legacy) return null;
  // Every parameter is carried over; only the old names change. A v2 name that is already there wins over its old name.
  const next = new URLSearchParams();
  for (const [name, value] of params) {
    if (name === "window" || name === "search" || name === "source") continue;
    if (name === "level" && value === "all") continue;
    next.append(name, value);
  }
  const window = params.get("window");
  const preset = window ? LEGACY_WINDOWS[window] : undefined;
  if (!params.has("time") && preset && preset !== DEFAULT_LOG_PRESET) next.set("time", preset);
  const search = params.get("search")?.trim();
  if (!params.has("q") && search) next.set("q", search);
  const names = [
    ...new Set(
      sources
        .flatMap((source) => source.split(","))
        .map((source) => source.trim())
        .filter(Boolean),
    ),
  ];
  if (names.length > 0) next.set("source", names.join(","));
  // As the list's own addresses (`serialize`): `,` `:` `/` and `@` stay readable, every other sign stays encoded.
  const text = next.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));
  return text ? `${LOGS_PAGE_PATH}?${text}` : LOGS_PAGE_PATH;
};
