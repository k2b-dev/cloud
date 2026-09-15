/**
 * Filter state for the logs admin page.
 * All filter values are stored as URL query parameters (SSR-friendly).
 */
/** Windows offered on the page; the numbers are hours of lookback. */
export const LOG_WINDOWS = { "1h": 1, "6h": 6, "24h": 24, "7d": 168, "30d": 720 } as const;

export type LogWindow = keyof typeof LOG_WINDOWS;

export const isLogWindow = (value: string | null | undefined): value is LogWindow =>
  value !== null && value !== undefined && Object.hasOwn(LOG_WINDOWS, value);

export type LogFilterState = {
  level: string;
  sources: string[];
  search: string;
  /**
   * The stat tiles used to summarise 24h while the table below was unbounded,
   * so clicking through to "errors" returned the full retention and the number
   * could not be reproduced. Both now read the same window.
   */
  window: LogWindow;
  page: number;
};

export const defaultLogFilter: LogFilterState = {
  level: "all",
  sources: [],
  search: "",
  window: "24h",
  page: 1,
};

/** Parse filter state from URL search params. */
export function parseLogFilterFromUrl(url: URL): LogFilterState {
  const params = url.searchParams;
  const rawSources = params.getAll("source");
  const window = params.get("window");
  const page = Number(params.get("page") ?? "1");
  return {
    level: params.get("level") || defaultLogFilter.level,
    sources: rawSources.length > 0 ? [...new Set(rawSources.map((value) => value.trim()).filter(Boolean))] : defaultLogFilter.sources,
    search: params.get("search")?.trim() || defaultLogFilter.search,
    window: isLogWindow(window) ? window : defaultLogFilter.window,
    page: Number.isSafeInteger(page) && page > 0 ? page : defaultLogFilter.page,
  };
}

/** Build URL with updated filter parameters. Only includes non-default values. */
export function buildLogFilterUrl(baseUrl: string, updates: Partial<LogFilterState>, current: LogFilterState): string {
  const merged = { ...current, ...updates };
  const params = new URLSearchParams();

  if (merged.level !== defaultLogFilter.level) params.set("level", merged.level);
  for (const source of merged.sources) params.append("source", source);
  if (merged.search) params.set("search", merged.search);
  if (merged.window !== defaultLogFilter.window) params.set("window", merged.window);
  if (merged.page > 1) params.set("page", String(merged.page));

  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/** Check if any filters are active (non-default). */
export function hasActiveLogFilters(filter: LogFilterState): boolean {
  return (
    filter.level !== defaultLogFilter.level ||
    filter.sources.length > 0 ||
    filter.search !== "" ||
    filter.window !== defaultLogFilter.window
  );
}
