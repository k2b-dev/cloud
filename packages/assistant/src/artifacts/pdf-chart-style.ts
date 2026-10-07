// Temporary chart stylesheet; HTML apps will supply the shared UI base stylesheet.
export const PDF_CHART_STYLE = `
:root {--k2b-text:#09090b;--k2b-surface:#ffffff;--k2b-danger-500:#ef4444;--k2b-font-sans:"IBM Plex Sans",ui-sans-serif,system-ui,sans-serif;--k2b-font-mono:"IBM Plex Mono",ui-monospace,monospace;--stdlib-chart-c1:#3b82f6;--stdlib-chart-c2:#10b981;--stdlib-chart-c3:#f59e0b;--stdlib-chart-c4:#8b5cf6;--stdlib-chart-c5:#ec4899;--stdlib-chart-c6:#06b6d4;--stdlib-chart-c7:#84cc16;--stdlib-chart-c8:#f97316;}
  .cloud-chart {
    display: block;
    width: 100%;
    height: var(--k2b-chart-height);
    max-height: 70vh;
    color: var(--k2b-text);
  }

  .cloud-chart > svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .cloud-chart[data-stretch] {
    container-type: size;
    --k2b-chart-inverse-x: tan(atan2(var(--k2b-chart-width), 100cqw));
    --k2b-chart-inverse-y: tan(atan2(var(--k2b-chart-height), 100cqh));
  }

  .cloud-chart[data-stretch] text {
    scale: var(--k2b-chart-inverse-x) var(--k2b-chart-inverse-y);
  }

  .cloud-chart[data-stretch] :is(circle, .stdlib-chart-point) {
    transform-box: fill-box;
    transform-origin: center;
    scale: var(--k2b-chart-inverse-x) var(--k2b-chart-inverse-y);
  }

  .cloud-chart[data-stretch] :is(path, line, rect, circle) {
    vector-effect: non-scaling-stroke;
  }

  .cloud-chart:not([data-stretch]) {
    height: auto;
    max-width: calc(var(--k2b-chart-width) * 1.5);
    margin-inline: auto;
  }

  .stdlib-chart {
    color: inherit;
    overflow: visible;
  }

  .stdlib-chart text {
    font-family: var(--k2b-font-sans);
  }

  .stdlib-chart-tick-label,
  .stdlib-chart-bar-value {
    font-family: var(--k2b-font-mono) !important;
    font-variant-numeric: tabular-nums;
  }

  .stdlib-chart-series-0 { fill: var(--stdlib-chart-c1); stroke: var(--stdlib-chart-c1); }
  .stdlib-chart-series-1 { fill: var(--stdlib-chart-c2); stroke: var(--stdlib-chart-c2); }
  .stdlib-chart-series-2 { fill: var(--stdlib-chart-c3); stroke: var(--stdlib-chart-c3); }
  .stdlib-chart-series-3 { fill: var(--stdlib-chart-c4); stroke: var(--stdlib-chart-c4); }
  .stdlib-chart-series-4 { fill: var(--stdlib-chart-c5); stroke: var(--stdlib-chart-c5); }
  .stdlib-chart-series-5 { fill: var(--stdlib-chart-c6); stroke: var(--stdlib-chart-c6); }
  .stdlib-chart-series-6 { fill: var(--stdlib-chart-c7); stroke: var(--stdlib-chart-c7); }
  .stdlib-chart-series-7 { fill: var(--stdlib-chart-c8); stroke: var(--stdlib-chart-c8); }
  .stdlib-chart-axis { stroke: currentColor; opacity: 0.25; fill: none; }
  .stdlib-chart-tick-label { font-size: 11px; fill: currentColor; opacity: 0.65; }
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
  .stdlib-chart-sparkline-max { fill: var(--stdlib-chart-c2); stroke: none; }
  .stdlib-chart-sparkline-min { fill: var(--k2b-danger-500); stroke: none; }
  .stdlib-chart-point { stroke: var(--k2b-surface); stroke-width: 1.5; }
  .stdlib-chart-slice { stroke: var(--k2b-surface); stroke-width: 2; stroke-linejoin: round; }
  .stdlib-chart-label { font-size: 11px; fill: currentColor; }
  .stdlib-chart-bar-value { font-size: 10px; fill: currentColor; opacity: 0.8; }
  .stdlib-chart-errorbar { stroke: currentColor; opacity: 0.55; fill: none; stroke-width: 1; }
  .stdlib-chart-error-band { fill-opacity: 0.15; stroke: none; }
  .stdlib-chart-trendline { stroke: currentColor; opacity: 0.55; stroke-width: 1.5; fill: none; stroke-dasharray: 5 4; }
  .stdlib-chart-minor-tick { stroke: currentColor; opacity: 0.25; }
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

`;
