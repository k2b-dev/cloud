import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

type ChartComponent = typeof import("../src/content/Chart").default;

const mapSeries = [
  {
    label: "Offices",
    data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin" }],
  },
];

const nextTurn = async () => {
  await Promise.resolve();
};

const captureChartSvg = (dom: ReturnType<typeof createDomTestHarness>) => {
  const prototype = dom.window.Element.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "innerHTML");
  if (!descriptor?.set) throw new Error("happy-dom does not expose the Element.innerHTML setter");
  let value = "";
  let writes = 0;

  Object.defineProperty(prototype, "innerHTML", {
    ...descriptor,
    set(this: Element, next: string) {
      if (this.classList.contains("k2b-chart__svg")) { value = next; writes++; }
      // happy-dom truncates SVG parsing at embedded styles; Chromium checks the complete SVG.
      descriptor.set!.call(this, next.replace(/<style>[\s\S]*?<\/style>/g, ""));
    },
  });

  return {
    read: () => value,
    writes: () => writes,
    restore: () => Object.defineProperty(prototype, "innerHTML", descriptor),
  };
};

describe("Chart runtime behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: ReturnType<typeof createDomTestHarness>;
  let renderedSvg: ReturnType<typeof captureChartSvg>;
  let Chart: ChartComponent;

  beforeAll(async () => {
    dom = createDomTestHarness();
    renderedSvg = captureChartSvg(dom);
    Chart = (await import("../src/content/Chart")).default;
  });

  afterAll(() => {
    renderedSvg.restore();
    dom.cleanup();
  });

  test("keeps server geometry through mount and resize and inspects in the current box", async () => {
    let width = 960;
    const bounds = spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => new dom.window.DOMRect(0, 0, width, 224),
    );
    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "line",
          series: [
            {
              data: [
                { x: 1, y: 12 },
                { x: 4, y: 42 },
              ],
            },
          ],
          interactive: true,
        }),
      dom.root,
    );
    try {
      await nextTurn();
      const svg = renderedSvg.read();
      expect(svg).toContain('viewBox="0 0 480 280"');
      expect(svg).toContain('preserveAspectRatio="none"');

      width = 320;
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      await nextTurn();
      expect(renderedSvg.read()).toBe(svg);

      for (const element of Array.from(dom.root.querySelectorAll("[data-chart-datum]"))) {
        Object.defineProperty(element, "getScreenCTM", { value: () => ({ a: width / 480, b: 0, c: 0, d: 224 / 280, e: 0, f: 0 }) });
      }
      const chart = dom.root.querySelector<HTMLElement>(".k2b-chart");
      chart?.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as FocusEvent);
      const anchor = dom.root.querySelector<HTMLElement>(".k2b-chart__anchor");
      expect(Number.parseFloat(anchor?.style.left ?? "")).toBeCloseTo((464 / 480) * width);
      expect(dom.root.querySelector('[role="tooltip"]')?.textContent).toContain("42");
    } finally {
      dispose();
      bounds.mockRestore();
    }
  });

  test("synchronizes controlled map viewports and resets to the current prop", async () => {
    const [viewport, setViewport] = createSignal({ latitude: 10, longitude: 20, zoom: 1 });

    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "map",
          series: mapSeries,
          interactive: true,
          get viewport() {
            return viewport();
          },
        }),
      dom.root,
    );
    await nextTurn();

    const landTransform = () => renderedSvg.read().match(/class="stdlib-chart-map-land"[^>]* transform="([^"]+)"/)?.[1];
    const initialTransform = landTransform();

    setViewport({ latitude: 20, longitude: 40, zoom: 2 });
    await nextTurn();
    const controlledTransform = landTransform();
    expect(controlledTransform).toBeTruthy();
    expect(controlledTransform).not.toBe(initialTransform);

    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
    await nextTurn();
    expect(landTransform()).not.toBe(controlledTransform);

    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Reset map view"]')?.click();
    await nextTurn();
    expect(landTransform()).toBe(controlledTransform);

    dispose();
  });

  test("follows a growing timeline until local interaction and resumes after reset", async () => {
    const interval = (from: number, to: number) => ({ from, to, state: "ok" });
    const [rows, setRows] = createSignal([{ label: "Worker", intervals: [interval(0, 10)] }]);

    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "stateTimeline",
          get rows() {
            return rows();
          },
          interactive: true,
        }),
      dom.root,
    );
    await nextTurn();

    const regions = () => renderedSvg.read().match(/class="stdlib-chart-state-region/g)?.length ?? 0;
    const svg = () => renderedSvg.read();
    expect(regions()).toBe(1);

    setRows([{ label: "Worker", intervals: [interval(0, 10), interval(10, 20)] }]);
    await nextTurn();
    expect(regions()).toBe(2);

    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')?.click();
    await nextTurn();
    const locallyControlledSvg = svg();

    setRows([{ label: "Worker", intervals: [interval(0, 10), interval(10, 20), interval(20, 40)] }]);
    await nextTurn();
    expect(svg()).toBe(locallyControlledSvg);

    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Reset timeline view"]')?.click();
    await nextTurn();
    expect(regions()).toBe(3);

    setRows([{ label: "Worker", intervals: [interval(0, 10), interval(10, 20), interval(20, 40), interval(40, 80)] }]);
    await nextTurn();
    expect(regions()).toBe(4);

    const chart = dom.root.querySelector<HTMLElement>(".k2b-chart")!;
    chart.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as FocusEvent);
    const tooltip = dom.root.querySelector<HTMLElement>('[role="tooltip"]')!;
    expect(chart.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.textContent).toContain("Worker");
    expect(tooltip.textContent).toContain("Duration: 10");
    chart.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }) as unknown as FocusEvent);
    expect(chart.hasAttribute("aria-describedby")).toBe(false);

    dispose();
  });

  test("connects active keyboard inspection to a stable tooltip id", async () => {
    const dispose = render(
      () =>
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
      dom.root,
    );
    await nextTurn();

    const chart = dom.root.querySelector<HTMLElement>('[aria-label="Interactive line chart"]');
    const tooltip = dom.root.querySelector<HTMLElement>('[role="tooltip"]');
    if (!tooltip) throw new Error("line chart tooltip was not rendered");
    expect(tooltip.id).toMatch(/^k2b-chart-tooltip-/);
    expect(chart?.hasAttribute("aria-describedby")).toBe(false);

    chart?.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as FocusEvent);
    await nextTurn();
    expect(chart?.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip?.textContent).toContain("Errors: 3");

    chart?.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }) as unknown as FocusEvent);
    await nextTurn();
    expect(chart?.hasAttribute("aria-describedby")).toBe(false);

    dispose();
  });
  test("all fourteen kinds inspect and select renderer-owned data without rebuilding SVG", async () => {
    const samples: import("../src/content/Chart").ChartProps[] = [
      {
        kind: "line",
        series: [
          {
            data: [
              { x: 1, y: 2 },
              { x: 2, y: 4 },
            ],
          },
        ],
      },
      { kind: "scatter", series: [{ data: [{ x: 1, y: 2 }] }] },
      { kind: "bar", data: [{ label: "A", value: 2 }] },
      { kind: "pie", data: [{ label: "A", value: 2 }] },
      { kind: "donut", data: [{ label: "A", value: 2 }] },
      { kind: "sparkline", data: [1, 2, 3] },
      { kind: "histogram", data: [1, 2, 3] },
      { kind: "boxplot", groups: [{ label: "A", values: [1, 2, 3] }] },
      { kind: "gauge", value: 40 },
      { kind: "barGauge", data: [{ label: "A", value: 40 }] },
      { kind: "stat", label: "A", value: 40, sparkline: [1, 2] },
      { kind: "heatmap", data: [{ x: "A", y: "B", value: 1 }] },
      { kind: "map", series: mapSeries },
      { kind: "stateTimeline", rows: [{ label: "A", intervals: [{ from: 1, to: 2, state: "ok" }] }] },
    ];
    for (const sample of samples) {
      const selections: import("../src/content/chart-inspection").ChartSelection[] = [];
      const dispose = render(
        () => createComponent(Chart, { ...sample, interactive: true, onSelect: (value) => selections.push(value) }),
        dom.root,
      );
      try {
        await nextTurn();
        const svg = renderedSvg.read();
        const writes = renderedSvg.writes();
        const chart = dom.root.querySelector<HTMLElement>(".k2b-chart")!;
        chart.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as FocusEvent);
        expect(chart.hasAttribute("aria-describedby")).toBe(true);
        expect(dom.root.querySelector("[data-inspected]")).not.toBeNull();
        expect(selections).toHaveLength(0);
        chart.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent);
        expect(selections).toHaveLength(1);
        expect(selections[0]!.kind).toBe(sample.kind);
        expect(selections[0]!.datum.values.length).toBeGreaterThan(0);
        expect(renderedSvg.read()).toBe(svg);
        expect(renderedSvg.writes()).toBe(writes);
        chart.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as KeyboardEvent);
        expect(chart.hasAttribute("aria-describedby")).toBe(false);
      } finally {
        dispose();
      }
    }
  });

  test("heatmap navigation skips missing cells and stale inspection closes on data updates", async () => {
    const [value, setValue] = createSignal(1);
    const selections: import("../src/content/chart-inspection").ChartSelection[] = [];
    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "heatmap",
          interactive: true,
          get data() {
            return [
              { x: "Mon", y: "EU", value: value() },
              { x: "Tue", y: "EU", value: 2 },
              { x: "Mon", y: "US", value: 3 },
            ];
          },
          onSelect: (selection) => selections.push(selection),
          tooltip: ({ datum }) => ({
            title: "<script>plain text</script>",
            rows: datum.values.map((field) => ({ label: field.key, value: String(field.value) })),
          }),
        }),
      dom.root,
    );
    try {
      await nextTurn();
      const chart = dom.root.querySelector<HTMLElement>(".k2b-chart")!;
      chart.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }) as unknown as FocusEvent);
      chart.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as KeyboardEvent);
      chart.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent);
      expect(selections[0]!.datum.index).toBe(2);
      expect(dom.root.querySelector('[role="tooltip"]')?.textContent).toContain("<script>plain text</script>");
      expect(dom.root.querySelector("script")).toBeNull();
      setValue(10);
      await nextTurn();
      expect(chart.hasAttribute("aria-describedby")).toBe(false);
      expect(dom.root.querySelector("[data-inspected]")).toBeNull();
    } finally {
      dispose();
    }
  });
  test("pointer inspection follows logarithmic anchors and does not select while hovering", async () => {
    const selections: import("../src/content/chart-inspection").ChartSelection[] = [];
    const dispose = render(
      () =>
        createComponent(Chart, {
          kind: "line",
          interactive: true,
          xAxis: { scale: "log" },
          series: [
            {
              data: [
                { x: 1, y: 2 },
                { x: 10, y: 3 },
                { x: 100, y: 4 },
              ],
            },
          ],
          onSelect: (selection) => selections.push(selection),
        }),
      dom.root,
    );
    try {
      await nextTurn();
      for (const element of Array.from(dom.root.querySelectorAll("[data-chart-datum]"))) {
        Object.defineProperty(element, "getScreenCTM", { value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
      }
      const chart = dom.root.querySelector<HTMLElement>(".k2b-chart")!;
      chart.dispatchEvent(
        new dom.window.PointerEvent("pointermove", {
          clientX: 252,
          clientY: 100,
          bubbles: true,
          pointerType: "mouse",
        }) as unknown as PointerEvent,
      );
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      expect(dom.root.querySelector('[role="tooltip"]')?.textContent).toContain("X: 10");
      expect(selections).toHaveLength(0);
      chart.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent);
      expect(selections[0]!.datum.index).toBe(1);
    } finally {
      dispose();
    }
  });
});
