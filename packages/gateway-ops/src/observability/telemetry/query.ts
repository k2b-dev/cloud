/**
 * The telemetry pages' declarations: the server routes (range, app, "only", order) and the browser vitals (range, app,
 * route). The SSR pages read the address only through them; the services filter and sort.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { type GatewayOpsMessages, gatewayOpsMessages } from "../../messages";
import { browserMessages } from "./browser/messages";
import { DEFAULT_TELEMETRY_RANGE, TELEMETRY_RANGES, TELEMETRY_ROUTE_SORTS, type TelemetryRange } from "./contracts";

export const TELEMETRY_PATH = "/admin/observability/telemetry";

const rangeLabel = (t: GatewayOpsMessages, range: TelemetryRange): string =>
  ({
    "1h": t.lastHour,
    "6h": t.lastHours({ count: 6 }),
    "24h": t.lastHours({ count: 24 }),
    "7d": t.lastDays({ count: 7 }),
    "30d": t.lastDays({ count: 30 }),
  })[range];

const rangeField = (t: GatewayOpsMessages) =>
  field.timeRange({
    label: t.timeRange,
    common: true,
    custom: false,
    presets: (Object.keys(TELEMETRY_RANGES) as TelemetryRange[]).map((value) => ({ value, label: rangeLabel(t, value) })),
    required: { kind: "preset", preset: DEFAULT_TELEMETRY_RANGE },
  });

/** Apps the address can hold; the one it names stays offered. */
const appOptions = (apps: readonly { id: string; label: string }[], selected: string | undefined) => {
  const known = apps.filter((app) => app.id !== "" && !app.id.includes(","));
  return [
    ...known.map((app) => ({ value: app.id, label: app.label })),
    ...(selected && !selected.includes(",") && !known.some((app) => app.id === selected) ? [{ value: selected, label: selected }] : []),
  ];
};

export const telemetryQuery = (locale: string, apps: readonly { id: string; label: string }[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const sortLabel = { errorRate: t.errorRate, errors: t.errors, requests: t.requests, slow: t.slow, duration: t.duration } as const;
  return defineListQuery({
    key: "gateway-ops.telemetry",
    fields: {
      range: rangeField(t),
      app: field.choice({ label: t.app, common: true, multiple: false, options: appOptions(apps, selected) }),
      only: field.choice({
        label: t.showOnly,
        common: true,
        options: [
          { value: "errors", label: t.withErrors },
          { value: "slow", label: t.withSlowRequests },
        ],
      }),
    },
    sort: {
      options: Object.fromEntries(TELEMETRY_ROUTE_SORTS.map((sort) => [sort, { label: sortLabel[sort], directions: ["desc"] as const }])),
      default: { field: "errorRate", direction: "desc" },
    },
    pageParams: ["route"],
  });
};
export type TelemetryListQuery = ReturnType<typeof telemetryQuery>;
export type TelemetryState = ListQueryStateOf<TelemetryListQuery>;

export const telemetryHref = (query: TelemetryListQuery, state: TelemetryState, route?: { app: string; route: string }) => {
  const params = query.serialize(state);
  if (route) {
    params.set("app", route.app);
    params.set("route", route.route);
  }
  return `${TELEMETRY_PATH}${params.size ? `?${params}` : ""}`;
};

/** Addresses from before v2 (`errors=1`, `slow=1`, `sort=errorRate`) lead to the same list in the v2 address. */
export const legacyTelemetryHref = (params: URLSearchParams): string | null => {
  const sort = params.get("sort");
  const legacySort = sort !== null && !sort.includes(".") && (TELEMETRY_ROUTE_SORTS as string[]).includes(sort);
  if (!params.has("errors") && !params.has("slow") && !legacySort) return null;
  const next = new URLSearchParams(params);
  const only = [next.get("errors") === "1" ? "errors" : "", next.get("slow") === "1" ? "slow" : ""].filter(Boolean);
  next.delete("errors");
  next.delete("slow");
  if (only.length && !next.has("only")) next.set("only", only.join(","));
  if (legacySort) {
    if (sort === "errorRate") next.delete("sort");
    else next.set("sort", `${sort}.desc`);
  }
  return `${TELEMETRY_PATH}${next.size ? `?${next}` : ""}`;
};

export const browserQuery = (locale: string, apps: readonly { id: string; label: string }[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const b = browserMessages.resolve([locale]).t;
  return defineListQuery({
    key: "gateway-ops.telemetry.browser",
    fields: {
      range: rangeField(t),
      app: field.choice({ label: b.app, common: true, multiple: false, options: appOptions(apps, selected) }),
      route: field.text({ label: b.route, common: true }),
    },
    sort: { fixed: { field: "route", direction: "asc", label: b.byRoute } },
    pageParams: ["page"],
  });
};
export type BrowserQuery = ReturnType<typeof browserQuery>;
export type BrowserState = ListQueryStateOf<BrowserQuery>;

/** The browser view's address: `view=browser` names the mode. */
export const browserHref = (query: BrowserQuery, state: BrowserState, page = 1) => {
  const params = query.serialize({ ...state, view: "browser" });
  if (page > 1) params.set("page", String(page));
  return `${TELEMETRY_PATH}?${params}`;
};
