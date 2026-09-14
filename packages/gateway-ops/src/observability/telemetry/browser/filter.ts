import { isTelemetryRange, type TelemetryRange } from "../contracts";
export type BrowserFilter = { range: TelemetryRange; appId: string; route: string; page: number };
export function parseBrowserFilter(url: URL): BrowserFilter {
  const range = url.searchParams.get("range");
  const page = Number(url.searchParams.get("page") ?? "1");
  return {
    range: isTelemetryRange(range) ? range : "24h",
    appId: (url.searchParams.get("app") ?? "").trim().slice(0, 64),
    route: (url.searchParams.get("route") ?? "").trim().slice(0, 200),
    page: Number.isInteger(page) && page > 0 && page <= 100000 ? page : 1,
  };
}
export function browserUrl(filter: BrowserFilter, patch: Partial<BrowserFilter> = {}): string {
  const next = { ...filter, ...patch };
  const params = new URLSearchParams({ view: "browser", range: next.range });
  if (next.appId) params.set("app", next.appId);
  if (next.route) params.set("route", next.route);
  if (next.page > 1) params.set("page", String(next.page));
  return `/admin/observability/telemetry?${params}`;
}
export function telemetryModeUrl(url: URL, browser: boolean): string {
  const filter = parseBrowserFilter(url);
  if (browser) return browserUrl({ ...filter, page: 1 });
  const params = new URLSearchParams();
  params.set("range", filter.range);
  if (filter.appId) params.set("app", filter.appId);
  return `/admin/observability/telemetry?${params}`;
}
