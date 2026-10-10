import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createComponent, type JSX } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

type MountedWindow = {
  dispose: () => void;
  frame: HTMLElement;
};

describe("FloatingWindow browser behaviour", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  let dom: DomTestHarness;
  let previousHTMLHeadElement: PropertyDescriptor | undefined;
  beforeAll(() => {
    dom = createDomTestHarness();
    Object.defineProperties(dom.window, {
      innerHeight: { configurable: true, value: 768 },
      innerWidth: { configurable: true, value: 1024 },
    });
    previousHTMLHeadElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLHeadElement");
    Object.defineProperty(globalThis, "HTMLHeadElement", {
      configurable: true,
      writable: true,
      value: dom.window.HTMLHeadElement,
    });
  });
  afterAll(() => {
    dom.cleanup();
    if (previousHTMLHeadElement) Object.defineProperty(globalThis, "HTMLHeadElement", previousHTMLHeadElement);
    else Reflect.deleteProperty(globalThis, "HTMLHeadElement");
  });

  const mountWindow = async (
    dom: DomTestHarness,
    title: string,
    onClose: () => void = () => {},
    children: JSX.Element = "Content",
  ): Promise<MountedWindow> => {
    const { default: FloatingWindow } = await import("../src/layout/FloatingWindow");
    const owner = dom.document.createElement("div");
    dom.root.append(owner);
    const disposeRoot = render(
      () =>
        createComponent(FloatingWindow, {
          title,
          onClose,
          children,
          resolveScope: () => owner,
        }),
      owner,
    );
    const frame = owner.querySelector<HTMLElement>(".k2b-floating-window");
    if (!frame) throw new Error(`FloatingWindow "${title}" did not render`);
    return {
      frame,
      dispose: () => {
        disposeRoot();
        owner.remove();
      },
    };
  };

  test("keeps layers compact and labels each window with a unique stable id", async () => {
    const first = await mountWindow(dom, "First");
    const second = await mountWindow(dom, "Second");

    expect(first.frame.style.zIndex).toBe("80");
    expect(second.frame.style.zIndex).toBe("81");
    const firstTitleId = first.frame.getAttribute("aria-labelledby");
    const secondTitleId = second.frame.getAttribute("aria-labelledby");
    expect(firstTitleId).toBeTruthy();
    expect(secondTitleId).toBeTruthy();
    expect(firstTitleId).not.toBe(secondTitleId);
    expect(first.frame.querySelector(`#${firstTitleId}`)?.textContent).toBe("First");
    expect(second.frame.querySelector(`#${secondTitleId}`)?.textContent).toBe("Second");

    first.frame.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, button: 0 }) as unknown as Event);
    expect(first.frame.style.zIndex).toBe("81");
    expect(second.frame.style.zIndex).toBe("80");

    first.dispose();
    expect(second.frame.style.zIndex).toBe("80");
    second.dispose();

    for (let index = 0; index < 32; index += 1) {
      const current = await mountWindow(dom, `Sequential ${index}`);
      expect(current.frame.style.zIndex).toBe("80");
      current.dispose();
    }
  });

  test("lets a nested widget consume Escape before closing the top window", async () => {
    const nested = dom.document.createElement("input");
    nested.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.preventDefault();
    });
    let closeCalls = 0;
    const mounted = await mountWindow(
      dom,
      "Nested Escape",
      () => {
        closeCalls += 1;
      },
      nested,
    );

    nested.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }) as unknown as Event,
    );
    expect(closeCalls).toBe(0);

    mounted.frame.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }) as unknown as Event,
    );
    expect(closeCalls).toBe(1);

    mounted.dispose();
  });

  test("removes active move and resize listeners on close or unmount", async () => {
    const trackedTypes = new Set(["pointermove", "pointerup", "pointercancel"]);
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const trackedWindow = dom.window as unknown as EventTarget;
    const originalAdd = trackedWindow.addEventListener.bind(trackedWindow);
    const originalRemove = trackedWindow.removeEventListener.bind(trackedWindow);
    trackedWindow.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (!listener) return;
      if (trackedTypes.has(type)) {
        const current = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        current.add(listener);
        listeners.set(type, current);
      }
      originalAdd(type, listener, options);
    }) as EventTarget["addEventListener"];
    trackedWindow.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      if (!listener) return;
      listeners.get(type)?.delete(listener);
      originalRemove(type, listener, options);
    }) as EventTarget["removeEventListener"];
    const activePointerListeners = () => [...listeners.values()].reduce((total, current) => total + current.size, 0);

    let closeCalls = 0;
    const moving = await mountWindow(dom, "Moving", () => {
      closeCalls += 1;
    });
    const header = moving.frame.querySelector("header");
    expect(header).not.toBeNull();
    expect(moving.frame.dataset.mobile).toBeUndefined();
    header!.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 40,
        clientY: 40,
      }) as unknown as Event,
    );
    // The drag's move, up, and cancel listeners, and the same three of its text-selection hold.
    expect(activePointerListeners()).toBe(6);

    moving.frame.querySelector<HTMLButtonElement>('[aria-label="Close window"]')?.click();
    expect(closeCalls).toBe(1);
    expect(activePointerListeners()).toBe(0);
    moving.dispose();

    const resizing = await mountWindow(dom, "Resizing");
    resizing.frame.querySelector<HTMLElement>('[data-edge="bottom-right"]')?.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 400,
        clientY: 400,
      }) as unknown as Event,
    );
    expect(activePointerListeners()).toBe(6);

    resizing.dispose();
    expect(activePointerListeners()).toBe(0);
  });

  test("ignores unrelated pointers while moving", async () => {
    const mounted = await mountWindow(dom, "Pointer ownership");
    const header = mounted.frame.querySelector("header")!;
    const before = mounted.frame.style.left;
    header.dispatchEvent(
      new dom.window.PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 100,
        pointerId: 7,
      }) as unknown as Event,
    );
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 500, clientY: 500, pointerId: 8 }));
    expect(mounted.frame.style.left).toBe(before);
    dom.window.dispatchEvent(new dom.window.PointerEvent("pointermove", { clientX: 140, clientY: 100, pointerId: 7 }));
    expect(mounted.frame.style.left).not.toBe(before);
    mounted.dispose();
  });
});
