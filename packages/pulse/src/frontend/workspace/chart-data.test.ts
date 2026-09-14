import { describe, expect, test } from "bun:test";
import { pointsToBars, pointsToHeatmap, pointsToHistogram, pointsToLineSeries } from "./chart-data";

describe("missing metric values", () => {
  const points = [1, null, 0, 2].map((value, i) => ({ bucket: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), value }));
  test("keeps measured zero while omitting unobserved numeric values", () => {
    expect(pointsToLineSeries(points, "Test")[0]?.data.map((p) => p.y)).toEqual([1, 0, 2]);
    expect(pointsToBars(points).map((p) => p.value)).toEqual([1, 0, 2]);
    expect(pointsToHeatmap(points).map((p) => p.value)).toEqual([1, 0, 2]);
    expect(pointsToHistogram(points)).toEqual([1, 0, 2]);
  });
  test("does not silently cut chart points", () => {
    const long = Array.from({ length: 300 }, (_, i) => ({ bucket: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), value: i }));
    expect(pointsToBars(long)).toHaveLength(300);
    expect(pointsToHeatmap(long)).toHaveLength(300);
  });
});
