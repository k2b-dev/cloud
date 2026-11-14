// CSS rule order is significant. Series-N rules emit first so shape-specific
// rules below can override (e.g. line's `fill: none` beats series fill, and
// slice/point's `stroke: white` beats series stroke).
export const DEFAULT_STYLES = `
/* font-family is intentionally not set here so the chart inherits the app's
   font from its surrounding HTML context. For standalone SVG usage, set
   font-family on a wrapping element or override .stdlib-chart in your CSS. */
.stdlib-chart {
  color: #1f2937;
  --stdlib-chart-c1: #3b82f6; --stdlib-chart-c2: #10b981;
  --stdlib-chart-c3: #f59e0b; --stdlib-chart-c4: #ef4444;
  --stdlib-chart-c5: #8b5cf6; --stdlib-chart-c6: #ec4899;
  --stdlib-chart-c7: #14b8a6; --stdlib-chart-c8: #f97316;
}
.stdlib-chart-series-0 { fill: var(--stdlib-chart-c1); stroke: var(--stdlib-chart-c1); }
.stdlib-chart-series-1 { fill: var(--stdlib-chart-c2); stroke: var(--stdlib-chart-c2); }
.stdlib-chart-series-2 { fill: var(--stdlib-chart-c3); stroke: var(--stdlib-chart-c3); }
.stdlib-chart-series-3 { fill: var(--stdlib-chart-c4); stroke: var(--stdlib-chart-c4); }
.stdlib-chart-series-4 { fill: var(--stdlib-chart-c5); stroke: var(--stdlib-chart-c5); }
.stdlib-chart-series-5 { fill: var(--stdlib-chart-c6); stroke: var(--stdlib-chart-c6); }
.stdlib-chart-series-6 { fill: var(--stdlib-chart-c7); stroke: var(--stdlib-chart-c7); }
.stdlib-chart-series-7 { fill: var(--stdlib-chart-c8); stroke: var(--stdlib-chart-c8); }
.stdlib-chart-axis { stroke: currentColor; opacity: 0.4; fill: none; }
.stdlib-chart-tick-label { font-size: 10px; fill: currentColor; opacity: 0.6; }
.stdlib-chart-axis-label { font-size: 11px; fill: currentColor; opacity: 0.85; }
.stdlib-chart-grid { stroke: currentColor; opacity: 0.08; stroke-dasharray: 2 2; fill: none; }
.stdlib-chart-title { font-size: 14px; font-weight: 600; fill: currentColor; }
.stdlib-chart-subtitle { font-size: 11px; fill: currentColor; opacity: 0.7; }
.stdlib-chart-reference { stroke: currentColor; opacity: 0.5; stroke-dasharray: 4 4; fill: none; }
.stdlib-chart-reference-label { font-size: 10px; fill: currentColor; opacity: 0.7; }
.stdlib-chart-line { fill: none; stroke-width: 2; }
.stdlib-chart-area { fill-opacity: 0.18; stroke: none; }
.stdlib-chart-sparkline { fill: none; stroke-width: 1.5; stroke: currentColor; }
.stdlib-chart-sparkline-area { stroke: none; }
.stdlib-chart-sparkline-last { fill: currentColor; stroke: none; }
.stdlib-chart-sparkline-max { fill: #10b981; stroke: none; }
.stdlib-chart-sparkline-min { fill: #ef4444; stroke: none; }
.stdlib-chart-point { stroke: white; stroke-width: 1.5; }
.stdlib-chart-slice { stroke: white; stroke-width: 2; stroke-linejoin: round; }
.stdlib-chart-label { font-size: 11px; fill: currentColor; }
.stdlib-chart-bar-value { font-size: 10px; fill: currentColor; opacity: 0.8; }
.stdlib-chart-errorbar { stroke: currentColor; opacity: 0.55; fill: none; stroke-width: 1; }
.stdlib-chart-error-band { fill-opacity: 0.15; stroke: none; }
.stdlib-chart-trendline { stroke: currentColor; opacity: 0.55; stroke-width: 1.5; fill: none; stroke-dasharray: 5 4; }
.stdlib-chart-minor-tick { stroke: currentColor; opacity: 0.25; }
.stdlib-chart-box { fill-opacity: 0.4; stroke-width: 1; }
.stdlib-chart-box-median { stroke: currentColor; stroke-width: 1.5; fill: none; }
.stdlib-chart-box-whisker { stroke: currentColor; opacity: 0.6; fill: none; }
.stdlib-chart-box-cap { stroke: currentColor; opacity: 0.6; fill: none; }
.stdlib-chart-box-outlier { fill: currentColor; opacity: 0.5; stroke: white; stroke-width: 1; }
.stdlib-chart-legend-swatch { stroke: none; }
.stdlib-chart-legend-label { font-size: 11px; font-weight: 400; fill: currentColor; stroke: none; }
.stdlib-chart-empty-text { font-size: 11px; fill: currentColor; opacity: 0.5; }
.stdlib-chart-gauge-track { stroke: currentColor; stroke-width: 10; opacity: 0.12; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-fill { stroke-width: 10; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-gradient-segment { stroke-width: 10; fill: none; stroke-linecap: butt; }
.stdlib-chart-gauge-gradient-scale { opacity: 0.22; }
.stdlib-chart-gauge-needle { stroke-width: 2; fill: none; stroke-linecap: round; }
.stdlib-chart-gauge-hub { fill: currentColor; stroke: none; }
.stdlib-chart-gauge-value { font-size: 28px; font-weight: 700; fill: currentColor; }
.stdlib-chart-gauge-label { font-size: 12px; fill: currentColor; opacity: 0.72; }
.stdlib-chart-gauge-unit { font-size: 11px; fill: currentColor; opacity: 0.6; }
.stdlib-chart-bar-gauge-track { fill: currentColor; opacity: 0.1; }
.stdlib-chart-bar-gauge-fill { stroke: none; }
.stdlib-chart-bar-gauge-label { font-size: 11px; fill: currentColor; opacity: 0.75; }
.stdlib-chart-bar-gauge-value { font-size: 11px; font-weight: 600; fill: currentColor; }
.stdlib-chart-stat-label { font-size: 12px; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-value { font-size: 30px; font-weight: 700; fill: currentColor; }
.stdlib-chart-stat-unit { font-size: 14px; font-weight: 600; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-delta { font-size: 12px; font-weight: 600; fill: currentColor; opacity: 0.72; }
.stdlib-chart-stat-delta-up { fill: #10b981; opacity: 1; }
.stdlib-chart-stat-delta-down { fill: #ef4444; opacity: 1; }
.stdlib-chart-stat-sparkline { fill: none; stroke: currentColor; stroke-width: 1.6; opacity: 0.86; }
.stdlib-chart-stat-sparkline-area { stroke: none; opacity: 0.18; }
.stdlib-chart-heatmap-cell { stroke: white; stroke-width: 1; }
.stdlib-chart-heatmap-label { font-size: 10px; fill: currentColor; opacity: 0.68; }
.stdlib-chart-map-land { fill: currentColor; opacity: var(--stdlib-chart-map-land-opacity, 0.12); stroke: currentColor; stroke-width: 0.5; stroke-linejoin: round; }
.stdlib-chart-map-point { stroke: var(--stdlib-chart-map-point-stroke, white); stroke-width: 1.5; }
.stdlib-chart-map-empty { font-size: 11px; fill: currentColor; opacity: 0.55; }
.stdlib-chart-state-region { stroke: white; stroke-width: 1; }
.stdlib-chart-state-label { font-size: 11px; fill: currentColor; opacity: 0.75; }
`.trim();
