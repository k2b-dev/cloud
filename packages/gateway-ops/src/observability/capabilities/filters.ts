/** The values the capability console and its API accept for origin, status and window. */

export const ORIGIN_FILTERS = ["all", "assistant", "mcp", "http", "app", "choice"] as const;
export type OriginFilter = (typeof ORIGIN_FILTERS)[number];

export const STATUS_FILTERS = ["all", "succeeded", "failed", "denied", "invalid_input", "timed_out", "rejected"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const WINDOWS = ["1h", "24h", "7d", "30d", "90d"] as const;
export type WindowFilter = (typeof WINDOWS)[number];

export const WINDOW_MS: Record<WindowFilter, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};
