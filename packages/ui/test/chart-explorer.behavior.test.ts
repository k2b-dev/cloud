import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { ChartExplorerData } from "../src/content/chart-explorer";
import type { DataTableSort } from "../src/content/DataTable";
import { createDomTestHarness } from "./dom";

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
  const openSwitcher = async () => {
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Chart view"]')!.click();
    await tick();
    return Array.from(dom.document.querySelectorAll<HTMLButtonElement>(".k2b-select-chip__option"));
  };
  test("shared filter controls pin the requested step and clear it without losing filters", async () => {
    const { ChartFilterControls } = await import("../src/content/ChartFilterControls");
    const [request, setRequest] = createSignal<import("../src/content/chart-explorer").ChartExplorerRequest>({
      step: "2026",
      visibleKeys: ["north"],
    });
    const dispose = render(
      () =>
        createComponent(ChartFilterControls, {
          get request() {
            return request();
          },
          displayedRequest: { step: "2025" },
          steps: [
            { key: "2025", label: "Previous year" },
            { key: "2026", label: "Current year" },
          ],
          compare: true,
          onRequest: setRequest,
        }),
      dom.root,
    );
    try {
      button("Pin as reference").click();
      await tick();
      expect(request()).toEqual({ step: "2026", referenceStep: "2026", visibleKeys: ["north"] });
      expect(button("Reference: Current year").getAttribute("aria-label")).toBe("Remove comparison: Current year");
      setRequest({ ...request(), step: "2025" });
      await tick();
      button("Reference: Current year").click();
      await tick();
      expect(request()).toEqual({ step: "2025", referenceStep: undefined, visibleKeys: ["north"] });
      expect(button("Pin as reference")).toBeDefined();
    } finally {
      dispose();
    }
  });
  test("the switcher lists every chart and keeps a chart named table distinct from the table entry", async () => {
    const choices = [
      { id: "offers", label: "Offers" },
      { id: "median", label: "Median price" },
      { id: "table", label: "Trend named table" },
    ];
    const charts: string[] = [];
    const views: string[] = [];
    const [chart, setChart] = createSignal("offers");
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Queues",
          data: data(),
          columns,
          charts: choices,
          get chart() {
            return chart();
          },
          defaultView: "table",
          onChartChange: (id) => {
            charts.push(id);
            setChart(id);
          },
          onViewChange: (view) => views.push(view),
        }),
      dom.root,
    );
    try {
      for (const choice of choices) {
        const options = await openSwitcher();
        expect(options.map((option) => option.textContent?.trim())).toEqual([...choices.map((choice) => choice.label), "Table"]);
        options.find((option) => option.textContent?.trim() === choice.label)!.click();
        await tick();
        expect(charts.at(-1)).toBe(choice.id);
        expect(views.at(-1)).toBe("chart");
        expect(dom.root.querySelector("table")).toBeNull();
        expect(dom.root.querySelector('[aria-label="Chart view"]')?.textContent).toContain(choice.label);
      }
      const options = await openSwitcher();
      options.find((option) => option.textContent?.trim() === "Table")!.click();
      await tick();
      expect(charts).toEqual(["offers", "median", "table"]);
      expect(views).toEqual(["chart", "chart", "chart", "table"]);
      expect(dom.root.querySelector("table")).not.toBeNull();
    } finally {
      dispose();
    }
  });
  test("without charts the switcher still offers Diagram and Table", async () => {
    const views: string[] = [];
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Queues",
          data: data(),
          columns,
          onViewChange: (view) => views.push(view),
        }),
      dom.root,
    );
    try {
      const options = await openSwitcher();
      expect(options.map((option) => option.textContent?.trim())).toEqual(["Diagram", "Table"]);
      options[1]!.click();
      await tick();
      expect(dom.root.querySelector("table")).not.toBeNull();
      (await openSwitcher())[0]!.click();
      await tick();
      expect(views).toEqual(["table", "chart"]);
      expect(dom.root.querySelector("table")).toBeNull();
    } finally {
      dispose();
    }
  });
  test("the table cap follows sorting, names shown and total rows, and Copy data includes every sorted row", async () => {
    const fixture = data();
    fixture.rows = [...fixture.rows, { key: "c", label: "Third", value: 70 }, { key: "d", label: "Fourth", value: 10 }];
    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator.clipboard, "writeText");
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text: string) => {
        copied.push(text);
      },
    });
    const [cap, setCap] = createSignal(2);
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Queues",
          data: fixture,
          columns,
          defaultView: "table",
          defaultSort: { key: "value", direction: "asc" },
          get tableRows() {
            return cap();
          },
        }),
      dom.root,
    );
    const labels = () =>
      Array.from(dom.root.querySelectorAll("tbody .k2b-data-table__row")).map((row) => row.querySelector("td")?.textContent?.trim());
    try {
      expect(labels()).toEqual(["Fourth", "Exports"]);
      const note = dom.root.querySelector(".k2b-chart-explorer__note")!;
      expect(note.textContent).toBe("Showing 2 of 4 rows. Sort to see others; Copy data copies all of them.");
      expect(note.closest(".k2b-chart-explorer__viewport")).not.toBeNull();
      button("Jobs").click();
      await tick();
      expect(labels()).toEqual(["Third", "Imports"]);
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Copy data"]')!.click();
      await tick();
      expect(copied).toEqual(["Queue\tJobs\nThird\t70\nImports\t42\nExports\t28\nFourth\t10"]);
      setCap(4);
      await tick();
      expect(labels()).toEqual(["Third", "Imports", "Exports", "Fourth"]);
      expect(dom.root.querySelector(".k2b-chart-explorer__note")).toBeNull();
    } finally {
      dispose();
      if (original) Object.defineProperty(navigator.clipboard, "writeText", original);
      else Reflect.deleteProperty(navigator.clipboard, "writeText");
    }
  });
  test("server-prepared line explorer follows a shared cursor without selecting rows", async () => {
    const { createChartCursor } = await import("../src/content/chart-cursor");
    const cursor = createChartCursor({ formatX: (x) => `Time ${x}` });
    const source = Symbol();
    const chart = prepare(
      {
        kind: "line",
        series: [
          {
            label: "Rate",
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
      },
      {
        key: ({ datum }) => String(datum.index),
        tooltip: ({ datum }) => ({ rows: [{ label: "Rate", value: String(datum.values.find((v) => v.key === "y")?.value) }] }),
      },
    );
    chart.svg = chart.svg.replace(/<style>[\s\S]*?<\/style>/g, "");
    let selected = 0;
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "Rate",
          cursor,
          columns,
          data: {
            chart,
            rows: [
              { key: "0", label: "First", value: 10 },
              { key: "1", label: "Second", value: 20 },
            ],
          },
          onSelectedKeyChange: () => selected++,
        }),
      dom.root,
    );
    try {
      await tick();
      const svg = dom.root.querySelector(".k2b-chart__svg")?.innerHTML;
      cursor.move(source, 2);
      expect(dom.root.querySelector('.k2b-chart__tooltip[role="tooltip"]')?.textContent).toContain("Time 2");
      expect(dom.root.querySelector('.k2b-chart__tooltip[role="tooltip"]')?.textContent).toContain("20");
      expect(dom.root.querySelector(".k2b-chart__svg")?.innerHTML).not.toBeUndefined();
      cursor.clear(source);
      expect(dom.root.querySelector(".k2b-chart__svg")?.innerHTML).toBe(svg);
      expect(selected).toBe(0);
    } finally {
      dispose();
    }
  });

  test("one entity selects all its marks and has exactly one table row; sorting and clearing preserve the contract", async () => {
    const dispose = render(() => createComponent(Explorer<Row>, { title: "Queues", data: data(), columns }), dom.root);
    try {
      dom.root.querySelector("[data-chart-datum]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(2);
      expect(dom.root.querySelector(".k2b-chart-explorer__details")?.textContent).toContain("Imports");
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Chart view"]')!.click();
      await tick();
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button"))
        .find((b) => b.textContent?.trim() === "Table")!
        .click();
      await tick();
      expect(dom.root.querySelectorAll("tbody .k2b-data-table__row")).toHaveLength(2);
      button("Jobs").click();
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
      button("Jobs").click();
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
  test("a custom first cell opens its action without nesting selection buttons; the row stays keyboard-selectable", async () => {
    const { Button } = await import("../src/actions/Button");
    let opened = 0;
    const selected: (string | null)[] = [];
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          title: "References",
          data: data(),
          defaultView: "table",
          columns: [
            {
              ...columns[0],
              id: "label",
              label: "Queue",
              value: (row: Row) => row.label,
              render: (row: Row) => createComponent(Button, { onClick: () => opened++, children: row.label }),
            },
            { id: "value", label: "Jobs", value: (row: Row) => String(row.value) },
          ],
          onSelectedKeyChange: (key) => selected.push(key),
        }),
      dom.root,
    );
    try {
      expect(dom.root.querySelector("button button") === null).toBe(true);
      button("Imports").click();
      await tick();
      expect(opened).toBe(1);
      expect(selected).toEqual([]);
      const row = dom.root.querySelector<HTMLTableRowElement>("tbody tr");
      if (!row) throw new Error("Missing table row");
      expect(row.tabIndex).toBe(0);
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await tick();
      expect(selected).toEqual(["a"]);
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
