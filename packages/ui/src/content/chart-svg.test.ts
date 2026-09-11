import { describe, expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
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
