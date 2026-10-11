import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ChartExplorerProps, ChartLegendEntry } from "./ChartExplorer";
import type { DataTableProps } from "./DataTable";

const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-explorer-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { prepareChartSnapshot } = await import("./chart-snapshot");
const { ChartExplorer } = await import("./ChartExplorer");

const rows = [{ key: "exports", label: 'Exports & "files"', value: 28 }];
const chart = () =>
  prepareChartSnapshot(
    { kind: "bar", data: rows, colorByBar: true },
    {
      key: ({ datum }) => rows[datum.index]!.key,
      tooltip: ({ datum }) => ({ title: datum.label, rows: [{ label: "Completed jobs", value: "28" }] }),
    },
  );
describe("SSR chart exploration", () => {
  test("prepares escaped metadata, stable keys and formatted text without browser APIs", () => {
    const snapshot = chart();
    expect(snapshot.marks[0]?.key).toBe("exports");
    expect(snapshot.marks[0]?.datum.label).toBe(rows[0]!.label);
    expect(snapshot.marks[0]?.tooltip.rows[0]?.label).toBe("Completed jobs");
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.svg).toContain("Completed jobs: 28</title>");
    expect(snapshot.svg).not.toContain(" · value: 28</title>");
    expect(() =>
      prepareChartSnapshot({ kind: "bar", data: [...rows, ...rows] }, { key: () => "same", tooltip: () => ({ rows: [] }) }),
    ).toThrow("unique");
  });
  test("renders the complete SVG, named slider and controls on the server", () => {
    const html = renderToString(() =>
      createComponent(ChartExplorer, {
        title: "Queues",
        selectedKey: "exports",
        data: { chart: chart(), rows },
        columns: [{ id: "label", label: "Queue", value: (row: (typeof rows)[number]) => row.label }],
      }),
    );
    expect(html).toContain('viewBox="0 0 480 280"');
    expect(html).toContain("height:18rem");
    expect(html).toContain("data-chart-datum");
    expect(html).toContain('aria-label="Copy data"');
    expect(html).toContain("data-selected");
    expect(html).toContain("--k2b-chart-selection-color:");
    expect(html).toMatch(/<h3 [^>]*class="k2b-chart-explorer__title ?"[^>]*>Queues<\/h3>/);
  });
  test("a chart below another heading takes the next heading level", () => {
    const html = renderToString(() =>
      createComponent(ChartExplorer, {
        title: "Queues",
        headingLevel: 4 as const,
        data: { chart: chart(), rows },
        columns: [{ id: "label", label: "Queue", value: (row: (typeof rows)[number]) => row.label }],
      }),
    );
    expect(html).toMatch(/<h4 [^>]*class="k2b-chart-explorer__title ?"[^>]*>Queues<\/h4>/);
    expect(html).not.toContain("<h3");
  });
});

test("a legend wraps below the chart inside the fixed viewport and leaves with the table", () => {
  const legend: ChartLegendEntry[] = [
    { label: "Frontend & <api>", color: 0 },
    { label: "Last year", color: 9, style: "dashed", reference: true },
  ];
  const render = (view: "chart" | "table") =>
    renderToString(() =>
      createComponent(ChartExplorer, {
        title: "Latency",
        view,
        height: "12rem",
        data: { chart: chart(), rows },
        columns: [{ id: "label", label: "Queue", value: (row: (typeof rows)[number]) => row.label }],
        legend,
      }),
    );
  const html = render("chart");
  expect(html).toContain('data-legend="true"');
  expect(html).toContain("height:12rem");
  expect(html).toContain('aria-label="Legend"');
  expect(html).toContain("Frontend &amp; &lt;api>");
  // Palette indices wrap like the renderer's eight series colors.
  expect(html).toContain("var(--stdlib-chart-c2)");
  expect(html).toContain('data-style="dashed"');
  expect(render("table")).not.toContain("k2b-chart-legend");
});

