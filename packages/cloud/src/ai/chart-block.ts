// Cloud retains AI policy and its public export names; portable rendering lives in @k2b/editor.
export {
  type ChartColumn as CloudAiChartColumn,
  type ChartRow as CloudAiChartRow,
  type ChartTable as CloudAiChartTable,
  chartDateTime,
  chartLegend as cloudAiChartLegend,
  chartMarkKey as cloudAiChartMarkKey,
  chartMarks as cloudAiChartMarks,
  chartNumberFormatters as cloudAiNumberFormatters,
  chartReferenceMark as cloudAiChartReferenceMark,
  chartRenderOptions as cloudAiChartRenderOptions,
  chartRows as cloudAiChartRows,
  chartSteppingIssue,
  chartTable as cloudAiChartTable,
  chartTooltip as cloudAiChartTooltip,
  chartXValueFormat as cloudAiChartXValueFormat,
  checkChartLabels as checkCloudAiChartLabels,
} from "@k2b/editor/charts";

import {
  chartBounds as bounds,
  CHAR,
  type ChartInput as CloudAiChartInput,
  chartSteppingIssue,
  chartRenderOptions as cloudAiChartRenderOptions,
  drawChart as draw,
  HEATMAP_MAX_ROWS,
  chartHeatmapLabelFit as heatmapLabelFit,
  MIN_PIE_RADIUS,
  chartSvgMarks as marks,
  NARROW,
  chartPieRadius as pieRadius,
  chartReferenceValues as referencesOf,
  chartSeries as seriesOf,
  chartValueAxes as valueAxes,
} from "@k2b/editor/charts";

/** Why chart options would not draw, found without drawing them; undefined when nothing is wrong. */
export function chartDataIssue(input: CloudAiChartInput): string | undefined {
  const points = seriesOf(input).flatMap((series) => series.data);
  if (new Set(points.map((point) => typeof point.x)).size > 1) return "Use either numbers or dates for x in all series, not both.";
  if ((input.kind === "pie" || input.kind === "donut") && !input.data.some((slice) => slice.value > 0))
    return "Pie and donut slices must add up to more than zero.";
  if ("references" in input)
    for (const ref of input.references ?? []) {
      const name = ref.axis ?? "y";
      if (name === "x" && input.kind !== "line" && input.kind !== "scatter" && input.kind !== "histogram")
        return "Use y references for bar and boxplot charts.";
      const type = name === "x" && points.length ? typeof points[0]!.x : "number";
      if (typeof ref.value !== type) return `Use ${type === "string" ? "dates" : "numbers"} for ${name} references, like the axis values.`;
    }
  const stepping = chartSteppingIssue(input);
  if (stepping) return stepping;
  for (const { values: data, axis, name } of valueAxes(input)) {
    const values = [...data, ...referencesOf(input, name)];
    const dates = name === "x" && typeof points[0]?.x === "string";
    const dateFormat = axis?.format && "date" in axis.format;
    if (axis?.format && dateFormat !== dates) return `Use a ${dates ? "date" : "number"} format for the ${name} axis.`;
    const domain = bounds(axis?.domain);
    if (domain && referencesOf(input, name).some((value) => value < domain[0] || value > domain[1]))
      return `Extend the ${name} domain to include every reference.`;
    if (axis?.scale === "log") {
      if (values.some((value) => value <= 0))
        return "A log axis shows only values above zero; use a linear axis or leave out the values at or below zero.";
    }
  }
  if (input.kind === "heatmap") {
    if (new Set(input.data.map((cell) => JSON.stringify([cell.x, cell.y]))).size !== input.data.length)
      return "Use each heatmap x/y pair once.";
    if (input.min !== undefined && input.max !== undefined && input.min >= input.max) return "Set heatmap min below max.";
  }
  // These renderers key or place labels by their text, so labels cannot be thinned like bars.
  if (input.kind === "heatmap") {
    const columns = [...new Set(input.data.map((item) => item.x))];
    const rows = [...new Set(input.data.map((item) => item.y))];
    const fit = heatmapLabelFit(columns, rows);
    const swapped = heatmapLabelFit(rows, columns);
    const swap = swapped.columns && swapped.rows;
    if (!fit.columns)
      return fit.characters < 1
        ? `${columns.length} columns do not fit a phone-wide chart; ${swap ? "swap x and y or use fewer columns." : "use fewer columns or shorter labels."}`
        : `Use column labels of at most ${fit.characters} characters for ${columns.length} columns, ${swap ? "or swap x and y." : "or use fewer columns."}`;
    if (!fit.rows) return `Use at most ${HEATMAP_MAX_ROWS} heatmap rows; ${swap ? "swap x and y or use fewer rows." : "use fewer rows."}`;
  }
  // A bar gauge label sits in a 140-unit column that starts 12 units in.
  const gaugeLabel = Math.floor((140 - 12) / NARROW / CHAR) - 1;
  if (input.kind === "barGauge" && input.data.some((item) => item.label.length > gaugeLabel))
    return `Use bar gauge labels of at most ${gaugeLabel} characters, or a bar chart for longer names.`;
  if (input.kind === "gauge" || input.kind === "barGauge") {
    const ranges =
      input.kind === "gauge"
        ? [{ min: input.min ?? 0, max: input.max ?? 100 }]
        : input.data.map((item) => ({ min: item.min ?? input.min ?? 0, max: item.max ?? input.max ?? 100 }));
    // Existing gauges clamp their value and normalize the range; only new band boundaries impose these rules.
    if (input.thresholds) {
      if (input.thresholds.some((threshold, index) => index > 0 && threshold.value <= input.thresholds![index - 1]!.value))
        return "Set thresholds in strictly ascending order.";
      if (
        ranges.some(({ min, max }) => min >= max || input.thresholds!.some((threshold) => threshold.value < min || threshold.value > max))
      )
        return "Keep thresholds within every min..max range.";
    }
  }
  return undefined;
}

/** Why chart options that pass the data checks still would not draw well; draws them once. */
export function chartDrawingIssue(input: CloudAiChartInput): string | undefined {
  try {
    const svg = draw(cloudAiChartRenderOptions(input, "en"));
    if (marks(svg).length === 0) return "None of the values can be drawn.";
    if ((input.kind === "pie" || input.kind === "donut") && pieRadius(svg) < MIN_PIE_RADIUS)
      return "The legend leaves too little room for the pie: combine small slices into one, shorten the labels, or use a bar chart.";
    return undefined;
  } catch (error) {
    return `The chart cannot be drawn: ${error instanceof Error ? error.message : String(error)}`;
  }
}
