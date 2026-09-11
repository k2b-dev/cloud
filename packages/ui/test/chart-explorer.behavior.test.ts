import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";
import type { ChartExplorerSnapshot, ChartExplorerRequest } from "../src/content/ChartExplorer";
type Row = { key: string; label: string; value: number };
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("ChartExplorer interactions", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }
  let dom: ReturnType<typeof createDomTestHarness>;
  let Explorer: typeof import("../src/content/ChartExplorer").ChartExplorer;
  let Chart: typeof import("../src/content/Chart").default;
  let prepare: typeof import("../src/content/chart-snapshot").prepareChartSnapshot;
  let restore: () => void;
  let writes = 0;
  beforeAll(async () => {
    dom = createDomTestHarness();
    const prototype = dom.window.Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "innerHTML")!;
    Object.defineProperty(prototype, "innerHTML", {
      ...descriptor,
      set(this: Element, value: string) {
        if (this.classList.contains("k2b-chart__svg")) writes++;
        descriptor.set!.call(this, value.replace(/<style>[\s\S]*?<\/style>/g, ""));
      },
    });
    restore = () => Object.defineProperty(prototype, "innerHTML", descriptor);
    Explorer = (await import("../src/content/ChartExplorer")).ChartExplorer;
    Chart = (await import("../src/content/Chart")).default;
    prepare = (await import("../src/content/chart-snapshot")).prepareChartSnapshot;
  });
  afterAll(() => {
    restore();
    dom.cleanup();
  });
  const snapshot = (step = "08", visibleKeys: readonly string[] = ["a", "b"]): ChartExplorerSnapshot<Row> => {
    const rows = [
      { key: "a", label: "Imports", value: step === "14" ? 50 : 42 },
      { key: "b", label: "Exports", value: 28 },
    ].filter((r) => visibleKeys.includes(r.key));
    return {
      request: { step, visibleKeys },
      rows,
      chart: prepare(
        { kind: "bar", data: rows, yAxis: { domain: [0, 60] } },
        {
          key: ({ datum }) => rows[datum.index]!.key,
          tooltip: ({ datum }) => ({ title: rows[datum.index]!.label, rows: [{ label: "Jobs", value: String(rows[datum.index]!.value) }] }),
        },
      ),
    };
  };
  const columns = [
    { id: "label", label: "Queue", value: (r: Row) => r.label, sortValue: (r: Row) => r.label },
    { id: "value", label: "Jobs", value: (r: Row) => String(r.value), sortValue: (r: Row) => r.value },
  ];
  const button = (label: string) => {
    const found = Array.from(dom.window.document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const slider = (index: number) => {
    const input = dom.root.querySelector<HTMLInputElement>('input[type="range"]')!;
    input.value = String(index);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const props = () => ({
    title: "Queues",
    snapshot: snapshot(),
    steps: [
      { key: "08", label: "08:00" },
      { key: "14", label: "14:00" },
      { key: "20", label: "20:00" },
    ],
    columns,
    getRowKey: (r: Row) => r.key,
  });
  test("selection survives pointer leave and table sorting, without regenerating SVG", async () => {
    const dispose = render(() => createComponent(Explorer<Row>, props()), dom.root);
    try {
      const before = writes;
      dom.root.querySelector("[data-chart-datum]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(1);
      dom.root.querySelector(".k2b-chart")!.dispatchEvent(new MouseEvent("pointerleave"));
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")).not.toBeNull();
      expect(writes).toBe(before);
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Chart view"]')!.click();
      await tick();
      button("Table").click();
      await tick();
      button("Jobs ↕").click();
      await tick();
      expect(dom.root.querySelector('[aria-sort="ascending"]')).not.toBeNull();
      expect(dom.root.querySelector("tbody tr")?.textContent).toContain("Exports");
      expect(dom.root.querySelector(".k2b-chart-explorer__details")?.textContent).toContain("Imports");
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Chart view"]')!.click();
      await tick();
      button("Diagram").click();
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(1);
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]')!.click();
      await tick();
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")).toBeNull();
    } finally {
      dispose();
    }
  });
  test("latest requested step wins even when an aborted loader completes afterwards", async () => {
    const requests: { request: ChartExplorerRequest; signal: AbortSignal; resolve: (value: ChartExplorerSnapshot<Row>) => void }[] = [];
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          ...props(),
          load: (request, signal) => new Promise((resolve) => requests.push({ request, signal, resolve })),
        }),
      dom.root,
    );
    try {
      const before = dom.root.querySelector(".k2b-chart__svg")?.innerHTML;
      slider(1);
      slider(2);
      await tick();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(dom.root.querySelector(".k2b-chart__svg")?.innerHTML).toBe(before);
      expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("08:00");
      requests[1]!.resolve(snapshot("20"));
      await tick();
      requests[0]!.resolve(snapshot("14"));
      await tick();
      expect(dom.root.querySelector(".k2b-chart-explorer__dimension-value")?.textContent).toContain("20:00");
      expect(JSON.parse(dom.root.querySelector('[data-chart-datum]')!.getAttribute("data-chart-datum")!)).toEqual(snapshot("20").chart.marks[0]!.datum);
      expect(dom.root.querySelector('[aria-busy="true"]')).toBeNull();
    } finally {
      dispose();
    }
  });
  test("failure retains old data, retry succeeds and replacement clears obsolete selection", async () => {
    const [current, setCurrent] = createSignal(snapshot());
    let attempt = 0;
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          ...props(),
          get snapshot() {
            return current();
          },
          load: async (request) => {
            if (attempt++ === 0) throw new Error("Offline");
            return snapshot(request.step);
          },
        }),
      dom.root,
    );
    try {
      dom.root.querySelector("[data-chart-datum]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      slider(1);
      await tick();
      expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("Could not load");
      expect(dom.root.querySelectorAll("[data-chart-datum]")).toHaveLength(2);
      button("Retry").click();
      await tick();
      expect(dom.root.querySelector(".k2b-chart-explorer__dimension-value")?.textContent).toContain("14:00");
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")).not.toBeNull();
      setCurrent(snapshot("14", ["b"]));
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum]")).toHaveLength(1);
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")).toBeNull();
    } finally {
      dispose();
    }
  });
  test("rejects mismatched responses and aborts in-flight work on unmount", async () => {
    let signal: AbortSignal | undefined;
    const dispose = render(
      () =>
        createComponent(Explorer<Row>, {
          ...props(),
          load: async (_request, nextSignal) => {
            signal = nextSignal;
            return snapshot("20");
          },
        }),
      dom.root,
    );
    slider(1);
    await tick();
    expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("Could not load");
    expect(dom.root.querySelector('[role="status"]')?.textContent).toContain("08:00");
    dispose();
    const disposePending = render(
      () =>
        createComponent(Explorer<Row>, {
          ...props(),
          load: (_request, nextSignal) => {
            signal = nextSignal;
            return new Promise(() => {});
          },
        }),
      dom.root,
    );
    slider(1);
    disposePending();
    expect(signal?.aborted).toBe(true);
  });
  test("controlled base Chart selection updates paint without rebuilding the SVG", async () => {
    const [selected, setSelected] = createSignal<import("../src/content/chart-inspection").ChartDatumRef | null>(null);
    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "bar",
          data: [
            { label: "A", value: 1 },
            { label: "B", value: 2 },
          ],
          interactive: true,
          get selected() {
            return selected();
          },
        }),
      dom.root,
    );
    try {
      const before = writes;
      setSelected({ role: "item", index: 1 });
      await tick();
      expect(dom.root.querySelectorAll("[data-chart-datum][data-selected]")).toHaveLength(1);
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")?.getAttribute("data-chart-datum")).toContain('"index":1');
      expect(writes).toBe(before);
      setSelected(null);
      await tick();
      expect(dom.root.querySelector("[data-chart-datum][data-selected]")).toBeNull();
    } finally {
      dispose();
    }
  });
});
