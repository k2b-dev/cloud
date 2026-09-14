/**
 * Shared vocabulary for the telemetry page.
 *
 * Kept free of server-only imports on purpose: the filter island bundles for
 * the browser, and anything reachable from it must not pull in `bun`'s `sql`.
 * The service layer imports these definitions rather than owning them.
 */

/**
 * Selectable windows. `bucketSeconds` is picked so every range renders as
 * 60–170 points: dense enough to show a spike, coarse enough to stay cheap.
 */
export const TELEMETRY_RANGES = {
  "1h": { hours: 1, bucketSeconds: 60 },
  "6h": { hours: 6, bucketSeconds: 300 },
  "24h": { hours: 24, bucketSeconds: 900 },
  "7d": { hours: 168, bucketSeconds: 3600 },
  "30d": { hours: 720, bucketSeconds: 21_600 },
} as const;

export type TelemetryRange = keyof typeof TELEMETRY_RANGES;

export const DEFAULT_TELEMETRY_RANGE: TelemetryRange = "24h";

export const isTelemetryRange = (value: string | null | undefined): value is TelemetryRange =>
  value !== null && value !== undefined && Object.hasOwn(TELEMETRY_RANGES, value);

/**
 * `errorRate` finds routes that are broken; `errors` finds where the most
 * failures happen overall. They disagree often enough — a route failing 900
 * times out of a million ranks nowhere by rate — that both are worth having.
 */
export type TelemetryRouteSort = "errorRate" | "errors" | "requests" | "slow" | "duration";

export const TELEMETRY_ROUTE_SORTS: TelemetryRouteSort[] = ["errorRate", "errors", "requests", "slow", "duration"];

export const DEFAULT_TELEMETRY_ROUTE_SORT: TelemetryRouteSort = "errorRate";

export const isTelemetryRouteSort = (value: string | null | undefined): value is TelemetryRouteSort =>
  TELEMETRY_ROUTE_SORTS.includes(value as TelemetryRouteSort);

export const TELEMETRY_SORT_LABELS: Record<TelemetryRouteSort, string> = {
  errorRate: "Error rate",
  errors: "Errors",
  requests: "Popularity",
  slow: "Slow",
  duration: "Duration",
};

/** Row filters, independent of ordering: narrow the table to what is wrong. */
export type TelemetryRouteScope = {
  errorsOnly: boolean;
  slowOnly: boolean;
};
