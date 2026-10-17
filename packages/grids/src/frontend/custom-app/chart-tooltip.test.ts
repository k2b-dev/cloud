import { expect, test } from "bun:test";
import type { ChartSelection } from "@k2b/ui";
import type { CustomAppValueFormat } from "../../custom-apps/contracts";
import { buildChartRenderData, type ChartRenderData } from "./chart-data";
import { customAppChartTooltip } from "./chart-tooltip";

const money = { style: "number", decimalPlaces: 2, unit: "€", unitPosition: "suffix" } as const;
const renderData = (kind: ChartRenderData["kind"], category = "Neu", relationLabels: Record<string, string> = {}) =>
  buildChartRenderData({
    widget: { chartType: kind },
    groupBy: [{ fieldId: "status" }],
    aggregations: [
      { fieldId: "amount", agg: "sum", label: "Umsatz" },
      { fieldId: "cost", agg: "sum", label: "Kosten" },
    ],
    buckets: [{ keys: [category], values: { amount__sum: 1234.5, cost__sum: 42 } }],
    fieldsById: new Map(),
    relationLabels,
    categoryFormat: { locale: "de", unknownRecordLabel: "Unbekannter Datensatz" },
  });
const formatter = (chart: ChartRenderData, valueFormat: CustomAppValueFormat = money) =>
  customAppChartTooltip({ chart, valueFormat, dateConfig: { locale: "de" }, shareLabel: "Anteil" });
const selection = (kind: ChartSelection["kind"], values: ChartSelection["datum"]["values"], label?: string, index = 0): ChartSelection => ({
  kind,
  datum: { role: kind === "line" ? "point" : "item", index, label, values, anchor: [0, 0] },
});

test("bar tooltips recover the real category despite blank drawing labels and format the aggregation", () => {
  expect(formatter(renderData("bar"))(selection("bar", [{ key: "value", value: 1234.5, formatted: "1234.5" }], ""))).toEqual({
    title: "Neu",
    rows: [{ label: "Umsatz", value: "1.234,50 €" }],
  });
});

test("line series at the same x share the category title and keep their own aggregation labels", () => {
  const chart = renderData("line");
  if (chart.kind !== "line") throw new Error("Expected line render data");
  const tooltip = formatter(chart);
  expect(
    chart.series.map((series, seriesIndex) => {
      const point = series.data[0]!;
      const selected = selection(
        "line",
        [
          { key: "x", value: point.x },
          { key: "y", value: point.y },
        ],
        series.label,
      );
      selected.datum.seriesIndex = seriesIndex;
      return tooltip(selected);
    }),
  ).toEqual([
    { title: "Neu", rows: [{ label: "Umsatz", value: "1.234,50 €" }] },
    { title: "Neu", rows: [{ label: "Kosten", value: "42,00 €" }] },
  ]);
});

test("donut tooltips show category, formatted aggregation and a localized share", () => {
  expect(
    formatter(renderData("donut"))(
      selection("donut", [
        { key: "value", value: 1234.5 },
        { key: "percent", value: 12.34 },
        { key: "total", value: 10000 },
      ]),
    ),
  ).toEqual({
    title: "Neu",
    rows: [
      { label: "Umsatz", value: "1.234,50 €" },
      { label: "Anteil", value: "12,3 %" },
    ],
  });
});

test("tooltips use the same percent, integer and prefix unit formats as the axes", () => {
  for (const [valueFormat, value, expected] of [
    [{ style: "percent", decimalPlaces: 1 }, 0.1234, "12,3 %"],
    [{ style: "integer" }, 1234.5, "1.235"],
    [{ style: "number", decimalPlaces: 2, unit: "€", unitPosition: "prefix" }, 1234.5, "€ 1.234,50"],
  ] satisfies [CustomAppValueFormat, number, string][]) {
    expect(formatter(renderData("bar"), valueFormat)(selection("bar", [{ key: "value", value }])).rows).toEqual([
      { label: "Umsatz", value: expected },
    ]);
  }
});

test("relation categories use resolved labels or the localized unknown record label", () => {
  const uuid = "ee5e662c-841e-4abd-b4e6-97bdc7d71234";
  for (const kind of ["bar", "line", "donut"] as const) {
    const labelMaps: Record<string, string>[] = [{}, { [uuid]: "Kundendienst" }];
    for (const relationLabels of labelMaps) {
      const chart = renderData(kind, uuid, relationLabels);
      const values =
        kind === "line"
          ? [
              { key: "x", value: 0 },
              { key: "y", value: 1234.5 },
            ]
          : [{ key: "value", value: 1234.5 }];
      expect(formatter(chart)(selection(kind, values)).title).toBe(relationLabels[uuid] ?? "Unbekannter Datensatz");
    }
  }
});

test("missing or non-finite values show an em dash and invalid shares are omitted", () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const values =
      value === undefined
        ? []
        : [
            { key: "value", value },
            { key: "percent", value },
          ];
    for (const kind of ["bar", "donut"] as const) {
      expect(formatter(renderData(kind))(selection(kind, values))).toEqual({
        title: "Neu",
        rows: [{ label: "Umsatz", value: "—" }],
      });
    }
    expect(formatter(renderData("line"))(selection("line", value === undefined ? [] : [{ key: "y", value }]))).toEqual({
      title: undefined,
      rows: [{ label: "", value: "—" }],
    });
  }
});

test("line titles reject missing, fractional and out-of-range bucket indices", () => {
  for (const x of [undefined, -1, 0.5, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(formatter(renderData("line"))(selection("line", x === undefined ? [] : [{ key: "x", value: x }])).title).toBeUndefined();
  }
});

test("a mismatched selection still uses the chart's own labels and safe missing values", () => {
  expect(formatter(renderData("bar"))(selection("line", [{ key: "y", value: 3 }], "Wrong label", 99))).toEqual({
    title: undefined,
    rows: [{ label: "Umsatz", value: "—" }],
  });
});
