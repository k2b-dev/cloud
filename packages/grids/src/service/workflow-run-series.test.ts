import { describe, expect, test } from "bun:test";
import { GridsWorkflowRunStatsWindowSchema } from "../workflows/contracts";
import { maxSeriesPoints, SERIES_BUCKETS, STATS_WINDOW_SECONDS } from "./workflow-run-series";

describe("workflow run series buckets", () => {
  test("every window stays within 90 days and a bounded number of points", () => {
    for (const window of GridsWorkflowRunStatsWindowSchema.options) {
      expect(STATS_WINDOW_SECONDS[window]).toBeLessThanOrEqual(90 * 24 * 60 * 60);
      // Buckets tile the window: only the first and the last bucket are partial.
      expect(STATS_WINDOW_SECONDS[window] % SERIES_BUCKETS[window].stepSeconds).toBe(0);
      expect(maxSeriesPoints(window)).toBeLessThanOrEqual(32);
    }
  });

  test("each window has its own readable bucket", () => {
    expect(Object.fromEntries(GridsWorkflowRunStatsWindowSchema.options.map((window) => [window, SERIES_BUCKETS[window].bucket]))).toEqual({
      "10m": "1m",
      "1h": "5m",
      "12h": "1h",
      "24h": "1h",
      "7d": "1d",
      "30d": "1d",
    });
    expect(maxSeriesPoints("24h")).toBe(26);
  });
});
