import type { ChartProps } from "../../src/content/Chart";

/** Shared fictional inputs for entry-point, renderer and hydration parity. */
export const chartFixtures = {
  waterfall: {
    kind: "waterfall",
    start: { label: "Opening", value: 10 },
    steps: [{ label: "Receipts", value: 5 }],
    end: { label: "Closing" },
  },
  area: { kind: "area", layout: "stacked", x: ["Jan", "Feb"], series: [{ label: "Sales", data: [3, 4] }] },
  line: {
    kind: "line",
    series: [
      {
        label: "Visits",
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 5 },
        ],
      },
    ],
    smooth: true,
  },
  bar: { kind: "bar", data: [{ label: "Imports", value: 4 }] },
  hbar: { kind: "hbar", series: ["Visits"], rows: [{ label: "Mail", values: [42] }] },
  funnel: {
    kind: "funnel",
    data: [
      { label: "Visit", value: 42 },
      { label: "Order", value: 15 },
    ],
  },
  pie: {
    kind: "pie",
    data: [
      { label: "Imports", value: 4 },
      { label: "Exports", value: 6 },
    ],
  },
  donut: { kind: "donut", data: [{ label: "Imports", value: 4 }] },
  scatter: { kind: "scatter", series: [{ data: [{ x: 1, y: 2 }] }] },
  sparkline: { kind: "sparkline", data: [2, 3, 1] },
  histogram: { kind: "histogram", data: [1, 2, 3, 4, 5], bins: 3 },
  boxplot: { kind: "boxplot", groups: [{ label: "Queue", values: [1, 2, 3, 4, 12] }] },
  gauge: { kind: "gauge", value: 42 },
  barGauge: { kind: "barGauge", data: [{ label: "Queue", value: 42 }] },
  stat: { kind: "stat", label: "Visits", value: 42, delta: 3, sparkline: [1, 2, 4] },
  heatmap: { kind: "heatmap", data: [{ x: "Mon", y: "Imports", value: 4 }] },
  map: { kind: "map", series: [{ data: [{ latitude: 52, longitude: 13 }] }] },
  stateTimeline: { kind: "stateTimeline", rows: [{ label: "Queue", intervals: [{ from: 1, to: 2, state: "ok" }] }] },
  treemap: { kind: "treemap", groups: ["Products"], data: [{ label: "Chairs", group: "Products", value: 40 }] },
  pareto: { kind: "pareto", labels: ["Current", "Previous"], data: [{ label: "Chairs", value: 40, prev: 30 }] },

  bubble: {
    kind: "bubble",
    groups: ["North"],
    xLabel: "Visits",
    yLabel: "Opens",
    averages: true,
    data: [{ label: "Campaign A", group: "North", x: 20, y: 40, size: 25 }],
  },
  radar: { kind: "radar", axes: ["Quality", "Speed", "Cost"], max: 5, series: [{ label: "Plan A", data: [4, 3, 2] }] },
  balanceFlow: {
    kind: "balanceFlow",
    currency: "EUR",
    periods: [
      {
        label: "October",
        opening: 100,
        inflows: [{ label: "Orders", value: 300 }],
        outflows: [{ label: "Fees", value: 50 }],
        closing: 350,
      },
    ],
  },
  sankey: {
    kind: "sankey",
    nodes: [
      { id: "a", label: "Click" },
      { id: "b", label: "Read" },
    ],
    links: [{ source: "a", target: "b", value: 42 }],
  },
} satisfies { [K in ChartProps["kind"]]: Extract<ChartProps, { kind: K }> };
