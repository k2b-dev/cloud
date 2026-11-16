import { getOwner, onCleanup } from "solid-js";
import { swapPage } from "./nav-swap";
import { type BeforeLeaveEvent, onBeforeLeave } from "./nav-veto";

export type UnsavedInputOptions = {
  /** Whether leaving now would lose input. Read on every way out. */
  dirty: () => boolean;
  /**
   * Asks the person before a page swap leaves; `true` leaves, `false` or `undefined` (a dismissed dialog) stays.
   * A document load (reload, closed tab, link to another scope, or a swap that fell back) asks the browser's own
   * dialog instead.
   */
  confirm: (url: URL) => boolean | undefined | Promise<boolean | undefined>;
};

/**
 * Protects unsaved input on every way out of the calling island's page, so a page swap asks the same question as a
 * document load: `confirm` before a swap, the browser's `beforeunload` dialog before a document load.
 *
 * One question at a time: navigations while it is open stay vetoed, and the answer applies to the newest of them.
 * A confirmed navigation passes this guard once, also when it falls back to a document load. If another guard
 * vetoes it, or a newer navigation replaces it, the input is protected again. Nothing happens after disposal.
 * Call it while the island renders or in onMount; it ends with the island's owner or the returned function.
 */
export function protectUnsavedInput(options: UnsavedInputOptions): () => void {
  if (typeof window === "undefined") return () => {};
  let disposed = false;
  /** The navigation the person confirmed, on its way out; `delta` only for a repeated Back. */
  let passing: { href: string; delta?: number } | undefined;
  /** The newest vetoed navigation while a question is open; the answer applies to it. */
  let waiting: BeforeLeaveEvent | undefined;
  const unload = (event: BeforeUnloadEvent) => {
    if (!passing && options.dirty()) event.preventDefault();
  };
  window.addEventListener("beforeunload", unload);
  const ask = async (): Promise<void> => {
    // Ask once history is back on this page.
    await waiting?.restored;
    if (disposed || !waiting) return;
    const leave = await options.confirm(new URL(waiting.url.href));
    const chosen = waiting;
    waiting = undefined;
    if (disposed || !leave) return;
    // A navigation vetoed while the question was open may still be rolling back.
    await chosen.restored;
    if (disposed || waiting) return;
    // A history-backed dialog replaced the forward entries: only Back can traverse again.
    if (chosen.delta !== undefined && chosen.delta < 0) {
      passing = { href: chosen.url.href, delta: chosen.delta };
      window.history.go(chosen.delta);
    } else {
      passing = { href: chosen.url.href };
      void swapPage(chosen.url.href);
    }
  };
  const stopLeave = onBeforeLeave((event) => {
    const confirmed = passing;
    passing = undefined;
    if (confirmed?.href === event.url.href && confirmed.delta === event.delta) {
      // Let the confirmed navigation pass. `restored` resolves only when some guard vetoed it: protect again then.
      passing = confirmed;
      void event.restored.then(() => {
        if (passing === confirmed) passing = undefined;
      });
      return;
    }
    if (!options.dirty()) return;
    event.preventDefault();
    const open = waiting !== undefined;
    waiting = event;
    if (!open) void ask().catch((error: unknown) => globalThis.reportError(error));
  });
  const dispose = () => {
    disposed = true;
    waiting = undefined;
    stopLeave();
    window.removeEventListener("beforeunload", unload);
  };
  if (getOwner()) onCleanup(dispose);
  return dispose;
}
