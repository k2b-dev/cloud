import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(dom: DomTestHarness, options: { disabled?: boolean } = {}) {
  const { default: PullToRefresh } = await import("../src/layout/PullToRefresh");
  const calls: Deferred[] = [];
  const onRefresh = () => {
    const next = deferred();
    calls.push(next);
    return next.promise;
  };
  const dispose = render(
    () => (
      <PullToRefresh onRefresh={onRefresh} disabled={options.disabled} label="Refreshing mail">
        <div class="port">
          <p class="row">Row</p>
          <a class="link" href="#link">
            Link
          </a>
        </div>
      </PullToRefresh>
    ),
    dom.root,
  );
  const root = dom.root.firstElementChild as HTMLElement;
  const port = root.querySelector<HTMLElement>(".port")!;
  const row = root.querySelector<HTMLElement>(".row")!;
  const link = root.querySelector<HTMLElement>(".link")!;
  const state = () => root.dataset.state;
  const win = dom.window as unknown as { Event: typeof Event; WheelEvent: typeof WheelEvent; PointerEvent: typeof PointerEvent };
  const touch = (type: string, target: HTMLElement, clientY: number) => {
    const event = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ identifier: 1, clientY }] });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const wheel = (target: HTMLElement, deltaY: number) => target.dispatchEvent(new win.WheelEvent("wheel", { bubbles: true, deltaY }));
  const pointer = (type: string, target: HTMLElement, clientY: number, init: Partial<PointerEventInit> = {}) => {
    const event = new win.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: "mouse",
      button: 0,
      clientY,
      ...init,
    });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  return { dispose, root, port, row, link, calls, state, touch, wheel, pointer };
}

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("a touch pull past the threshold refreshes once and stays busy until the refresh settles", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      expect(view.state()).toBe("idle");
      view.touch("touchstart", view.row, 100);
      expect(view.touch("touchmove", view.row, 140)).toBe(true);
      expect(view.state()).toBe("pulling");
      expect(view.root.style.getPropertyValue("--k2b-pull-to-refresh-distance")).toBe("20px");
      view.touch("touchmove", view.row, 240);
      expect(view.state()).toBe("ready");
      view.touch("touchend", view.row, 240);
      expect(view.state()).toBe("refreshing");
      expect(view.calls).toHaveLength(1);
      expect(view.root.querySelector('[role="status"]')?.textContent).toBe("Refreshing mail");
      expect(view.root.querySelector("i")?.className).toContain("k2b-spin");

      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 300);
      view.touch("touchend", view.row, 300);
      view.wheel(view.row, -400);
      expect(view.calls).toHaveLength(1);

      view.calls[0]!.resolve();
      await settle();
      expect(view.state()).toBe("idle");
      expect(view.root.querySelector('[role="status"]')?.textContent).toBe("");
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });

  test("a short or upward touch never refreshes and a cancelled pull resets", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 130);
      view.touch("touchend", view.row, 130);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(0);

      view.touch("touchstart", view.row, 100);
      expect(view.touch("touchmove", view.row, 60)).toBe(false);
      view.touch("touchmove", view.row, 300);
      expect(view.state()).toBe("idle");

      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 300);
      expect(view.state()).toBe("ready");
      view.touch("touchcancel", view.row, 300);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(0);
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });

  test("wheel overscroll accumulates at the top, resets when scrolling back, and triggers once", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.wheel(view.row, -60);
      expect(view.state()).toBe("pulling");
      view.wheel(view.row, 20);
      expect(view.state()).toBe("idle");
      view.wheel(view.row, -60);
      view.wheel(view.row, -60);
      expect(view.state()).toBe("pulling");
      view.wheel(view.row, -20);
      expect(view.state()).toBe("refreshing");
      view.wheel(view.row, -200);
      view.wheel(view.row, -200);
      expect(view.calls).toHaveLength(1);
      view.calls[0]!.resolve();
      await settle();
      expect(view.state()).toBe("idle");
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });

  test("a mouse drag on free space refreshes, while drags on links and clicks do not", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      expect(view.pointer("pointerdown", view.row, 100)).toBe(false);
      expect(view.pointer("pointermove", view.row, 90)).toBe(false);
      expect(view.state()).toBe("idle");
      expect(view.pointer("pointermove", view.row, 150)).toBe(true);
      expect(view.state()).toBe("pulling");
      expect(view.root.hasPointerCapture(7)).toBe(true);
      view.pointer("pointermove", view.row, 240);
      expect(view.state()).toBe("ready");
      view.pointer("pointerup", view.row, 240);
      expect(view.calls).toHaveLength(1);
      view.calls[0]!.resolve();
      await settle();

      view.pointer("pointerdown", view.link, 100);
      view.pointer("pointermove", view.link, 300);
      view.pointer("pointerup", view.link, 300);
      expect(view.state()).toBe("idle");

      view.pointer("pointerdown", view.row, 100);
      view.pointer("pointerup", view.row, 100);
      expect(view.state()).toBe("idle");

      view.pointer("pointerdown", view.row, 100, { pointerType: "touch" });
      view.pointer("pointermove", view.row, 300, { pointerType: "touch" });
      expect(view.state()).toBe("idle");

      view.pointer("pointerdown", view.row, 100);
      view.pointer("pointermove", view.row, 300);
      view.pointer("pointercancel", view.row, 300);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(1);
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });

  test("nothing starts while the container is scrolled or the gesture is disabled", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.port.scrollTop = 40;
      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 300);
      view.touch("touchend", view.row, 300);
      view.wheel(view.row, -400);
      view.pointer("pointerdown", view.row, 100);
      view.pointer("pointermove", view.row, 300);
      view.pointer("pointerup", view.row, 300);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(0);
    } finally {
      view.dispose();
      dom.cleanup();
    }

    const disabledDom = createDomTestHarness();
    const disabled = await mount(disabledDom, { disabled: true });
    try {
      disabled.wheel(disabled.row, -400);
      disabled.touch("touchstart", disabled.row, 100);
      disabled.touch("touchmove", disabled.row, 300);
      disabled.touch("touchend", disabled.row, 300);
      expect(disabled.state()).toBe("idle");
      expect(disabled.calls).toHaveLength(0);
    } finally {
      disabled.dispose();
      disabledDom.cleanup();
    }
  });
}
