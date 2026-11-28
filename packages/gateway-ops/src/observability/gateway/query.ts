/**
 * The routes page's one declaration: the traffic window, one app and a search over prefix and app. The SSR page reads
 * the address only through it.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { type GatewayOpsMessages, gatewayOpsMessages } from "../../messages";
import { DEFAULT_TELEMETRY_RANGE, TELEMETRY_RANGES, type TelemetryRange } from "../telemetry/contracts";

export const ROUTES_PATH = "/admin/observability/gateway/routes";
/** A search longer than any prefix plus app id finds nothing; the address refuses it. */
export const ROUTES_SEARCH_MAX = 200;

const rangeLabel = (t: GatewayOpsMessages, range: TelemetryRange): string =>
  ({
    "1h": t.lastHour,
    "6h": t.lastHours({ count: 6 }),
    "24h": t.lastHours({ count: 24 }),
    "7d": t.lastDays({ count: 7 }),
    "30d": t.lastDays({ count: 30 }),
  })[range];

export const routesQuery = (locale: string, apps: readonly { id: string; label: string }[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const known = apps.filter((app) => app.id !== "" && !app.id.includes(","));
  const extra = selected && !selected.includes(",") && !known.some((app) => app.id === selected) ? [{ id: selected, label: selected }] : [];
  return defineListQuery({
    key: "gateway-ops.routes",
    fields: {
      range: field.timeRange({
        label: t.timeRange,
        common: true,
        custom: false,
        presets: (Object.keys(TELEMETRY_RANGES) as TelemetryRange[]).map((value) => ({ value, label: rangeLabel(t, value) })),
        required: { kind: "preset", preset: DEFAULT_TELEMETRY_RANGE },
      }),
      app: field.choice({
        label: t.app,
        common: true,
        multiple: false,
        options: [...known, ...extra].map((app) => ({ value: app.id, label: app.label })),
      }),
    },
    search: { label: t.filterRoutesLabel },
    sort: { fixed: { field: "hits", direction: "desc", label: t.hits } },
  });
};

export type RoutesQuery = ReturnType<typeof routesQuery>;
export type RoutesState = ListQueryStateOf<RoutesQuery>;

export const routesHref = (query: RoutesQuery, state: RoutesState) => {
  const text = query.serialize(state).toString();
  return text ? `${ROUTES_PATH}?${text}` : ROUTES_PATH;
};

/** The address before v2 named its search `search`; it leads to the same list. Null when nothing moves. */
export const legacyRoutesHref = (params: URLSearchParams): string | null => {
  if (!params.has("search")) return null;
  const next = new URLSearchParams(params);
  const search = next.get("search") ?? "";
  next.delete("search");
  if (search.trim() && !next.has("q")) next.set("q", search.trim());
  const text = next.toString();
  return text ? `${ROUTES_PATH}?${text}` : ROUTES_PATH;
};
