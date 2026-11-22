import { describe, it, expect } from "bun:test";
import {
  charts,
  scatter,
  line,
  bar,
  pie,
  donut,
  sparkline,
  histogram,
  boxplot,
  gauge,
  barGauge,
  stat,
  heatmap,
  map,
  stateTimeline,
  // helpers
  escapeXml,
  normalizePadding,
  computeDomain,
  niceStep,
  extendDomainToNice,
  mapRange,
  mapLog,
  niceLogTicks,
  linePathD,
  smoothPathD,
  stepPathD,
  arcPathD,
  markerPath,
  linearRegression,
  computeBoxStats,
  autoBin,
  svgRoot,
} from "./charts";

// Counts non-overlapping occurrences of `needle` in `haystack`.
const count = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// =====================================================================
// helpers — pure functions
// =====================================================================

describe("escapeXml", () => {
  it("escapes & < > and quotes", () => {
    expect(escapeXml(`<a href="x">foo & 'bar'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;foo &amp; &#39;bar&#39;&lt;/a&gt;",
    );
  });

  it("returns unchanged text without specials", () => {
    expect(escapeXml("hello world")).toBe("hello world");
  });

  it("escapes ampersand first to avoid double-escaping", () => {
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });
});

describe("normalizePadding", () => {
  it("returns defaults for undefined", () => {
    const p = normalizePadding(undefined);
    expect(p).toEqual({ top: 16, right: 16, bottom: 32, left: 40 });
  });

  it("applies a single number to all four sides", () => {
    expect(normalizePadding(8)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
  });

  it("merges partial objects with defaults", () => {
    expect(normalizePadding({ top: 4, left: 4 })).toEqual({
      top: 4,
      right: 16,
      bottom: 32,
      left: 4,
    });
  });
});

describe("computeDomain", () => {
  it("returns [0, 1] for empty input", () => {
    expect(computeDomain([])).toEqual([0, 1]);
  });

  it("returns [0, 1] when all values are non-finite", () => {
    expect(computeDomain([NaN, Infinity, -Infinity])).toEqual([0, 1]);
  });

  it("filters non-finite values", () => {
    expect(computeDomain([1, NaN, 5, Infinity, 3])).toEqual([1, 5]);
  });

  it("pads ±1 around a single finite value", () => {
    expect(computeDomain([42])).toEqual([41, 43]);
  });

  it("returns min and max for a normal list", () => {
    expect(computeDomain([3, -2, 5, 1])).toEqual([-2, 5]);
  });
});

describe("niceStep", () => {
  it("returns 1 for non-positive range", () => {
    expect(niceStep(0, 5)).toBe(1);
    expect(niceStep(-10, 5)).toBe(1);
  });

  it("picks 1, 2, 5, or 10 within the magnitude band", () => {
    expect(niceStep(10, 5)).toBe(2); // rough = 2 → norm 2 → 2
    expect(niceStep(50, 5)).toBe(10); // rough = 10
    expect(niceStep(100, 5)).toBe(20); // rough = 20 → norm 2 → 2*10
    expect(niceStep(7, 5)).toBe(1); // rough = 1.4 → norm 1.4 (< 1.5) → 1
    expect(niceStep(15, 5)).toBe(5); // rough = 3 → norm 3 (< 7) → 5
  });

  it("scales with magnitude for large ranges", () => {
    // range 1_000_000, target 5 → rough 200_000 → mag 100_000 → norm 2 → 2*100_000
    expect(niceStep(1_000_000, 5)).toBe(200_000);
  });

  it("scales for small ranges", () => {
    // range 0.05, target 5 → rough 0.01 → mag 0.01 → norm 1 → 0.01
    expect(niceStep(0.05, 5)).toBeCloseTo(0.01, 5);
  });
});

describe("extendDomainToNice", () => {
  it("rounds outward to step boundaries", () => {
    const r = extendDomainToNice(3, 17, 5);
    expect(r.domain).toEqual([0, 20]);
    expect(r.ticks).toEqual([0, 5, 10, 15, 20]);
  });

  it("handles negatives", () => {
    const r = extendDomainToNice(-7, 12, 5);
    expect(r.domain).toEqual([-10, 15]);
    expect(r.ticks).toEqual([-10, -5, 0, 5, 10, 15]);
  });

  it("preserves boundaries that already align", () => {
    const r = extendDomainToNice(0, 10, 2);
    expect(r.domain).toEqual([0, 10]);
    expect(r.ticks).toEqual([0, 2, 4, 6, 8, 10]);
  });
});

describe("mapRange", () => {
  it("performs linear mapping", () => {
    expect(mapRange(5, [0, 10], [0, 100])).toBe(50);
    expect(mapRange(0, [0, 10], [0, 100])).toBe(0);
    expect(mapRange(10, [0, 10], [0, 100])).toBe(100);
  });

  it("handles inverted output range (svg y-flip)", () => {
    expect(mapRange(5, [0, 10], [100, 0])).toBe(50);
    expect(mapRange(10, [0, 10], [100, 0])).toBe(0);
    expect(mapRange(0, [0, 10], [100, 0])).toBe(100);
  });

  it("returns midpoint for zero-width input domain", () => {
    expect(mapRange(5, [10, 10], [0, 100])).toBe(50);
  });
});

describe("linePathD", () => {
  it("returns empty string for no points", () => {
    expect(linePathD([])).toBe("");
  });

  it("starts with M and continues with L", () => {
    expect(linePathD([{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 10 }])).toBe(
      "M 0 0 L 10 5 L 20 10",
    );
  });

  it("formats fractional coordinates", () => {
    expect(linePathD([{ x: 1.234, y: 5.678 }, { x: 2.0, y: 3.0 }])).toBe(
      "M 1.23 5.68 L 2 3",
    );
  });
});

describe("arcPathD", () => {
  it("emits a single sector for partial arcs (no inner)", () => {
    const d = arcPathD(50, 50, 40, 0, Math.PI / 2);
    expect(d).toMatch(/^M 50 50 L /);
    expect(count(d, "A")).toBe(1);
  });

  it("emits donut sector with two arcs (outer + inner)", () => {
    const d = arcPathD(50, 50, 40, 0, Math.PI / 2, 20);
    expect(count(d, "A")).toBe(2);
    expect(d).not.toMatch(/^M 50 50 L /);
  });

  it("splits full circle into two 180° arcs", () => {
    const d = arcPathD(50, 50, 40, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);
    expect(count(d, "A")).toBe(2);
  });

  it("splits full donut into two outer + two inner arcs", () => {
    const d = arcPathD(50, 50, 40, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 20);
    expect(count(d, "A")).toBe(4);
  });

  it("uses large-arc-flag 1 when sweep > 180°", () => {
    const d = arcPathD(50, 50, 40, 0, Math.PI * 1.2);
    // Pattern: "A r r 0 1 1 ..." → flag is 1
    expect(d).toMatch(/A 40 40 0 1 1/);
  });

  it("uses large-arc-flag 0 when sweep < 180°", () => {
    const d = arcPathD(50, 50, 40, 0, Math.PI * 0.5);
    expect(d).toMatch(/A 40 40 0 0 1/);
  });
});

// =====================================================================
// svgRoot
// =====================================================================

describe("svgRoot", () => {
  it("emits root svg with viewBox and stdlib-chart class", () => {
    const out = svgRoot({ width: 400, height: 240 }, "<g/>");
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('viewBox="0 0 400 240"');
    expect(out).toContain('class="stdlib-chart"');
    expect(out).toContain("<style>");
    expect(out).toContain("<g/>");
  });

  it("appends user className to root class", () => {
    const out = svgRoot({ width: 1, height: 1, className: "my-chart" }, "");
    expect(out).toContain('class="stdlib-chart my-chart"');
  });

  it("escapes user className", () => {
    const out = svgRoot({ width: 1, height: 1, className: '"x" onload=' }, "");
    expect(out).not.toContain('"x" onload=');
    expect(out).toContain("&quot;x&quot;");
  });

  it("embeds default stylesheet with all 8 series colors", () => {
    const out = svgRoot({ width: 1, height: 1 }, "");
    for (let i = 0; i < 8; i++) {
      expect(out).toContain(`.stdlib-chart-series-${i}`);
      expect(out).toContain(`--stdlib-chart-c${i + 1}`);
    }
  });
});

// =====================================================================
// scatter
// =====================================================================

describe("charts.scatter", () => {
  it("returns valid SVG with correct viewBox", () => {
    const svg = scatter({ series: [{ data: [{ x: 1, y: 2 }] }] });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('viewBox="0 0 400 240"');
    expect(svg).toContain('class="stdlib-chart"');
  });

  it("respects custom width and height", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }] }],
      width: 800,
      height: 400,
    });
    expect(svg).toContain('viewBox="0 0 800 400"');
  });

  it("renders one circle per finite point", () => {
    const svg = scatter({
      series: [{ data: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }],
    });
    expect(count(svg, "<circle")).toBe(3);
  });

  it("filters out non-finite points", () => {
    const svg = scatter({
      series: [
        {
          data: [
            { x: 1, y: 1 },
            { x: NaN, y: 2 },
            { x: 3, y: Infinity },
            { x: 4, y: 4 },
          ],
        },
      ],
    });
    expect(count(svg, "<circle")).toBe(2);
  });

  it("returns empty-state SVG for empty series array", () => {
    const svg = scatter({ series: [] });
    expect(svg).toContain("no data");
    expect(svg).not.toContain("<circle");
  });

  it("returns empty-state SVG when no finite points exist", () => {
    const svg = scatter({ series: [{ data: [{ x: NaN, y: NaN }] }] });
    expect(svg).toContain("no data");
  });

  it("assigns distinct series classes for multi-series", () => {
    const svg = scatter({
      series: [
        { data: [{ x: 1, y: 1 }] },
        { data: [{ x: 2, y: 2 }] },
        { data: [{ x: 3, y: 3 }] },
      ],
    });
    expect(svg).toContain('class="stdlib-chart-series-0"');
    expect(svg).toContain('class="stdlib-chart-series-1"');
    expect(svg).toContain('class="stdlib-chart-series-2"');
  });

  it("applies xAxis.format to tick labels", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }],
      xAxis: { format: (v) => `${v}px` },
    });
    expect(svg).toContain("0px");
    expect(svg).toContain("100px");
  });

  it("applies yAxis.format to tick labels", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }, { x: 0, y: 50 }] }],
      yAxis: { format: (v) => `$${v}` },
    });
    expect(svg).toContain("$0");
    expect(svg).toContain("$50");
  });

  it("renders xAxis label when provided", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }] }],
      xAxis: { label: "Time" },
    });
    expect(svg).toContain(">Time<");
  });

  it("renders yAxis label when provided", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }] }],
      yAxis: { label: "Value" },
    });
    expect(svg).toContain(">Value<");
  });

  it("appends className to root svg", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }] }],
      className: "revenue",
    });
    expect(svg).toContain('class="stdlib-chart revenue"');
  });
});

// =====================================================================
// line
// =====================================================================

describe("charts.line", () => {
  it("renders one path per series", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] },
      ],
    });
    expect(count(svg, '<path class="stdlib-chart-line')).toBe(2);
  });

  it("skips a series with fewer than 2 finite points", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }] },
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      ],
    });
    expect(count(svg, '<path class="stdlib-chart-line')).toBe(1);
  });

  it("returns empty-state SVG when no series have finite data", () => {
    const svg = line({ series: [{ data: [] }] });
    expect(svg).toContain("no data");
  });

  it("sorts points by x before drawing the path", () => {
    const svg = line({
      series: [{ data: [{ x: 5, y: 1 }, { x: 1, y: 1 }, { x: 3, y: 1 }] }],
      smooth: false, // assert via straight-segment count
    });
    const path = /<path class="stdlib-chart-line[^"]*" d="(M[^"]+)"\/>/.exec(svg);
    expect(path).not.toBeNull();
    expect(count(path![1]!, "M")).toBe(1);
    expect(count(path![1]!, "L")).toBe(2);
  });

  it("filters non-finite points within a series", () => {
    const svg = line({
      series: [
        {
          data: [
            { x: 0, y: 0 },
            { x: 1, y: NaN },
            { x: 2, y: 4 },
            { x: 3, y: 9 },
          ],
        },
      ],
      smooth: false,
    });
    // 4 points → 1 NaN filtered → 3 finite → path has M + 2 Ls.
    const path = /<path class="stdlib-chart-line[^"]*" d="(M[^"]+)"\/>/.exec(svg);
    expect(path).not.toBeNull();
    expect(count(path![1]!, "L")).toBe(2);
  });

  it("uses series classes 0..7 cyclically", () => {
    const svg = line({
      series: Array.from({ length: 9 }, (_, i) => ({
        data: [{ x: 0, y: i }, { x: 1, y: i + 1 }],
      })),
    });
    // Series 0 and 8 share class -series-0 (modulo 8)
    expect(count(svg, "stdlib-chart-series-0")).toBeGreaterThanOrEqual(2);
  });

  it("includes axis tick labels", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
    });
    expect(svg).toContain('<text class="stdlib-chart-tick-label"');
  });

  it("renders grid lines for y-axis", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
    });
    expect(svg).toContain('<line class="stdlib-chart-grid"');
  });
});

// =====================================================================
// bar
// =====================================================================

describe("charts.bar", () => {
  it("renders one rect per data item", () => {
    const svg = bar({
      data: [
        { label: "A", value: 10 },
        { label: "B", value: 25 },
        { label: "C", value: 15 },
      ],
    });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBe(3);
  });

  it("renders an x-axis label per bar", () => {
    const svg = bar({
      data: [
        { label: "Q1", value: 120 },
        { label: "Q2", value: 180 },
      ],
    });
    expect(svg).toContain(">Q1<");
    expect(svg).toContain(">Q2<");
  });

  it("includes zero in the y-domain even when all values are positive", () => {
    const svg = bar({
      data: [
        { label: "A", value: 50 },
        { label: "B", value: 80 },
      ],
    });
    // Y-axis tick labels should include 0
    expect(svg).toMatch(/>0</);
  });

  it("includes zero in the y-domain even when all values are negative", () => {
    const svg = bar({
      data: [
        { label: "A", value: -50 },
        { label: "B", value: -80 },
      ],
    });
    expect(svg).toMatch(/>0</);
  });

  it("draws a zero baseline when domain spans positive and negative", () => {
    const svg = bar({
      data: [
        { label: "Profit", value: 50 },
        { label: "Loss", value: -30 },
      ],
    });
    // Two horizontal axis-class lines: x-axis (bottom) and zero baseline.
    expect(count(svg, 'class="stdlib-chart-axis"')).toBeGreaterThanOrEqual(2);
  });

  it("does not crash on empty input", () => {
    const svg = bar({ data: [] });
    expect(svg).toContain("no data");
    expect(svg).not.toContain("<rect class=\"stdlib-chart-bar");
  });

  it("filters non-finite values", () => {
    const svg = bar({
      data: [
        { label: "A", value: 10 },
        { label: "B", value: NaN },
        { label: "C", value: Infinity },
        { label: "D", value: 20 },
      ],
    });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBe(2);
  });

  it("centers a single bar within plot area", () => {
    const svg = bar({ data: [{ label: "only", value: 10 }] });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBe(1);
  });

  it("escapes labels", () => {
    const svg = bar({ data: [{ label: '<script>alert("x")</script>', value: 1 }] });
    expect(svg).not.toContain("<script>alert");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("applies yAxis.format to tick labels", () => {
    const svg = bar({
      data: [{ label: "A", value: 100 }],
      yAxis: { format: (v) => `${v}%` },
    });
    expect(svg).toContain("100%");
    expect(svg).toContain("0%");
  });

  it("renders yAxis label when provided", () => {
    const svg = bar({
      data: [{ label: "A", value: 1 }],
      yAxis: { label: "Revenue" },
    });
    expect(svg).toContain(">Revenue<");
  });
});

// =====================================================================
// pie / donut
// =====================================================================

describe("charts.pie", () => {
  it("uses rounded stroke joins so narrow slices do not create center spikes", () => {
    const svg = pie({
      data: [
        { label: "Big", value: 79 },
        { label: "Small A", value: 9 },
        { label: "Small B", value: 4.2 },
        { label: "Small C", value: 3.7 },
        { label: "Small D", value: 2.3 },
        { label: "Small E", value: 1.5 },
      ],
    });
    expect(svg).toContain(
      ".stdlib-chart-slice { stroke: white; stroke-width: 2; stroke-linejoin: round; }",
    );
  });

  it("renders one path per slice", () => {
    const svg = pie({
      data: [
        { label: "A", value: 30 },
        { label: "B", value: 50 },
        { label: "C", value: 20 },
      ],
    });
    expect(count(svg, '<path class="stdlib-chart-slice')).toBe(3);
  });

  it("uses series classes 0..N for slices", () => {
    const svg = pie({
      data: [
        { label: "A", value: 1 },
        { label: "B", value: 1 },
        { label: "C", value: 1 },
      ],
    });
    expect(svg).toContain("stdlib-chart-series-0");
    expect(svg).toContain("stdlib-chart-series-1");
    expect(svg).toContain("stdlib-chart-series-2");
  });

  it("renders empty-state for empty data", () => {
    const svg = pie({ data: [] });
    expect(svg).toContain("no data");
    expect(svg).not.toContain("<path");
  });

  it("renders empty-state when all values are non-positive", () => {
    const svg = pie({ data: [{ label: "A", value: 0 }, { label: "B", value: -5 }] });
    expect(svg).toContain("no data");
  });

  it("filters non-finite slices", () => {
    const svg = pie({
      data: [
        { label: "A", value: 50 },
        { label: "B", value: NaN },
        { label: "C", value: Infinity },
        { label: "D", value: 25 },
      ],
    });
    expect(count(svg, '<path class="stdlib-chart-slice')).toBe(2);
  });

  it("renders a single 100% slice as a full circle (two arcs)", () => {
    const svg = pie({ data: [{ label: "only", value: 100 }] });
    // One slice path; the path itself contains 2 'A' commands for a full circle.
    const pathMatch = /<path class="stdlib-chart-slice[^"]*" d="([^"]+)"\/>/.exec(svg);
    expect(pathMatch).not.toBeNull();
    expect(count(pathMatch![1]!, "A")).toBe(2);
  });

  it("does not render labels by default", () => {
    const svg = pie({ data: [{ label: "A", value: 1 }] });
    expect(svg).not.toContain('<text class="stdlib-chart-label"');
  });

  it("renders one label per slice when showLabels is true", () => {
    const svg = pie({
      data: [
        { label: "Foo", value: 30 },
        { label: "Bar", value: 70 },
      ],
      showLabels: true,
    });
    expect(count(svg, '<text class="stdlib-chart-label"')).toBe(2);
    expect(svg).toContain("Foo (30%)");
    expect(svg).toContain("Bar (70%)");
  });

  it("escapes label content in XML", () => {
    const svg = pie({
      data: [{ label: '<img onerror=alert(1)>', value: 50 }, { label: "B", value: 50 }],
      showLabels: true,
    });
    expect(svg).not.toContain("<img onerror");
    expect(svg).toContain("&lt;img onerror=alert(1)&gt;");
  });

  it("formats sub-10% percentages with 1 decimal", () => {
    const svg = pie({
      data: [
        { label: "A", value: 5 },
        { label: "B", value: 95 },
      ],
      showLabels: true,
    });
    expect(svg).toContain("(5.0%)");
    expect(svg).toContain("(95%)");
  });

  it("respects custom innerRadius for pie (donut effect)", () => {
    const svg = pie({
      data: [{ label: "A", value: 50 }, { label: "B", value: 50 }],
      innerRadius: 0.5,
    });
    // With innerRadius > 0 each sector path has 2 'A' commands (outer + inner arc).
    const path = /<path class="stdlib-chart-slice[^"]*" d="([^"]+)"\/>/.exec(svg);
    expect(path).not.toBeNull();
    expect(count(path![1]!, "A")).toBe(2);
  });

  it("clamps innerRadius into [0, 0.95]", () => {
    const a = pie({ data: [{ label: "A", value: 1 }], innerRadius: -10 });
    const b = pie({ data: [{ label: "A", value: 1 }], innerRadius: 5 });
    // Both should still render.
    expect(a).toContain("<path class=\"stdlib-chart-slice");
    expect(b).toContain("<path class=\"stdlib-chart-slice");
  });

  it("renders legend with label and percent when legend:true", () => {
    const svg = pie({
      data: [
        { label: "Rent", value: 79 },
        { label: "Other", value: 21 },
      ],
      legend: true,
    });
    expect(svg).toContain("stdlib-chart-legend");
    expect(svg).toContain("Rent (79%)");
    expect(svg).toContain("Other (21%)");
  });

  it("legend off by default — no legend group emitted", () => {
    const svg = pie({
      data: [
        { label: "A", value: 1 },
        { label: "B", value: 1 },
      ],
    });
    // CSS rules for legend classes are always present; what we check is that
    // no actual legend <g> is rendered.
    expect(svg).not.toContain(`<g class="stdlib-chart-legend">`);
  });

  it("formats small slice percentages to 1 decimal in legend", () => {
    const svg = pie({
      data: [
        { label: "Big", value: 95 },
        { label: "Tiny", value: 2.3 },
        { label: "Sliver", value: 2.7 },
      ],
      legend: true,
    });
    expect(svg).toContain("Tiny (2.3%)");
    expect(svg).toContain("Sliver (2.7%)");
    expect(svg).toContain("Big (95%)");
  });

  it("legend reduces pie radius (reserves space below)", () => {
    const w = 400;
    const h = 320;
    const data = [
      { label: "A", value: 50 },
      { label: "B", value: 50 },
    ];
    const noLegend = pie({ data, width: w, height: h });
    const withLegend = pie({ data, width: w, height: h, legend: true });
    // Extract first slice path's radius via the first arc command (A rx ry ...).
    const r = (svg: string): number => {
      const m = / d="M[^A]*A ([\d.]+) /.exec(svg);
      return m ? parseFloat(m[1]!) : -1;
    };
    expect(r(noLegend)).toBeGreaterThan(0);
    expect(r(withLegend)).toBeGreaterThan(0);
    expect(r(withLegend)).toBeLessThan(r(noLegend));
  });
});

describe("charts.donut", () => {
  it("renders donut sectors with both outer and inner arcs", () => {
    const svg = donut({
      data: [
        { label: "A", value: 30 },
        { label: "B", value: 70 },
      ],
    });
    const path = /<path class="stdlib-chart-slice[^"]*" d="([^"]+)"\/>/.exec(svg);
    expect(path).not.toBeNull();
    // Donut sector: outer arc + inner arc reverse → 2 'A' commands per slice.
    expect(count(path![1]!, "A")).toBe(2);
  });

  it("uses pie() with innerRadius 0.6 by default", () => {
    const a = donut({ data: [{ label: "A", value: 1 }] });
    const b = pie({ data: [{ label: "A", value: 1 }], innerRadius: 0.6 });
    expect(a).toBe(b);
  });

  it("respects explicit innerRadius override", () => {
    const a = donut({ data: [{ label: "A", value: 1 }], innerRadius: 0.3 });
    const b = pie({ data: [{ label: "A", value: 1 }], innerRadius: 0.3 });
    expect(a).toBe(b);
  });

  it("supports legend option (same as pie)", () => {
    const svg = donut({
      data: [
        { label: "Used", value: 67 },
        { label: "Free", value: 33 },
      ],
      legend: true,
    });
    expect(svg).toContain("stdlib-chart-legend");
    expect(svg).toContain("Used (67%)");
    expect(svg).toContain("Free (33%)");
  });
});

// =====================================================================
// CSS specificity: line fill bug regression
// =====================================================================

describe("CSS rule order — series before shape", () => {
  it("line stroke-only — series-N rules emit before shape rules so line's fill: none wins", () => {
    const svg = line({ series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] });
    // The order is: series-0 first, then -line. With same specificity, -line
    // overrides fill since it's later. We assert the lexical order of these
    // selectors in the embedded stylesheet so the regression is caught.
    const seriesIdx = svg.indexOf(".stdlib-chart-series-0 ");
    const lineIdx = svg.indexOf(".stdlib-chart-line ");
    expect(seriesIdx).toBeGreaterThan(0);
    expect(lineIdx).toBeGreaterThan(0);
    expect(seriesIdx).toBeLessThan(lineIdx);
  });

  it("slice/point shape rules also emit after series-N", () => {
    const svg = pie({ data: [{ label: "A", value: 1 }] });
    const seriesIdx = svg.indexOf(".stdlib-chart-series-0 ");
    const sliceIdx = svg.indexOf(".stdlib-chart-slice ");
    expect(seriesIdx).toBeLessThan(sliceIdx);
  });
});

// =====================================================================
// smoothPathD
// =====================================================================

describe("smoothPathD", () => {
  it("returns empty for no points", () => {
    expect(smoothPathD([])).toBe("");
  });

  it("returns just M for a single point", () => {
    expect(smoothPathD([{ x: 1, y: 2 }])).toBe("M 1 2");
  });

  it("falls back to straight line for two points", () => {
    expect(smoothPathD([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe("M 0 0 L 10 5");
  });

  it("emits cubic C commands for 3+ points", () => {
    const d = smoothPathD([{ x: 0, y: 0 }, { x: 5, y: 10 }, { x: 10, y: 0 }]);
    expect(d).toMatch(/^M /);
    expect(d).toContain(" C ");
    // n-1 segments → n-1 C commands.
    expect(d.match(/ C /g)?.length).toBe(2);
  });

  it("never bends backward in x when point spacing is uneven", () => {
    const d = smoothPathD([
      { x: 0, y: 4 },
      { x: 250, y: 10 },
      { x: 267, y: 1 },
      { x: 268, y: 8 },
    ]);
    const segments = [...d.matchAll(/ C (\S+) \S+ (\S+) \S+ (\S+) \S+/g)];
    let startX = 0;

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      const [, cp1Raw, cp2Raw, endRaw] = segment;
      const cp1 = Number(cp1Raw);
      const cp2 = Number(cp2Raw);
      const end = Number(endRaw);
      expect(cp1).toBeGreaterThanOrEqual(startX);
      expect(cp2).toBeGreaterThanOrEqual(cp1);
      expect(end).toBeGreaterThanOrEqual(cp2);
      startX = end;
    }
  });
});

// =====================================================================
// line — smooth option
// =====================================================================

describe("charts.line — smooth", () => {
  it("uses smooth Catmull-Rom curves by default", () => {
    const svg = line({ series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }] }] });
    const path = /<path class="stdlib-chart-line[^"]*" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(path).toContain(" C ");
    expect(path).not.toMatch(/ L /);
  });

  it("uses straight segments when smooth: false", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }] }],
      smooth: false,
    });
    const path = /<path class="stdlib-chart-line[^"]*" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(path).toMatch(/ L /);
    expect(path).not.toContain(" C ");
  });

  it("explicit smooth: true also produces curves", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 4 }] }],
      smooth: true,
    });
    expect(svg).toContain(" C ");
  });
});

// =====================================================================
// scatter — size dimension
// =====================================================================

describe("charts.scatter — size dimension", () => {
  it("uses default radius (3) when no point has a size", () => {
    const svg = scatter({ series: [{ data: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }] });
    expect(svg).toMatch(/<circle [^>]*r="3"/);
  });

  it("scales radius with size when provided", () => {
    const svg = scatter({
      series: [
        {
          data: [
            { x: 1, y: 1, size: 10 },
            { x: 2, y: 2, size: 50 },
            { x: 3, y: 3, size: 100 },
          ],
        },
      ],
    });
    // With default sizeRange [3, 12], the smallest size maps to 3 and the
    // largest to 12. Assert both extremes appear.
    expect(svg).toMatch(/<circle [^>]*r="3"/);
    expect(svg).toMatch(/<circle [^>]*r="12"/);
  });

  it("respects custom sizeRange", () => {
    const svg = scatter({
      series: [
        {
          data: [
            { x: 1, y: 1, size: 10 },
            { x: 2, y: 2, size: 100 },
          ],
        },
      ],
      sizeRange: [5, 25],
    });
    expect(svg).toMatch(/<circle [^>]*r="5"/);
    expect(svg).toMatch(/<circle [^>]*r="25"/);
  });

  it("falls back to mid-range radius for points without size when others have it", () => {
    const svg = scatter({
      series: [
        {
          data: [
            { x: 1, y: 1, size: 10 },
            { x: 2, y: 2 }, // no size
            { x: 3, y: 3, size: 100 },
          ],
        },
      ],
      sizeRange: [4, 20],
    });
    // Fallback midpoint = 12.
    expect(svg).toMatch(/<circle [^>]*r="12"/);
  });
});

// =====================================================================
// bar — colorByBar
// =====================================================================

describe("charts.bar — colorByBar", () => {
  it("defaults to single color (all bars use series-0)", () => {
    const svg = bar({
      data: [
        { label: "A", value: 1 },
        { label: "B", value: 2 },
        { label: "C", value: 3 },
      ],
    });
    expect(count(svg, 'class="stdlib-chart-bar stdlib-chart-series-0"')).toBe(3);
    // No bar uses any series class other than -0. Check element-level only,
    // not the embedded stylesheet (which always lists all 8 series rules).
    expect(svg).not.toContain('class="stdlib-chart-bar stdlib-chart-series-1"');
    expect(svg).not.toContain('class="stdlib-chart-bar stdlib-chart-series-2"');
  });

  it("assigns distinct series classes when colorByBar is true", () => {
    const svg = bar({
      data: [
        { label: "A", value: 1 },
        { label: "B", value: 2 },
        { label: "C", value: 3 },
      ],
      colorByBar: true,
    });
    expect(svg).toContain("stdlib-chart-bar stdlib-chart-series-0");
    expect(svg).toContain("stdlib-chart-bar stdlib-chart-series-1");
    expect(svg).toContain("stdlib-chart-bar stdlib-chart-series-2");
  });

  it("cycles series colors mod 8 when colorByBar with > 8 bars", () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      label: String(i),
      value: i + 1,
    }));
    const svg = bar({ data, colorByBar: true });
    // Bar 0 and bar 8 share series-0 (modulo 8).
    expect(count(svg, "stdlib-chart-bar stdlib-chart-series-0")).toBe(2);
  });
});

// =====================================================================
// sparkline
// =====================================================================

describe("charts.sparkline", () => {
  it("renders an svg with the default 80x20 viewBox", () => {
    const svg = sparkline({ data: [1, 2, 3, 4] });
    expect(svg).toContain('viewBox="0 0 80 20"');
  });

  it("respects custom width and height", () => {
    const svg = sparkline({ data: [1, 2, 3], width: 200, height: 40 });
    expect(svg).toContain('viewBox="0 0 200 40"');
  });

  it("renders a stdlib-chart-sparkline path", () => {
    const svg = sparkline({ data: [1, 2, 3, 4, 5] });
    expect(svg).toContain('<path class="stdlib-chart-sparkline"');
  });

  it("auto-x bare numbers to their index", () => {
    const svg = sparkline({ data: [10, 20, 10], smooth: false });
    const path = /<path class="stdlib-chart-sparkline" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(path).toMatch(/^M /);
    expect(path).toContain(" L ");
  });

  it("accepts Point[] input as well", () => {
    const a = sparkline({ data: [10, 20, 30] });
    const b = sparkline({
      data: [
        { x: 0, y: 10 },
        { x: 1, y: 20 },
        { x: 2, y: 30 },
      ],
    });
    expect(a).toBe(b);
  });

  it("filters non-finite values", () => {
    const svg = sparkline({ data: [10, NaN, 30, Infinity, 50], smooth: false });
    // 5 entries, 2 dropped → 3 valid → path has M + 2 L
    const path = /<path class="stdlib-chart-sparkline" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(count(path, "L")).toBe(2);
  });

  it("renders empty svg with stable size for too-few-points", () => {
    const svg = sparkline({ data: [] });
    expect(svg).toContain('viewBox="0 0 80 20"');
    expect(svg).not.toContain("<path");
  });

  it("uses smooth curves by default", () => {
    const svg = sparkline({ data: [1, 5, 3, 7, 2] });
    const path = /<path class="stdlib-chart-sparkline" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(path).toContain(" C ");
  });

  it("uses straight segments when smooth: false", () => {
    const svg = sparkline({ data: [1, 5, 3, 7, 2], smooth: false });
    const path = /<path class="stdlib-chart-sparkline" d="([^"]+)"\/>/.exec(svg)![1]!;
    expect(path).toMatch(/ L /);
    expect(path).not.toContain(" C ");
  });

  it("renders last-point dot when showLast: true", () => {
    const svg = sparkline({ data: [1, 2, 3], showLast: true });
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-last"');
  });

  it("does not render last-point dot by default", () => {
    const svg = sparkline({ data: [1, 2, 3] });
    // Check for the element, not the CSS rule (which always exists in styles).
    expect(svg).not.toContain('<circle class="stdlib-chart-sparkline-last"');
  });

  it("appends className to root svg", () => {
    const svg = sparkline({ data: [1, 2], className: "trend-up" });
    expect(svg).toContain('class="stdlib-chart trend-up"');
  });
});

// =====================================================================
// title + subtitle (header)
// =====================================================================

describe("charts header (title + subtitle)", () => {
  it("renders title text when title is provided", () => {
    const svg = bar({ data: [{ label: "A", value: 1 }], title: "Q4 Revenue" });
    expect(svg).toContain('<text class="stdlib-chart-title"');
    expect(svg).toContain(">Q4 Revenue<");
  });

  it("renders subtitle text when subtitle is provided", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      subtitle: "in EUR",
    });
    expect(svg).toContain('<text class="stdlib-chart-subtitle"');
    expect(svg).toContain(">in EUR<");
  });

  it("renders both with title above subtitle", () => {
    const svg = bar({
      data: [{ label: "A", value: 1 }],
      title: "Top",
      subtitle: "Bottom",
    });
    const titleY = /<text class="stdlib-chart-title"[^>]*y="([0-9.]+)"/.exec(svg);
    const subY = /<text class="stdlib-chart-subtitle"[^>]*y="([0-9.]+)"/.exec(svg);
    expect(titleY).not.toBeNull();
    expect(subY).not.toBeNull();
    expect(parseFloat(titleY![1]!)).toBeLessThan(parseFloat(subY![1]!));
  });

  it("does not render header elements when neither prop given", () => {
    const svg = bar({ data: [{ label: "A", value: 1 }] });
    expect(svg).not.toContain('<text class="stdlib-chart-title"');
    expect(svg).not.toContain('<text class="stdlib-chart-subtitle"');
  });

  it("XML-escapes title and subtitle", () => {
    const svg = bar({
      data: [{ label: "A", value: 1 }],
      title: '<script>alert("x")</script>',
      subtitle: "& others",
    });
    expect(svg).not.toContain("<script>alert");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("&amp; others");
  });

  it("works on scatter, line, bar, pie, donut", () => {
    expect(scatter({ series: [{ data: [{ x: 0, y: 0 }] }], title: "S" })).toContain(">S<");
    expect(line({ series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }], title: "L" })).toContain(">L<");
    expect(bar({ data: [{ label: "x", value: 1 }], title: "B" })).toContain(">B<");
    expect(pie({ data: [{ label: "A", value: 1 }], title: "P" })).toContain(">P<");
    expect(donut({ data: [{ label: "A", value: 1 }], title: "D" })).toContain(">D<");
  });

  it("shifts plot content down to make room for header", () => {
    const without = bar({ data: [{ label: "A", value: 10 }] });
    const withHeader = bar({ data: [{ label: "A", value: 10 }], title: "Title" });
    const rectWithout = /<rect class="stdlib-chart-bar[^"]*" [^>]*y="([0-9.]+)"/.exec(without);
    const rectWith = /<rect class="stdlib-chart-bar[^"]*" [^>]*y="([0-9.]+)"/.exec(withHeader);
    expect(rectWithout).not.toBeNull();
    expect(rectWith).not.toBeNull();
    expect(parseFloat(rectWith![1]!)).toBeGreaterThan(parseFloat(rectWithout![1]!));
  });

  it("pie center shifts down to accommodate header", () => {
    // Both should render full circles. Compare the M command's y coord (start
    // of the first arc) — with header it should be lower (larger y).
    const a = pie({ data: [{ label: "All", value: 1 }] });
    const b = pie({ data: [{ label: "All", value: 1 }], title: "T" });
    const yA = parseFloat(/<path class="stdlib-chart-slice[^"]*" d="M [0-9.]+ ([0-9.]+)/.exec(a)![1]!);
    const yB = parseFloat(/<path class="stdlib-chart-slice[^"]*" d="M [0-9.]+ ([0-9.]+)/.exec(b)![1]!);
    expect(yB).toBeGreaterThan(yA);
  });
});

// =====================================================================
// reference lines
// =====================================================================

describe("charts reference lines", () => {
  it("renders a horizontal reference line for axis: y (default)", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 50 }],
    });
    expect(svg).toContain('<line class="stdlib-chart-reference"');
  });

  it("default axis is y", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 50 }],
    });
    // Horizontal: y1 == y2 in the line attribute.
    const ref = /<line class="stdlib-chart-reference" x1="([0-9.]+)" y1="([0-9.]+)" x2="([0-9.]+)" y2="([0-9.]+)"\/>/.exec(svg);
    expect(ref).not.toBeNull();
    expect(ref![2]).toBe(ref![4]);
  });

  it("renders a vertical reference line for axis: x", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 5, axis: "x" }],
    });
    const ref = /<line class="stdlib-chart-reference" x1="([0-9.]+)" y1="([0-9.]+)" x2="([0-9.]+)" y2="([0-9.]+)"\/>/.exec(svg);
    expect(ref).not.toBeNull();
    expect(ref![1]).toBe(ref![3]);
  });

  it("renders a label when provided", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 50, label: "Target" }],
    });
    expect(svg).toContain('<text class="stdlib-chart-reference-label"');
    expect(svg).toContain(">Target<");
  });

  it("skips reference lines outside the y-domain", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 9999 }],
    });
    expect(svg).not.toContain('<line class="stdlib-chart-reference"');
  });

  it("skips reference lines outside the x-domain", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 9999, axis: "x" }],
    });
    expect(svg).not.toContain('<line class="stdlib-chart-reference"');
  });

  it("renders multiple references", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 30 }, { value: 70 }],
    });
    expect(count(svg, '<line class="stdlib-chart-reference"')).toBe(2);
  });

  it("works on scatter", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }, { x: 10, y: 100 }] }],
      references: [{ value: 50 }],
    });
    expect(svg).toContain('<line class="stdlib-chart-reference"');
  });

  it("works on bar (y-axis only)", () => {
    const svg = bar({
      data: [{ label: "A", value: 100 }, { label: "B", value: 200 }],
      references: [{ value: 150, label: "Target" }],
    });
    expect(svg).toContain('<line class="stdlib-chart-reference"');
    expect(svg).toContain(">Target<");
  });

  it("ignores x-axis references on bar (x is categorical)", () => {
    const svg = bar({
      data: [{ label: "A", value: 100 }],
      references: [{ value: 5, axis: "x" }],
    });
    expect(svg).not.toContain('<line class="stdlib-chart-reference"');
  });

  it("XML-escapes reference label", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 10 }] }],
      references: [{ value: 5, label: '<img onerror="x">' }],
    });
    expect(svg).not.toContain("<img onerror");
    expect(svg).toContain("&lt;img");
  });

  it("filters non-finite reference values", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 10 }] }],
      references: [{ value: NaN }, { value: Infinity }, { value: 5, label: "OK" }],
    });
    expect(count(svg, '<line class="stdlib-chart-reference"')).toBe(1);
    expect(svg).toContain(">OK<");
  });
});

// =====================================================================
// sparkline area
// =====================================================================

describe("charts.sparkline — area", () => {
  it("renders BOTH the stroke line and the area fill when area: true", () => {
    const svg = sparkline({ data: [3, 7, 5, 9, 12, 10, 14], area: true });
    expect(svg).toContain('<path class="stdlib-chart-sparkline"');
    expect(svg).toContain('<path class="stdlib-chart-sparkline-area"');
  });

  it("renders a stroke line and no area path when area is false/undefined", () => {
    const svg = sparkline({ data: [3, 7, 5, 9, 12] });
    expect(svg).toContain('<path class="stdlib-chart-sparkline"');
    expect(svg).not.toContain('<path class="stdlib-chart-sparkline-area"');
    expect(svg).not.toContain("<linearGradient");
  });

  it("emits a linearGradient fading from translucent to transparent", () => {
    const svg = sparkline({ data: [1, 5, 2, 6], area: true });
    // Vertical gradient (top→bottom) with two stops.
    expect(svg).toMatch(/<linearGradient id="[^"]+" x1="0" y1="0" x2="0" y2="1">/);
    expect(svg).toMatch(/stop-color="currentColor" stop-opacity="0\.28"/);
    expect(svg).toContain('stop-opacity="0"');
  });

  it("area fill path references the gradient via url(#...)", () => {
    const svg = sparkline({ data: [1, 5, 2, 6], area: true });
    const gradMatch = /<linearGradient id="([^"]+)"/.exec(svg);
    expect(gradMatch).not.toBeNull();
    const gradId = gradMatch![1]!;
    expect(svg).toContain(`fill="url(#${gradId})"`);
  });

  it("area mode composes with smooth curves", () => {
    const svg = sparkline({ data: [72, 74, 73, 76, 78], area: true, smooth: true });
    const areaPath = /<path class="stdlib-chart-sparkline-area"[^>]* d="([^"]+)"\/>/.exec(svg);
    const strokePath = /<path class="stdlib-chart-sparkline" d="([^"]+)"\/>/.exec(svg);
    expect(areaPath).not.toBeNull();
    expect(strokePath).not.toBeNull();
    expect(areaPath![1]!).toContain(" C ");
    expect(strokePath![1]!).toContain(" C ");
  });

  it("gradient IDs are unique across multiple sparkline calls", () => {
    const a = sparkline({ data: [1, 2, 3], area: true });
    const b = sparkline({ data: [1, 2, 3], area: true });
    const idA = /<linearGradient id="([^"]+)"/.exec(a)![1]!;
    const idB = /<linearGradient id="([^"]+)"/.exec(b)![1]!;
    expect(idA).not.toBe(idB);
  });

  it("area path is closed and extends down to the bottom edge", () => {
    const svg = sparkline({
      data: [1, 5, 2, 6],
      area: true,
      width: 100,
      height: 30,
      smooth: false,
    });
    const path = /<path class="stdlib-chart-sparkline-area"[^>]* d="([^"]+)"\/>/.exec(svg)![1]!;
    // Path ends with two L commands to the bottom and a Z to close.
    expect(path.trim().endsWith("Z")).toBe(true);
    // Bottom-edge y == height (30) — must appear at least twice (last-x + first-x).
    const bottomEdgeCount = (path.match(/ 30(?:\D|$)/g) ?? []).length;
    expect(bottomEdgeCount).toBeGreaterThanOrEqual(2);
  });

  it("area mode still composes with showLast / showMinMax dots", () => {
    const svg = sparkline({
      data: [3, 7, 5, 9, 12, 4, 14],
      area: true,
      showLast: true,
      showMinMax: true,
    });
    expect(svg).toContain('<path class="stdlib-chart-sparkline-area"');
    expect(svg).toContain('<path class="stdlib-chart-sparkline"');
    expect(svg).toContain('class="stdlib-chart-sparkline-last"');
    expect(svg).toContain('class="stdlib-chart-sparkline-max"');
    expect(svg).toContain('class="stdlib-chart-sparkline-min"');
  });

  it("area: false yields identical output to omitting the option", () => {
    const a = sparkline({ data: [1, 2, 3, 4] });
    const b = sparkline({ data: [1, 2, 3, 4], area: false });
    expect(a).toBe(b);
  });
});

// =====================================================================
// sparkline showMinMax
// =====================================================================

describe("charts.sparkline — showMinMax", () => {
  it("renders both min and max dots when showMinMax: true", () => {
    const svg = sparkline({ data: [3, 7, 2, 9, 5, 12, 8], showMinMax: true });
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-max"');
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-min"');
  });

  it("does not render min/max dots by default", () => {
    const svg = sparkline({ data: [1, 2, 3] });
    expect(svg).not.toContain('<circle class="stdlib-chart-sparkline-max"');
    expect(svg).not.toContain('<circle class="stdlib-chart-sparkline-min"');
  });

  it("skips dots when all values are equal", () => {
    const svg = sparkline({ data: [5, 5, 5, 5], showMinMax: true });
    expect(svg).not.toContain('<circle class="stdlib-chart-sparkline-max"');
    expect(svg).not.toContain('<circle class="stdlib-chart-sparkline-min"');
  });

  it("combines with showLast (all three render)", () => {
    const svg = sparkline({ data: [3, 7, 2, 9], showMinMax: true, showLast: true });
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-max"');
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-min"');
    expect(svg).toContain('<circle class="stdlib-chart-sparkline-last"');
  });

  it("max dot positions over the highest value", () => {
    // Data: max is at index 3 (value 9). x-pixel at index 3 with width 80,
    // 1.5 inset → mapRange(3, [0,4], [1.5, 78.5]) ≈ 59.4.
    const svg = sparkline({ data: [1, 2, 3, 9, 4], showMinMax: true });
    const max = /<circle class="stdlib-chart-sparkline-max" cx="([0-9.]+)"/.exec(svg);
    expect(max).not.toBeNull();
    expect(parseFloat(max![1]!)).toBeGreaterThan(40);
    expect(parseFloat(max![1]!)).toBeLessThan(70);
  });
});

// =====================================================================
// bar showValues
// =====================================================================

describe("charts.bar — showValues", () => {
  it("renders one value text per bar when showValues: true", () => {
    const svg = bar({
      data: [{ label: "A", value: 10 }, { label: "B", value: 20 }],
      showValues: true,
    });
    expect(count(svg, '<text class="stdlib-chart-bar-value"')).toBe(2);
  });

  it("does not render value text by default", () => {
    const svg = bar({ data: [{ label: "A", value: 10 }] });
    expect(svg).not.toContain('<text class="stdlib-chart-bar-value"');
  });

  it("uses yAxis.format for value text when provided", () => {
    const svg = bar({
      data: [{ label: "A", value: 100 }],
      showValues: true,
      yAxis: { format: (v) => `${v}%` },
    });
    expect(svg).toContain(">100%<");
  });

  it("places value above bar for positive values", () => {
    const svg = bar({
      data: [{ label: "A", value: 100 }],
      showValues: true,
    });
    const rect = /<rect class="stdlib-chart-bar[^"]*" [^>]*y="([0-9.]+)"/.exec(svg);
    const text = /<text class="stdlib-chart-bar-value" [^>]*y="([0-9.]+)"/.exec(svg);
    expect(rect).not.toBeNull();
    expect(text).not.toBeNull();
    // Text y should be smaller than rect y (above).
    expect(parseFloat(text![1]!)).toBeLessThan(parseFloat(rect![1]!));
  });

  it("places value below bar for negative values", () => {
    const svg = bar({
      data: [{ label: "A", value: -50 }],
      showValues: true,
    });
    const rect = /<rect class="stdlib-chart-bar[^"]*" [^>]*y="([0-9.]+)" width="[0-9.]+" height="([0-9.]+)"/.exec(svg);
    const text = /<text class="stdlib-chart-bar-value" [^>]*y="([0-9.]+)"/.exec(svg);
    expect(rect).not.toBeNull();
    expect(text).not.toBeNull();
    const rectBottom = parseFloat(rect![1]!) + parseFloat(rect![2]!);
    expect(parseFloat(text![1]!)).toBeGreaterThan(rectBottom);
  });

  it("XML-escapes formatted value", () => {
    const svg = bar({
      data: [{ label: "A", value: 1 }],
      showValues: true,
      yAxis: { format: () => '<x>' },
    });
    expect(svg).not.toContain("<x>");
    expect(svg).toContain("&lt;x&gt;");
  });
});

// =====================================================================
// line area
// =====================================================================

describe("charts.line — area", () => {
  it("emits area path in addition to line path when area: true", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }] }],
      area: true,
    });
    expect(svg).toContain('<path class="stdlib-chart-area');
    expect(svg).toContain('<path class="stdlib-chart-line');
  });

  it("does not emit area path by default", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }] }],
    });
    expect(svg).not.toContain('<path class="stdlib-chart-area');
  });

  it("area path is closed with Z", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }] }],
      area: true,
    });
    const areaPath = /<path class="stdlib-chart-area[^"]*" d="([^"]+)"/.exec(svg);
    expect(areaPath).not.toBeNull();
    expect(areaPath![1]).toMatch(/Z\s*$/);
  });

  it("renders one area + one line per series for multi-series", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 5 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 3 }] },
      ],
      area: true,
    });
    expect(count(svg, '<path class="stdlib-chart-area')).toBe(2);
    expect(count(svg, '<path class="stdlib-chart-line')).toBe(2);
  });

  it("works with smooth: true (area path uses C commands)", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }] }],
      area: true,
      smooth: true,
    });
    const areaPath = /<path class="stdlib-chart-area[^"]*" d="([^"]+)"/.exec(svg);
    expect(areaPath).not.toBeNull();
    expect(areaPath![1]!).toContain(" C ");
  });

  it("each area path uses cyclic series classes", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      ],
      area: true,
    });
    expect(svg).toContain('stdlib-chart-area stdlib-chart-series-0');
    expect(svg).toContain('stdlib-chart-area stdlib-chart-series-1');
  });
});

// =====================================================================
// legend
// =====================================================================

describe("charts legend", () => {
  it("renders a legend group when legend: true on multi-series line", () => {
    const svg = line({
      series: [
        { label: "A", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { label: "B", data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      ],
      legend: true,
    });
    expect(svg).toContain('<g class="stdlib-chart-legend">');
    expect(svg).toContain(">A<");
    expect(svg).toContain(">B<");
  });

  it("renders a swatch + label per entry", () => {
    const svg = line({
      series: [
        { label: "A", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { label: "B", data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      ],
      legend: true,
    });
    expect(count(svg, '<rect class="stdlib-chart-legend-swatch"')).toBe(2);
    expect(count(svg, '<text class="stdlib-chart-legend-label"')).toBe(2);
  });

  it("falls back to 'Series N' when no label is set", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
      ],
      legend: true,
    });
    expect(svg).toContain(">Series 1<");
    expect(svg).toContain(">Series 2<");
  });

  it("does not render legend by default", () => {
    const svg = line({
      series: [
        { label: "A", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      ],
    });
    expect(svg).not.toContain('<g class="stdlib-chart-legend">');
  });

  it("works on scatter", () => {
    const svg = scatter({
      series: [
        { label: "Group A", data: [{ x: 0, y: 0 }] },
        { label: "Group B", data: [{ x: 1, y: 1 }] },
      ],
      legend: true,
    });
    expect(svg).toContain('<g class="stdlib-chart-legend">');
    expect(svg).toContain(">Group A<");
  });

  it("works on bar with colorByBar: true", () => {
    const svg = bar({
      data: [
        { label: "Q1", value: 10 },
        { label: "Q2", value: 20 },
      ],
      colorByBar: true,
      legend: true,
    });
    expect(svg).toContain('<g class="stdlib-chart-legend">');
    expect(svg).toContain(">Q1<");
    expect(svg).toContain(">Q2<");
  });

  it("skips legend on bar without colorByBar (single color, redundant)", () => {
    const svg = bar({
      data: [{ label: "Q1", value: 10 }],
      legend: true,
    });
    expect(svg).not.toContain('<g class="stdlib-chart-legend">');
  });

  it("legend entries use cyclic series classes", () => {
    const svg = line({
      series: [
        { label: "A", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { label: "B", data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
        { label: "C", data: [{ x: 0, y: 2 }, { x: 1, y: 3 }] },
      ],
      legend: true,
    });
    expect(svg).toContain('stdlib-chart-legend-item stdlib-chart-series-0');
    expect(svg).toContain('stdlib-chart-legend-item stdlib-chart-series-1');
    expect(svg).toContain('stdlib-chart-legend-item stdlib-chart-series-2');
  });

  it("XML-escapes legend labels", () => {
    const svg = line({
      series: [{ label: '<x>', data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      legend: true,
    });
    expect(svg).not.toContain(">x>"); // would only appear if unescaped
    expect(svg).toContain("&lt;x&gt;");
  });

  it("plot area shrinks vertically to make room for legend", () => {
    const a = line({
      series: [{ label: "S", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    });
    const b = line({
      series: [{ label: "S", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      legend: true,
    });
    // The x-axis line position approximates the bottom of the plot area.
    // Match the *first* axis line (the y-axis is rendered first as a vertical line; the x-axis is the next one; we'll just count y2 of any axis line and look for the lowest y in each).
    const axisYs = (svg: string): number[] => {
      const out: number[] = [];
      const re = /<line class="stdlib-chart-axis"[^>]*y2="([0-9.]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(svg))) out.push(parseFloat(m[1]!));
      return out;
    };
    const aMax = Math.max(...axisYs(a));
    const bMax = Math.max(...axisYs(b));
    expect(bMax).toBeLessThan(aMax);
  });
});

// =====================================================================
// dashboard panels
// =====================================================================

describe("charts.gauge", () => {
  it("renders a radial gauge with value, label, and track/fill paths", () => {
    const svg = gauge({ value: 72, min: 0, max: 100, label: "CPU", unit: "%" });
    expect(svg).toContain('class="stdlib-chart');
    expect(svg).toContain("stdlib-chart-gauge-track");
    expect(svg).toContain("stdlib-chart-gauge-fill");
    expect(svg).toContain("72%");
    expect(svg).toContain(">CPU<");
  });

  it("renders threshold gradients without overlapping segment arcs", () => {
    const svg = gauge({
      value: 85,
      thresholds: [
        { value: 70 },
        { value: 90 },
        { value: 100 },
      ],
    });
    expect(svg).not.toContain("<linearGradient");
    expect(svg).toContain("stdlib-chart-gauge-gradient-segment stdlib-chart-gauge-gradient-scale");
    expect(count(svg, '<path class="stdlib-chart-gauge-gradient-segment stdlib-chart-gauge-gradient-scale')).toBe(72);
    expect(count(svg, '<path class="stdlib-chart-gauge-gradient-segment"')).toBeGreaterThan(50);
    expect(svg).toContain("var(--stdlib-chart-c1)");
    expect(svg).toContain("var(--stdlib-chart-c2)");
    expect(svg).toContain("var(--stdlib-chart-c3)");
  });

  it("escapes labels and supports custom colors as SVG attributes", () => {
    const svg = gauge({
      value: 95,
      label: "<CPU>",
      thresholds: [{ value: 100, color: "#ef4444" }],
    });
    expect(svg).toContain("&lt;CPU&gt;");
    expect(svg).toContain('stroke="#ef4444"');
  });

  it("does not render a needle unless explicitly requested", () => {
    expect(gauge({ value: 72 })).not.toContain('<line class="stdlib-chart-gauge-needle');
    expect(gauge({ value: 72, showNeedle: true })).toContain('<line class="stdlib-chart-gauge-needle');
  });
});

describe("charts.barGauge", () => {
  it("renders one filled bar per finite item", () => {
    const svg = barGauge({
      data: [
        { label: "API", value: 63, unit: "ms" },
        { label: "Disk", value: 91, unit: "%" },
      ],
    });
    expect(count(svg, '<rect class="stdlib-chart-bar-gauge-fill')).toBe(2);
    expect(svg).toContain(">API<");
    expect(svg).toContain("63ms");
  });

  it("renders empty-state text when no finite values exist", () => {
    const svg = barGauge({ data: [{ label: "bad", value: NaN }] });
    expect(svg).toContain("No data");
  });
});

describe("charts.stat", () => {
  it("renders label, value, delta, and sparkline paths", () => {
    const svg = stat({
      label: "Requests / min",
      value: 12482,
      delta: 8.4,
      deltaFormat: (v) => `${v}%`,
      sparkline: [1, 2, 3, 2, 5],
    });
    expect(svg).toContain("Requests / min");
    expect(svg).toContain("12482");
    expect(svg).toContain("+8.4%");
    expect(svg).toContain("stdlib-chart-stat-delta-up");
    expect(svg).toContain("stdlib-chart-stat-sparkline");
  });

  it("marks negative numeric deltas as down", () => {
    const svg = stat({ label: "Errors", value: 12, delta: -3 });
    expect(svg).toContain("stdlib-chart-stat-delta-down");
  });
});

describe("charts.heatmap", () => {
  it("renders one cell per finite data point", () => {
    const svg = heatmap({
      data: [
        { x: "00", y: "p50", value: 10 },
        { x: "04", y: "p50", value: 20 },
        { x: "00", y: "p95", value: 40 },
      ],
    });
    expect(count(svg, '<rect class="stdlib-chart-heatmap-cell')).toBe(3);
    expect(svg).toContain(">00<");
    expect(svg).toContain(">p95<");
  });

  it("supports visible values and escapes labels", () => {
    const svg = heatmap({
      data: [{ x: "<x>", y: "row", value: 7 }],
      showValues: true,
    });
    expect(svg).toContain("&lt;x&gt;");
    expect(svg).toContain(">7<");
  });
});

describe("charts.map", () => {
  it("renders the world land path and one point per valid coordinate", () => {
    const svg = map({
      series: [
        {
          label: "Healthy",
          data: [
            { latitude: 52.52, longitude: 13.405, label: "Berlin" },
            { latitude: 40.7128, longitude: -74.006, label: "New York" },
          ],
        },
      ],
    });
    expect(svg).toContain('class="stdlib-chart-map-land"');
    expect(count(svg, '<circle class="stdlib-chart-map-point')).toBe(2);
    expect(svg).toContain("<title>Berlin</title>");
    expect(svg).toContain("<title>New York</title>");
  });

  it("uses series colors, scales finite sizes, and renders a legend", () => {
    const svg = map({
      series: [
        { label: "Healthy", data: [{ latitude: 0, longitude: 0, size: 10 }] },
        { label: "Down", data: [{ latitude: 10, longitude: 10, size: 100 }] },
      ],
      sizeRange: [2, 10],
      legend: true,
    });
    expect(svg).toContain('stdlib-chart-map-point stdlib-chart-series-0');
    expect(svg).toContain('stdlib-chart-map-point stdlib-chart-series-1');
    expect(svg).toContain('r="2"');
    expect(svg).toContain('r="10"');
    expect(svg).toContain(">Healthy<");
    expect(svg).toContain(">Down<");
  });

  it("filters invalid coordinates while keeping the map and empty state", () => {
    const svg = map({
      series: [
        {
          data: [
            { latitude: 91, longitude: 0 },
            { latitude: 0, longitude: -181 },
            { latitude: NaN, longitude: 0 },
          ],
        },
      ],
    });
    expect(svg).toContain('class="stdlib-chart-map-land"');
    expect(svg).not.toContain('<circle class="stdlib-chart-map-point');
    expect(svg).toContain("No data");
  });

  it("escapes point labels and normalizes a reversed size range", () => {
    const svg = map({
      series: [
        {
          data: [
            { latitude: 0, longitude: 0, size: 1, label: '<node id="1">' },
            { latitude: 1, longitude: 1, size: 2 },
          ],
        },
      ],
      sizeRange: [9, 3],
    });
    expect(svg).toContain("&lt;node id=&quot;1&quot;&gt;");
    expect(svg).toContain('r="3"');
    expect(svg).toContain('r="9"');
  });

  it("renders a deterministic clipped viewport centered on the requested coordinate", () => {
    const options = {
      series: [
        {
          data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin" }],
        },
      ],
      viewport: { latitude: 52.52, longitude: 13.405, zoom: 3 },
    };
    const svg = map(options);

    expect(svg).toBe(map(options));
    expect(svg).toContain(
      '<svg class="stdlib-chart-map-viewport" x="16" y="18" width="608" height="304" viewBox="0 0 608 304" overflow="hidden">',
    );
    expect(svg).toContain('cx="304" cy="152" r="4"');
  });

  it("clamps zoom and center coordinates to the visible world bounds", () => {
    const series = [{ data: [{ latitude: 0, longitude: 0 }] }];
    const clamped = map({
      series,
      viewport: { latitude: 87.1875, longitude: 174.375, zoom: 5 },
    });
    const outside = map({
      series,
      viewport: { latitude: 90, longitude: 180, zoom: 99 },
    });

    expect(outside).toBe(clamped);
  });

  it("falls back to the full-world viewport for non-finite values", () => {
    const series = [{ data: [{ latitude: 0, longitude: 0 }] }];
    const fullWorld = map({ series });
    const invalid = map({
      series,
      viewport: { latitude: NaN, longitude: Number.POSITIVE_INFINITY, zoom: NaN },
    });
    const belowMinimum = map({
      series,
      viewport: { latitude: 45, longitude: 90, zoom: -99 },
    });

    expect(invalid).toBe(fullWorld);
    expect(belowMinimum).toBe(fullWorld);
  });

  it("keeps marker radii fixed while zooming", () => {
    const series = [{ data: [{ latitude: 0, longitude: 0, size: 10 }] }];
    const fullWorld = map({ series, sizeRange: [8, 8] });
    const zoomed = map({
      series,
      sizeRange: [8, 8],
      viewport: { latitude: 0, longitude: 0, zoom: 5 },
    });

    expect(fullWorld).toContain('cx="304" cy="152" r="8"');
    expect(zoomed).toContain('cx="304" cy="152" r="8"');
  });
});

describe("charts.stateTimeline", () => {
  it("renders state regions for intervals", () => {
    const svg = stateTimeline({
      rows: [
        {
          label: "API",
          intervals: [
            { from: 0, to: 4, state: "ok" },
            { from: 4, to: 6, state: "warn" },
          ],
        },
      ],
      states: [{ state: "ok" }, { state: "warn" }],
    });
    expect(count(svg, '<rect class="stdlib-chart-state-region')).toBe(2);
    expect(svg).toContain(">API<");
    expect(svg).toContain("stdlib-chart-legend");
  });

  it("renders empty-state text without rows", () => {
    const svg = stateTimeline({ rows: [] });
    expect(svg).toContain("No data");
  });
});

// =====================================================================
// namespace
// =====================================================================

describe("charts namespace", () => {
  it("exposes all chart functions", () => {
    expect(charts.scatter).toBe(scatter);
    expect(charts.line).toBe(line);
    expect(charts.bar).toBe(bar);
    expect(charts.pie).toBe(pie);
    expect(charts.donut).toBe(donut);
    expect(charts.sparkline).toBe(sparkline);
    expect(charts.histogram).toBe(histogram);
    expect(charts.boxplot).toBe(boxplot);
    expect(charts.gauge).toBe(gauge);
    expect(charts.barGauge).toBe(barGauge);
    expect(charts.stat).toBe(stat);
    expect(charts.heatmap).toBe(heatmap);
    expect(charts.map).toBe(map);
    expect(charts.stateTimeline).toBe(stateTimeline);
  });
});

// =====================================================================
// v0.7 — markers
// =====================================================================

describe("markerPath", () => {
  it("generates a path for each shape", () => {
    for (const shape of ["circle", "square", "triangle", "diamond", "plus", "cross"] as const) {
      const d = markerPath(shape, 50, 50, 5);
      expect(d).toMatch(/^M /);
      expect(d.length).toBeGreaterThan(10);
    }
  });

  it("circle path uses arc commands", () => {
    expect(markerPath("circle", 50, 50, 5)).toContain(" A ");
  });

  it("polygon shapes use line commands and close with Z", () => {
    for (const shape of ["square", "triangle", "diamond", "plus", "cross"] as const) {
      expect(markerPath(shape, 0, 0, 4)).toMatch(/Z\s*$/);
    }
  });
});

describe("charts.scatter — markers", () => {
  it("renders <circle> by default", () => {
    const svg = scatter({ series: [{ data: [{ x: 0, y: 0 }] }] });
    expect(svg).toContain("<circle");
  });

  it("renders <path> for non-circle markers", () => {
    const svg = scatter({
      series: [{ marker: "square", data: [{ x: 0, y: 0 }] }],
    });
    expect(svg).toContain('<path class="stdlib-chart-point"');
  });

  it("autoVariant cycles markers per series", () => {
    const svg = scatter({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
        { data: [{ x: 0, y: 2 }, { x: 1, y: 3 }] },
      ],
      autoVariant: true,
    });
    // First series: circle, second: square, third: triangle. Confirm path-shape diversity.
    expect(svg).toContain("<circle");
    expect(svg).toContain('<path class="stdlib-chart-point"');
  });

  it("explicit marker overrides autoVariant", () => {
    const svg = scatter({
      series: [{ marker: "diamond", data: [{ x: 0, y: 0 }] }],
      autoVariant: true,
    });
    // Diamond shape: M cx cy-r L cx+r cy L cx cy+r L cx-r cy Z
    expect(svg).toContain('<path class="stdlib-chart-point"');
    expect(svg).not.toContain("<circle");
  });
});

// =====================================================================
// v0.7 — line styles
// =====================================================================

describe("charts.line — line styles", () => {
  it("no stroke-dasharray for solid (default)", () => {
    const svg = line({ series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] });
    expect(svg).not.toContain("stroke-dasharray=");
  });

  it("dashed lineStyle adds stroke-dasharray", () => {
    const svg = line({
      series: [{ lineStyle: "dashed", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    });
    expect(svg).toContain('stroke-dasharray="6 4"');
  });

  it("dotted produces a finer dash pattern", () => {
    const svg = line({
      series: [{ lineStyle: "dotted", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    });
    expect(svg).toContain('stroke-dasharray="2 3"');
  });

  it("dashdot produces a compound pattern", () => {
    const svg = line({
      series: [{ lineStyle: "dashdot", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    });
    expect(svg).toContain('stroke-dasharray="6 3 2 3"');
  });

  it("autoVariant cycles dash patterns", () => {
    const svg = line({
      series: [
        { data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        { data: [{ x: 0, y: 1 }, { x: 1, y: 2 }] },
        { data: [{ x: 0, y: 2 }, { x: 1, y: 3 }] },
        { data: [{ x: 0, y: 3 }, { x: 1, y: 4 }] },
      ],
      autoVariant: true,
    });
    // Series 1: solid (no dash), 2: dashed, 3: dotted, 4: dashdot.
    expect(svg).toContain('stroke-dasharray="6 4"');
    expect(svg).toContain('stroke-dasharray="2 3"');
    expect(svg).toContain('stroke-dasharray="6 3 2 3"');
  });
});

// =====================================================================
// v0.7 — log scale + minor ticks
// =====================================================================

describe("mapLog", () => {
  it("maps domain endpoints to range endpoints", () => {
    expect(mapLog(1, [1, 1000], [0, 100])).toBeCloseTo(0, 5);
    expect(mapLog(1000, [1, 1000], [0, 100])).toBeCloseTo(100, 5);
  });

  it("maps decade boundaries proportionally", () => {
    // 10 is one decade above 1, so 1/3 of the [0, 100] range.
    expect(mapLog(10, [1, 1000], [0, 100])).toBeCloseTo(33.33, 1);
  });

  it("returns midpoint for invalid domains", () => {
    expect(mapLog(5, [-1, 10], [0, 100])).toBe(50);
    expect(mapLog(5, [1, 1], [0, 100])).toBe(50);
  });
});

describe("niceLogTicks", () => {
  it("includes decade boundaries enclosing the data", () => {
    const r = niceLogTicks(3, 800);
    expect(r.domain).toEqual([1, 1000]);
    expect(r.ticks).toEqual([1, 10, 100, 1000]);
  });

  it("aligned input keeps the boundaries", () => {
    const r = niceLogTicks(1, 100);
    expect(r.ticks).toEqual([1, 10, 100]);
  });

  it("returns finite ticks for Number.MAX_VALUE without infinite-looping", () => {
    const start = performance.now();
    const r = niceLogTicks(1, Number.MAX_VALUE);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50); // was infinite loop before fix
    expect(r.ticks.length).toBeGreaterThan(0);
    expect(r.ticks.every((t) => Number.isFinite(t))).toBe(true);
  });

  it("clamps to a finite span when given absurd inputs", () => {
    const r = niceLogTicks(1e-100, 1e100);
    expect(r.ticks.every((t) => Number.isFinite(t) && t > 0)).toBe(true);
    expect(r.ticks.length).toBeLessThan(100);
  });
});

describe("autoBin (regression)", () => {
  it("does not OOM on bins: 1e9 — caps internally", () => {
    const r = autoBin([1, 2, 3], 1_000_000_000);
    expect(r.counts.length).toBeLessThan(2000); // capped
  });

  it("falls back to data span for empty edges array", () => {
    const r = autoBin([1, 5, 9], []);
    expect(r.counts.length).toBeGreaterThan(0);
    expect(r.edges.every((e) => Number.isFinite(e))).toBe(true);
  });

  it("does not RangeError on huge inputs", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => i);
    expect(() => autoBin(big, 50)).not.toThrow();
  });
});

describe("scatter — log axis filters non-positive points", () => {
  it("scatter with yAxis.scale: 'log' drops y <= 0 points before rendering", () => {
    const svg = scatter({
      series: [{ data: [{ x: 1, y: 1 }, { x: 2, y: -5 }, { x: 3, y: 100 }] }],
      yAxis: { scale: "log" },
    });
    // Two valid points (y=1, y=100), one filtered (y=-5). Only 2 circles.
    expect(count(svg, "<circle")).toBe(2);
  });
});

describe("line — log axis filters non-positive points", () => {
  it("line with yAxis.scale: 'log' drops y <= 0 points before path", () => {
    const svg = line({
      series: [{ data: [{ x: 1, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 10 }, { x: 4, y: 100 }] }],
      yAxis: { scale: "log" },
    });
    // Path has 3 valid points (y=1,10,100); y=0 filtered.
    const path = /<path class="stdlib-chart-line[^"]*" d="([^"]+)"/.exec(svg)![1]!;
    // Path commands present; coordinates finite.
    expect(path).toMatch(/[ML]/);
    expect(path).not.toContain("Infinity");
    expect(path).not.toContain("NaN");
  });
});

describe("sparkline — preserves index gaps for NaN values", () => {
  it("data: [10, NaN, 30] → 2 valid points at x=0 and x=2 (not 0 and 1)", () => {
    const svg = sparkline({ data: [10, NaN, 30], smooth: false });
    // The sparkline uses an internal x-domain [0,2] so the visible x of the
    // second valid point is at the right edge, NOT the middle.
    const path = /<path class="stdlib-chart-sparkline" d="([^"]+)"/.exec(svg)![1]!;
    // Two L commands: M, L for one segment.
    expect(count(path, " L ")).toBe(1);
    // Last x should be near the right edge (~78.5 for default width 80, inset 1.5).
    const lastL = /L ([0-9.]+) /.exec(path);
    expect(lastL).not.toBeNull();
    expect(parseFloat(lastL![1]!)).toBeGreaterThan(70);
  });
});

describe("charts.line — log scale", () => {
  it("yAxis.scale: log produces tick labels at powers of 10", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 1 }, { x: 1, y: 1000 }] }],
      yAxis: { scale: "log" },
    });
    // Y-axis tick labels at 1, 10, 100, 1000.
    expect(svg).toContain(">1<");
    expect(svg).toContain(">10<");
    expect(svg).toContain(">100<");
    expect(svg).toContain(">1000<");
  });

  it("xAxis.scale: log accepts only positive values", () => {
    const svg = line({
      series: [{ data: [{ x: 0.1, y: 1 }, { x: 100, y: 5 }] }],
      xAxis: { scale: "log" },
    });
    expect(svg).toContain("viewBox");
    // Should not throw on positive xs only.
  });

  it("minorTicks: true produces minor-tick elements", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 100 }] }],
      yAxis: { minorTicks: true },
    });
    expect(svg).toContain('<line class="stdlib-chart-minor-tick"');
  });

  it("minorTicks: false (default) produces no minor-tick elements", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 100 }] }],
    });
    expect(svg).not.toContain('<line class="stdlib-chart-minor-tick"');
  });
});

// =====================================================================
// v0.7 — error bars + error band
// =====================================================================

describe("charts.scatter — error bars", () => {
  it("renders error bar elements for points with errY", () => {
    const svg = scatter({
      series: [{ data: [{ x: 5, y: 10, errY: 2 }] }],
    });
    expect(svg).toContain('<line class="stdlib-chart-errorbar"');
    // Three lines per error bar (vertical + 2 caps).
    expect(count(svg, '<line class="stdlib-chart-errorbar"')).toBe(3);
  });

  it("asymmetric errYHigh/errYLow are honored", () => {
    const svg = scatter({
      series: [{ data: [{ x: 5, y: 10, errYHigh: 5, errYLow: 1 }] }],
    });
    // Three lines (vertical + 2 caps); we just smoke-test render here.
    expect(count(svg, '<line class="stdlib-chart-errorbar"')).toBe(3);
  });

  it("renders horizontal error bars for errX", () => {
    const svg = scatter({
      series: [{ data: [{ x: 5, y: 10, errX: 0.5 }] }],
    });
    // 3 errorbar lines (1 horizontal + 2 vertical caps).
    expect(count(svg, '<line class="stdlib-chart-errorbar"')).toBe(3);
  });

  it("no error bars when no err* fields are set", () => {
    const svg = scatter({ series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] });
    expect(svg).not.toContain('<line class="stdlib-chart-errorbar"');
  });

  it("expands y-domain to include error extents", () => {
    // Without err: y ranges from 0 to 10. With err=10, range expands beyond.
    const a = scatter({ series: [{ data: [{ x: 0, y: 5 }, { x: 1, y: 10 }] }] });
    const b = scatter({ series: [{ data: [{ x: 0, y: 5 }, { x: 1, y: 10, errY: 10 }] }] });
    // The y-axis tick label '20' should appear in b but not a.
    expect(b).toContain(">20<");
    expect(a).not.toMatch(/>20</);
  });
});

describe("charts.line — errorBand", () => {
  it("renders an error-band path when errorBand: true", () => {
    const svg = line({
      series: [
        {
          data: [
            { x: 0, y: 0, errYHigh: 1, errYLow: 1 },
            { x: 1, y: 2, errYHigh: 1, errYLow: 1 },
            { x: 2, y: 1, errYHigh: 1, errYLow: 1 },
          ],
        },
      ],
      errorBand: true,
    });
    expect(svg).toContain('<path class="stdlib-chart-error-band');
  });

  it("error band path is closed with Z", () => {
    const svg = line({
      series: [
        {
          data: [
            { x: 0, y: 0, errY: 1 },
            { x: 1, y: 2, errY: 1 },
          ],
        },
      ],
      errorBand: true,
    });
    const band = /<path class="stdlib-chart-error-band[^"]*" d="([^"]+)"/.exec(svg);
    expect(band).not.toBeNull();
    expect(band![1]).toMatch(/Z\s*$/);
  });

  it("no error band by default", () => {
    const svg = line({
      series: [
        {
          data: [
            { x: 0, y: 0, errY: 1 },
            { x: 1, y: 2, errY: 1 },
          ],
        },
      ],
    });
    expect(svg).not.toContain('<path class="stdlib-chart-error-band');
  });
});

// =====================================================================
// v0.7 — trend line
// =====================================================================

describe("linearRegression", () => {
  it("recovers slope and intercept of a perfect line", () => {
    const r = linearRegression([
      { x: 0, y: 3 },
      { x: 1, y: 5 },
      { x: 2, y: 7 },
      { x: 3, y: 9 },
    ]);
    expect(r).not.toBeNull();
    expect(r!.slope).toBeCloseTo(2, 6);
    expect(r!.intercept).toBeCloseTo(3, 6);
    expect(r!.r2).toBeCloseTo(1, 6);
  });

  it("returns null for fewer than 2 points", () => {
    expect(linearRegression([])).toBeNull();
    expect(linearRegression([{ x: 0, y: 0 }])).toBeNull();
  });

  it("returns null when all x are equal", () => {
    expect(
      linearRegression([
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
      ]),
    ).toBeNull();
  });

  it("computes a meaningful r² for noisy data", () => {
    const r = linearRegression([
      { x: 0, y: 0.1 },
      { x: 1, y: 1.9 },
      { x: 2, y: 4.05 },
      { x: 3, y: 6.1 },
    ]);
    expect(r).not.toBeNull();
    expect(r!.r2).toBeGreaterThan(0.99);
  });
});

describe("charts.scatter — trendline", () => {
  it("renders a trendline when trendline: true", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }] }],
      trendline: true,
    });
    expect(svg).toContain('<line class="stdlib-chart-trendline"');
  });

  it("no trendline by default", () => {
    const svg = scatter({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 2 }] }],
    });
    expect(svg).not.toContain('<line class="stdlib-chart-trendline"');
  });

  it("skips trendline when regression cannot be computed", () => {
    // Single point → regression returns null.
    const svg = scatter({
      series: [{ data: [{ x: 5, y: 5 }] }],
      trendline: true,
    });
    expect(svg).not.toContain('<line class="stdlib-chart-trendline"');
  });
});

// =====================================================================
// v0.7 — step plot
// =====================================================================

describe("stepPathD", () => {
  it("'before' mode: extends horizontally to next x at OLD y, then jumps", () => {
    const d = stepPathD([{ x: 0, y: 0 }, { x: 1, y: 5 }], "before");
    expect(d).toBe("M 0 0 L 1 0 L 1 5");
  });

  it("'after' mode: jumps at current x, then extends horizontally", () => {
    const d = stepPathD([{ x: 0, y: 0 }, { x: 1, y: 5 }], "after");
    expect(d).toBe("M 0 0 L 0 5 L 1 5");
  });

  it("'middle' mode: step at midpoint of x", () => {
    const d = stepPathD([{ x: 0, y: 0 }, { x: 2, y: 5 }], "middle");
    expect(d).toBe("M 0 0 L 1 0 L 1 5 L 2 5");
  });

  it("returns empty for empty input", () => {
    expect(stepPathD([], "before")).toBe("");
  });
});

describe("charts.line — step", () => {
  it("step: 'before' produces only L commands (no smooth C)", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }] }],
      step: "before",
    });
    const path = /<path class="stdlib-chart-line[^"]*" d="([^"]+)"/.exec(svg)![1]!;
    expect(path).toContain(" L ");
    expect(path).not.toContain(" C ");
  });

  it("step takes precedence over smooth", () => {
    const svg = line({
      series: [{ data: [{ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 3 }] }],
      step: "after",
      smooth: true,
    });
    const path = /<path class="stdlib-chart-line[^"]*" d="([^"]+)"/.exec(svg)![1]!;
    expect(path).not.toContain(" C ");
  });
});

// =====================================================================
// v0.7 — histogram
// =====================================================================

describe("autoBin", () => {
  it("uses Sturges' formula by default", () => {
    const r = autoBin([1, 2, 3, 4, 5, 6, 7, 8]);
    // n=8 → ceil(log2(8))+1 = 4 bins
    expect(r.edges.length).toBe(5);
    expect(r.counts.length).toBe(4);
  });

  it("respects explicit bin count", () => {
    const r = autoBin([1, 2, 3, 4, 5], 5);
    expect(r.counts.length).toBe(5);
  });

  it("respects explicit bin edges", () => {
    const r = autoBin([1, 2, 5, 8, 9], [0, 3, 6, 10]);
    expect(r.edges).toEqual([0, 3, 6, 10]);
    expect(r.counts).toEqual([2, 1, 2]);
  });

  it("filters non-finite values", () => {
    const r = autoBin([1, NaN, 5, Infinity, 9], 3);
    expect(r.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("handles empty/all-non-finite input", () => {
    expect(autoBin([])).toEqual({ edges: [0, 1], counts: [0] });
    expect(autoBin([NaN, Infinity])).toEqual({ edges: [0, 1], counts: [0] });
  });
});

describe("charts.histogram", () => {
  it("renders one rect per bin", () => {
    const svg = histogram({ data: [1, 2, 3, 4, 5, 6, 7, 8], bins: 4 });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBe(4);
  });

  it("returns empty-state for empty data", () => {
    const svg = histogram({ data: [] });
    expect(svg).toContain("no data");
  });

  it("respects custom bin count", () => {
    const svg = histogram({ data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bins: 5 });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBe(5);
  });

  it("accepts explicit bin edges", () => {
    const svg = histogram({ data: [1, 5, 5, 9], bins: [0, 4, 8, 10] });
    expect(count(svg, '<rect class="stdlib-chart-bar')).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================
// v0.7 — box plot
// =====================================================================

describe("computeBoxStats", () => {
  it("computes quartiles for known data", () => {
    const r = computeBoxStats([1, 2, 3, 4, 5, 6, 7]);
    expect(r).not.toBeNull();
    expect(r!.q1).toBeCloseTo(2.5, 5);
    expect(r!.q2).toBeCloseTo(4, 5);
    expect(r!.q3).toBeCloseTo(5.5, 5);
  });

  it("identifies outliers beyond 1.5×IQR", () => {
    const r = computeBoxStats([1, 2, 3, 4, 5, 100]);
    expect(r).not.toBeNull();
    expect(r!.outliers).toContain(100);
  });

  it("returns null for empty/all-non-finite input", () => {
    expect(computeBoxStats([])).toBeNull();
    expect(computeBoxStats([NaN, Infinity])).toBeNull();
  });

  it("filters non-finite values", () => {
    const r = computeBoxStats([1, NaN, 3, Infinity, 5]);
    expect(r).not.toBeNull();
    expect(r!.q2).toBe(3);
  });

  it("min and max are the actual data extremes", () => {
    const r = computeBoxStats([1, 2, 3, 4, 100]);
    expect(r!.min).toBe(1);
    expect(r!.max).toBe(100);
  });
});

describe("charts.boxplot", () => {
  it("renders one box per group", () => {
    const svg = boxplot({
      groups: [
        { label: "A", values: [1, 2, 3, 4, 5] },
        { label: "B", values: [3, 4, 5, 6, 7] },
      ],
    });
    expect(count(svg, '<rect class="stdlib-chart-box ')).toBe(2);
  });

  it("renders median line per box", () => {
    const svg = boxplot({
      groups: [{ label: "A", values: [1, 2, 3, 4, 5] }],
    });
    expect(svg).toContain('<line class="stdlib-chart-box-median"');
  });

  it("renders whiskers and caps", () => {
    const svg = boxplot({
      groups: [{ label: "A", values: [1, 2, 3, 4, 5] }],
    });
    expect(svg).toContain('class="stdlib-chart-box-whisker"');
    expect(svg).toContain('class="stdlib-chart-box-cap"');
  });

  it("renders outliers when present (default showOutliers)", () => {
    const svg = boxplot({
      groups: [{ label: "A", values: [1, 2, 3, 4, 5, 100] }],
    });
    expect(svg).toContain('class="stdlib-chart-box-outlier ');
  });

  it("showOutliers: false suppresses outlier dots", () => {
    const svg = boxplot({
      groups: [{ label: "A", values: [1, 2, 3, 4, 5, 100] }],
      showOutliers: false,
    });
    expect(svg).not.toContain('<circle class="stdlib-chart-box-outlier');
  });

  it("returns empty-state for empty groups", () => {
    expect(boxplot({ groups: [] })).toContain("no data");
    expect(boxplot({ groups: [{ label: "A", values: [] }] })).toContain("no data");
  });

  it("renders one tick label per group on x axis", () => {
    const svg = boxplot({
      groups: [
        { label: "Class 1", values: [1, 2, 3] },
        { label: "Class 2", values: [4, 5, 6] },
      ],
    });
    expect(svg).toContain(">Class 1<");
    expect(svg).toContain(">Class 2<");
  });
});
