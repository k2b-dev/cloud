import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";
import type { ChartExplorerData } from "../src/content/chart-explorer";
import type { DataTableSort } from "../src/content/DataTable";
type Row = { key: string; label: string; value: number };
describe("chart explorer presentation", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }
  let dom: ReturnType<typeof createDomTestHarness>,
    Explorer: typeof import("../src/content/ChartExplorer").ChartExplorer,
    prepare: typeof import("../src/content/chart-snapshot").prepareChartSnapshot;
  beforeAll(async () => {
    dom = createDomTestHarness();
    Explorer = (await import("../src/content/ChartExplorer")).ChartExplorer;
    prepare = (await import("../src/content/chart-snapshot")).prepareChartSnapshot;
  });
  afterAll(() => dom.cleanup());
  const tick = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const data = (): ChartExplorerData<Row> => {
    const rows = [
      { key: "a", label: "Imports", value: 42 },
      { key: "b", label: "Exports", value: 28 },
    ];
    const result = {
      rows,
      chart: prepare(
        {
          kind: "bar",
          data: [
            { label: "Current", value: 42 },
            { label: "Reference", value: 30 },
            { label: "Other", value: 28 },
          ],
        },
        {
          key: ({ datum }) => ["a:current", "a:reference", "b:current"][datum.index]!,
          rowKey: ({ datum }) => (datum.index < 2 ? "a" : "b"),
          tooltip: () => ({ rows: [] }),
        },
      ),
    };
    // happy-dom's SVG parser does not handle the renderer's embedded stylesheet.
    result.chart.svg = result.chart.svg.replace(/<style>[\s\S]*?<\/style>/g, "");
    return result;
  };
  const columns = [
    { id: "label", label: "Queue", value: (r: Row) => r.label },
    { id: "value", label: "Jobs", value: (r: Row) => String(r.value), sortValue: (r: Row) => r.value },
  ];
  const button = (text: string) =>
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)!;
  test("one entity selects all its marks and has exactly one table row; sorting and clearing preserve the contract", async () => {
    const dispose = render(() => createComponent(Explorer<Row>, { title: "Queues", data: data(), columns }), dom.root);
    try {
      dom.root.querySelector("[data-chart-datum]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(2);
      expect(dom.root.querySelector(".k2b-chart-explorer__details")?.textContent).toContain("Imports");
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Chart view"]')!.click();
      await tick();
      Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button"))
        .find((b) => b.textContent?.trim() === "Table")!
        .click();
      await tick();
      expect(dom.root.querySelectorAll("tbody .k2b-data-table__row")).toHaveLength(2);
      button("Jobs ↕").click();
      await tick();
      expect(dom.root.querySelector("tbody tr")?.textContent).toContain("Exports");
      expect(dom.root.querySelector('tr[data-selected="true"]')?.textContent).toContain("Imports");
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]')!.click();
      await tick();
      expect(dom.root.querySelector('tr[data-selected="true"]')).toBeNull();
    } finally {
      dispose();
    }
  });
  test("controlled view and sort emit requests without overriding their owner", async () => {
    const [view, setView] = createSignal<"chart" | "table">("table");
    const [sort, setSort] = createSignal<DataTableSort | null>(null);
    const changes: DataTableSort[] = [];
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Queues",
          data: data(),
          columns,
          get view() {
            return view();
          },
          onViewChange: setView,
          get sort() {
            return sort();
          },
          onSortChange: (value) => {
            if (value) changes.push(value);
          },
          selectedKey: "a",
          renderDetails: false,
        }),
      dom.root,
    );
    try {
      expect(dom.root.querySelector("table")).not.toBeNull();
      button("Jobs ↕").click();
      await tick();
      expect(changes).toHaveLength(1);
      expect(dom.root.querySelector("tbody tr")?.textContent).toContain("Imports");
      setSort(changes[0]!);
      await tick();
      expect(dom.root.querySelector("tbody tr")?.textContent).toContain("Exports");
      expect(dom.root.querySelector(".k2b-chart-explorer__details")).toBeNull();
      setView("chart");
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(2);
    } finally {
      dispose();
    }
  });
  test("missing local row does not clear a sibling's controlled selection; custom table cells and unplotted rows remain usable", async () => {
    const changes: (string | null)[] = [];
    const fixture = data();
    fixture.rows = [...fixture.rows, { key: "missing", label: "Unavailable", value: 0 }];
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Queues",
          data: fixture,
          columns: [columns[0]!, { ...columns[1]!, render: (r) => `Current ${r.value}` }],
          defaultView: "table",
          selectedKey: "sibling-only",
          onSelectedKeyChange: (k) => changes.push(k),
        }),
      dom.root,
    );
    try {
      await tick();
      expect(changes).toEqual([]);
      expect(dom.root.textContent).toContain("Current 42");
      button("Unavailable").click();
      await tick();
      expect(changes).toContain("missing");
    } finally {
      dispose();
    }
  });
});
