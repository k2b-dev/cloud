import { Window } from "happy-dom";

export type DomTestHarness = {
  window: Window;
  document: Document;
  root: HTMLElement;
  cleanup: () => void;
};

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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});

export function createDomTestHarness(): DomTestHarness {
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

  let cleaned = false;
  return {
    window,
    document: window.document as unknown as Document,
    root: root as unknown as HTMLElement,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      root.remove();
      window.close();

      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globals[name];
      }
    },
  };
}