test("reference glyphs and linked controls are present in the server output", async () => {
  const { ChartExplorerControls } = await import("./ChartExplorerControls");
  const { createChartExplorer } = await import("./chart-explorer");
  const reference = prepareChartSnapshot(
    { kind: "bar", data: [{ label: "A", value: 3, colorIndex: 1 }], colorByBar: true },
    {
      key: () => "a:reference",
      rowKey: () => "a",
      tooltip: () => ({ title: "Reference 08:00", rows: [] }),
      reference: () => true,
    },
  );
  expect(reference.marks[0]?.reference).toBe(true);
  expect(reference.svg).toContain('data-chart-reference="true"');
  expect(reference.svg).toContain("--k2b-chart-reference-color:var(--stdlib-chart-c2)");
  const request = { step: "17", referenceStep: "08", visibleKeys: ["a"] };
  const initial = { request, charts: { a: { chart: reference, rows: [{ key: "a" }] } } };
  const html = renderToString(() => {
    const group = createChartExplorer({ snapshot: () => initial, load: async () => initial });
    return createComponent(ChartExplorerControls, {
      explorer: group,
      title: "Analysis",
      steps: [
        { key: "08", label: "08:00" },
        { key: "17", label: "17:00" },
      ],
    });
  });
  expect(html).toContain('aria-label="Remove comparison: 08:00"');
  expect(html).toContain("Current");
  expect(html).toContain('aria-valuetext="17:00"');
});

test("bar gauge snapshots include every row beyond the default chart height", () => {
  const data = Array.from({ length: 12 }, (_, index) => ({ label: `Row ${index}`, value: index }));
  const snapshot = prepareChartSnapshot(
    { kind: "barGauge", data, min: 0, max: 12 },
    {
      key: ({ datum }) => String(datum.index),
      tooltip: ({ datum }) => ({ rows: [{ label: "Value", value: String(datum.index) }] }),
    },
  );
  expect(snapshot.height).toBe(366);
  expect(snapshot.marks).toHaveLength(12);
  expect(snapshot.marks.every((mark) => mark.datum.anchor[1] < snapshot.height)).toBe(true);
});

test("sortable table headers use the DataTable markers and accessible sort state", () => {
  const html = renderToString(() =>
    createComponent(ChartExplorer<(typeof rows)[number]>, {
      title: "Queues",
      data: { chart: chart(), rows },
      defaultView: "table",
      defaultSort: { key: "label", direction: "asc" },
      columns: [
        {
          id: "label",
          label: "Queue",
          value: (row: (typeof rows)[number]) => row.label,
          sortValue: (row: (typeof rows)[number]) => row.label,
        },
        {
          id: "value",
          label: "Value",
          value: (row: (typeof rows)[number]) => String(row.value),
          sortValue: (row: (typeof rows)[number]) => row.value,
        },
      ],
    }),
  );
  const headers = html.match(/<th\b[^>]*>[\s\S]*?<\/th>/g) ?? [];
  expect(headers).toHaveLength(2);
  expect(headers[0]).toContain('aria-sort="ascending"');
  expect(headers[0]).toContain('class="k2b-data-table__sort-icon ti ti-arrow-up"');
  expect(headers[0]).toContain('data-active="true"');
  expect(headers[1]).toContain('aria-sort="none"');
  expect(headers[1]).toContain('class="k2b-data-table__sort-icon ti ti-arrow-down"');
  expect(headers[1]).not.toContain("data-active");
  expect(html).not.toMatch(/[↑↓↕]/);
});

test("empty explorers retain the header and height with caller-owned feedback", () => {
  const html = renderToString(() =>
    createComponent(ChartExplorer, {
      title: "Loading results",
      height: "18rem",
      empty: "View unavailable",
      data: { chart: { kind: "bar", svg: "", width: 480, height: 280, marks: [], stretch: true }, rows: [] },
      columns: [{ id: "n", label: "Count", value: () => "" }],
    } satisfies ChartExplorerProps<{ key: string }>),
  );
  expect(html).toContain("Loading results");
  expect(html).toContain("View unavailable");
  expect(html).toContain("height:18rem");
});

test("DataTable renders keyboard-accessible client sort buttons and retains server sort links", async () => {
  const { default: DataTable } = await import("./DataTable");
  const table = (links: boolean) =>
    renderToString(() =>
      createComponent(DataTable, {
        rows: [{ id: "1", n: 1 }],
        columns: [{ id: "n", header: "Count", value: "n", sortable: true }],
        sort: { key: "n", direction: "asc" },
        onSortChange: () => {},
        ...(links ? { sortHref: () => "?sort=n" } : {}),
      } satisfies DataTableProps<{ id: string; n: number }>),
    );
  expect(table(false)).toContain('<button type="button" class="k2b-data-table__header-content k2b-data-table__sort"');
  expect(table(false)).toContain('aria-sort="ascending"');
  expect(table(true)).toContain('<a href="?sort=n"');
  expect(table(true)).not.toContain('<button type="button" class="k2b-data-table__header-content');
});
