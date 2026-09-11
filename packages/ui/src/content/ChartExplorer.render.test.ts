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
        snapshot: { chart: chart(), rows, request: { step: "08", visibleKeys: ["exports"] } },
        steps: [
          { key: "08", label: "08:00" },
          { key: "14", label: "14:00" },
        ],
        columns: [{ id: "label", label: "Queue", value: (row: (typeof rows)[number]) => row.label }],
        getRowKey: (row: (typeof rows)[number]) => row.key,
      }),
    );
    expect(html).toContain('viewBox="0 0 480 280"');
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="08:00"');
    expect(html).toContain("height:18rem");
    expect(html).toContain("data-chart-datum");
    expect(html).toContain("Copy data");
    expect(html).toContain('data-selected style="--k2b-chart-selection-color:');
  });
});
