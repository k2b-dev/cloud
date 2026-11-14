import type { ChartDrawingOptions } from "./core/render";
import type { charts } from "./core/svg";

/** Fixed migration baseline: newly registered kinds have their own tests, without a stdlib predecessor. */
type PortedChartOptions = Extract<ChartDrawingOptions, { kind: keyof typeof charts }>;

export type ChartParityRow = {
  id: string;
  feature: string;
  spec: PortedChartOptions;
  /** Compatibility input for an additive option with no predecessor in stdlib. */
  legacySpec?: PortedChartOptions;
  /** Frozen pre-port row used when this additive option had no predecessor. */
  legacyId?: string;
  proof: { file: string; test: string; kind?: "demo" };
  gap?: string;
};
const points = [
  { x: 1, y: 2, errY: 0.5 },
  { x: 2, y: 5, errY: 1 },
  { x: 5, y: 3, errY: 0.5 },
];
const line = { kind: "line", series: [{ label: "Visits", data: points }] } satisfies ChartDrawingOptions;
const bar = {
  kind: "bar",
  data: [
    { label: "Imports", value: 4 },
    { label: "Exports", value: 7 },
  ],
} satisfies ChartDrawingOptions;
const pie = { kind: "pie", data: bar.data } satisfies ChartDrawingOptions;
const timeline = {
  kind: "stateTimeline",
  rows: [
    {
      label: "Queue",
      intervals: [
        { from: 1, to: 3, state: "ok" },
        { from: 3, to: 5, state: "busy", href: "/jobs/2", tooltip: "Still running" },
      ],
    },
  ],
  states: [
    { state: "ok", label: "Healthy", color: "#10b981" },
    { state: "busy", label: "Working", color: "#a855f7" },
  ],
} satisfies ChartDrawingOptions;
const map = {
  kind: "map",
  series: [{ label: "Visits", data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin", size: 4 }] }],
} satisfies ChartDrawingOptions;
const histogram = { kind: "histogram", data: [1, 2, 2, 3, 5] } satisfies ChartDrawingOptions;
const boxplot = { kind: "boxplot", groups: [{ label: "Imports", values: [1, 2, 3, 4, 8, 14] }] } satisfies ChartDrawingOptions;
const gauge = { kind: "gauge", value: 42, min: 0, max: 100 } satisfies ChartDrawingOptions;
const barGauge = { kind: "barGauge", data: [{ label: "Imports", value: 42 }] } satisfies ChartDrawingOptions;
const stat = { kind: "stat", label: "Visits", value: 42 } satisfies ChartDrawingOptions;
const heatmap = {
  kind: "heatmap",
  data: [
    { x: "Mon", y: "Imports", value: 4 },
    { x: "Tue", y: "Imports", value: 7 },
  ],
} satisfies ChartDrawingOptions;
const sparkline = { kind: "sparkline", data: [2, 5, 3] } satisfies ChartDrawingOptions;
const percent = (value: number) => new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 }).format(value);
const currency = (value: number) => new Intl.NumberFormat("de", { style: "currency", currency: "EUR" }).format(value);
const compact = (value: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(value);
const date = (value: number) => new Date(value).toISOString().slice(0, 10);

/** Every approved parity item has a concrete SVG spec and a named test or existing live demo. */
export const chartParity: readonly ChartParityRow[] = [
  {
    id: "standalone-ui-palette",
    feature: "Standalone UI palette: opt-in conversion preserves styled renderer bytes",
    proof: {
      file: "packages/ui/src/charts/core/palette.test.ts",
      test: "all fourteen raw renderer kinds carry the UI defaults on explicit conversion",
    },
    spec: pie,
    legacyId: "kind-pie",
  },
  {
    id: "notebooks-pdf-palette",
    feature: "Notebooks PDF and map-print figures and legends use the UI palette",
    proof: {
      file: "packages/notebooks/src/service/note-pdf.test.ts",
      test: "note PDF includes the chart, data fallback and Cloud light palette",
    },
    spec: pie,
    legacyId: "kind-pie",
  },
  {
    id: "notebooks-browser-print-palette",
    feature: "Notebooks browser print copy uses UI violet for the fourth series",
    proof: {
      file: "packages/notebooks/src/frontend/[id]/_components/note-print-copy.browser.test.ts",
      test: "the Book copy prints the whole note; changes at print time replace the stale copy",
    },
    spec: pie,
    legacyId: "kind-pie",
  },
  {
    id: "notes-preview-palette",
    feature: "Notes share previews rasterize line and bar charts with the UI palette",
    proof: {
      file: "pwas/notes/server/preview.test.ts",
      test: "%s standalone Notes preview rasterizes the UI blue instead of its old private palette",
    },
    spec: pie,
    legacyId: "kind-pie",
  },
  {
    id: "line-forecast",
    feature: "Line: forecast and first-series band",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "forecast layout binds ordered bounds to the first series suffix",
    },
    spec: {
      ...line,
      forecast: {
        from: 2,
        band: [
          [4, 6],
          [2, 4],
        ],
      },
    },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "line-zero",
    feature: "Line: negative zone",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "forecast, zero zone, warning threshold and today use portable presentation attributes",
    },
    spec: { ...line, zero: true },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "line-threshold",
    feature: "Line: warning threshold",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "forecast, zero zone, warning threshold and today use portable presentation attributes",
    },
    spec: { ...line, threshold: { value: 4, label: "Reserve" } },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "line-marker",
    feature: "Line: labelled today marker",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "forecast, zero zone, warning threshold and today use portable presentation attributes",
    },
    spec: { ...line, marker: { at: 2, label: "Today" } },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "line-step-directions",
    feature: "Line: before and after steps",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "both step directions and existing middle steps remain distinct",
    },
    spec: { ...line, step: "after" },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "line-cursor-values",
    feature: "Line: values at cursor",
    proof: {
      file: "packages/ui/src/charts/core/line-forecast.test.ts",
      test: "line legends carry cursor fields, missing final values and bounded names",
    },
    spec: { ...line, legend: true, legendValues: true },
    legacySpec: line,
    legacyId: "kind-line",
  },
  {
    id: "kind-line",
    feature: "line",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: line,
  },
  {
    id: "kind-bar",
    feature: "bar",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: bar,
  },
  {
    id: "kind-pie",
    feature: "pie",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: pie,
  },
  {
    id: "kind-donut",
    feature: "donut",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...pie, kind: "donut" },
  },
  {
    id: "kind-scatter",
    feature: "scatter",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, kind: "scatter" },
  },
  {
    id: "kind-sparkline",
    feature: "sparkline",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: sparkline,
  },
  {
    id: "kind-histogram",
    feature: "histogram",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: histogram,
  },
  {
    id: "kind-boxplot",
    feature: "boxplot",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: boxplot,
  },
  {
    id: "kind-gauge",
    feature: "gauge",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: gauge,
  },
  {
    id: "kind-barGauge",
    feature: "barGauge",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: barGauge,
  },
  {
    id: "kind-stat",
    feature: "stat",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: stat,
  },
  {
    id: "kind-heatmap",
    feature: "heatmap",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: heatmap,
  },
  {
    id: "kind-map",
    feature: "map",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: map,
  },
  {
    id: "kind-stateTimeline",
    feature: "stateTimeline",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: timeline,
  },
  {
    id: "line-smooth",
    feature: "Line: smooth",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, smooth: true },
  },
  {
    id: "line-area",
    feature: "Line: area",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, area: true },
  },
  {
    id: "line-autoVariant",
    feature: "Line: autoVariant",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, autoVariant: true },
  },
  {
    id: "line-legend",
    feature: "Line: legend",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, legend: true },
  },
  {
    id: "line-step",
    feature: "Line: step",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, step: "middle" },
  },
  {
    id: "line-errorBand",
    feature: "Line: errorBand",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, errorBand: true },
  },
  {
    id: "line-references",
    feature: "Line: references",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: {
      ...line,
      references: [
        { value: 3, label: "Target" },
        { value: 2, axis: "x", label: "Start" },
      ],
    },
  },
  {
    id: "line-reference-style",
    feature: "Line: per-reference style",
    proof: {
      file: "packages/ui/src/charts/core/reference-style.test.ts",
      test: "reference lines have independent solid, dashed and dotted styles and semantic tones",
    },
    legacySpec: { ...line, references: [{ value: 3, label: "Target" }] },
    spec: { ...line, references: [{ value: 3, label: "Target", style: "solid", tone: "success" }] },
  },
  {
    id: "line-legend-placement",
    feature: "Line: legendPlacement",
    proof: {
      file: "packages/ui/src/content/Chart.render.test.ts",
      test: "keeps every original index and escapes names, without the bottom legend",
    },
    spec: { ...line, legend: true, legendPlacement: "top-start" },
  },
  {
    id: "line-maxGap",
    feature: "Line: maxGap",
    proof: {
      file: "packages/ui/src/content/chart-line-gaps.test.ts",
      test: "splits adjacent runs while preserving inspection metadata and isolated zero",
    },
    spec: { ...line, maxGap: 2 },
  },
  {
    id: "line-time-zone",
    feature: "Line: round ticks and time zone (#2723)",
    proof: {
      file: "packages/ui/src/content/chart-time-axis.render.test.ts",
      test: "ticks land on round wall times in the zone, not on decimal millisecond steps",
    },
    spec: {
      ...line,
      series: [
        {
          data: [
            { x: Date.UTC(2026, 9, 25, 0), y: 2 },
            { x: Date.UTC(2026, 9, 25, 4), y: 5 },
          ],
        },
      ],
      timeAxis: { timeZone: "Europe/Berlin", locale: "en" },
    },
  },
  {
    id: "line-shared-cursor",
    feature: "Line: shared cursor",
    proof: {
      file: "packages/ui/test/chart-runtime.behavior.test.ts",
      test: "shares exact X without redrawing SVG, preserves selection and clears only the active source",
    },
    spec: line,
  },
  {
    id: "bar-columns",
    feature: "Bar: columns",
    proof: { file: "packages/ui/src/content/chart-bar.test.ts", test: "few short labels stand below columns, each with its value" },
    spec: bar,
  },
  {
    id: "bar-rows",
    feature: "Bar: rows",
    proof: {
      file: "packages/ui/src/content/chart-bar.test.ts",
      test: "labels that do not fit below columns become rows: every category keeps its label and value",
    },
    spec: {
      ...bar,
      data: [
        { label: "Northwestern coastal region", value: 4 },
        { label: "Eastern uplands and foothills", value: 7 },
      ],
    },
  },
  {
    id: "bar-wrap",
    feature: "Bar: long label wrap",
    proof: {
      file: "packages/ui/src/content/chart-bar.test.ts",
      test: "long labels wrap to two lines and keep their full text when shortened",
    },
    spec: { ...bar, data: [{ label: "Northwestern coastal region and surrounding rural districts", value: 4 }] },
  },
  {
    id: "bar-colorByBar",
    feature: "Bar: colorByBar",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...bar, colorByBar: true },
  },
  {
    id: "bar-showValues",
    feature: "Bar: showValues",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...bar, showValues: true },
  },
  {
    id: "bar-references",
    feature: "Bar: references",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...bar, references: [{ value: 5, label: "Target" }] },
  },
  {
    id: "pie-innerRadius",
    feature: "pie: innerRadius",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...pie, kind: "pie", innerRadius: 0.4 },
  },
  {
    id: "pie-showLabels",
    feature: "pie: showLabels",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...pie, kind: "pie", showLabels: true },
  },
  {
    id: "pie-format",
    feature: "Pie: tooltip/table format",
    proof: { file: "packages/editor/src/charts.test.ts", test: "names value and y columns before axis labels, including stat sparklines" },
    spec: { ...pie, kind: "pie" },
  },
  {
    id: "donut-innerRadius",
    feature: "donut: innerRadius",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...pie, kind: "donut", innerRadius: 0.4 },
  },
  {
    id: "donut-showLabels",
    feature: "donut: showLabels",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...pie, kind: "donut", showLabels: true },
  },
  {
    id: "donut-format",
    feature: "Donut: tooltip/table format",
    proof: { file: "packages/editor/src/charts.test.ts", test: "names value and y columns before axis labels, including stat sparklines" },
    spec: { ...pie, kind: "donut" },
  },
  {
    id: "histogram-bins-count",
    feature: "Histogram bins: 3",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...histogram, bins: 3 },
  },
  {
    id: "histogram-bins-edges",
    feature: "Histogram bins: [0,2,4,6]",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...histogram, bins: [0, 2, 4, 6] },
  },
  {
    id: "boxplot-outliers",
    feature: "Boxplot: quartiles, whiskers, outliers",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...boxplot, showOutliers: true, colorByBox: true },
  },
  {
    id: "gauge-thresholds",
    feature: "gauge: thresholds",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: {
      ...gauge,
      thresholds: [
        { value: 50, label: "Target", color: "#10b981" },
        { value: 100, label: "Limit", color: "#a855f7" },
      ],
    },
  },
  {
    id: "gauge-unit",
    feature: "gauge: unit",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...gauge, unit: "%" },
  },
  {
    id: "gauge-min-max",
    feature: "gauge: min-max",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...gauge, min: 0, max: 80 },
  },
  {
    id: "barGauge-thresholds",
    feature: "barGauge: thresholds",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: {
      ...barGauge,
      thresholds: [
        { value: 50, label: "Target", color: "#10b981" },
        { value: 100, label: "Limit", color: "#a855f7" },
      ],
    },
  },
  {
    id: "barGauge-unit",
    feature: "barGauge: unit",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...barGauge, unit: "%" },
  },
  {
    id: "barGauge-min-max",
    feature: "barGauge: min-max",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...barGauge, min: 0, max: 80 },
  },
  {
    id: "stat-delta",
    feature: "Stat: delta",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...stat, delta: 3, deltaFormat: percent },
  },
  {
    id: "stat-better",
    feature: "Stat: better mapping to trend",
    proof: {
      file: "packages/cloud/src/ai/view-block.test.ts",
      test: "formats signed deltas and determines improvement without model colors",
    },
    spec: { ...stat, delta: 3, trend: "up" },
  },
  {
    id: "stat-sparkline",
    feature: "Stat: sparkline",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...stat, sparkline: [1, 2, 4] },
  },
  {
    id: "sparkline-gradient",
    feature: "Sparkline: area and extrema",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...sparkline, area: true, showLast: true, showMinMax: true },
  },
  {
    id: "heatmap-values",
    feature: "Heatmap: showValues",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...heatmap, showValues: true },
  },
  {
    id: "heatmap-min-max",
    feature: "Heatmap: min/max",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...heatmap, min: 0, max: 10 },
  },
  {
    id: "map-focus",
    feature: "Map: zoomFocus",
    proof: {
      file: "packages/ui/src/content/Chart.render.test.ts",
      test: "renders interactive controls and the initial viewport on the server",
    },
    spec: { ...map, zoomFocus: { latitude: 50, longitude: 10 } },
  },
  {
    id: "map-keys",
    feature: "Map: pan/zoom keys with Alt inspection",
    proof: {
      file: "packages/ui/test/chart-runtime.behavior.test.ts",
      test: "synchronizes controlled map viewports and resets to the current prop",
    },
    spec: { ...map, viewport: { latitude: 50, longitude: 10, zoom: 2 } },
  },
  {
    id: "timeline-states",
    feature: "State timeline: states",
    proof: {
      file: "packages/ui/src/content/chart-state-timeline.test.ts",
      test: "renders safe links, tooltips, semantic colors and the full label in a title",
    },
    spec: timeline,
  },
  {
    id: "timeline-intervals",
    feature: "State timeline: intervals",
    proof: {
      file: "packages/ui/src/content/chart-state-timeline.test.ts",
      test: "renders safe links, tooltips, semantic colors and the full label in a title",
    },
    spec: timeline,
  },
  {
    id: "timeline-links",
    feature: "State timeline: links",
    proof: {
      file: "packages/ui/src/content/chart-state-timeline.test.ts",
      test: "renders safe links, tooltips, semantic colors and the full label in a title",
    },
    spec: timeline,
  },
  {
    id: "timeline-tooltips",
    feature: "State timeline: tooltips",
    proof: {
      file: "packages/ui/src/content/chart-state-timeline.test.ts",
      test: "renders safe links, tooltips, semantic colors and the full label in a title",
    },
    spec: timeline,
  },
  {
    id: "timeline-alt-keys",
    feature: "State timeline: pan/zoom keys with Alt inspection",
    proof: {
      file: "packages/ui/test/chart-runtime.behavior.test.ts",
      test: "follows a growing timeline until local interaction and resumes after reset",
    },
    spec: timeline,
  },
  {
    id: "axis-label",
    feature: "Axes: label",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, yAxis: { label: "Visits" } },
  },
  {
    id: "axis-domain",
    feature: "Axes: domain",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, yAxis: { domain: [0, 10] } },
  },
  {
    id: "axis-ticks",
    feature: "Axes: ticks",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, yAxis: { ticks: 3 } },
  },
  {
    id: "axis-scale",
    feature: "Axes: scale",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, yAxis: { scale: "log" } },
  },
  {
    id: "axis-format-number",
    feature: "Axis format: number",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, xAxis: { format: String } },
  },
  {
    id: "axis-format-percent",
    feature: "Axis format: percent",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, xAxis: { format: percent } },
  },
  {
    id: "axis-format-currency",
    feature: "Axis format: currency",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, xAxis: { format: currency } },
  },
  {
    id: "axis-format-compact",
    feature: "Axis format: compact",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, xAxis: { format: compact } },
  },
  {
    id: "axis-format-date",
    feature: "Axis format: date",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "every parity spec preserves legacy SVG output" },
    spec: { ...line, xAxis: { format: date } },
  },
  {
    id: "tooltip",
    feature: "Tooltip formatter",
    proof: {
      file: "packages/ui/src/content/chart-tooltips.browser.test.ts",
      test: "a plain bar chart shows label and value on hover without shifting layout",
    },
    spec: bar,
  },
  {
    id: "select",
    feature: "onSelect and controlled selected",
    proof: {
      file: "packages/ui/test/chart-runtime.behavior.test.ts",
      test: "all fourteen kinds inspect and select renderer-owned data without rebuilding SVG",
    },
    spec: bar,
  },
  {
    id: "keyboard",
    feature: "Arrows, Home, End, Enter, Escape",
    proof: {
      file: "packages/ui/src/content/chart-tooltips.browser.test.ts",
      test: "one chart tab stop supports ArrowRight, End, Home and Escape",
    },
    spec: bar,
  },
  {
    id: "tap",
    feature: "Tap and swipe threshold",
    proof: {
      file: "packages/ui/src/content/chart-tooltips.browser.test.ts",
      test: "phone taps pin inspection; outside pointerdown and scrolling dismiss it",
    },
    spec: bar,
  },
  {
    id: "inspectChart",
    feature: "inspectChart export",
    proof: {
      file: "packages/ui/test/chart-inspection-core.behavior.test.ts",
      test: "inspects plain SVG with pointer and keyboard, pins selections, and tears down completely",
    },
    spec: line,
  },
  {
    id: "empty",
    feature: "Empty: No data",
    proof: { file: "packages/ui/src/content/Chart.render.test.ts", test: "empty charts have no inspection or accessible group" },
    spec: { ...bar, data: [] },
  },
  {
    id: "explorer-view",
    feature: "Explorer: chart/table",
    proof: { file: "packages/ui/test/chart-explorer.behavior.test.ts", test: "without charts the switcher still offers Diagram and Table" },
    spec: bar,
  },
  {
    id: "explorer-copy",
    feature: "Explorer: copy with formula guard",
    proof: {
      file: "packages/ui/test/chart-explorer.behavior.test.ts",
      test: "Copy data guards formula text and headers while preserving numeric cells and TSV quoting",
    },
    spec: bar,
  },
  {
    id: "explorer-steps",
    feature: "Explorer: step slider",
    proof: {
      file: "packages/ui/src/content/ChartExplorer.render.test.ts",
      test: "renders the complete SVG, named slider and controls on the server",
    },
    spec: line,
  },
  {
    id: "explorer-series",
    feature: "Explorer: series filter",
    proof: {
      file: "packages/ui/test/chart-controller.behavior.test.ts",
      test: "pinning captures displayed time, series filters apply to both periods and empty differs from omitted",
    },
    spec: line,
  },
  {
    id: "explorer-pin",
    feature: "Explorer: pin comparison",
    proof: {
      file: "packages/ui/test/chart-explorer.behavior.test.ts",
      test: "shared filter controls pin the requested step and clear it without losing filters",
    },
    spec: line,
  },
  {
    id: "explorer-retry",
    feature: "Explorer: retry",
    proof: {
      file: "packages/ui/test/chart-controller.behavior.test.ts",
      test: "errors retain their cause and every chart; retry is a forced fresh request",
    },
    spec: line,
  },
  {
    id: "snapshot-view",
    feature: "ChartSnapshotView",
    proof: {
      file: "packages/ui/src/content/ChartExplorer.render.test.ts",
      test: "prepares escaped metadata, stable keys and formatted text without browser APIs",
    },
    spec: bar,
  },
  {
    id: "server-snapshot",
    feature: "prepareChartSnapshot on server",
    proof: { file: "packages/ui/src/charts/parity.test.ts", test: "snapshots and scenes use the same pure SVG renderer" },
    spec: bar,
  },
  {
    id: "chat-chart",
    feature: "Chat chart tool",
    proof: { file: "packages/cloud/src/ai/view-block.test.ts", test: "accepts the chart tool contract and summaries contain no values" },
    spec: line,
  },
  {
    id: "chat-files",
    feature: "Chat view files",
    proof: { file: "packages/cloud/src/ai/view-block.test.ts", test: "Phase S view files retain their original canonical shape" },
    spec: line,
  },
  {
    id: "chat-linkX",
    feature: "Chat groups with linkX",
    proof: { file: "packages/cloud/src/ai/view-block.test.ts", test: "linkX only links line charts with the same kind of x" },
    spec: line,
  },
  {
    id: "notebook-print",
    feature: "Notebooks: print SVG and table",
    proof: {
      file: "packages/notebooks/src/frontend/lib/notebook-charts.browser.test.ts",
      test: "printing a chart switched to its table prints every row without overlap",
    },
    spec: bar,
  },
  {
    id: "cloud-chart",
    feature: "Chat native charts",
    proof: {
      file: "packages/assistant/src/chat-code/runtime/views.test.ts",
      test: "canonical chart forms pass through for every kind including gauge",
    },
    spec: line,
  },
  {
    id: "pulse",
    feature: "Pulse saved chart JSON",
    proof: {
      file: "packages/pulse/src/frontend/workspace/sql-result-chart.test.ts",
      test: "adapts the first time column and numeric/Nullable series to Chart line props",
    },
    spec: line,
  },
  {
    id: "gateway-snapshot",
    feature: "gateway-ops snapshots",
    proof: {
      file: "packages/gateway-ops/src/frontend/operational-charts.test.ts",
      test: "snapshots preserve units, missing samples, zero and exact counts",
    },
    spec: line,
  },
  {
    id: "gateway-timeline",
    feature: "gateway-ops timelines",
    proof: {
      file: "packages/gateway-ops/src/observability/jobs/timeline.test.ts",
      test: "gives a millisecond run a visible width without moving its start",
    },
    spec: timeline,
  },
  {
    id: "grids",
    feature: "Grids custom apps",
    proof: {
      file: "packages/grids/src/service/custom-app-insights.test.ts",
      test: "date-typed chart categories use the request locale without reinterpreting text or timestamps",
    },
    spec: bar,
  },
  {
    id: "venue",
    feature: "Venue",
    proof: {
      file: "packages/venue/src/frontend/_components/venue-workspace/feedback-chart-tooltips.test.ts",
      test: "ratings per day name the day and count the ratings as a whole number",
    },
    spec: line,
  },
  {
    id: "tools",
    feature: "Tools",
    proof: {
      file: "packages/tools/src/frontend/tools/speed-test-format.test.ts",
      test: "a sparkline sample names its metric and shows the reading with its unit",
    },
    spec: sparkline,
  },
  {
    id: "core-usage",
    feature: "Core AI usage",
    proof: { file: "packages/core/src/pages/admin/settings/_components/AiUsageCharts.tsx", test: "AiUsageCharts", kind: "demo" },
    spec: line,
  },
  {
    id: "core-quota",
    feature: "Core AI quota",
    proof: { file: "packages/core/src/pages/admin/settings/_components/AiQuotaCharts.tsx", test: "AiQuotaCharts", kind: "demo" },
    spec: bar,
  },
  {
    id: "docs-demos",
    feature: "Fibel chart demos",
    proof: { file: "docs-site/src/ui/demo-sections/charts.tsx", test: "ChartDemo", kind: "demo" },
    spec: line,
  },
  {
    id: "explorer-reference-series-style",
    feature: "Explorer: reference series legend style",
    proof: {
      file: "packages/ui/src/content/ChartExplorer.render.test.ts",
      test: "a legend wraps below the chart inside the fixed viewport and leaves with the table",
    },
    spec: line,
  },
  {
    id: "docs-explorer",
    feature: "Fibel explorer demos",
    proof: { file: "docs-site/src/ui/ChartExplorerShowcases.tsx", test: "ChartExplorerShowcases", kind: "demo" },
    spec: map,
  },
];

export const chartParityMarkdown = (): string =>
  [
    "| Feature | Proof | Status |",
    "| --- | --- | --- |",
    ...chartParity.map((row) => `| ${row.feature} | ${row.proof.file}: ${row.proof.test} | ${row.gap ? "Gap: " + row.gap : "Covered"} |`),
  ].join("\n");
