import { describe, expect, test } from "bun:test";
import { charts, renderChartSvg } from "../charts/core";
import { responsiveChartSvg, responsiveMapSvg, selectedChartSvg } from "./chart-svg";

describe("responsive SVG presentation", () => {
  test("retains escaped content and geometry while anchoring labels and rotated axes", () => {
    const options = {
      width: 480,
      height: 280,
      series: [
        {
          data: [
            { x: 1, y: 12 },
            { x: 4, y: 42 },
          ],
        },
      ],
      title: '<text x="10" y="20">not markup</text>',
      yAxis: { label: "Requests" },
    };
    const original = charts.line(options);
    const responsive = responsiveChartSvg(original);
    expect(responsive).toContain('viewBox="0 0 480 280"');
    expect(responsive).toContain('preserveAspectRatio="none"');
    expect(responsive.match(/<path\b[^>]*>/g)).toEqual(original.match(/<path\b[^>]*>/g));
    expect(responsive).toContain("&lt;text");
    expect(responsive).toContain(";transform:rotate(-90deg)");
    expect(responsive.match(/style="transform-origin:/g)?.length).toBe(original.match(/<text\b/g)?.length);
  });
});

test("responsive reference labels retain their color and anchor in one style attribute", () => {
  const svg = responsiveChartSvg(
    charts.line({
      series: [
        {
          data: [
            { x: 1, y: 1 },
            { x: 2, y: 5 },
          ],
        },
      ],
      references: [{ value: 3, label: "Target", tone: "success" }],
    }),
  );
  const label = svg.match(/<text class="stdlib-chart-reference-label"[^>]*>/)![0];
  expect(label.match(/style=/g)).toHaveLength(1);
  expect(label).toContain("color:var(--k2b-success-text,#047857);transform-origin:");
});

test("SSR selects every mark of an entity without duplicating reference style attributes", () => {
  const svg =
    '<svg><g data-chart-datum="{&quot;role&quot;:&quot;bar&quot;,&quot;index&quot;:0}"><rect /></g><g style="--reference:green" data-chart-datum="{&quot;role&quot;:&quot;bar&quot;,&quot;index&quot;:1}"><rect /></g></svg>';
  const result = selectedChartSvg(svg, [
    { role: "bar", index: 0 },
    { role: "bar", index: 1 },
  ]);
  expect(result.match(/data-selected/g)).toHaveLength(2);
  const groups = result.match(/<g[^>]*>/g)!;
  for (const group of groups) expect(group.match(/style=/g)).toHaveLength(1);
  expect(groups[1]).toContain("--reference:green;--k2b-chart-selection-color:");
});

test("map viewport fills its CSS box without changing geographic paths or cropping its header", () => {
  const source = charts.map({
    width: 480,
    height: 280,
    title: "Offices",
    subtitle: "Today",
    legend: true,
    inspect: true,
    series: [{ label: "Team", data: [{ latitude: 52, longitude: 13 }] }],
  });
  const svg = responsiveMapSvg(source, 480, 280, { latitude: 0, longitude: 0, zoom: 2 });
  expect(svg.slice(0, svg.indexOf(">"))).not.toContain("viewBox");
  expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  expect(svg).toMatch(/class="stdlib-chart-map-viewport" x="[\d.]+%" y="[\d.]+%" width="[\d.]+%" height="[\d.]+%"/);
  expect(svg).toContain('class="stdlib-chart-title" x="50%"');
  expect(svg.match(/<path[^>]*>/g)).toEqual(source.match(/<path[^>]*>/g));
  expect(svg.match(/data-chart-datum="[^"]*"/g)).toEqual(source.match(/data-chart-datum="[^"]*"/g));
  const overview = responsiveMapSvg(source, 480, 280, { latitude: 0, longitude: 0, zoom: 0 });
  expect(overview).toContain('preserveAspectRatio="xMidYMid meet"');
  expect(overview).toContain("--k2b-map-inverse-scale:calc(max(");
  expect(svg).toContain("scale(4)");
  expect(overview).toContain("scale(1)");
});

// The server paints a selected mark with the colour the browser reads from it: a state or a threshold with its own
// colour, not the series colour of its row or place.
test("SSR selects a mark with its own colour in that colour, as the browser does", () => {
  const timeline = renderChartSvg(
    {
      kind: "stateTimeline",
      rows: [
        { label: "Queue", intervals: [{ from: 0, to: 1, state: "ok" }] },
        { label: "Worker", intervals: [{ from: 1, to: 2, state: "failed" }] },
      ],
      states: [
        { state: "ok", label: "Healthy", color: "#10b981" },
        { state: "failed", label: "Failed", color: "#ef4444" },
      ],
    },
    480,
    200,
  );
  const failed = selectedChartSvg(timeline, { role: "interval", index: 0, seriesIndex: 1 });
  expect(failed).toContain("--k2b-chart-selection-color:color-mix(in srgb,#ef4444 72%");
  const gauge = renderChartSvg(
    {
      kind: "barGauge",
      data: [{ label: "Disk", value: 92 }],
      thresholds: [
        { value: 0, color: "#10b981" },
        { value: 90, color: "#ef4444" },
      ],
    },
    480,
    120,
  );
  const datum = /data-chart-datum="([^"]*)"/.exec(gauge)![1]!.replace(/&quot;/g, '"');
  const { role, index, seriesIndex } = JSON.parse(datum) as { role: string; index: number; seriesIndex?: number };
  expect(selectedChartSvg(gauge, { role, index, seriesIndex })).toContain("--k2b-chart-selection-color:color-mix(in srgb,#ef4444 72%");
});
