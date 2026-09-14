import { expect, test } from "bun:test";
import { prepareOperationalCharts, alignCountSeries } from "./operational-charts";

test("comparison counts align to shared intervals without filling gaps", () => {
  expect(
    alignCountSeries(
      [
        { x: 60000, y: 2 },
        { x: 120000, y: 3 },
        { x: 600000, y: 4 },
      ],
      300000,
    ),
  ).toEqual([
    { x: 0, y: 5 },
    { x: 600000, y: 4 },
  ]);
});

test("snapshots preserve units, missing samples, zero and exact counts", () => {
  const charts = prepareOperationalCharts(
    [
      {
        kind: "line",
        title: "Requests",
        maxGap: 60000,
        series: [
          {
            label: "Requests",
            data: [
              { x: 0, y: 12345 },
              { x: 120000, y: 0 },
            ],
          },
        ],
      },
      { kind: "line", title: "Latency", unit: "ms", maxGap: 60000, series: [{ label: "Average", data: [{ x: 0, y: 125 }] }] },
    ],
    "en",
  );
  expect(charts[0]!.data.rows.map((r) => r.value)).toEqual([12345, 0]);
  expect(charts[0]!.data.rows[0]!.formatted).toBe("12,345");
  expect(charts[0]!.data.chart.svg).toContain(' d=" "');
  expect(charts[1]!.data.rows).toHaveLength(1);
  expect(charts[1]!.data.chart.marks[0]!.tooltip.rows[0]!.value).toBe("125 ms");
  expect(JSON.parse(JSON.stringify(charts))).toEqual(charts);
});

test("ranked bars keep full labels and row identity after sorting", () => {
  const [chart] = prepareOperationalCharts(
    [
      {
        kind: "bar",
        title: "Tables",
        unit: "bytes",
        data: [
          { label: "small", value: 0 },
          { label: "large", value: 2048 },
        ],
      },
    ],
    "en",
  );
  expect(chart!.data.rows.map((row) => row.label)).toEqual(["large", "small"]);
  expect(chart!.data.chart.marks.map((mark) => mark.rowKey)).toEqual(["0", "1"]);
  expect(chart!.data.chart.marks[0]!.tooltip.title).toBe("large");
  expect(chart!.data.rows[0]!.formatted).toContain("2");
});
