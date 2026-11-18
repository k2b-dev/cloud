import { expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isServer, render } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../src/styles/css-contract-test-helpers";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
      // The primary button stays pressed from pointerdown until the release.
      buttons: type === "pointerdown" || type === "pointermove" ? 1 : 0,
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

  test("wheel overscroll adds up at the top without moving the indicator, resets when scrolling back, and triggers once", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.wheel(view.row, -60);
      expect(view.state()).toBe("idle");
      view.wheel(view.row, 20);
      view.wheel(view.row, -60);
      view.wheel(view.row, -60);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(0);
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

  test("trackpad momentum after a wheel refresh slides the indicator in once and never starts a second refresh", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const view = await mount(dom);
    const states: string[] = [];
    const record = () => {
      if (states.at(-1) !== view.state()) states.push(view.state()!);
    };
    const flush = async () => {
      for (let step = 0; step < 5; step++) await Promise.resolve();
    };
    // A flick: fast upward deltas that decay, one every 16 ms, for about 1.3 s.
    const momentum = async (from: number, frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        view.wheel(view.row, -Math.max(1, from * 0.94 ** frame));
        record();
        jest.advanceTimersByTime(16);
        await flush();
        record();
      }
    };
    try {
      record();
      await momentum(60, 20);
      // The refresh is quick and settles while the momentum still runs.
      expect(view.calls).toHaveLength(1);
      view.calls[0]!.resolve();
      await flush();
      record();
      await momentum(25, 60);
      jest.advanceTimersByTime(1000);
      await flush();
      record();

      expect(view.calls).toHaveLength(1);
      expect(states).toEqual(["idle", "refreshing", "idle"]);

      // Once the gesture rested and the indicator left, a new overscroll refreshes again.
      view.wheel(view.row, -200);
      expect(view.calls).toHaveLength(2);
      view.calls[1]!.resolve();
      await flush();
    } finally {
      view.dispose();
      dom.cleanup();
      jest.useRealTimers();
    }
  });

  test("a refresh stays calm until its indicator has left, then the next pull may start", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const view = await mount(dom);
    const flush = async () => {
      for (let step = 0; step < 5; step++) await Promise.resolve();
    };
    try {
      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 240);
      view.touch("touchend", view.row, 240);
      expect(view.calls).toHaveLength(1);
      view.calls[0]!.resolve();
      await flush();
      expect(view.state()).toBe("idle");

      // The indicator is still sliding out: a pull now does nothing.
      view.touch("touchstart", view.row, 100);
      expect(view.touch("touchmove", view.row, 240)).toBe(false);
      view.touch("touchend", view.row, 240);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(1);

      jest.advanceTimersByTime(200);
      // A touch refresh leaves no wheel gesture behind: the first overscroll counts.
      view.wheel(view.row, -200);
      expect(view.calls).toHaveLength(2);
      view.calls[1]!.resolve();
      await flush();
    } finally {
      view.dispose();
      dom.cleanup();
      jest.useRealTimers();
    }
  });

  test("momentum of a scroll that reaches the top is not a pull, and a fresh gesture after a pause is", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.port.scrollTop = 120;
      view.wheel(view.row, -60);
      jest.advanceTimersByTime(16);
      // The list reaches its top while the flick still runs.
      view.port.scrollTop = 0;
      for (let frame = 0; frame < 30; frame++) {
        view.wheel(view.row, -40);
        jest.advanceTimersByTime(16);
      }
      expect(view.calls).toHaveLength(0);
      expect(view.state()).toBe("idle");

      jest.advanceTimersByTime(300);
      view.wheel(view.row, -200);
      expect(view.calls).toHaveLength(1);
      view.calls[0]!.resolve();
      for (let step = 0; step < 5; step++) await Promise.resolve();
    } finally {
      view.dispose();
      dom.cleanup();
      jest.useRealTimers();
    }
  });

  test("a failed refresh marks the indicator in place, announces it, and leaves calmly", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    const view = await mount(dom);
    const flush = async () => {
      for (let step = 0; step < 5; step++) await Promise.resolve();
    };
    const status = () => view.root.querySelector('[role="status"]')!;
    try {
      view.wheel(view.row, -200);
      expect(view.state()).toBe("refreshing");
      view.calls[0]!.reject(new Error("offline"));
      await flush();

      expect(view.state()).toBe("error");
      expect(view.root.style.getPropertyValue("--k2b-pull-to-refresh-distance")).toBe("64px");
      expect(status().querySelector("i")?.className).toBe("ti ti-exclamation-mark");
      expect(status().querySelector(".k2b-sr-only")?.textContent).toBe("Refresh failed");
      expect(status().querySelector(".k2b-pull-to-refresh__message")?.textContent).toBe("Refresh failed");
      expect(status().querySelector(".k2b-pull-to-refresh__message")?.getAttribute("aria-hidden")).toBe("true");

      // While the mark shows, no input starts another refresh.
      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 300);
      view.touch("touchend", view.row, 300);
      jest.advanceTimersByTime(400);
      view.wheel(view.row, -400);
      expect(view.calls).toHaveLength(1);

      // 400 ms have passed; the mark shows for 2600 ms in all.
      jest.advanceTimersByTime(2200);
      expect(view.state()).toBe("idle");
      expect(status().querySelector(".k2b-sr-only")?.textContent).toBe("");
      // The hint slides out with the indicator instead of vanishing first.
      expect(status().querySelector(".k2b-pull-to-refresh__message")?.textContent).toBe("Refresh failed");
      jest.advanceTimersByTime(200);
      expect(status().textContent).toBe("");
      view.wheel(view.row, -200);
      expect(view.calls).toHaveLength(2);
      view.calls[1]!.resolve();
      await flush();
    } finally {
      view.dispose();
      dom.cleanup();
      jest.useRealTimers();
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
      // Wait until the indicator has left, so the drags below are really tried.
      await new Promise((resolve) => setTimeout(resolve, 250));

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

  test("a press released outside the wrapper ends there, so a later hover never pulls or holds text selection", async () => {
    const dom = createDomTestHarness();
    const view = await mount(dom);
    try {
      view.pointer("pointerdown", view.row, 100);
      view.pointer("pointermove", view.row, 60);
      // The release happens above the wrapper, which hears no pointerup.
      expect(view.pointer("pointermove", view.row, 300, { buttons: 0 })).toBe(false);
      expect(view.state()).toBe("idle");
      expect(view.root.hasPointerCapture(7)).toBe(false);
      expect(document.documentElement.style.getPropertyValue("user-select")).toBe("");
      view.pointer("pointermove", view.row, 300);
      view.pointer("pointerup", view.row, 300);
      expect(view.state()).toBe("idle");
      expect(view.calls).toHaveLength(0);

      view.pointer("pointerdown", view.row, 100);
      view.pointer("pointermove", view.row, 240);
      expect(view.state()).toBe("ready");
      expect(document.documentElement.style.getPropertyValue("user-select")).toBe("none");
      view.pointer("pointermove", view.row, 240, { buttons: 0 });
      expect(view.state()).toBe("idle");
      expect(document.documentElement.style.getPropertyValue("user-select")).toBe("");
      expect(view.calls).toHaveLength(0);
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

  test("the refreshing spinner owns its rotation while the pull progress turns a separate wrapper", async () => {
    const dom = createDomTestHarness();
    dom.root.classList.add("k2b-ui");
    const view = await mount(dom);
    try {
      view.touch("touchstart", view.row, 100);
      view.touch("touchmove", view.row, 240);
      view.touch("touchend", view.row, 240);
      expect(view.state()).toBe("refreshing");

      const spinner = view.root.querySelector<HTMLElement>(".k2b-spin")!;
      const stylesDir = resolve(import.meta.dir, "../src/styles");
      const matching = (element: Element) =>
        readShippedCssRules(stylesDir).filter((rule) => {
          if (rule.context || rule.selector.includes("::")) return false;
          try {
            return element.matches(rule.selector);
          } catch {
            return false;
          }
        });
      const spinnerRules = matching(spinner);
      const progressRules = matching(spinner.parentElement!).filter((rule) =>
        cssDeclarations(rule.body)
          .get("transform")
          ?.some((value) => value.includes("--k2b-pull-to-refresh-progress")),
      );

      expect(spinnerRules.some((rule) => cssDeclarations(rule.body).get("animation")?.[0]?.includes("k2b-spin"))).toBe(true);
      // A static transform on the spinning element becomes the implicit start keyframe and freezes the spin.
      expect(spinnerRules.filter((rule) => cssDeclarations(rule.body).has("transform")).map((rule) => rule.selector)).toEqual([]);
      expect(progressRules).toHaveLength(1);
      expect(readFileSync(resolve(stylesDir, "index.css"), "utf8")).toMatch(
        /@keyframes k2b-spin \{\s*from \{\s*transform: rotate\(0deg\);\s*\}\s*to \{\s*transform: rotate\(360deg\);/,
      );
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });
}
