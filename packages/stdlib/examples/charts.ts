/**
 * Visual review for src/charts.ts.
 *
 * Run with `bun run examples/charts.ts`. Generates one SVG per case plus
 * an `index.html` in `examples/out/` showing every chart type and feature
 * in a single unified grid. SVGs are inlined into the HTML so theme demos
 * (currentColor, custom-property palettes) actually apply.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { charts } from "../src/charts";

const OUT_DIR = join(import.meta.dir, "out");

// Datasets ----------------------------------------------------------------

const noisySeriesA = Array.from({ length: 30 }, (_, i) => ({
  x: i,
  y: Math.round(50 + Math.sin(i * 0.3) * 18 + (Math.random() - 0.5) * 8),
}));
const noisySeriesB = Array.from({ length: 30 }, (_, i) => ({
  x: i,
  y: Math.round(40 + Math.cos(i * 0.4) * 14 + (Math.random() - 0.5) * 6),
}));
const noisySeriesC = Array.from({ length: 30 }, (_, i) => ({
  x: i,
  y: Math.round(35 + Math.sin(i * 0.2 + 1) * 10 + (Math.random() - 0.5) * 5),
}));

const quarterlyRevenue = [
  { label: "Q1", value: 124 },
  { label: "Q2", value: 187 },
  { label: "Q3", value: 162 },
  { label: "Q4", value: 215 },
];

const monthlyMix = [
  { label: "Jan", value: 30 },
  { label: "Feb", value: -10 },
  { label: "Mar", value: 22 },
  { label: "Apr", value: -18 },
  { label: "May", value: 45 },
  { label: "Jun", value: 12 },
];

const fiveSlices = [
  { label: "Engineering", value: 42 },
  { label: "Sales", value: 23 },
  { label: "Marketing", value: 18 },
  { label: "Support", value: 11 },
  { label: "Other", value: 6 },
];

// Box-Muller for an approximately gaussian sample.
const gauss = (mean: number, sd: number): number => {
  const u1 = Math.random();
  const u2 = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// Cases -------------------------------------------------------------------

type Case = { name: string; title: string; svg: string };

const cases: Case[] = [
  {
    name: "scatter",
    title: "Scatter — bubble chart, multi-series, autoVariant markers",
    svg: charts.scatter({
      title: "Two populations",
      series: [
        {
          label: "Group A",
          data: Array.from({ length: 18 }, () => ({
            x: 5 + Math.random() * 30,
            y: 10 + Math.random() * 60,
            size: 5 + Math.random() * 95,
          })),
        },
        {
          label: "Group B",
          data: Array.from({ length: 18 }, () => ({
            x: 30 + Math.random() * 30,
            y: 20 + Math.random() * 60,
            size: 5 + Math.random() * 95,
          })),
        },
      ],
      sizeRange: [3, 16],
      autoVariant: true,
      legend: true,
    }),
  },
  {
    name: "scatter-science",
    title: "Scatter — error bars + trend line",
    svg: charts.scatter({
      title: "Reaction time vs trial",
      yAxis: { label: "ms ± σ" },
      xAxis: { label: "Trial #" },
      series: [
        {
          data: Array.from({ length: 14 }, (_, i) => ({
            x: i,
            y: Math.round(20 + i * 3 + Math.sin(i) * 4),
            errY: 2 + Math.random() * 2.5,
          })),
        },
      ],
      trendline: true,
    }),
  },
  {
    name: "line",
    title: "Line — multi-series, smooth, autoVariant styles, legend",
    svg: charts.line({
      title: "Revenue vs Costs vs Forecast",
      yAxis: { format: (v) => `€${v}k` },
      series: [
        { label: "Revenue", data: noisySeriesA },
        { label: "Costs", data: noisySeriesB },
        { label: "Forecast", data: noisySeriesC },
      ],
      autoVariant: true,
      legend: true,
      width: 480,
      height: 280,
    }),
  },
  {
    name: "line-area",
    title: "Line — area chart with reference",
    svg: charts.line({
      series: [{ data: noisySeriesA }],
      area: true,
      references: [{ value: 50, label: "baseline" }],
    }),
  },
  {
    name: "line-errorband",
    title: "Line — error band (95% CI)",
    svg: charts.line({
      title: "Estimate with confidence interval",
      series: [
        {
          data: Array.from({ length: 24 }, (_, i) => {
            const y = 50 + Math.sin(i * 0.4) * 18;
            const err = 4 + Math.random() * 3;
            return { x: i, y, errYHigh: err, errYLow: err };
          }),
        },
      ],
      errorBand: true,
    }),
  },
  {
    name: "line-log",
    title: "Line — logarithmic y-axis with minor ticks",
    svg: charts.line({
      title: "Logarithmic decay",
      yAxis: { scale: "log", label: "Intensity", minorTicks: true },
      xAxis: { label: "Step" },
      series: [
        {
          data: Array.from({ length: 30 }, (_, i) => ({
            x: i,
            y: Math.pow(10, 0.5 + i * 0.1) * (1 + Math.sin(i * 0.5) * 0.05),
          })),
        },
      ],
    }),
  },
  {
    name: "line-step",
    title: "Line — step plot (population by census year)",
    svg: charts.line({
      title: "Population by census year",
      yAxis: { format: (v) => `${v}M` },
      series: [
        {
          data: [
            { x: 1990, y: 250 },
            { x: 2000, y: 281 },
            { x: 2010, y: 309 },
            { x: 2020, y: 331 },
          ],
        },
      ],
      step: "before",
    }),
  },
  {
    name: "bar",
    title: "Bar — title + value labels + target reference + formatted axis",
    svg: charts.bar({
      title: "Quarterly Revenue",
      subtitle: "in thousand EUR",
      data: quarterlyRevenue,
      yAxis: { format: (v) => `€${v}k` },
      references: [{ value: 200, label: "Target" }],
      showValues: true,
    }),
  },
  {
    name: "bar-mixed",
    title: "Bar — positive / negative with values",
    svg: charts.bar({
      data: monthlyMix,
      showValues: true,
    }),
  },
  {
    name: "bar-multicolor",
    title: "Bar — colorByBar with legend",
    svg: charts.bar({
      title: "Quarterly Performance",
      data: quarterlyRevenue,
      colorByBar: true,
      legend: true,
      width: 480,
      height: 280,
    }),
  },
  {
    name: "pie",
    title: "Pie — slices with labels",
    svg: charts.pie({
      title: "Team allocation",
      data: fiveSlices,
      showLabels: true,
      width: 480,
      height: 320,
    }),
  },
  {
    name: "donut",
    title: "Donut — usage indicator",
    svg: charts.donut({
      title: "Storage used",
      data: [
        { label: "Used", value: 67 },
        { label: "Free", value: 33 },
      ],
    }),
  },
  {
    name: "pie-collision-labels",
    title: "Pie — showLabels overlap when one slice dominates",
    svg: charts.pie({
      title: "Monthly budget",
      subtitle: "showLabels: dominant slice forces small labels to collide",
      data: [
        { label: "Rent", value: 79 },
        { label: "Groceries", value: 9 },
        { label: "Books", value: 4.2 },
        { label: "Utilities", value: 3.7 },
        { label: "Transport", value: 2.3 },
        { label: "Food & coffee", value: 1.5 },
      ],
      showLabels: true,
      width: 480,
      height: 320,
    }),
  },
  {
    name: "pie-legend",
    title: "Pie — legend variant (recommended for collision-prone data)",
    svg: charts.pie({
      title: "Monthly budget",
      subtitle: "legend: wraps below the chart, no overlap",
      data: [
        { label: "Rent", value: 79 },
        { label: "Groceries", value: 9 },
        { label: "Books", value: 4.2 },
        { label: "Utilities", value: 3.7 },
        { label: "Transport", value: 2.3 },
        { label: "Food & coffee", value: 1.5 },
      ],
      legend: true,
      width: 480,
      height: 320,
    }),
  },
  {
    name: "donut-legend-many-slices",
    title: "Donut — legend wraps to multiple rows for many slices",
    svg: charts.donut({
      title: "Traffic sources",
      data: [
        { label: "Direct", value: 28 },
        { label: "Organic search", value: 22 },
        { label: "Social media", value: 14 },
        { label: "Referral", value: 11 },
        { label: "Email campaigns", value: 9 },
        { label: "Paid search", value: 7 },
        { label: "Affiliate", value: 5 },
        { label: "Other", value: 4 },
      ],
      legend: true,
      width: 480,
      height: 360,
    }),
  },
  {
    name: "sparkline",
    title: "Sparkline — smooth + min/max + last",
    svg: charts.sparkline({
      data: [4, 7, 2, 9, 5, 12, 8, 15, 11, 18, 14, 20, 17, 22, 19],
      showMinMax: true,
      showLast: true,
      width: 160,
      height: 32,
    }),
  },
  {
    name: "sparkline-area",
    title: "Sparkline — smooth stroke + gradient fade-to-transparent (dashboard tile)",
    svg: charts.sparkline({
      data: [72, 74, 73, 76, 78, 77, 80, 79, 82, 84, 83, 86, 85, 88, 87],
      area: true,
      smooth: true,
      width: 240,
      height: 56,
    }),
  },
  {
    name: "gauge",
    title: "Gauge — radial KPI with thresholds",
    svg: charts.gauge({
      value: 72,
      min: 0,
      max: 100,
      label: "CPU usage",
      unit: "%",
      thresholds: [
        { value: 80, color: "#10b981" },
        { value: 90, color: "#f59e0b" },
        { value: 100, color: "#ef4444" },
      ],
      width: 300,
      height: 190,
    }),
  },
  {
    name: "bar-gauge",
    title: "Bar gauge — compact service metrics",
    svg: charts.barGauge({
      data: [
        { label: "API latency", value: 63, unit: "ms", max: 120 },
        { label: "DB connections", value: 82, unit: "%" },
        { label: "Queue depth", value: 24, unit: "%" },
        { label: "Disk usage", value: 91, unit: "%" },
      ],
      thresholds: [
        { value: 70, color: "#10b981" },
        { value: 88, color: "#f59e0b" },
        { value: 100, color: "#ef4444" },
      ],
      width: 420,
    }),
  },
  {
    name: "stat",
    title: "Stat — large value + delta + sparkline",
    svg: charts.stat({
      label: "Requests / min",
      value: 12482,
      delta: 8.4,
      deltaFormat: (v) => `${v}%`,
      sparkline: [8420, 9100, 9800, 10300, 9900, 11100, 11800, 11400, 12482],
      width: 300,
      height: 150,
    }),
  },
  {
    name: "heatmap",
    title: "Heatmap — latency buckets over time",
    svg: charts.heatmap({
      data: [
        { x: "00", y: "p95", value: 26 },
        { x: "04", y: "p95", value: 34 },
        { x: "08", y: "p95", value: 58 },
        { x: "12", y: "p95", value: 89 },
        { x: "16", y: "p95", value: 94 },
        { x: "20", y: "p95", value: 42 },
        { x: "00", y: "p75", value: 18 },
        { x: "04", y: "p75", value: 22 },
        { x: "08", y: "p75", value: 39 },
        { x: "12", y: "p75", value: 62 },
        { x: "16", y: "p75", value: 70 },
        { x: "20", y: "p75", value: 27 },
        { x: "00", y: "p50", value: 9 },
        { x: "04", y: "p50", value: 12 },
        { x: "08", y: "p50", value: 19 },
        { x: "12", y: "p50", value: 34 },
        { x: "16", y: "p50", value: 38 },
        { x: "20", y: "p50", value: 14 },
      ],
      yLabels: ["p95", "p75", "p50"],
      showValues: true,
      width: 460,
      height: 230,
    }),
  },
  {
    name: "map-status",
    title: "Map — global service health by region",
    svg: charts.map({
      title: "Edge network health",
      subtitle: "Live regions",
      series: [
        {
          label: "Healthy",
          data: [
            { latitude: 37.7749, longitude: -122.4194, label: "San Francisco" },
            { latitude: 40.7128, longitude: -74.006, label: "New York" },
            { latitude: -23.5505, longitude: -46.6333, label: "São Paulo" },
            { latitude: 52.52, longitude: 13.405, label: "Berlin" },
            { latitude: 1.3521, longitude: 103.8198, label: "Singapore" },
            { latitude: -33.8688, longitude: 151.2093, label: "Sydney" },
          ],
        },
        {
          label: "Degraded",
          data: [
            { latitude: 19.4326, longitude: -99.1332, label: "Mexico City" },
            { latitude: -1.2921, longitude: 36.8219, label: "Nairobi" },
            { latitude: 35.6762, longitude: 139.6503, label: "Tokyo" },
          ],
        },
        {
          label: "Down",
          data: [
            { latitude: 25.2048, longitude: 55.2708, label: "Dubai" },
          ],
        },
      ],
      legend: true,
      width: 640,
      height: 350,
    }),
  },
  {
    name: "map-volume",
    title: "Map — traffic volume encoded as bubble size",
    svg: charts.map({
      title: "Requests by point of presence",
      series: [
        {
          label: "Requests",
          data: [
            { latitude: 47.6062, longitude: -122.3321, label: "Seattle · 42k", size: 42 },
            { latitude: 41.8781, longitude: -87.6298, label: "Chicago · 68k", size: 68 },
            { latitude: 51.5072, longitude: -0.1276, label: "London · 112k", size: 112 },
            { latitude: 50.1109, longitude: 8.6821, label: "Frankfurt · 146k", size: 146 },
            { latitude: 19.076, longitude: 72.8777, label: "Mumbai · 91k", size: 91 },
            { latitude: 22.3193, longitude: 114.1694, label: "Hong Kong · 74k", size: 74 },
            { latitude: -33.9249, longitude: 18.4241, label: "Cape Town · 28k", size: 28 },
            { latitude: -34.6037, longitude: -58.3816, label: "Buenos Aires · 35k", size: 35 },
          ],
        },
      ],
      sizeRange: [3, 13],
      width: 640,
      height: 320,
    }),
  },
  {
    name: "map-compact",
    title: "Map — deterministic Europe viewport",
    svg: charts.map({
      series: [
        {
          data: [
            { latitude: 59.3293, longitude: 18.0686, label: "Stockholm" },
            { latitude: 52.52, longitude: 13.405, label: "Berlin" },
            { latitude: 48.8566, longitude: 2.3522, label: "Paris" },
            { latitude: 38.7223, longitude: -9.1393, label: "Lisbon" },
            { latitude: 37.9838, longitude: 23.7275, label: "Athens" },
          ],
        },
      ],
      viewport: { latitude: 50, longitude: 10, zoom: 2 },
      width: 420,
      height: 220,
      className: "compact-map",
    }),
  },
  {
    name: "state-timeline",
    title: "State timeline — service health regions",
    svg: charts.stateTimeline({
      rows: [
        {
          label: "API",
          intervals: [
            { from: 0, to: 6, state: "ok" },
            { from: 6, to: 8, state: "warn" },
            { from: 8, to: 16, state: "ok" },
            { from: 16, to: 18, state: "down" },
            { from: 18, to: 24, state: "ok" },
          ],
        },
        {
          label: "Worker",
          intervals: [
            { from: 0, to: 14, state: "ok" },
            { from: 14, to: 20, state: "warn" },
            { from: 20, to: 24, state: "ok" },
          ],
        },
        {
          label: "DB",
          intervals: [{ from: 0, to: 24, state: "ok" }],
        },
      ],
      states: [
        { state: "ok", label: "OK", color: "#10b981" },
        { state: "warn", label: "Warn", color: "#f59e0b" },
        { state: "down", label: "Down", color: "#ef4444" },
      ],
      xAxis: { label: "hours", format: (v) => `${v}:00` },
      width: 560,
      height: 190,
    }),
  },
  {
    name: "histogram",
    title: "Histogram — gaussian sample (n=1000)",
    svg: charts.histogram({
      title: "Reaction times",
      xAxis: { label: "ms" },
      yAxis: { label: "Count" },
      data: Array.from({ length: 1000 }, () => gauss(50, 15)),
      bins: 30,
    }),
  },
  {
    name: "boxplot",
    title: "Box plot — distribution per group",
    svg: charts.boxplot({
      title: "Score distribution by class",
      yAxis: { label: "Score" },
      groups: ["A", "B", "C", "D", "E"].map((label, i) => ({
        label,
        values: Array.from({ length: 50 }, () => {
          const base = 50 + i * 5;
          return (
            base +
            (Math.random() - 0.5) * 20 +
            (Math.random() < 0.05 ? (Math.random() - 0.5) * 80 : 0)
          );
        }),
      })),
      colorByBox: true,
    }),
  },
];

await mkdir(OUT_DIR, { recursive: true });
for (const c of cases) {
  await writeFile(join(OUT_DIR, `${c.name}.svg`), c.svg);
}

// HTML --------------------------------------------------------------------

const card = (c: Case, idPrefix = ""): string => `
  <figure id="${idPrefix}${c.name}">
    <figcaption>${c.title}</figcaption>
    <div class="svg-wrap">${c.svg}</div>
  </figure>`.trim();

const themedSubset: Case[] = cases.filter((c) =>
  ["line", "bar-multicolor", "donut", "scatter", "gauge", "bar-gauge", "stat", "heatmap", "map-status", "map-volume", "state-timeline"].includes(c.name),
);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>stdlib charts — visual review</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
      margin: 0;
      padding: 32px;
      background: #f9fafb;
      color: #111827;
    }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 32px 0 12px; font-size: 16px; opacity: 0.8; font-weight: 600; }
    p.lead { color: #6b7280; margin: 0 0 16px; max-width: 720px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
      gap: 16px;
    }
    figure {
      background: white;
      border-radius: 8px;
      padding: 14px 14px 18px;
      margin: 0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    figcaption {
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 8px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .svg-wrap svg { display: block; width: 100%; height: auto; }
    .compact-map { --stdlib-chart-map-land-opacity: 0.2; }
    section.theme-dark {
      background: #111827;
      color: #f3f4f6;
      padding: 24px;
      border-radius: 12px;
      margin-top: 32px;
    }
    section.theme-dark figure { background: #1f2937; box-shadow: none; }
    section.theme-dark figcaption { color: #9ca3af; }
    section.theme-custom {
      padding: 24px;
      border-radius: 12px;
      margin-top: 32px;
      background: #fff7ed;
      --stdlib-chart-c1: #f43f5e;
      --stdlib-chart-c2: #f97316;
      --stdlib-chart-c3: #eab308;
      --stdlib-chart-c4: #22c55e;
      --stdlib-chart-c5: #06b6d4;
      --stdlib-chart-c6: #6366f1;
      --stdlib-chart-c7: #a855f7;
      --stdlib-chart-c8: #ec4899;
    }
  </style>
</head>
<body>
  <h1>stdlib charts</h1>
  <p class="lead">Every chart type and feature in one grid. SVGs are inlined so theme overrides (currentColor, --stdlib-chart-c1..c8) apply.</p>

  <div class="grid">
${cases.map((c) => card(c)).join("\n")}
  </div>

  <section class="theme-dark">
    <h2>Dark theme — parent sets <code>color: #f3f4f6</code></h2>
    <p class="lead" style="color: #9ca3af">Axes and tick labels use <code>currentColor</code>, so they pick up the parent's color.</p>
    <div class="grid">
${themedSubset.map((c) => card(c, "dark-")).join("\n")}
    </div>
  </section>

  <section class="theme-custom">
    <h2>Custom palette — overridden <code>--stdlib-chart-c1</code> through <code>-c8</code></h2>
    <p class="lead">Sunset palette via CSS custom properties. No JS, no rebuild.</p>
    <div class="grid">
${themedSubset.map((c) => card(c, "custom-")).join("\n")}
    </div>
  </section>
</body>
</html>`;

await writeFile(join(OUT_DIR, "index.html"), html);

console.log(`Wrote ${cases.length} SVGs + index.html to ${OUT_DIR}`);
console.log(`Open: file://${join(OUT_DIR, "index.html")}`);
