import { getOwner, onCleanup } from "solid-js";
import { swapPage } from "./nav-swap";
import { onBeforeLeave } from "./nav-veto";

export type UnsavedInputOptions = {
  /** Whether leaving now would lose input. Read on every way out. */
  dirty: () => boolean;
  /**
   * Asks the person before a page swap leaves; `true` leaves, `false` or `undefined` (a dismissed dialog) stays. A document load (reload, closed tab, link to
   * another scope, or a swap that fell back) asks the browser's own dialog instead.
   */
  confirm: (url: URL) => boolean | undefined | Promise<boolean | undefined>;
};

/**
 * Protects unsaved input on every way out of the calling island's page, so a page swap asks the same question as a
 * document load: `confirm` before a swap, the browser's `beforeunload` dialog before a document load. After the
 * person confirms, the island is on its way out and does not ask again, also when the swap then falls back to a
 * document load. Call it while the island renders or in onMount; it ends with the island's owner or the returned
 * function.
 */
export function protectUnsavedInput(options: UnsavedInputOptions): () => void {
  if (typeof window === "undefined") return () => {};
  let released = false;
  const unload = (event: BeforeUnloadEvent) => {
    if (!released && options.dirty()) event.preventDefault();
  };
  window.addEventListener("beforeunload", unload);
  const stopLeave = onBeforeLeave((event) => {
    if (released || !options.dirty()) return;
    event.preventDefault();
    // Ask once history is back on this page, then repeat the navigation the person chose.
    void event.restored
      .then(() => options.confirm(event.url))
      .then((leave) => {
        if (!leave) return;
        released = true;
        // A history-backed dialog replaced the forward entries: only Back can traverse again.
        if (event.delta !== undefined && event.delta < 0) window.history.go(event.delta);
        else void swapPage(event.url.href);
      })
      .catch((error: unknown) => globalThis.reportError(error));
  });
  const dispose = () => {
    stopLeave();
    window.removeEventListener("beforeunload", unload);
  };
  if (getOwner()) onCleanup(dispose);
  return dispose;
}
