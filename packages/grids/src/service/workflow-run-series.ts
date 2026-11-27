import type { GridsWorkflowRunSeriesBucket, GridsWorkflowRunStatsWindow } from "../workflows/contracts";

/** How far back each run-stats window reaches. */
export const STATS_WINDOW_SECONDS: Record<GridsWorkflowRunStatsWindow, number> = {
  "10m": 10 * 60,
  "1h": 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

/**
 * One bucket size per window. The window rolls with the current time while
 * buckets start on the viewer's clock, so the first and the last bucket are
 * partial: a series has `window / step + 1` points, and a daylight-saving
 * switch inside a day series can add one more calendar day.
 */
export const SERIES_BUCKETS: Record<GridsWorkflowRunStatsWindow, { bucket: GridsWorkflowRunSeriesBucket; stepSeconds: number }> = {
  "10m": { bucket: "1m", stepSeconds: 60 },
  "1h": { bucket: "5m", stepSeconds: 5 * 60 },
  "12h": { bucket: "1h", stepSeconds: 60 * 60 },
  "24h": { bucket: "1h", stepSeconds: 60 * 60 },
  "7d": { bucket: "1d", stepSeconds: 24 * 60 * 60 },
  "30d": { bucket: "1d", stepSeconds: 24 * 60 * 60 },
};

/** The most points a window's series can carry. */
export const maxSeriesPoints = (window: GridsWorkflowRunStatsWindow): number =>
  Math.ceil(STATS_WINDOW_SECONDS[window] / SERIES_BUCKETS[window].stepSeconds) + 2;
