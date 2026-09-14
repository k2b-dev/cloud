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

test("calendar chart labels and gaps use the query zone through DST", async () => {
  const { queryBucketMaxGap, queryPointColumns } = await import("./chart-data");
  const context = { locale: "en", timeZone: "Europe/Berlin", firstDayOfWeek: 1 as const };
  const points = [
    { bucket: "2026-03-28T23:00:00.000Z", value: 4 },
    { bucket: "2026-03-29T22:00:00.000Z", value: 1 },
  ];
  expect(pointsToBars(points, context, "day")[0]?.label).toContain("Mar 29, 2026");
  expect(pointsToHeatmap(points, context, "day")[0]?.y).toContain("Mar 29, 2026");
  const cell = queryPointColumns(context, "day")[0]?.value;
  if (typeof cell !== "function") throw Error("Missing bucket formatter");
  expect(cell(points[0]!)).toContain("Mar 29, 2026");
  expect(queryBucketMaxGap(points, "day", context)).toBe(24 * 3600000);
  expect(queryBucketMaxGap([{ bucket: "2025-10-25T22:00:00Z", value: 1 }], "day", context)).toBe(25 * 3600000);
  expect(queryBucketMaxGap([{ bucket: "2026-01-31T23:00:00Z", value: 1 }], "month", context)).toBe(28 * 24 * 3600000);
});
