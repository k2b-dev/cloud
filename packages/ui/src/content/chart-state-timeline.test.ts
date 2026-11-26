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

describe("state timeline: now, runs of seconds, planned runs", () => {
  const DAY = 86_400_000;
  // a day of an assistant's runs: one of four seconds at 08:00, one planned at 18:00; the page passes "now" (14:00)
  const day = (extra: Record<string, unknown> = {}) =>
    renderStateTimelineSvg({
      width: 480,
      height: stateTimelineHeight(1, false),
      domain: [0, DAY],
      legend: false,
      states: [
        { state: "ok", label: "Erfolgreich", color: "#10b981" },
        { state: "scheduled", label: "Geplant" },
      ],
      rows: [
        {
          label: "Morgenbericht",
          intervals: [
            { from: 8 * 3_600_000, to: 8 * 3_600_000 + 4_000, state: "ok", href: "/app/assistant/runs/r1", tooltip: "08:00, 4 s" },
            { from: 18 * 3_600_000, to: 18 * 3_600_000 + 60_000, state: "scheduled", planned: true, tooltip: "18:00" },
          ],
        },
      ],
      nowLabel: "Jetzt",
      plannedLabel: "geplant",
      ...extra,
    });
  const attribute = (tag: string, name: string) => Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]);
  const rect = (svg: string, nth: number) => [...svg.matchAll(/<rect class="stdlib-chart-state-region[^>]*>/g)][nth]?.[0] ?? "";

  test("a run of seconds is at least 3 units wide, centred on its start, and keeps its link and hint", () => {
    const svg = day();
    const run = rect(svg, 0);
    const start = attribute(run, "x") + attribute(run, "width") / 2;
    expect(attribute(run, "width")).toBe(3);
    // 08:00 on the plot: the plot starts after the lane's name (6.3 units a letter and 20 of air) and ends 16 units
    // before the right edge
    const plotLeft = "Morgenbericht".length * 6.3 + 20;
    expect(Math.abs(start - (plotLeft + (8 / 24) * (464 - plotLeft)))).toBeLessThan(0.01);
    expect(svg).toContain('href="/app/assistant/runs/r1"');
    expect(svg).toContain('data-chart-tooltip="08:00, 4 s"');
  });

  test("now is a thin line over the lanes with its word, where the page says; outside the day there is none", () => {
    const svg = day({ now: 14 * 3_600_000 });
    expect(svg).toMatch(/<line class="stdlib-chart-state-now"/);
    expect(svg).toMatch(/<text class="[^"]*stdlib-chart-state-now-label"[^>]*>Jetzt<\/text>/);
    expect(day({ now: 2 * DAY })).not.toContain("stdlib-chart-state-now");
    // no clock of its own: without `now` there is no line
    expect(day()).not.toContain("stdlib-chart-state-now");
  });

  test("a planned run is an outline in its state's colour, not filled, and says so to assistive technology", () => {
    const svg = day();
    const planned = rect(svg, 1);
    expect(planned).toContain("data-planned");
    expect(planned).toContain('stroke-dasharray="3 2"');
    expect(planned).toContain('style="stroke:var(--stdlib-chart-c2)"');
    expect(planned).toContain('fill-opacity="0.12"');
    expect(svg).toContain('aria-label="Morgenbericht, Geplant, geplant"');
    // the run that happened stays filled
    expect(rect(svg, 0)).not.toContain("data-planned");
  });
});
