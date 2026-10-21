import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Chart } = await import("./Chart");

const series = [
  {
    label: "Visits",
    data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin" }],
  },
];

describe("Chart map interaction SSR", () => {
  test("renders interactive controls and the initial viewport on the server", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "map",
        series,
        interactive: true,
        viewport: { latitude: 52.52, longitude: 13.405, zoom: 2 },
      }),
    );

    expect(html).toContain('aria-label="Interactive map"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Reset map view"');
    expect(html).toContain("stdlib-chart-map-viewport");
  });

  test("inspects maps without enabling navigation controls", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "map",
        series,
      }),
    );

    expect(html).toContain('aria-label="Interactive map"');
    expect(html).toContain("data-chart-datum=");
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("data-drag=");
    expect(html).not.toContain("k2b-chart__controls");
    expect(html).not.toContain('aria-label="Zoom in"');
    expect(html).toContain("stdlib-chart-map-viewport");
  });
});

describe("Chart state timeline SSR", () => {
  const rows = [
    {
      label: "Notifications recovery",
      href: "/admin/observability/jobs?source=notifications",
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

  test("renders links, tooltip data and timeline controls on the server", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "stateTimeline",
        rows,
        domain: [0, 100],
        states: [{ state: "ok", label: "Succeeded", color: "#10b981" }],
        interactive: true,
      }),
    );

    expect(html).toContain('aria-label="Interactive timeline"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Reset timeline view"');
    expect(html).toContain('data-chart-tooltip="Succeeded in 22 ms"');
    expect(html).toContain("/admin/observability/jobs?run=trace%3Aspan");
  });

  test("inspects timelines without enabling navigation controls", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "stateTimeline",
        rows,
      }),
    );

    expect(html).toContain('aria-label="Interactive timeline"');
    expect(html).toContain("data-chart-datum=");
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("data-drag=");
    expect(html).not.toContain("k2b-chart__controls");
    expect(html).not.toContain('aria-label="Zoom in"');
  });
});

describe("Chart line interaction SSR", () => {
  test("exposes one keyboard-focusable chart without map or timeline controls", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "line",
        series: [
          {
            label: "Errors",
            data: [
              { x: 1, y: 2 },
              { x: 2, y: 3 },
            ],
          },
        ],
        interactive: true,
      }),
    );

    expect(html).toContain('aria-label="Interactive line chart"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('aria-label="Zoom in"');
    expect(html).toContain('role="tooltip"');
  });
});

describe("Chart presentation hooks", () => {
  test("carries the drag, crosshair and empty affordances as package classes", () => {
    const draggable = renderToString(() => createComponent(Chart, { kind: "map", series, interactive: true }));
    const crosshair = renderToString(() =>
      createComponent(Chart, {
        kind: "line",
        series: [{ label: "Errors", data: [{ x: 1, y: 2 }] }],
        interactive: true,
      }),
    );
    const empty = renderToString(() => createComponent(Chart, { kind: "line", series: [] }));

    // Cloud spells these as `cursor-grab` / `cursor-crosshair` utilities; the
    // package moves them to data attributes so no Tailwind scan is required.
    expect(draggable).toContain('data-drag="idle"');
    expect(draggable).toContain("k2b-chart__controls");
    expect(draggable).toContain("k2b-chart__svg");
    expect(crosshair).toContain('data-crosshair="true"');
    expect(crosshair).toContain("k2b-chart__anchor");
    expect(crosshair).toContain("k2b-tooltip");
    expect(empty).toContain("k2b-chart__empty");
    expect(empty).toContain("No data");
    expect(empty).not.toContain("text-dimmed");
  });
});

