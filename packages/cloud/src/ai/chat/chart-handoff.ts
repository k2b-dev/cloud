import type { JSX } from "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "cloud-chart-drawing": JSX.HTMLAttributes<HTMLElement>;
    }
  }
}

/** Only drawing SVGs, never toolbar or legend icons. */
export const drawingSvg = ".k2b-chart__svg > svg";

/** A stable 64-bit FNV-1a fingerprint keeps chart data out of the handoff attribute. */
export const drawingKey = (name: string, props: object): string => {
  const source = JSON.stringify([name, props], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(source.charCodeAt(index))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
};

/**
 * The ordinary island mount removes its server children synchronously. A chart's custom element can hand its
 * detached subtree directly to its matching client wrapper during that same call, without delaying the island.
 * Unclaimed subtrees expire at the next microtask; no document/history cache or SSR runtime hook is needed.
 */
const handoff = Symbol.for("@k2b/cloud/chart-handoff");
export function chartHandoff() {
  const shared: typeof globalThis & { [handoff]?: (key: string) => HTMLElement | undefined } = globalThis;
  if (shared[handoff]) return shared[handoff];
  const removed = new Set<HTMLElement>();
  const claimed = new WeakSet<HTMLElement>();
  customElements.define(
    "cloud-chart-drawing",
    class extends HTMLElement {
      disconnectedCallback() {
        if (!this.hasAttribute("data-cloud-chart-server") || claimed.has(this) || !this.querySelector(drawingSvg)) return;
        removed.add(this);
        queueMicrotask(() => removed.delete(this));
      }
    },
  );
  shared[handoff] = (key: string): HTMLElement | undefined => {
    const element = [...removed].find((node) => node.dataset.cloudChartKey === key);
    if (element) {
      removed.delete(element);
      claimed.add(element);
    }
    return element;
  };
  return shared[handoff];
}
