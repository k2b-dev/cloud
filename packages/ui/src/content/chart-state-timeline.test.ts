import { describe, expect, test } from "bun:test";
import {
  normalizeStateTimelineViewport,
  panStateTimelineViewport,
  renderStateTimelineSvg,
  stateTimelineDomain,
  stateTimelineHeight,
  zoomStateTimelineViewport,
} from "./chart-state-timeline";

const rows = [
  {
    label: "A job with a descriptive source label",
    href: "/admin/observability/jobs?source=a",
    intervals: [
      {
        from: 20,
        to: 22,
        state: "ok",
        href: "/admin/observability/jobs?run=trace%3Aspan",
        tooltip: "Succeeded in 22 ms",
      },
    ],
  },
];

describe("state timeline viewport", () => {
  test("uses an explicit domain instead of shrinking to the data", () => {
    expect(stateTimelineDomain(rows, [0, 100])).toEqual([0, 100]);
  });

  test("keeps zoom and pan bounded by the full domain", () => {
    const zoomed = zoomStateTimelineViewport([0, 100], [0, 100], 1);
    expect(zoomed[1] - zoomed[0]).toBeLessThan(100);
    expect(panStateTimelineViewport(zoomed, [0, 100], 10_000, 500)[0]).toBe(0);
    expect(normalizeStateTimelineViewport([-50, 150], [0, 100])).toEqual([0, 100]);
  });
});

describe("state timeline rendering", () => {
  test("renders safe links, tooltips, semantic colors and the full label in a title", () => {
    const svg = renderStateTimelineSvg({
      width: 800,
      height: stateTimelineHeight(1),
      rows,
      domain: [0, 100],
      states: [{ state: "ok", label: "Succeeded", color: "#10b981" }],
      legend: true,
    });

    expect(svg).toContain('href="/admin/observability/jobs?source=a"');
    expect(svg).toContain('href="/admin/observability/jobs?run=trace%3Aspan"');
    expect(svg).toContain('data-chart-tooltip="Succeeded in 22 ms"');
    expect(svg).toContain('fill="#10b981"');
    expect(svg).toContain("<title>A job with a descriptive source label</title>");
  });

  test("rejects executable links", () => {
    const svg = renderStateTimelineSvg({
      width: 800,
      height: 160,
      rows: [{ ...rows[0]!, href: "javascript:alert(1)" }],
    });
    expect(svg).not.toContain("javascript:");
  });
});

describe("state timeline over instants (timeAxis)", () => {
  // a day in Berlin: 26 November 2026, 00:00 to 24:00 local time (UTC+1)
  const dayStart = Date.UTC(2026, 10, 25, 23);
  const at = (hours: number, minutes = 0) => dayStart + hours * 3_600_000 + minutes * 60_000;
  const day = (extra: Record<string, unknown> = {}) =>
    renderStateTimelineSvg({
      width: 480,
      height: stateTimelineHeight(1, false),
      domain: [dayStart, at(24)],
      legend: false,
      interactive: true,
      states: [{ state: "ok", label: "Erfolgreich", color: "#10b981" }],
      rows: [
        {
          label: "Morgenbericht",
          intervals: [
            { from: at(7), to: at(7) + 4_000, state: "ok" },
            { from: at(9), to: at(10, 30), state: "ok" },
            { from: at(12), to: at(12, 12), state: "ok" },
          ],
        },
      ],
      timeAxis: { timeZone: "Europe/Berlin", locale: "de" },
      ...extra,
    });
  const tickLabels = (svg: string) =>
    [...svg.matchAll(/<text class="stdlib-chart-heatmap-label"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  const datum = (svg: string, nth: number) =>
    JSON.parse(([...svg.matchAll(/data-chart-datum="([^"]*)"/g)][nth]?.[1] ?? "{}").replaceAll("&quot;", '"')) as {
      values: { key: string; value: unknown; formatted?: string }[];
    };
  const field = (svg: string, nth: number, key: string) => datum(svg, nth).values.find((value) => value.key === key)?.formatted;

  test("the axis of a day steps in hours on the zone's wall clock, 24 hours in German, the day at midnight", () => {
    expect(tickLabels(day())).toEqual(["26. Nov.", "06:00", "12:00", "18:00", "27. Nov."]);
  });

  test("a run's duration has its unit, and its start and end are clock times", () => {
    const svg = day();
    expect(field(svg, 0, "duration")).toBe("4 s");
    expect(field(svg, 1, "duration")).toBe("1 h 30 min");
    expect(field(svg, 2, "duration")).toBe("12 min");
    expect(field(svg, 0, "from")).toBe("07:00");
    expect(field(svg, 1, "to")).toBe("10:30");
  });

  test("the page's own format still labels the axis and the times", () => {
    const svg = day({ xAxis: { format: (value: number) => `t${(value - dayStart) / 3_600_000}` } });
    expect(tickLabels(svg)).toEqual(["t0", "t6", "t12", "t18", "t24"]);
    expect(field(svg, 0, "from")).toBe("t7");
    expect(field(svg, 0, "duration")).toBe("4 s");
  });
});
