import { expect, test } from "bun:test";
import type { ChartProps } from "../content/Chart";

/** Shared fictional inputs for entry-point, renderer and hydration parity. */
export const chartFixtures = {
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
} satisfies { [K in ChartProps["kind"]]: Extract<ChartProps, { kind: K }> };

test("every chart fixture has its matching discriminator", () => {
  for (const [kind, spec] of Object.entries(chartFixtures)) expect(String(spec.kind)).toBe(kind);
});
