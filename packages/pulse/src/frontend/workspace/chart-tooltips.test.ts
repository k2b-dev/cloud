import { expect, test } from "bun:test";
import type { ChartSelection } from "@k2b/ui";
import { metricChartTooltip, type MetricChartTooltipOptions } from "./chart-tooltips";

const options: MetricChartTooltipOptions = {
  title: "CPU",
  unit: "%",
  points: [
    { bucket: "2026-01-01T13:00:00.000Z", value: 42 },
    { bucket: "2026-01-01T14:00:00.000Z", value: null },
    { bucket: "2026-01-01T15:00:00.000Z", value: 37.5 },
  ],
  bucket: "1h",
  dateContext: { locale: "de", timeZone: "Europe/Berlin" },
  countLabel: "Anzahl",
};
const selection = (
  kind: ChartSelection["kind"],
  role: ChartSelection["datum"]["role"],
  values: ChartSelection["datum"]["values"],
  label?: string,
  index = 0,
): ChartSelection => ({ kind, datum: { index, role, values, label, anchor: [0, 0] } });

test("bar tooltips keep the bucket label and format the metric unit", () => {
  expect(metricChartTooltip(options)(selection("bar", "item", [{ key: "value", value: 42 }], "14:00"))).toEqual({
    title: "14:00",
    rows: [{ label: "CPU", value: "42%" }],
  });
});

test("line tooltips share the zoned bucket title and retain each series label", () => {
  const tooltip = metricChartTooltip(options);
  const values = [
    { key: "y", value: 41.999999 },
    { key: "x", value: Date.parse("2026-01-01T13:00:00.000Z") },
  ];
  expect(tooltip(selection("line", "point", values, "host=a"))).toEqual({
    title: "14:00",
    rows: [{ label: "host=a", value: "42%" }],
  });
  expect(tooltip(selection("line", "point", values))).toEqual({ title: "14:00", rows: [{ label: "CPU", value: "42%" }] });
});

test("histogram tooltips show a unit range and localized count", () => {
  expect(
    metricChartTooltip({ ...options, unit: "s" })(
      selection("histogram", "bin", [
        { key: "count", value: 1234 },
        { key: "to", value: 2 },
        { key: "from", value: 0.5 },
      ]),
    ),
  ).toEqual({ title: "500ms – 2s", rows: [{ label: "Anzahl", value: "1.234" }] });
});

test("stat sparkline indices skip null and non-finite observations", () => {
  const tooltip = metricChartTooltip({
    ...options,
    points: [options.points[0]!, { bucket: "2026-01-01T13:30:00.000Z", value: Number.NaN }, ...options.points.slice(1)],
  });
  expect(tooltip(selection("stat", "point", [{ key: "y", value: 37.5 }], undefined, 1))).toEqual({
    title: "16:00",
    rows: [{ label: "CPU", value: "37.5%" }],
  });
});

test("stat values preserve the displayed string and name its last bucket", () => {
  const tooltip = metricChartTooltip(options);
  expect(tooltip(selection("stat", "value", [{ key: "value", value: "37.5%" }]))).toEqual({
    title: "16:00",
    rows: [{ label: "CPU", value: "37.5%" }],
  });
  expect(tooltip(selection("stat", "value", [{ key: "value", value: 37.5, formatted: "37.5%" }])).rows).toEqual([
    { label: "CPU", value: "37.5%" },
  ]);
});

test("heatmap and gauge tooltips name time and metric without placeholder rows", () => {
  const tooltip = metricChartTooltip(options);
  expect(
    tooltip(
      selection("heatmap", "cell", [
        { key: "value", value: 42 },
        { key: "x", value: "14:00 · host=a" },
        { key: "y", value: "01. Jan. 2026" },
      ]),
    ),
  ).toEqual({ title: "01. Jan. 2026 · 14:00 · host=a", rows: [{ label: "CPU", value: "42%" }] });
  for (const kind of ["gauge", "barGauge"] as const) {
    expect(
      tooltip(
        selection(kind, kind === "gauge" ? "value" : "item", [
          { key: "min", value: 0 },
          { key: "max", value: 100 },
          { key: "value", value: 42 },
        ]),
      ),
    ).toEqual({ title: "16:00", rows: [{ label: "CPU", value: "42%" }] });
  }
});

test("missing and non-finite metric numbers show n/a; unknown kinds use only a numeric value or y", () => {
  const tooltip = metricChartTooltip({ ...options, points: [] });
  for (const values of [[], [{ key: "value", value: Number.NaN }], [{ key: "value", value: Number.POSITIVE_INFINITY }]]) {
    for (const kind of ["gauge", "stat"] as const) {
      expect(tooltip(selection(kind, "value", values))).toEqual({ title: undefined, rows: [{ label: "CPU", value: "n/a" }] });
    }
  }
  expect(tooltip(selection("scatter", "point", [{ key: "y", value: 41.999999 }], "host=a"))).toEqual({
    title: "host=a",
    rows: [{ label: "CPU", value: "42%" }],
  });
  expect(tooltip(selection("map", "point", [{ key: "latitude", value: 42 }], "host=a"))).toEqual({ title: "host=a", rows: [] });
});
