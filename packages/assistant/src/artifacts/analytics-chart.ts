import { prepareChartSnapshot, type ChartSelection, type ChartRenderOptions, type ChartSnapshot } from "@k2b/ui";
import { formatValue, type ExplorerData, type AnalyticsNode } from "./runtime/analytics-contracts";

type Presentation = Extract<AnalyticsNode, { type: "chart" }>["data"];
const datumKey = (selection: ChartSelection) => `${selection.datum.role}:${selection.datum.seriesIndex ?? ""}:${selection.datum.index}`;
function formattedOptions(data: Presentation, locale: string): ChartRenderOptions {
  const options = data.options;
  const formats = data.formats;
  const format = (key: string) => (formats?.[key] ? (value: number) => formatValue(value, formats[key], locale) : undefined);
  switch (options.kind) {
    case "line":
    case "scatter":
    case "histogram":
      return { ...options, xAxis: { ...options.xAxis, format: format("x") }, yAxis: { ...options.yAxis, format: format("y") } };
    case "bar":
    case "boxplot":
      return { ...options, yAxis: { ...options.yAxis, format: format("value") } };
    case "stat":
      return { ...options, format: format("value"), deltaFormat: format("delta") };
    case "gauge":
    case "barGauge":
    case "heatmap":
      return { ...options, format: format("value") };
    case "stateTimeline":
      return { ...options, xAxis: { ...options.xAxis, format: format("x") } };
    default:
      return options;
  }
}
export function chartSnapshot(data: Presentation, locale: string): ChartSnapshot {
  const mappings = new Map(data.marks?.map((mark) => [`${mark.role}:${mark.seriesIndex ?? ""}:${mark.index}`, mark]));
  if (mappings.size !== (data.marks?.length ?? 0)) throw new Error("Chart datum mappings must be unique");
  const used = new Set<string>();
  const snapshot = prepareChartSnapshot(formattedOptions(data, locale), {
    key(selection) {
      const id = datumKey(selection);
      used.add(id);
      if (data.marks && !mappings.has(id)) throw new Error("Every rendered mark requires a mapping");
      return mappings.get(id)?.key ?? id;
    },
    rowKey: (selection) => mappings.get(datumKey(selection))?.rowKey ?? datumKey(selection),
    reference: (selection) => mappings.get(datumKey(selection))?.reference ?? false,
    tooltip: (selection) =>
      mappings.get(datumKey(selection))?.tooltip ?? {
        title: selection.datum.label,
        rows: selection.datum.values.map((value) => ({
          label: value.key,
          value: data.formats?.[value.key]
            ? formatValue(value.value, data.formats[value.key], locale)
            : (value.formatted ?? String(value.value)),
        })),
      },
  });
  if (data.marks && used.size !== mappings.size) throw new Error("Chart mappings must match rendered marks");
  return snapshot;
}
export function explorerChart(data: ExplorerData, columns: Extract<AnalyticsNode, { type: "explorer" }>["columns"], locale: string) {
  const spec = data.chart;
  const rows = data.rows.map((row) => ({ key: String(row[data.rowKey]), values: row }));
  if ("options" in spec) return { rows, chart: chartSnapshot(spec, locale) };
  const tooltip = (index: number) => ({
    rows: columns.map((column) => ({ label: column.label, value: formatValue(data.rows[index]?.[column.key], column.format, locale) })),
  });
  const numeric = (index: number, field: string) => {
    const value = data.rows[index]?.[field];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Chart field ${field} requires finite numbers`);
    return value;
  };
  const category = (index: number, field: string) => {
    const value = data.rows[index]?.[field];
    if (value === null || value === undefined) throw new Error(`Missing chart field ${field}`);
    return String(value);
  };
  const rowKey = (index: number) => rows[index]!.key;
  if (spec.kind === "bar" || spec.kind === "pie" || spec.kind === "donut") {
    const values = rows.map((_, i) => ({ label: category(i, spec.category), value: numeric(i, spec.value) }));
    if (spec.kind !== "bar" && values.some((value) => value.value <= 0))
      throw new Error("Pie and donut values must be positive; filter explicitly before rendering");
    return {
      rows,
      chart: prepareChartSnapshot(
        spec.kind === "bar"
          ? {
              kind: "bar",
              data: values,
              yAxis: {
                label: columns.find((column) => column.key === spec.value)?.label,
                format: (value) => formatValue(value, columns.find((column) => column.key === spec.value)?.format, locale),
              },
            }
          : { kind: spec.kind, data: values },
        { key: (selection) => rowKey(selection.datum.index), tooltip: (selection) => tooltip(selection.datum.index) },
      ),
    };
  }
  if (!("x" in spec)) throw new Error("Unsupported chart mapping");
  const grouped = new Map<string, number[]>();
  rows.forEach((_, index) => {
    const group = spec.series ? category(index, spec.series) : "";
    const indices = grouped.get(group) ?? [];
    indices.push(index);
    grouped.set(group, indices);
  });
  const groups = [...grouped];
  const indexFor = (selection: ChartSelection) => groups[selection.datum.seriesIndex ?? 0]![1][selection.datum.index]!;
  return {
    rows,
    chart: prepareChartSnapshot(
      {
        kind: spec.kind,
        series: groups.map(([label, indices]) => ({ label, data: indices.map((i) => ({ x: numeric(i, spec.x), y: numeric(i, spec.y) })) })),
        xAxis: { format: (value) => formatValue(value, columns.find((column) => column.key === spec.x)?.format, locale) },
        yAxis: { format: (value) => formatValue(value, columns.find((column) => column.key === spec.y)?.format, locale) },
      },
      { key: (selection) => rowKey(indexFor(selection)), tooltip: (selection) => tooltip(indexFor(selection)) },
    ),
  };
}
