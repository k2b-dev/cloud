---
title: Chart renderer parity
navTitle: Chart parity
section: Contributing
order: 1312
description: Verify chart drawing, interaction and consumer compatibility during the SVG core migration.
tags: [contributing, testing, ui, charts]
updated: 2026-11-06
---

# Chart renderer parity

The catalog in `packages/ui/src/charts/parity.ts` names a test or demo for every
existing kind, option and consumer. The unit test compares SVG with immutable
pre-port drawings in `packages/ui/test/charts/legacy-svg.json`, captured from
stdlib 0.30.0 and the UI adapters at B1 commit `2016c0dd5e`. Only incremental
sparkline gradient IDs are normalized. Runtime renderer code never generates the
expected output during a test.

Covered means the named proof exists and the compatibility drawing matches its
frozen SVG. It does not mean every browser or consumer proof ran locally.
Per-reference line style and tone are additive: their catalog row compares the
old default drawing using `legacySpec`; the named test verifies the new options.
Existing explorer reference-series styling has a separate row.

Run the focused parity test and browser file, then owning package typechecks.
Regenerate this table with `bun scripts/render-chart-parity.ts`. Remove the
stdlib chart wrapper only after the catalog has no open row and the port is
merged. The fixture catalog is excluded from the published UI build.

<!-- chart-parity:start -->
| Feature | Proof | Status |
| --- | --- | --- |
| Line: forecast and first-series band | packages/ui/src/charts/core/line-forecast.test.ts: forecast layout binds ordered bounds to the first series suffix | Covered |
| Line: negative zone | packages/ui/src/charts/core/line-forecast.test.ts: forecast, zero zone, warning threshold and today use portable presentation attributes | Covered |
| Line: warning threshold | packages/ui/src/charts/core/line-forecast.test.ts: forecast, zero zone, warning threshold and today use portable presentation attributes | Covered |
| Line: labelled today marker | packages/ui/src/charts/core/line-forecast.test.ts: forecast, zero zone, warning threshold and today use portable presentation attributes | Covered |
| Line: before and after steps | packages/ui/src/charts/core/line-forecast.test.ts: both step directions and existing middle steps remain distinct | Covered |
| Line: values at cursor | packages/ui/src/charts/core/line-forecast.test.ts: line legends carry cursor fields, missing final values and bounded names | Covered |
| line | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| bar | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| pie | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| donut | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| scatter | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| sparkline | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| histogram | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| boxplot | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| gauge | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| barGauge | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| stat | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| heatmap | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| map | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| stateTimeline | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: smooth | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: area | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: autoVariant | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: legend | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: step | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: errorBand | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: references | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Line: per-reference style | packages/ui/src/charts/core/reference-style.test.ts: reference lines have independent solid, dashed and dotted styles and semantic tones | Covered |
| Line: legendPlacement | packages/ui/src/content/Chart.render.test.ts: keeps every original index and escapes names, without the bottom legend | Covered |
| Line: maxGap | packages/ui/src/content/chart-line-gaps.test.ts: splits adjacent runs while preserving inspection metadata and isolated zero | Covered |
| Line: round ticks and time zone (#2723) | packages/ui/src/content/chart-time-axis.render.test.ts: ticks land on round wall times in the zone, not on decimal millisecond steps | Covered |
| Line: shared cursor | packages/ui/test/chart-runtime.behavior.test.ts: shares exact X without redrawing SVG, preserves selection and clears only the active source | Covered |
| Bar: columns | packages/ui/src/content/chart-bar.test.ts: few short labels stand below columns, each with its value | Covered |
| Bar: rows | packages/ui/src/content/chart-bar.test.ts: labels that do not fit below columns become rows: every category keeps its label and value | Covered |
| Bar: long label wrap | packages/ui/src/content/chart-bar.test.ts: long labels wrap to two lines and keep their full text when shortened | Covered |
| Bar: colorByBar | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Bar: showValues | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Bar: references | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| pie: innerRadius | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| pie: showLabels | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Pie: tooltip/table format | packages/editor/src/charts.test.ts: names value and y columns before axis labels, including stat sparklines | Covered |
| donut: innerRadius | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| donut: showLabels | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Donut: tooltip/table format | packages/editor/src/charts.test.ts: names value and y columns before axis labels, including stat sparklines | Covered |
| Histogram bins: 3 | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Histogram bins: [0,2,4,6] | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Boxplot: quartiles, whiskers, outliers | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| gauge: thresholds | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| gauge: unit | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| gauge: min-max | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| barGauge: thresholds | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| barGauge: unit | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| barGauge: min-max | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Stat: delta | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Stat: better mapping to trend | packages/cloud/src/ai/view-block.test.ts: formats signed deltas and determines improvement without model colors | Covered |
| Stat: sparkline | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Sparkline: area and extrema | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Heatmap: showValues | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Heatmap: min/max | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Map: zoomFocus | packages/ui/src/content/Chart.render.test.ts: renders interactive controls and the initial viewport on the server | Covered |
| Map: pan/zoom keys with Alt inspection | packages/ui/test/chart-runtime.behavior.test.ts: synchronizes controlled map viewports and resets to the current prop | Covered |
| State timeline: states | packages/ui/src/content/chart-state-timeline.test.ts: renders safe links, tooltips, semantic colors and the full label in a title | Covered |
| State timeline: intervals | packages/ui/src/content/chart-state-timeline.test.ts: renders safe links, tooltips, semantic colors and the full label in a title | Covered |
| State timeline: links | packages/ui/src/content/chart-state-timeline.test.ts: renders safe links, tooltips, semantic colors and the full label in a title | Covered |
| State timeline: tooltips | packages/ui/src/content/chart-state-timeline.test.ts: renders safe links, tooltips, semantic colors and the full label in a title | Covered |
| State timeline: pan/zoom keys with Alt inspection | packages/ui/test/chart-runtime.behavior.test.ts: follows a growing timeline until local interaction and resumes after reset | Covered |
| Axes: label | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axes: domain | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axes: ticks | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axes: scale | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axis format: number | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axis format: percent | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axis format: currency | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axis format: compact | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Axis format: date | packages/ui/src/charts/parity.test.ts: every parity spec preserves legacy SVG output | Covered |
| Tooltip formatter | packages/ui/src/content/chart-tooltips.browser.test.ts: a plain bar chart shows label and value on hover without shifting layout | Covered |
| onSelect and controlled selected | packages/ui/test/chart-runtime.behavior.test.ts: all fourteen kinds inspect and select renderer-owned data without rebuilding SVG | Covered |
| Arrows, Home, End, Enter, Escape | packages/ui/src/content/chart-tooltips.browser.test.ts: one chart tab stop supports ArrowRight, End, Home and Escape | Covered |
| Tap and swipe threshold | packages/ui/src/content/chart-tooltips.browser.test.ts: phone taps pin inspection; outside pointerdown and scrolling dismiss it | Covered |
| inspectChart export | packages/ui/test/chart-inspection-core.behavior.test.ts: inspects plain SVG with pointer and keyboard, pins selections, and tears down completely | Covered |
| Empty: No data | packages/ui/src/content/Chart.render.test.ts: empty charts have no inspection or accessible group | Covered |
| Explorer: chart/table | packages/ui/test/chart-explorer.behavior.test.ts: without charts the switcher still offers Diagram and Table | Covered |
| Explorer: copy with formula guard | packages/ui/test/chart-explorer.behavior.test.ts: Copy data guards formula text and headers while preserving numeric cells and TSV quoting | Covered |
| Explorer: step slider | packages/ui/src/content/ChartExplorer.render.test.ts: renders the complete SVG, named slider and controls on the server | Covered |
| Explorer: series filter | packages/ui/test/chart-controller.behavior.test.ts: pinning captures displayed time, series filters apply to both periods and empty differs from omitted | Covered |
| Explorer: pin comparison | packages/ui/test/chart-explorer.behavior.test.ts: shared filter controls pin the requested step and clear it without losing filters | Covered |
| Explorer: retry | packages/ui/test/chart-controller.behavior.test.ts: errors retain their cause and every chart; retry is a forced fresh request | Covered |
| ChartSnapshotView | packages/ui/src/content/ChartExplorer.render.test.ts: prepares escaped metadata, stable keys and formatted text without browser APIs | Covered |
| prepareChartSnapshot on server | packages/ui/src/charts/parity.test.ts: snapshots and scenes use the same pure SVG renderer | Covered |
| Chat chart tool | packages/cloud/src/ai/view-block.test.ts: accepts the chart tool contract and summaries contain no values | Covered |
| Chat view files | packages/cloud/src/ai/view-block.test.ts: Phase S view files retain their original canonical shape | Covered |
| Chat groups with linkX | packages/cloud/src/ai/view-block.test.ts: linkX only links line charts with the same kind of x | Covered |
| Notebooks: print SVG and table | packages/notebooks/src/frontend/lib/notebook-charts.browser.test.ts: printing a chart switched to its table prints every row without overlap | Covered |
| Chat native charts | packages/assistant/src/chat-code/runtime/views.test.ts: canonical chart forms pass through for every kind including gauge | Covered |
| Pulse saved chart JSON | packages/pulse/src/frontend/workspace/sql-result-chart.test.ts: adapts the first time column and numeric/Nullable series to Chart line props | Covered |
| gateway-ops snapshots | packages/gateway-ops/src/frontend/operational-charts.test.ts: snapshots preserve units, missing samples, zero and exact counts | Covered |
| gateway-ops timelines | packages/gateway-ops/src/observability/jobs/timeline.test.ts: gives a millisecond run a visible width without moving its start | Covered |
| Grids custom apps | packages/grids/src/service/custom-app-insights.test.ts: date-typed chart categories use the request locale without reinterpreting text or timestamps | Covered |
| Venue | packages/venue/src/frontend/_components/venue-workspace/feedback-chart-tooltips.test.ts: ratings per day name the day and count the ratings as a whole number | Covered |
| Tools | packages/tools/src/frontend/tools/speed-test-format.test.ts: a sparkline sample names its metric and shows the reading with its unit | Covered |
| Core AI usage | packages/core/src/pages/admin/settings/_components/AiUsageCharts.tsx: AiUsageCharts | Covered |
| Core AI quota | packages/core/src/pages/admin/settings/_components/AiQuotaCharts.tsx: AiQuotaCharts | Covered |
| Fibel chart demos | docs-site/src/ui/demo-sections/charts.tsx: ChartDemo | Covered |
| Explorer: reference series legend style | packages/ui/src/content/ChartExplorer.render.test.ts: a legend wraps below the chart inside the fixed viewport and leaves with the table | Covered |
| Fibel explorer demos | docs-site/src/ui/ChartExplorerShowcases.tsx: ChartExplorerShowcases | Covered |
<!-- chart-parity:end -->
