import { expect, spyOn, test } from "bun:test";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

test("a summary measures its initial controls before paint and defers observer changes to one cancellable frame", async () => {
  const dom = createDomTestHarness();
  dom.document.documentElement.style.fontSize = "16px";
  let notify: ((width: number) => void) | undefined;
  let disconnected = false;
  class Observer implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      notify = (width) =>
        this.callback(
          [
            {
              target,
              contentRect: new dom.window.DOMRect(0, 0, width, 64),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          this,
        );
    }
    unobserve() {}
    disconnect() {
      disconnected = true;
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  const original = HTMLElement.prototype.getBoundingClientRect;
  const box = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("k2b-notice-card-container") ? new dom.window.DOMRect(0, 0, 390, 64) : original.call(this);
  });
  const frames = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const { NoticeRow } = await import("../src/surfaces/NoticeRow");
  let dispose: (() => void) | undefined;
  try {
    dispose = render(
      () => (
        <NoticeRow detail="Version saved" reserve={false} actions={({ narrow }) => <button>{narrow ? "Phone" : "Desktop"}</button>}>
          Saved.
        </NoticeRow>
      ),
      dom.root,
    );
    expect(dom.root.querySelector("button")?.textContent).toBe("Phone");
    expect(frames.size).toBe(0);
    notify!(800);
    expect(dom.root.querySelector("button")?.textContent).toBe("Phone");
    expect(frames.size).toBe(1);
    const frame = [...frames.values()][0]!;
    frames.clear();
    frame(0);
    expect(dom.root.querySelector("button")?.textContent).toBe("Desktop");
    notify!(390);
    expect(frames.size).toBe(1);
    notify!(800);
    expect(frames.size).toBe(0);
    notify!(390);
    dispose();
    dispose = undefined;
    expect(disconnected).toBe(true);
    expect(frames.size).toBe(0);
  } finally {
    dispose?.();
    box.mockRestore();
    raf.mockRestore();
    cancel.mockRestore();
    dom.cleanup();
  }
});

test("a notice adds its body only while its children render something", async () => {
  const dom = createDomTestHarness();
  const { NoticeCard } = await import("../src/surfaces/NoticeCard");
  const [offered, setOffered] = createSignal(false);
  const dispose = render(
    () => (
      <NoticeCard tone="danger" title="The answer was interrupted." detail="The model service did not answer.">
        <Show when={offered()}>
          <button type="button">Continue</button>
        </Show>
      </NoticeCard>
    ),
    dom.root,
  );
  try {
    // No empty body, so the detail's gap to a body never adds space below the notice.
    expect(dom.root.querySelector(".k2b-notice-card__body")).toBeNull();
    setOffered(true);
    expect(dom.root.querySelector(".k2b-notice-card__body button")?.textContent).toBe("Continue");
    setOffered(false);
    expect(dom.root.querySelector(".k2b-notice-card__body")).toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("a notice adds its actions row only while the actions render something", async () => {
  const dom = createDomTestHarness();
  const { NoticeCard } = await import("../src/surfaces/NoticeCard");
  const [offered, setOffered] = createSignal(false);
  const dispose = render(
    () => (
      <NoticeCard
        tone="danger"
        title="Source unavailable"
        actions={
          <Show when={offered()}>
            <button type="button">Retry now</button>
          </Show>
        }
      />
    ),
    dom.root,
  );
  try {
    const card = dom.root.querySelector(".k2b-notice-card")!;
    expect(card.querySelector(".k2b-notice-card__actions")).toBeNull();
    expect(card.hasAttribute("data-actions")).toBe(false);
    setOffered(true);
    expect(card.querySelector(".k2b-notice-card__actions button")?.textContent).toBe("Retry now");
    expect(card.hasAttribute("data-actions")).toBe(true);
    setOffered(false);
    expect(card.querySelector(".k2b-notice-card__actions")).toBeNull();
    expect(card.hasAttribute("data-actions")).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});
