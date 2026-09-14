import { expect, test } from "bun:test";
import { buildVitalCharts, vitalValue } from "./charts";

test("chart snapshots preserve absent metrics, measured zero, counts and stable time keys", () => {
  const charts = buildVitalCharts(
    {
      summary: [],
      routes: [],
      totalRoutes: 0,
      page: 1,
      perPage: 50,
      series: [
        { name: "LCP", count: 2, p75: 125, bucket: 1700000000000 },
        { name: "CLS", count: 1, p75: 0, bucket: 1700000000000 },
        { name: "LCP", count: 3, p75: 250, bucket: 1700001800000 },
      ],
    },
    "de",
    "1h",
    1700003600000,
  );
  expect(charts.map((chart) => chart.data.rows.length)).toEqual([2, 0, 1]);
  for (const chart of charts) expect(chart.data.chart.marks.map((mark) => mark.rowKey)).toEqual(chart.data.rows.map((row) => row.key));
  expect(charts[0]!.data.chart.kind).toBe("line");
  expect(charts[2]!.data.rows[0]!.p75).toBe(0);
  expect(charts[2]!.data.chart.svg).toContain('fill="var(--stdlib-chart-c1)"');
  expect(charts[0]!.data.chart.svg).toContain(' d=" "');
  expect(vitalValue("CLS", 0, "de")).toBe("0");
  expect(vitalValue("INP", undefined, "de")).toBe("—");
  expect(vitalValue("LCP", 123, "en")).toBe("123 ms");
});
