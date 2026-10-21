import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { isServer } from "solid-js/web";
import { type ChartSelection, createChartCursor, inspectChart } from "../src/chart-inspection";
import { createDomTestHarness } from "./dom";

const data = [
  { label: "First", value: 10 },
  { label: "Second", value: 20 },
  { label: "Third", value: 30 },
];
const markup = () => charts.bar({ data, inspect: true, width: 480, height: 280 }).replace(/<style>[\s\S]*?<\/style>/g, "");
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("framework-free chart inspection", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: ReturnType<typeof createDomTestHarness>;
  beforeAll(() => {
    dom = createDomTestHarness();
  });
  afterAll(() => dom.cleanup());

  const mount = (svg = markup()) => {
    const container = dom.document.createElement("div");
    container.innerHTML = svg;
    dom.root.append(container);
    container.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 480, 280);
    for (const element of container.querySelectorAll("svg, [data-chart-datum]")) {
      Object.defineProperty(element, "getScreenCTM", { value: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
      element.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 480, 280);
    }
    return container;
  };
  const pointer = (target: Element, type = "pointermove") =>
    target.dispatchEvent(
      new dom.window.PointerEvent(type, { bubbles: true, pointerType: "mouse", clientX: 100, clientY: 100 }) as unknown as PointerEvent,
    );
  const key = (container: HTMLElement, value: string) =>
    container.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: value }));
  const focus = (container: HTMLElement) => container.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

  test("inspects plain SVG with pointer and keyboard, pins selections, and tears down completely", async () => {
    const container = mount();
    const marks = Array.from(container.querySelectorAll<SVGGraphicsElement>("[data-chart-datum]"));
    expect(marks).toHaveLength(3);
    let calls = 0;
    const selections: ChartSelection[] = [];
    const inspection = inspectChart(container, {
      kind: "bar",
      format: ({ datum }) => {
        calls++;
        return { title: `Datum ${datum.index + 1}`, rows: [{ label: "Value", value: "<b>x</b>" }] };
      },
      select: (selection) => selections.push(selection),
    });
    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
    // happy-dom has no Popover API; model its open state for this tooltip.
    let open = false;
    const matches = tooltip.matches.bind(tooltip);
    tooltip.showPopover = () => {
      open = true;
    };
    tooltip.hidePopover = () => {
      open = false;
    };
    Object.defineProperty(tooltip, "matches", {
      value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)),
    });
    try {
      expect(container.getAttribute("tabindex")).toBe("0");
      pointer(marks[0]!);
      await nextFrame();
      expect(tooltip.textContent).toBe("Datum 1Value: <b>x</b>");
      expect(open).toBe(true);
      expect(container.getAttribute("aria-describedby")).toBe(tooltip.id);
      expect(tooltip.querySelectorAll("b")).toHaveLength(1);
      expect(tooltip.querySelector("b")?.textContent).toBe("<b>x</b>");
      expect(tooltip.querySelector("b b")).toBeNull();

      focus(container);
      key(container, "ArrowRight");
      expect(tooltip.textContent).toContain("Datum 2");
      expect(marks[1]!.hasAttribute("data-inspected")).toBe(true);
      key(container, "End");
      expect(tooltip.textContent).toContain("Datum 3");
      expect(marks[2]!.hasAttribute("data-inspected")).toBe(true);
      key(container, "Home");
      expect(tooltip.textContent).toContain("Datum 1");
      key(container, "Escape");
      expect(open).toBe(false);
      expect(container.hasAttribute("aria-describedby")).toBe(false);
      expect(container.querySelector("[data-inspected]")).toBeNull();

      marks[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 100 }));
      expect(selections).toHaveLength(1);
      expect(selections[0]?.kind).toBe("bar");
      expect(selections[0]?.datum.index).toBe(0);
      pointer(marks[1]!);
      await nextFrame();
      container.dispatchEvent(new dom.window.PointerEvent("pointerleave") as unknown as PointerEvent);
      expect(tooltip.textContent).toContain("Datum 1");
      expect(container.getAttribute("aria-describedby")).toBe(tooltip.id);
      pointer(dom.root, "pointerdown");
      expect(container.hasAttribute("aria-describedby")).toBe(false);

      focus(container);
      tooltip.dispatchEvent(new Event("scroll"));
      expect(container.getAttribute("aria-describedby")).toBe(tooltip.id);
      dom.window.dispatchEvent(new dom.window.Event("resize"));
      expect(container.hasAttribute("aria-describedby")).toBe(false);
      focus(container);
      dom.window.dispatchEvent(new dom.window.Event("scroll"));
      expect(container.hasAttribute("aria-describedby")).toBe(false);

      focus(container);
      expect(container.style.getPropertyValue("--k2b-chart-inspection-x")).not.toBe("");
      pointer(marks[1]!); // Teardown must cancel this queued frame too.
      inspection.destroy();
      inspection.destroy();
      const callsAfterDestroy = calls;
      expect(open).toBe(false);
      expect(container.querySelector('[role="tooltip"]')).toBeNull();
      expect(container.querySelector(".k2b-chart__anchor")).toBeNull();
      expect(container.hasAttribute("tabindex")).toBe(false);
      expect(container.querySelector("[data-inspected]")).toBeNull();
      expect(marks.every((mark) => !mark.style.getPropertyValue("--k2b-chart-inspection-color"))).toBe(true);
      expect(container.style.getPropertyValue("--k2b-chart-inspection-x")).toBe("");
      pointer(marks[0]!);
      focus(container);
      key(container, "ArrowRight");
      await nextFrame();
      expect(calls).toBe(callsAfterDestroy);
      expect(container.hasAttribute("aria-describedby")).toBe(false);
      inspection.invalidate();
      inspection.close();
      expect(calls).toBe(callsAfterDestroy);
      expect(() => {
        pointer(dom.root, "pointerdown");
        dom.window.dispatchEvent(new dom.window.Event("scroll"));
        dom.window.dispatchEvent(new dom.window.Event("resize"));
      }).not.toThrow();
    } finally {
      inspection.destroy();
      container.remove();
    }
  });

  test("refreshes metadata after a redraw and closes on focusout", () => {
    const container = mount();
    const inspection = inspectChart(container, {
      kind: "bar",
      format: ({ datum }) => ({ title: datum.label, rows: [] }),
    });
    try {
      focus(container);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("First");
      const mark = container.querySelector("[data-chart-datum]")!;
      const datum = JSON.parse(mark.getAttribute("data-chart-datum")!);
      mark.setAttribute("data-chart-datum", JSON.stringify({ ...datum, label: "Redrawn" }));
      inspection.invalidate();
      expect(container.hasAttribute("aria-describedby")).toBe(false);
      focus(container);
      expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Redrawn");
      container.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(container.hasAttribute("aria-describedby")).toBe(false);
      focus(container);
      inspection.close();
      expect(container.hasAttribute("aria-describedby")).toBe(false);
    } finally {
      inspection.destroy();
      container.remove();
    }
  });

  test("links plain line charts and unsubscribes on teardown", () => {
    const svg = charts
      .line({
        series: [
          {
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
        inspect: true,
        width: 480,
        height: 280,
      })
      .replace(/<style>[\s\S]*?<\/style>/g, "");
    const first = mount(svg),
      second = mount(svg);
    const cursor = createChartCursor({ formatX: (x) => `Time ${x}` });
    let calls = 0;
    const options = {
      kind: "line",
      cursor,
      format: () => {
        calls++;
        return { rows: [{ label: "Value", value: "20" }] };
      },
    } as const;
    const a = inspectChart(first, options),
      b = inspectChart(second, options);
    try {
      focus(first);
      expect(cursor.read()?.x).toBe(2);
      expect(second.querySelector('[role="tooltip"]')?.textContent).toBe("Time 2Value: 20");
      expect(second.hasAttribute("aria-describedby")).toBe(true);
      a.destroy();
      expect(cursor.read()).toBeNull();
      expect(second.hasAttribute("aria-describedby")).toBe(false);
      const callsBeforeFocus = calls;
      focus(second);
      expect(calls).toBe(callsBeforeFocus + 1);
      expect(first.hasAttribute("aria-describedby")).toBe(false);
    } finally {
      a.destroy();
      b.destroy();
      first.remove();
      second.remove();
    }
  });

  test("a line's edge point answers its own mark outside the plot bounds", async () => {
    const svg = charts
      .line({
        series: [
          {
            data: [
              { x: 1, y: 10 },
              { x: 2, y: 20 },
            ],
          },
        ],
        inspect: true,
        width: 480,
        height: 280,
      })
      .replace(/<style>[\s\S]*?<\/style>/g, "");
    const container = mount(svg);
    // The plot starts at x 200; the first point's hit area straddles that edge.
    for (const axis of container.querySelectorAll(".stdlib-chart-axis"))
      axis.getBoundingClientRect = () => new dom.window.DOMRect(200, 0, 200, 280);
    const inspection = inspectChart(container, { kind: "line", format: () => ({ rows: [{ label: "Value", value: "10" }] }) });
    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
    let open = false;
    const matches = tooltip.matches.bind(tooltip);
    tooltip.showPopover = () => {
      open = true;
    };
    tooltip.hidePopover = () => {
      open = false;
    };
    Object.defineProperty(tooltip, "matches", {
      value: (selector: string) => (selector === ":popover-open" ? open : matches(selector)),
    });
    const move = (target: Element, clientX: number, clientY = 100) =>
      target.dispatchEvent(
        new dom.window.PointerEvent("pointermove", {
          bubbles: true,
          pointerType: "mouse",
          clientX,
          clientY,
        }) as unknown as PointerEvent,
      );
    try {
      move(container.querySelector("[data-chart-datum]")!, 199);
      await nextFrame();
      expect(open).toBe(true);
      // A visible series path can cover the mark. Its rounded point center
      // still belongs to the same painted edge, without a direct metadata hit.
      const path = container.querySelector(".stdlib-chart-line")!;
      for (const [x, y] of [
        [199.99998, 100],
        [400.00002, 100],
        [300, -0.00002],
        [300, 280.00002],
      ]) {
        move(path, x!, y!);
        await nextFrame();
        expect(open).toBe(true);
      }
      // The raster allowance must not turn axes/legend space into plot hits.
      for (const [x, y] of [
        [199, 100],
        [401, 100],
        [300, -1],
        [300, 281],
      ]) {
        move(path, x!, y!);
        await nextFrame();
        expect(open).toBe(false);
      }
      // Empty space outside the plot still closes inspection.
      move(container.querySelector("svg")!, 150);
      await nextFrame();
      expect(open).toBe(false);
    } finally {
      inspection.destroy();
      container.remove();
    }
  });

  test("keeps the host's own accessible description while inspecting", () => {
    const container = mount();
    container.setAttribute("aria-describedby", "chart-note");
    const inspection = inspectChart(container, { kind: "bar", format: () => ({ rows: [] }) });
    const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]')!;
    try {
      inspection.close();
      expect(container.getAttribute("aria-describedby")).toBe("chart-note");
      focus(container);
      expect(container.getAttribute("aria-describedby")).toBe(`chart-note ${tooltip.id}`);
      key(container, "Escape");
      expect(container.getAttribute("aria-describedby")).toBe("chart-note");
      focus(container);
      inspection.destroy();
      expect(container.getAttribute("aria-describedby")).toBe("chart-note");
    } finally {
      inspection.destroy();
      container.remove();
    }
  });

  test("preserves an existing tabindex and host attributes, and assigns distinct tooltip IDs", () => {
    const container = mount();
    const other = mount();
    container.setAttribute("tabindex", "-1");
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Jobs");
    container.className = "host-chart";
    container.style.color = "red";
    const options = { kind: "bar", format: () => ({ rows: [] }) } as const;
    const first = inspectChart(container, options);
    const second = inspectChart(other, options);
    try {
      expect(container.querySelector('[role="tooltip"]')?.id).not.toBe(other.querySelector('[role="tooltip"]')?.id);
      first.destroy();
      expect(container.getAttribute("tabindex")).toBe("-1");
      expect(container.getAttribute("role")).toBe("group");
      expect(container.getAttribute("aria-label")).toBe("Jobs");
      expect(container.className).toBe("host-chart");
      expect(container.style.color).toBe("red");
    } finally {
      first.destroy();
      second.destroy();
      container.remove();
      other.remove();
    }
  });
});
