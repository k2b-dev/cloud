import { describe, expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

const settle = () => Bun.sleep(20);
/** Dialog focus moves in an animation frame; poll so a loaded runner does not flake. */
const until = async (condition: () => boolean) => {
  for (let waited = 0; waited < 2_000 && !condition(); waited += 10) await Bun.sleep(10);
};

type Box = { left: number; top: number; width: number; height: number };
const rect = ({ left, top, width, height }: Box) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** happy-dom has no layout: a 400×300 viewport with a 200×100 diagram centered at fit. */
const layout = (root: HTMLElement) => {
  const viewport = root.querySelector<HTMLElement>(".k2b-zoom-pan")!;
  const stage = viewport.querySelector<HTMLElement>(".k2b-zoom-pan__stage")!;
  const content = stage.firstElementChild as HTMLElement;
  viewport.getBoundingClientRect = () => rect({ left: 0, top: 0, width: 400, height: 300 });
  content.getBoundingClientRect = () => {
    const match = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([\d.e+-]+)\)/.exec(stage.style.transform);
    const [x, y, scale] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 1];
    return rect({ left: x + 100 * scale, top: y + 100 * scale, width: 200 * scale, height: 100 * scale });
  };
  return { viewport, stage };
};

const transformOf = (stage: HTMLElement) => {
  const match = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([\d.e+-]+)\)/.exec(stage.style.transform)!;
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
};

const button = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

const key = (dom: DomTestHarness, target: HTMLElement, value: string) => {
  const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }) as unknown as KeyboardEvent;
  target.dispatchEvent(event);
  return event;
};

const pointer = (dom: DomTestHarness, target: HTMLElement, type: string, init: { x: number; y: number; id?: number }) =>
  target.dispatchEvent(
    new dom.window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: init.id ?? 1,
      clientX: init.x,
      clientY: init.y,
    }) as unknown as Event,
  );

