// Draws every axis kind with values that the float spacing or the tick budget used to keep counting forever.
// termination.test.ts runs this file in a child process with a deadline, so a regression fails instead of hanging.
import { chartTimeStep, chartTimeTicks } from "../../content/chart-time-axis";
import { renderChartSvg } from "./render";
import { extendDomainToNice, stateTimeline } from "./svg";

// One value at 1e17 has a float spacing of 16, so its ±1 padding collapses to a zero range.
const big = 1e17;
const pair = (x: number, y: number) => [{ x, y }];
const cases: Record<string, () => string | number[]> = {
  "line, auto y": () => renderChartSvg({ kind: "line", series: [{ label: "A", data: [...pair(0, big), ...pair(1, big)] }] }, 480, 280),
  "line, nearly equal y": () =>
    renderChartSvg({ kind: "line", series: [{ label: "A", data: [...pair(0, big), ...pair(1, big + 16)] }] }, 480, 280),
  "line, auto x": () => renderChartSvg({ kind: "line", series: [{ label: "A", data: [...pair(big, 1), ...pair(big, 2)] }] }, 480, 280),
  "line, fixed y with a tick target past the budget": () =>
    renderChartSvg({ kind: "line", series: [{ label: "A", data: pair(0, 0.5) }], yAxis: { domain: [0, 1], ticks: 1e9 } }, 480, 280),
  "line, time x": () =>
    renderChartSvg({ kind: "line", series: [{ label: "A", data: pair(big, 1) }], timeAxis: { timeZone: "UTC" } }, 480, 280),
  "scatter, auto x and y": () => renderChartSvg({ kind: "scatter", series: [{ label: "A", data: pair(big, big) }] }, 480, 280),
  "histogram, auto x": () => renderChartSvg({ kind: "histogram", data: [big, big, big] }, 480, 280),
  "boxplot, auto y": () => renderChartSvg({ kind: "boxplot", groups: [{ label: "A", values: [big, big, big] }] }, 480, 280),
  "bar, auto y": () => renderChartSvg({ kind: "bar", data: [{ label: "A", value: -big }] }, 480, 280),
  "bar, fixed y with a tick target past the budget": () =>
    renderChartSvg({ kind: "bar", data: [{ label: "A", value: 0.5 }], yAxis: { domain: [0, 1], ticks: 1e9 } }, 480, 280),
  "state timeline, time x": () =>
    renderChartSvg({ kind: "stateTimeline", rows: [{ label: "A", intervals: [{ from: big, to: big, state: "on" }] }] }, 480, 280),
  "core state timeline, time x": () =>
    stateTimeline({ width: 480, height: 280, rows: [{ label: "A", intervals: [{ from: big, to: big, state: "on" }] }] }),
  "log y": () =>
    renderChartSvg(
      { kind: "line", series: [{ label: "A", data: pair(0, 1) }], yAxis: { scale: "log", domain: [1e-300, 1e300] } },
      480,
      280,
    ),
  "nice ticks, step below the float spacing": () => extendDomainToNice(big, big, 1).ticks,
  "nice ticks, step past the budget": () => extendDomainToNice(0, 1, 1e-9).ticks,
  "nice ticks, negative step": () => extendDomainToNice(0, 10, -1).ticks,
  "time ticks, instants past the Date range": () => chartTimeTicks([big, big + 86_400_000], "UTC", chartTimeStep(86_400_000, 5)),
  "time ticks, a step below the float spacing": () =>
    chartTimeTicks([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)], "UTC", { unit: "hour", size: 1e-20 }),
  "time ticks, a step that repeats one minute": () =>
    chartTimeTicks([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)], "UTC", { unit: "hour", size: 1e-9 }),
  "time ticks, a zero year step": () => chartTimeTicks([Date.UTC(2026, 0, 1), Date.UTC(2036, 0, 1)], "UTC", { unit: "year", size: 0 }),
  "time ticks, a negative step": () => chartTimeTicks([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)], "UTC", { unit: "hour", size: -1 }),
};

for (const [name, draw] of Object.entries(cases)) {
  const result = draw();
  console.log(
    JSON.stringify({ name, ...(typeof result === "string" ? { svg: result.length, nan: /NaN/.test(result) } : { ticks: result }) }),
  );
}
console.log(JSON.stringify({ done: Object.keys(cases).length }));
