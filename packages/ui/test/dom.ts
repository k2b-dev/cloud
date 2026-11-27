import { Window } from "happy-dom";
import { pendingLoadsKey } from "../src/internal/pending-loads";

export type DomTestHarness = {
  window: Window;
  document: Document;
  root: HTMLElement;
  /** Removes the DOM; with library loads still running, the window stays until they end (or the next harness starts). */
  cleanup: () => Promise<void>;
};

// The library's loads that run while a harness exists, such as the prompt fields a focus preloads
// (src/internal/pending-loads.ts). A chunk that ran without a window stays broken for the rest of the process.
const pendingLoads = new Set<Promise<unknown>>();
Reflect.set(globalThis, pendingLoadsKey, pendingLoads);
/** The teardown of a harness that waits for loads; the next harness finishes it first, and the load runs on in its window. */
let unfinished: (() => void) | undefined;

const globalBindings = (window: Window): Record<string, unknown> => ({
  window,
  self: window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  history: window.history,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  SVGElement: window.SVGElement,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  // A browser always has it, and a shared primitive may read it while it renders (a v2 menu or dialog asks whether
  // the window is the phone), so every behavior test gets it as a browser would.
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});

export function createDomTestHarness(): DomTestHarness {
  unfinished?.();
  const window = new Window({ url: "http://localhost/" });
  const bindings = globalBindings(window);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = globalThis as unknown as Record<string, unknown>;

  for (const [name, value] of Object.entries(bindings)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }

  const root = window.document.createElement("div");
  root.dataset.testRoot = "";
  window.document.body.append(root);

  let torn = false;
  let tornDown = () => {};
  const handedOver = new Promise<void>((resolve) => (tornDown = resolve));
  const teardown = () => {
    if (torn) return;
    torn = true;
    tornDown();
    if (unfinished === teardown) unfinished = undefined;
    // window.close() only closes script-opened windows, not this detached window.
    // Happy DOM cancels its timers synchronously before finishing async teardown.
    void window.happyDOM.close();

    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
  };

  let cleaned: Promise<void> | undefined;
  return {
    window,
    document: window.document as unknown as Document,
    root: root as unknown as HTMLElement,
    cleanup: () => {
      if (cleaned) return cleaned;
      root.remove();
      if (pendingLoads.size === 0) {
        teardown();
        cleaned = Promise.resolve();
        return cleaned;
      }
      unfinished = teardown;
      cleaned = (async () => {
        while (pendingLoads.size > 0 && !torn) await Promise.race([Promise.allSettled([...pendingLoads]), handedOver]);
        teardown();
      })();
      return cleaned;
    },
  };
}
