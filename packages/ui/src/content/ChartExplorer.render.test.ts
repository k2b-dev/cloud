import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

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
  });
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