describe("ZoomPanViewport", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }

  const mount = async (fullscreen?: import("../src/content/ZoomPanViewport").ZoomPanViewportProps["fullscreen"]) => {
    const dom = createDomTestHarness();
    dom.root.classList.add("k2b-ui");
    // The component module may have been imported with an earlier test's document.
    delegateEvents(["click", "keydown", "pointerdown", "pointermove", "pointerup"], dom.document);
    const { ZoomPanViewport } = await import("../src/content/ZoomPanViewport");
    const clicks: string[] = [];
    const dispose = render(
      () => (
        <ZoomPanViewport label="Diagram" fullscreen={fullscreen}>
          <button type="button" class="content" ref={(element) => element.addEventListener("click", () => clicks.push("content"))}>
            Node
          </button>
        </ZoomPanViewport>
      ),
      dom.root,
    );
    return { dom, dispose, clicks, ...layout(dom.root) };
  };

  test("buttons zoom in steps between fit and 8× and reset to fit", async () => {
    const { dom, dispose, viewport, stage } = await mount();
    try {
      expect(viewport.getAttribute("aria-label")).toBe("Diagram");
      expect(viewport.tabIndex).toBe(0);
      expect(transformOf(stage).scale).toBe(1);
      button(viewport, "Zoom in").click();
      expect(transformOf(stage).scale).toBeCloseTo(Math.SQRT2);
      expect(viewport.dataset.zoomed).toBe("true");
      for (let step = 0; step < 10; step++) button(viewport, "Zoom in").click();
      expect(transformOf(stage).scale).toBe(8);
      button(viewport, "Zoom out").click();
      expect(transformOf(stage).scale).toBeCloseTo(8 / Math.SQRT2);
      button(viewport, "Reset zoom").click();
      expect(transformOf(stage)).toEqual({ x: 0, y: 0, scale: 1 });
      expect(viewport.dataset.zoomed).toBeUndefined();
      expect(button(viewport, "Open fullscreen")).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("keys zoom, reset, and pan only above fit; arrows scroll the page at fit", async () => {
    const { dom, dispose, viewport, stage } = await mount();
    try {
      expect(key(dom, viewport, "ArrowLeft").defaultPrevented).toBe(false);
      expect(key(dom, viewport, "+").defaultPrevented).toBe(true);
      key(dom, viewport, "+");
      key(dom, viewport, "+");
      key(dom, viewport, "+");
      expect(transformOf(stage).scale).toBeCloseTo(4);
      const before = transformOf(stage);
      expect(key(dom, viewport, "ArrowLeft").defaultPrevented).toBe(true);
      expect(transformOf(stage).x).toBe(before.x + 48);
      key(dom, viewport, "-");
      expect(transformOf(stage).scale).toBeCloseTo(2 * Math.SQRT2);
      key(dom, viewport, "0");
      expect(transformOf(stage).scale).toBe(1);
      // Keys on a control inside the viewport keep their own meaning.
      expect(key(dom, button(viewport, "Zoom in"), "+").defaultPrevented).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("the wheel zooms toward the pointer only with Ctrl or Cmd", async () => {
    const { dom, dispose, viewport, stage } = await mount();
    try {
      const wheel = (init: { ctrlKey?: boolean; metaKey?: boolean }) => {
        const event = new dom.window.WheelEvent("wheel", { deltaY: -50, bubbles: true, cancelable: true });
        // happy-dom's WheelEvent ignores modifier keys and coordinates in its init dictionary.
        Object.defineProperties(event, {
          clientX: { value: 150 },
          clientY: { value: 120 },
          ctrlKey: { value: init.ctrlKey ?? false },
          metaKey: { value: init.metaKey ?? false },
        });
        viewport.dispatchEvent(event as unknown as Event);
        return event;
      };
      expect(wheel({}).defaultPrevented).toBe(false);
      expect(transformOf(stage).scale).toBe(1);
      expect(wheel({ ctrlKey: true }).defaultPrevented).toBe(true);
      const zoomed = transformOf(stage);
      expect(zoomed.scale).toBeCloseTo(Math.exp(0.5));
      // The content point under the pointer stays under it.
      expect(zoomed.x + 150 * zoomed.scale).toBeCloseTo(150);
      expect(zoomed.y + 120 * zoomed.scale).toBeCloseTo(120);
      wheel({ metaKey: true });
      expect(transformOf(stage).scale).toBeGreaterThan(zoomed.scale);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("dragging pans only above fit, stays clamped, and does not click the content", async () => {
    const { dom, dispose, viewport, stage, clicks } = await mount();
    const content = viewport.querySelector<HTMLElement>(".content")!;
    try {
      pointer(dom, content, "pointerdown", { x: 200, y: 150 });
      pointer(dom, content, "pointermove", { x: 260, y: 150 });
      pointer(dom, content, "pointerup", { x: 260, y: 150 });
      expect(transformOf(stage)).toEqual({ x: 0, y: 0, scale: 1 });

      key(dom, viewport, "+");
      key(dom, viewport, "+");
      key(dom, viewport, "+");
      key(dom, viewport, "+");
      expect(transformOf(stage).scale).toBeCloseTo(4);
      const start = transformOf(stage);
      pointer(dom, viewport, "pointerdown", { x: 200, y: 150 });
      pointer(dom, viewport, "pointermove", { x: 230, y: 160 });
      expect(transformOf(stage).x).toBeCloseTo(start.x + 30);
      expect(transformOf(stage).y).toBeCloseTo(start.y + 10);
      expect(viewport.dataset.dragging).toBe("true");
      pointer(dom, viewport, "pointermove", { x: 5000, y: 5000 });
      pointer(dom, viewport, "pointerup", { x: 5000, y: 5000 });
      // The diagram's left and top edges stop at the viewport's edges.
      expect(transformOf(stage).x).toBeCloseTo(-100 * 4);
      expect(transformOf(stage).y).toBeCloseTo(-100 * 4);
      expect(viewport.dataset.dragging).toBeUndefined();

      content.click();
      expect(clicks).toEqual([]);
      content.click();
      expect(clicks).toEqual(["content"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("fullscreen opens a fitted full-size dialog with actions and returns focus on Escape", async () => {
    const exported: string[] = [];
    const { dom, dispose, viewport } = await mount({
      title: "Architecture",
      content: () => <span class="fullscreen-copy">Node</span>,
      actions: [
        { label: "SVG", icon: "ti ti-download", onSelect: () => void exported.push("svg") },
        {
          label: "PNG",
          onSelect: async () => {
            await Bun.sleep(1);
            exported.push("png");
          },
        },
      ],
    });
    try {
      key(dom, viewport, "+");
      const trigger = button(viewport, "Open fullscreen");
      trigger.focus();
      trigger.click();
      await settle();
      const dialog = dom.document.querySelector("dialog")!;
      expect(dialog.className).toContain("k2b-dialog--full");
      expect(dialog.getAttribute("aria-label")).toBe("Architecture");
      expect(dialog.querySelector("h2")?.textContent).toBe("Architecture");
      const inner = dialog.querySelector<HTMLElement>(".k2b-zoom-pan")!;
      expect(inner.querySelector(".fullscreen-copy")).not.toBeNull();
      expect(inner.querySelector<HTMLElement>(".k2b-zoom-pan__stage")!.style.transform).toContain("scale(1)");
      expect(button(inner, "Open fullscreen")).toBeNull();
      await until(() => dom.document.activeElement === inner);
      expect(dom.document.activeElement).toBe(inner);

      const actions = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".k2b-dialog__actions button"));
      expect(actions.map((action) => action.textContent?.trim())).toEqual(["SVG", "PNG"]);
      actions[0]!.click();
      actions[1]!.click();
      await until(() => exported.length === 2);
      expect(exported).toEqual(["svg", "png"]);

      dialog.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }) as unknown as Event);
      await until(() => dom.document.activeElement === trigger);
      expect(dom.document.querySelector("dialog")).toBeNull();
      expect(dom.document.activeElement).toBe(trigger);

      viewport.focus();
      key(dom, viewport, "F");
      await settle();
      expect(dom.document.querySelector("dialog")).not.toBeNull();
      dom.document.querySelector("dialog")!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }) as unknown as Event);
      await until(() => dom.document.activeElement === viewport);
      expect(dom.document.activeElement).toBe(viewport);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
