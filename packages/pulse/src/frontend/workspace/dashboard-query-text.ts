import type { PulseDashboardEventQuery, PulseDashboardMetricQuery, PulseDashboardStateQuery } from "../../contracts";

export const quoteQueryPart = (value: string): string =>
  /[\s,=]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;

const queryFiltersToText = (query: PulseDashboardMetricQuery | PulseDashboardEventQuery | PulseDashboardStateQuery): string => {
  const source = query.sourceId ? ` source ${query.sourceId}` : "";
  const resource = query.resourceKey ? ` resource ${quoteQueryPart(query.resourceKey)}` : "";
  const resourceType = query.resourceType ? ` resource_type ${quoteQueryPart(query.resourceType)}` : "";
  const dimensions = Object.entries(query.dimensions ?? {});
  const where = dimensions.length ? ` where ${dimensions.map(([key, value]) => `${key}=${quoteQueryPart(String(value))}`).join(", ")}` : "";
  const limit = query.kind === "events" || query.kind === "states" ? ` limit ${query.limit}` : "";
  return `${source}${resource}${resourceType}${where}${limit}`;
};

export const dashboardMetricQueryText = (query: PulseDashboardMetricQuery): string =>
  `metric ${query.metric} ${query.aggregation} every ${query.bucket}${query.reduce ? ` reduce ${query.reduce}` : ""}${
    query.groupBy ? ` group by ${quoteQueryPart(query.groupBy)}` : ""
  } since ${query.since}${queryFiltersToText(query)}`;

export const dashboardEventQueryText = (query: PulseDashboardEventQuery): string =>
  `events ${query.event ?? "*"}${
    query.aggregation && query.aggregation !== "rows"
      ? ` ${query.aggregation.replace("_", " ")} every ${query.bucket ?? "1h"}${
          query.groupBy?.length ? ` group by ${query.groupBy.map(quoteQueryPart).join(", ")}` : ""
        }`
      : ""
  } since ${query.since}${queryFiltersToText(query)}`;

export const dashboardStateQueryText = (query: PulseDashboardStateQuery): string =>
  `states ${query.state ?? "*"}${query.since ? ` since ${query.since}` : ""}${queryFiltersToText(query)}`;
