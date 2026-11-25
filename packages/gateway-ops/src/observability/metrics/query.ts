/**
 * The metrics catalogue's one declaration: source, type and search. The SSR page reads the address only through it
 * and filters the catalogue itself.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";

export const METRICS_PATH = "/admin/observability/metrics";

export const metricsQuery = (locale: string, sources: readonly { id: string; label: string }[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const known = sources.filter((source) => source.id !== "" && !source.id.includes(","));
  return defineListQuery({
    key: "gateway-ops.metrics",
    fields: {
      source: field.choice({
        label: t.source,
        common: true,
        multiple: false,
        options: [
          ...known.map((source) => ({ value: source.id, label: source.label })),
          ...(selected && !known.some((source) => source.id === selected) ? [{ value: selected, label: selected }] : []),
        ],
      }),
      type: field.choice({
        label: t.type,
        common: true,
        multiple: false,
        options: [
          { value: "gauge", label: t.gauge },
          { value: "counter", label: t.counter },
        ],
      }),
    },
    search: { label: t.searchMetricsLabel },
    sort: { fixed: { field: "source", direction: "asc", label: t.bySource } },
  });
};
export type MetricsQuery = ReturnType<typeof metricsQuery>;
export type MetricsState = ListQueryStateOf<MetricsQuery>;

export const metricsHref = (query: MetricsQuery, state: MetricsState) => {
  const params = query.serialize(state);
  return `${METRICS_PATH}${params.size ? `?${params}` : ""}`;
};