describe("Chart default inspection SSR", () => {
  for (const options of [
    { kind: "bar", data: [{ label: "Imports", value: 42 }] },
    { kind: "sparkline", data: [12, 24, 18] },
    { kind: "stat", label: "Requests", value: 42 },
  ] satisfies import("./Chart").ChartProps[]) {
    test(`${options.kind} is inspectable without interactive`, () => {
      const html = renderToString(() => createComponent(Chart, options));
      expect(html).toContain("data-chart-datum=");
      expect(html).toContain('tabindex="0"');
      expect(html).toContain('role="group"');
      expect(html).toContain('data-interactive="true"');
      expect(html).toContain('role="tooltip"');
      expect(html).toContain('popover="manual"');
      expect(html).toContain('data-instant="true"');
      expect(html).toContain('class="k2b-chart__anchor"');
      expect(html).toContain('aria-label="');
      const marks = [...html.matchAll(/<g data-chart-role="[^"]*" data-chart-datum="[^"]*">([\s\S]*?)<\/g>/g)];
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) expect(mark[1]).toMatch(/^<title>[^<]+<\/title>/);
      if (options.kind === "stat") expect(html).toContain('aria-label="Requests"');
    });
  }

  test("explicit false still inspects a line and exposes its crosshair", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "line",
        series: [{ data: [{ x: 1, y: 2 }] }],
        interactive: false,
      }),
    );
    expect(html).toContain('data-crosshair="true"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("data-chart-datum=");
  });

  test("names prefer the kind override, then nonblank title, then value label, then default", () => {
    const bar = { kind: "bar" } as const;
    const data = [{ label: "Imports", value: 42 }];
    const render = (options: import("./Chart").ChartProps) => renderToString(() => createComponent(Chart, options));
    expect(render({ ...bar, data, title: "Queue jobs" })).toContain('aria-label="Queue jobs"');
    expect(render({ ...bar, data, title: "Queue jobs", labels: { interactiveChart: "Import queues" } })).toContain(
      'aria-label="Import queues"',
    );
    expect(render({ kind: "stat", label: "Requests", value: 42, title: "Traffic" })).toContain('aria-label="Traffic"');
    expect(render({ kind: "gauge", value: 42, label: "Capacity", title: "  " })).toContain('aria-label="Capacity"');
    expect(render({ ...bar, data, title: "  " })).not.toContain("aria-description=");
    expect(render({ ...bar, data, title: "Queue jobs" })).toContain("aria-description=");
    expect(render({ kind: "map", series, labels: { interactiveMap: "Visitors" } })).toContain('aria-label="Visitors"');
    expect(
      render({
        kind: "stateTimeline",
        rows: [{ label: "Worker", intervals: [{ from: 0, to: 1, state: "ok" }] }],
        labels: { interactiveTimeline: "Worker history" },
      }),
    ).toContain('aria-label="Worker history"');
    expect(render({ kind: "line", series: [{ data: [{ x: 1, y: 2 }] }], labels: { interactiveLine: "Latency" } })).toContain(
      'aria-label="Latency"',
    );
  });

  test("empty charts have no inspection or accessible group", () => {
    const html = renderToString(() => createComponent(Chart, { kind: "bar", data: [], interactive: true }));
    expect(html).toContain("No data");
    expect(html).not.toContain("tabindex=");
    expect(html).not.toContain('role="tooltip"');
    expect(html).not.toContain("aria-label=");
    expect(html).not.toContain('role="group"');
  });

  test("StatCell names its inspectable trend after the cell", async () => {
    const { StatCell } = await import("../surfaces/StatCell");
    const html = renderToString(() => createComponent(StatCell, { label: "Requests", value: 42, trend: [12, 24, 18] }));
    expect(html).toContain('data-chart-kind="sparkline"');
    expect(html).toContain('aria-label="Requests"');
    expect(html).toContain('role="tooltip"');
  });
});

describe("Line chart top legend", () => {
  const series = [
    { label: "", data: [] },
    {
      label: "Orders <total>",
      data: [
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ],
    },
  ];
  test("keeps every original index and escapes names, without the bottom legend", () => {
    const html = renderToString(() =>
      createComponent(Chart, {
        kind: "line",
        series,
        legend: true,
        legendPlacement: "top-start",
        className: "report-palette",
        style: { height: "200px" },
      }),
    );
    expect(html).toContain('data-legend-placement="top-start"');
    expect(html).toContain('class="stdlib-chart k2b-chart__legend-swatch report-palette"');
    expect(html).toContain("height:200px");
    expect(html).toContain("Series 1");
    expect(html).toContain("Orders &lt;total>");
    expect(html).toContain('class="stdlib-chart-series-1"');
    expect(html).not.toContain('class="stdlib-chart-legend"');
    expect(html.indexOf("k2b-chart__legend-item")).toBeLessThan(html.indexOf('class="k2b-chart__svg"'));
  });
  test("preserves opt-out, default callers and empty states", () => {
    const render = (options: import("./Chart").ChartProps) => renderToString(() => createComponent(Chart, options));
    expect(render({ kind: "line", series, legend: true })).toContain('class="stdlib-chart-legend"');
    expect(render({ kind: "line", series, legend: false, legendPlacement: "top-start" })).not.toContain("k2b-chart__legend-item");
    expect(render({ kind: "line", series: [], legend: true, legendPlacement: "top-start" })).toContain("k2b-chart__empty");
    expect(render({ kind: "line", series: [], legend: true, legendPlacement: "top-start" })).not.toContain("k2b-chart__legend-item");
  });
});
