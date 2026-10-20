import { getOwner, onCleanup } from "solid-js";
import { islandOf } from "./mount";

export type BeforeLeaveEvent = {
  /** Where the swap would go (absolute URL). */
  readonly url: URL;
  /** Back/Forward only: how many entries history moved, negative for Back. Undefined for a click or swapPage(). */
  readonly delta?: number;
  /**
   * Resolves once nav undid the vetoed navigation and history is back on this page's entry: right away for a click
   * or swapPage(), after the rollback for Back/Forward. Open history-backed dialogs only then.
   * Never rejects. If nobody vetoes, it never resolves.
   */
  readonly restored: Promise<void>;
  /** Keeps the person on this page. */
  preventDefault(): void;
};

type Check = { check: (event: BeforeLeaveEvent) => void; element?: HTMLElement };
const vetoKey = Symbol.for("@k2b/ssr/nav-veto");
const shared: typeof globalThis & { [vetoKey]?: Set<Check> } = globalThis;

/**
 * Asks `check` before nav swaps the column that holds the calling island. Call it while the island renders or in
 * onMount: the registration ends with the island's owner (onCleanup). The returned function also ends it.
 */
export function onBeforeLeave(check: (event: BeforeLeaveEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const owner = getOwner();
  const registration = { check, element: owner ? islandOf(owner) : undefined };
  shared[vetoKey] ??= new Set();
  const checks = shared[vetoKey];
  checks.add(registration);
  const dispose = () => {
    checks.delete(registration);
  };
  if (owner) onCleanup(dispose);
  return dispose;
}

/** Internal swap gate: returns a veto's restoration resolver, or undefined when all checks allow leaving. */
export const allowsLeave = (root: HTMLElement, url: URL, delta?: number): (() => void) | undefined => {
  let restore = () => {};
  const restored = new Promise<void>((resolve) => {
    restore = resolve;
  });
  const checks = shared[vetoKey];
  for (const registration of [...(checks ?? [])]) {
    const { check, element } = registration;
    if (!checks?.has(registration) || (element && (!element.isConnected || !root.contains(element)))) continue;
    let prevented = false;
    try {
      check({
        url: new URL(url.href),
        delta,
        restored,
        preventDefault: () => {
          prevented = true;
        },
      });
    } catch (error) {
      // Even a check that prevented before throwing must not trap the person on this page.
      globalThis.reportError(error);
      continue;
    }
    if (prevented) return restore;
  }
  return undefined;
};
