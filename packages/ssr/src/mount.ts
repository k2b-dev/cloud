import { fromJSON } from "seroval";
import type { Component } from "solid-js";
import { createComponent, ErrorBoundary, render } from "solid-js/web";

/** Props received by a configured island error fallback component. */
export type IslandErrorProps = {
  error: unknown;
  reset: () => void;
};

const defaultFallback = (reset: () => void): HTMLDivElement => {
  const alert = document.createElement("div");
  alert.setAttribute("role", "alert");
  alert.setAttribute("data-ssr-error", "");
  alert.append("This part of the page could not be displayed. ");
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Try again";
  button.addEventListener("click", reset);
  alert.append(button);
  return alert;
};

const report = (element: HTMLElement, error: unknown, reset: () => void): void => {
  const event = new CustomEvent("ssr:island-error", {
    bubbles: true,
    cancelable: true,
    detail: { error, id: element.dataset.id, reset },
  });
  if (element.dispatchEvent(event)) globalThis.reportError(error);
};

type IslandRegistry = {
  /** Mounts one wrapper with the registering runtime's component and Solid instance, keyed by the entry's selector. */
  components: Map<string, (element: HTMLElement) => void>;
  /** The dispose function of each mounted wrapper. */
  mounted: WeakMap<HTMLElement, () => void>;
};
const islandsKey = Symbol.for("@k2b/ssr/islands");
const registry = (): IslandRegistry => {
  const shared: typeof globalThis & { [islandsKey]?: IslandRegistry } = globalThis;
  shared[islandsKey] ??= { components: new Map(), mounted: new WeakMap() };
  return shared[islandsKey];
};

const mountElement = <Props extends object>(
  element: HTMLElement,
  Component: Component<Props>,
  Fallback?: Component<IslandErrorProps>,
): void => {
  const { mounted } = registry();
  if (mounted.has(element)) return;
  const start = (): void => {
    try {
      element.innerHTML = "";
      const dispose = render(
        () =>
          createComponent(ErrorBoundary, {
            fallback: (error: unknown, reset: () => void) => {
              report(element, error, reset);
              if (!Fallback) return defaultFallback(reset);
              return createComponent(ErrorBoundary, {
                fallback: (fallbackError: unknown) => {
                  globalThis.reportError(fallbackError);
                  return defaultFallback(reset);
                },
                get children() {
                  return createComponent(Fallback, { error, reset });
                },
              });
            },
            get children() {
              // Props are data: JSON.parse and Seroval fromJSON never evaluate them.
              return createComponent(Component, fromJSON<Props>(JSON.parse(element.dataset.props ?? "")));
            },
          }),
        element,
      );
      mounted.set(element, dispose);
    } catch (error) {
      report(element, error, start);
      element.replaceChildren(defaultFallback(start));
      mounted.set(element, () => element.replaceChildren());
    }
  };
  start();
};

const wrappers = (root: ParentNode): HTMLElement[] => {
  const elements = [...root.querySelectorAll<HTMLElement>("solid-island,solid-client")];
  if (root instanceof HTMLElement && root.matches("solid-island,solid-client")) elements.unshift(root);
  return elements;
};

/** Mount each island/client instance in its own error boundary. */
export const mount = <Props extends object>(
  Component: Component<Props>,
  selector: string,
  Fallback?: Component<IslandErrorProps>,
): void => {
  const mountOne = (element: HTMLElement) => mountElement(element, Component, Fallback);
  registry().components.set(selector, mountOne);
  document.querySelectorAll<HTMLElement>(selector).forEach(mountOne);
};

/** Internal navigation API: mount registered wrappers in document order, including root itself. */
export const mountIslands = (root: ParentNode): void => {
  const { components } = registry();
  for (const element of wrappers(root)) {
    components.get(`${element.localName}[data-id="${element.dataset.id}"]`)?.(element);
  }
};

/**
 * Internal navigation API: notify then dispose mounted wrappers in document order, including root itself.
 * Call while wrappers are still in the document so ssr:island-dispose reaches window listeners before Solid cleanups.
 */
export const disposeIslands = (root: ParentNode): void => {
  const { mounted } = registry();
  for (const element of wrappers(root)) {
    const dispose = mounted.get(element);
    if (!dispose) continue;
    element.dispatchEvent(new CustomEvent("ssr:island-dispose", { bubbles: true, detail: { id: element.dataset.id } }));
    try {
      dispose();
    } catch (error) {
      globalThis.reportError(error);
    } finally {
      mounted.delete(element);
    }
  }
};
