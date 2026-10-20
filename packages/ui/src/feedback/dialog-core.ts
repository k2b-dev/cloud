import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { getK2bPortalRoot } from "../internal/portal";
import { RenderErrorBoundary } from "../internal/render-error";
import { resolveUiMessages } from "../intl/messages";
import { isPointInsideToast } from "./toast";

export type DialogClose<T> = (result?: T) => void;

export type OpenDialogOptions = {
  /** Close only this dialog when its owning operation is cancelled. */
  signal?: AbortSignal;
  panelClassName?: string;
  contentClassName?: string;
  initialFocus?: "first-input" | "none" | ((dialog: HTMLDialogElement) => HTMLElement | null);
  cancelBehavior?: "resolve-undefined" | "ignore";
  ariaLabel?: string;
  /**
   * Add a same-URL history entry while the dialog is open, so the browser's or the phone's Back closes the dialog
   * instead of leaving the page. Normally closing the dialog removes the entry again; the returned promise settles after that.
   * With the Navigation API, same-URL traversals between this core's entries and the page do not reach application popstate listeners.
   * Without it, only the synthetic Back on close is suppressed.
   * Island disposal closes every open dialog immediately and forgets its marker without traversing history.
   * The same-URL entry remains for the router to replace and counts as a page entry for later dialogs.
   * A traversal that `@k2b/ssr/nav` hides from popstate listeners reaches this core through `ssr:nav-popstate`.
   */
  history?: boolean;
};

export type DialogRender<T> = (
  close: DialogClose<T>,
  context: {
    dialog: HTMLDialogElement;
    /** Switch this entry between a modal and a modeless window without remounting. */
    setModal: (modal: boolean) => void;
    /** Set viewport coordinates, or restore the panel stylesheet position with null. */
    setPosition: (position: { x: number; y: number } | null) => void;
    /** Route Escape/backdrop through the same guarded handler as Cancel and X. */
    setDismissHandler: (handler: () => void | Promise<void>) => void;
    /** Request dismissal through this entry's cancellation policy and guard. */
    requestDismiss: () => Promise<void>;
  },
) => JSX.Element;

export type DialogCore = {
  open: <T>(view: DialogRender<T>, options?: OpenDialogOptions) => Promise<T | undefined>;
  close: (result?: unknown) => void;
  isOpen: () => boolean;
};

type DialogStackEntry = {
  container: HTMLDivElement;
  dispose?: () => void;
  resolve?: (value: unknown) => void;
  panelClassName: string;
  cancelBehavior: NonNullable<OpenDialogOptions["cancelBehavior"]>;
  initialFocus: NonNullable<OpenDialogOptions["initialFocus"]>;
  opener?: HTMLElement;
  openerRing: boolean;
  ariaLabel?: string;
  dismissHandler?: () => void | Promise<void>;
  dismissPending?: boolean;
  modal: boolean;
  position?: { x: number; y: number } | null;
  /** The marker of this dialog's history entry, for dialogs opened with `history`. */
  historyId?: number;
};

type DialogState = {
  element?: HTMLDialogElement;
  modal?: boolean;
  stack: DialogStackEntry[];
  scrollLocked?: boolean;
  previousBodyOverflow?: string;
  previousHtmlOverflow?: string;
  mouseDownOnDialog?: boolean;
  connectionObserver?: MutationObserver;
};

const DEFAULT_PANEL_CLASS = "k2b-dialog";
const DEFAULT_CONTENT_CLASS = "k2b-dialog__viewport";
/** The frame of a dialog whose content could not render: a custom or bare surface may draw no frame of its own. */
const RENDER_ERROR_PANEL_CLASS = "k2b-dialog k2b-dialog--small";
let nextDialogTitleId = 0;
let nextHistoryId = 0;
/** The history state key that marks a dialog's same-URL entry. */
const HISTORY_MARKER = "k2bDialog";

const historyRecord = (): Record<string, unknown> =>
  typeof history.state === "object" && history.state !== null ? { ...history.state } : {};
const historyMarker = (): unknown => historyRecord()[HISTORY_MARKER];
const historySnapshot = () => ({ href: location.href, length: history.length });

const resolveInitialFocusTarget = (entry: DialogStackEntry, dialog: HTMLDialogElement): HTMLElement | null => {
  const { initialFocus } = entry;
  if (initialFocus === "none") return null;
  if (typeof initialFocus === "function") return initialFocus(dialog);
  const input = entry.container.querySelector<HTMLElement>(
    "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role='combobox']:not([disabled]):not([aria-disabled='true'])",
  );
  return (
    input ??
    entry.container.querySelector<HTMLElement>(
      "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    )
  );
};

const applyAccessibleName = (dialog: HTMLDialogElement, entry: DialogStackEntry): void => {
  dialog.removeAttribute("aria-label");
  dialog.removeAttribute("aria-labelledby");
  if (entry.ariaLabel) {
    dialog.setAttribute("aria-label", entry.ariaLabel);
    return;
  }
  const heading = entry.container.querySelector<HTMLElement>("h1, h2, h3");
  if (!heading) {
    dialog.setAttribute("aria-label", resolveUiMessages().dialog);
    return;
  }
  heading.id ||= `k2b-dialog-title-${++nextDialogTitleId}`;
  dialog.setAttribute("aria-labelledby", heading.id);
};

const schedule = (callback: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else queueMicrotask(callback);
};

/**
 * Whether focus is still where closing a level left it, on the page or the
 * dialog: nothing took it before the next frame, neither a close handler nor a
 * Tab pressed right after Escape.
 */
const focusUnclaimed = (dialog: HTMLDialogElement): boolean => {
  const active = document.activeElement;
  return !active || active === document.body || active === dialog;
};

/** Checked by shape: a test harness or an iframe may create the event in another realm. */
const isPopState = (value: unknown): value is PopStateEvent =>
  typeof value === "object" && value !== null && "type" in value && value.type === "popstate" && "state" in value;

type HistoryEntry = { historyId?: number };
type HistoryHolder = HistoryEntry & { onBack: () => void };

export const createDialogCore = () => {
  const state: DialogState = { stack: [] };
  /** Markers of this core's entries in the browser history, oldest first. */
  let historyIds: number[] = [];
  const issued = new Set<number>();
  /**
   * Markers forgotten during island disposal. Their entries stay in `historyIds` as barriers: a synthetic Back never
   * crosses one, because the router may have replaced that entry with another page.
   */
  const forgotten = new Set<number>();
  const deadMarker = (marker: unknown): marker is number => typeof marker === "number" && forgotten.has(marker);
  /** How often islands were disposed, so a dialog that waits to open notices that a content swap happened meanwhile. */
  let disposals = 0;
  const ownMarker = (marker: unknown): marker is number => typeof marker === "number" && issued.has(marker);
  let seen: ReturnType<typeof historySnapshot> | undefined;
  let traversalFrom: { href: string; marker: unknown } | undefined;
  let syntheticFrom: { href: string; marker: unknown } | undefined;
  const historyHolders = new Set<HistoryHolder>();
  let historySyncScheduled = false;
  let disposingIslands = false;
  /** Settles when the synthetic Back that removes closed dialogs' entries has arrived. */
  let returning: Promise<void> | undefined;
  let resolveReturning: (() => void) | undefined;

  /** Outside island disposal, closed entries leave with one Back to the newest live dialog or holder, or to the page. */
  const syncHistory = () => {
    if (returning) {
      void returning.then(() => {
        if (historySyncScheduled) syncHistory();
      });
      return;
    }
    historySyncScheduled = false;
    const openIds = new Set([...state.stack, ...historyHolders].map((entry) => entry.historyId));
    const current = historyIds.at(-1);
    let steps = 0;
    while (historyIds.length > 0 && !openIds.has(historyIds.at(-1)) && !deadMarker(historyIds.at(-1))) {
      historyIds.pop();
      steps++;
    }
    // Someone else moved the history meanwhile; leave it alone.
    if (steps === 0 || historyMarker() !== current || location.href !== seen?.href || history.length !== seen?.length) return;
    const back = new Promise<void>((resolve) => {
      resolveReturning = resolve;
    });
    returning = back;
    void back.then(() => {
      if (returning === back) returning = undefined;
    });
    syntheticFrom = { href: location.href, marker: current };
    history.go(-steps);
  };

  const releaseHistory = (entry: HistoryEntry) => {
    if (entry.historyId === undefined) return;
    // During a content swap the router owns history. Forget the marker without moving history; its entry stays a
    // barrier for later synthetic Backs and is left for the router to replace.
    if (disposingIslands) {
      issued.delete(entry.historyId);
      forgotten.add(entry.historyId);
      entry.historyId = undefined;
      return;
    }
    if (historySyncScheduled) return;
    historySyncScheduled = true;
    queueMicrotask(syncHistory);
  };

  /** Traversals this core already handled: a page swap router also reports the ones it hides from listeners. */
  const handled = new WeakSet<PopStateEvent>();
  /** Back or Forward moved to another entry: close dialogs and holders opened after the one it shows. */
  const onPopState = (event: PopStateEvent) => {
    if (handled.has(event)) return;
    handled.add(event);
    const resolveBack = resolveReturning;
    // Without the Navigation API, only our synthetic Back has a known departure.
    const from = typeof navigation !== "undefined" ? traversalFrom : resolveBack ? syntheticFrom : undefined;
    traversalFrom = undefined;
    syntheticFrom = undefined;
    resolveReturning = undefined;
    try {
      const marker = historyMarker();
      if (from && from.href === location.href && from.marker !== marker && (ownMarker(from.marker) || ownMarker(marker))) {
        event.stopImmediatePropagation();
      }
      // Own entries are ordered by id. A retired entry reached by Forward stays tracked, so closing the dialogs
      // beneath it also removes it. A forgotten entry keeps the holders opened before it and stays a barrier.
      historyIds = ownMarker(marker) || deadMarker(marker) ? [...historyIds.filter((id) => id < marker), marker] : [];
      const gone = (entry: DialogStackEntry) => entry.historyId !== undefined && !historyIds.includes(entry.historyId);
      while (state.stack.some(gone)) popTop(undefined);
      for (const holder of [...historyHolders].reverse()) {
        if (holder.historyId === undefined || historyIds.includes(holder.historyId)) continue;
        historyHolders.delete(holder);
        releaseHistory(holder);
        holder.onBack();
      }
    } finally {
      seen = historySnapshot();
      resolveBack?.();
    }
  };

  /**
   * Island disposal means the page content changes, as a document load would. Every dialog closes, top first, whichever
   * code opened it: which island calls open() is not knowable after an await, in onMount or from a timer, and a modal
   * left over the new content would block it.
   */
  const onIslandDispose = () => {
    if (!disposingIslands) {
      disposingIslands = true;
      queueMicrotask(() => {
        disposingIslands = false;
      });
      // Entries released just before, whose Back has not started yet, stay as well: the router owns history now.
      // A Back already on its way still settles through `returning`.
      historySyncScheduled = false;
      const live = new Set([...state.stack, ...historyHolders].map((entry) => entry.historyId));
      for (const id of historyIds) {
        if (live.has(id) || !issued.delete(id)) continue;
        forgotten.add(id);
      }
    }
    disposals++;
    while (state.stack.length > 0) popTop(undefined);
  };

  /** `@k2b/ssr/nav` stops a traversal to another server page before later listeners and reports it here. */
  const onHiddenPopState = (event: Event) => {
    const detail: unknown = "detail" in event ? event.detail : undefined;
    if (isPopState(detail)) onPopState(detail);
  };
  const onNavigate = (event: NavigateEvent) => {
    if (event.navigationType === "traverse") traversalFrom = { href: location.href, marker: historyMarker() };
  };
  /** The window whose history this core listens to; a test harness may replace the window between dialogs. */
  let listening: { window: Window; navigation?: Navigation } | undefined;
  const listen = () => {
    if (listening?.window === window) return;
    listening?.window.removeEventListener("popstate", onPopState, { capture: true });
    listening?.window.removeEventListener("ssr:nav-popstate", onHiddenPopState, { capture: true });
    listening?.window.removeEventListener("ssr:island-dispose", onIslandDispose, { capture: true });
    listening?.navigation?.removeEventListener("navigate", onNavigate);
    window.addEventListener("popstate", onPopState, { capture: true });
    window.addEventListener("ssr:nav-popstate", onHiddenPopState, { capture: true });
    // Capture opens the disposal window before target listeners can release history holders.
    window.addEventListener("ssr:island-dispose", onIslandDispose, { capture: true });
    const current = typeof navigation !== "undefined" ? navigation : undefined;
    current?.addEventListener("navigate", onNavigate);
    listening = { window, navigation: current };
  };
  // Chromium runs a window's popstate listeners in the order they were added, capture or not. The shared core is
  // created before islands mount and add their navigation listeners, so it listens from the start.
  if (typeof window !== "undefined") listen();

  const pushHistory = (entry: HistoryEntry) => {
    listen();
    const previous = historyRecord();
    // A reload or Forward never brings back a dialog or its sensitive transient state.
    if (historyIds.length === 0 && previous[HISTORY_MARKER] !== undefined) {
      delete previous[HISTORY_MARKER];
      history.replaceState(previous, "");
    }
    entry.historyId = ++nextHistoryId;
    issued.add(entry.historyId);
    historyIds.push(entry.historyId);
    history.pushState({ ...previous, [HISTORY_MARKER]: entry.historyId }, "");
    seen = historySnapshot();
  };

  /** Internal non-dialog participation in the same history stack. Releasing never calls onBack. */
  const holdHistory = (onBack: () => void): (() => void) => {
    const holder: HistoryHolder = { onBack };
    historyHolders.add(holder);
    const pushWhenReady = () => {
      if (!historyHolders.has(holder)) return;
      // Just like open(): remove closed entries before adding another one.
      if (historySyncScheduled) syncHistory();
      if (returning) void returning.then(pushWhenReady);
      else pushHistory(holder);
    };
    pushWhenReady();
    return () => {
      if (!historyHolders.delete(holder)) return;
      releaseHistory(holder);
    };
  };

  /**
   * Settles once released entries have left history or were forgotten during island disposal. A caller that navigates waits
   * for it, as a dialog's result waits: a Back still on its way would otherwise land behind the new entry.
   */
  const historySettled = async (): Promise<void> => {
    while (historySyncScheduled || returning) {
      if (!returning) syncHistory();
      if (returning) await returning;
    }
  };

  const ensureDialogElement = () => {
    if (typeof document === "undefined") throw new Error("@k2b/ui dialogs can only be opened in the browser");
    // Reuse the shared element whenever it is still in the document. Resolving
    // the portal root first would create a second <dialog> when focus has moved
    // into another `.k2b-ui` scope, orphaning the levels already on the stack.
    if (state.element?.isConnected) return state.element;

    const element = document.createElement("dialog");
    element.onclose = () => {
      // Repeated Escape can force a non-cancelable native close. A retained
      // entry (ignore, an async guard, or a parent) still owns the modal.
      const top = state.stack[state.stack.length - 1];
      if (state.element !== element || element.open || !top) return;
      if (top.modal) element.showModal();
      else element.show();
      resolveInitialFocusTarget(top, element)?.focus();
    };
    getK2bPortalRoot().appendChild(element);
    state.element = element;
    return element;
  };

  const lockPageScroll = () => {
    if (typeof document === "undefined" || state.scrollLocked) return;
    state.previousBodyOverflow = document.body.style.overflow;
    state.previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    state.scrollLocked = true;
  };

  const unlockPageScroll = () => {
    if (typeof document === "undefined" || !state.scrollLocked) return;
    document.body.style.overflow = state.previousBodyOverflow ?? "";
    document.documentElement.style.overflow = state.previousHtmlOverflow ?? "";
    state.scrollLocked = false;
    state.previousBodyOverflow = undefined;
    state.previousHtmlOverflow = undefined;
  };

  const applyPresentation = (entry: DialogStackEntry) => {
    const dialog = state.element;
    if (!dialog || state.stack[state.stack.length - 1] !== entry) return;
    const position = entry.position;
    dialog.style.position = position ? "fixed" : "";
    dialog.style.inset = position ? `${position.y}px auto auto ${position.x}px` : "";
    dialog.style.margin = position ? "0" : "";
    dialog.style.transform = position ? "none" : "";
    dialog.dataset.modeless = String(!entry.modal);
    dialog.setAttribute("aria-modal", String(entry.modal));
    if (dialog.open && state.modal !== entry.modal) {
      const active = document.activeElement;
      dialog.close();
      if (entry.modal) dialog.showModal();
      else dialog.show();
      if (active instanceof HTMLElement && active.isConnected && (!entry.modal || dialog.contains(active))) {
        active.focus({ preventScroll: true });
      } else resolveInitialFocusTarget(entry, dialog)?.focus({ preventScroll: true });
    }
    state.modal = entry.modal;
    if (entry.modal) lockPageScroll();
    else unlockPageScroll();
  };

  const modelessEscape = (event: KeyboardEvent) => {
    const top = state.stack[state.stack.length - 1];
    if (!top || top.modal || event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    event.preventDefault();
    void requestDismiss(top);
  };

  const stopConnectionObserver = () => {
    document.removeEventListener("keydown", modelessEscape);
    state.connectionObserver?.disconnect();
    state.connectionObserver = undefined;
  };

  const applyCancelBehavior = (
    dialog: HTMLDialogElement,
    close: () => void,
    behavior: NonNullable<OpenDialogOptions["cancelBehavior"]>,
  ) => {
    dialog.oncancel = (event) => {
      if (behavior === "ignore") {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      close();
    };
    dialog.onmousedown = (event) => {
      state.mouseDownOnDialog = event.target === dialog;
    };
    dialog.onclick = (event) => {
      const realBackdropClick = state.mouseDownOnDialog === true;
      state.mouseDownOnDialog = false;
      if (event.target !== dialog || !state.modal) return;
      if (!realBackdropClick) return;
      if (behavior === "ignore") return;
      if (isPointInsideToast(event.clientX, event.clientY)) return;
      close();
    };
  };

  const requestDismiss = async (entry: DialogStackEntry) => {
    if (state.stack[state.stack.length - 1] !== entry || entry.dismissPending || entry.cancelBehavior === "ignore") return;
    if (!entry.dismissHandler) {
      popTop(undefined);
      return;
    }
    entry.dismissPending = true;
    try {
      await entry.dismissHandler();
    } catch (error) {
      // A failed guard must never discard the dialog's state.
      console.error("Dialog dismissal failed", error);
    } finally {
      entry.dismissPending = false;
    }
  };

  const popTop = (result?: unknown) => {
    const top = state.stack.pop();
    if (!top) return;
    releaseHistory(top);
    top.dispose?.();
    top.container.remove();

    const dialog = state.element;
    const previous = state.stack[state.stack.length - 1];
    if (previous && dialog) {
      previous.container.style.display = "";
      dialog.className = previous.panelClassName;
      applyPresentation(previous);
      applyAccessibleName(dialog, previous);
      applyCancelBehavior(dialog, () => void requestDismiss(previous), previous.cancelBehavior);
      schedule(() => {
        if (!focusUnclaimed(dialog)) return;
        if (top.opener?.isConnected) returnFocus(top.opener, top.openerRing);
        else resolveInitialFocusTarget(previous, dialog)?.focus();
      });
    } else if (dialog) {
      dialog.oncancel = null;
      dialog.onmousedown = null;
      dialog.onclick = null;
      dialog.removeAttribute("aria-label");
      dialog.removeAttribute("aria-labelledby");
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      dialog.remove();
      state.element = undefined;
      stopConnectionObserver();
      unlockPageScroll();
      // After the Escape that closed it: WebKit lights the ring of whatever
      // that key press leaves focused.
      schedule(() => {
        if (top.opener?.isConnected && focusUnclaimed(dialog)) returnFocus(top.opener, top.openerRing);
      });
    }

    top.resolve?.(result);
  };

  const resetDisconnectedDialog = () => {
    if (state.stack.length === 0 || state.element?.isConnected) return;
    const entries = state.stack.splice(0);
    const dialog = state.element;
    state.element = undefined;
    stopConnectionObserver();
    dialog?.remove();
    unlockPageScroll();
    for (const entry of entries.reverse()) {
      releaseHistory(entry);
      entry.dispose?.();
      entry.container.remove();
      entry.resolve?.(undefined);
    }
  };

  const observeConnection = () => {
    if (state.connectionObserver || typeof MutationObserver === "undefined") return;
    document.addEventListener("keydown", modelessEscape);
    state.connectionObserver = new MutationObserver(resetDisconnectedDialog);
    state.connectionObserver.observe(document.documentElement, { childList: true, subtree: true });
  };

  const open = <T>(view: DialogRender<T>, options: OpenDialogOptions = {}): Promise<T | undefined> => {
    return openAfter(view, options, disposals);
  };

  const openAfter = <T>(view: DialogRender<T>, options: OpenDialogOptions, requested: number): Promise<T | undefined> => {
    if (options.signal?.aborted) return Promise.resolve(undefined);
    if (options.history) {
      // Dialogs closed just now leave the history first, or this dialog's entry would be the one removed.
      if (historySyncScheduled) syncHistory();
      if (returning) return returning.then(() => openAfter(view, options, requested));
    }
    // A dialog that waited for history while islands were disposed would open over content it was never meant for.
    if (disposals !== requested) return Promise.resolve(undefined);
    const dialog = ensureDialogElement();
    listen();
    const previousTop = state.stack[state.stack.length - 1];
    if (previousTop) previousTop.container.style.display = "none";
    const activeElement = document.activeElement;

    const panelClassName = options.panelClassName ?? DEFAULT_PANEL_CLASS;
    const cancelBehavior = options.cancelBehavior ?? "resolve-undefined";
    const initialFocus = options.initialFocus ?? "first-input";
    dialog.className = panelClassName;

    const container = document.createElement("div");
    container.className = options.contentClassName ?? DEFAULT_CONTENT_CLASS;
    dialog.appendChild(container);

    const entry: DialogStackEntry = {
      container,
      panelClassName,
      cancelBehavior,
      initialFocus,
      opener: activeElement instanceof HTMLElement ? activeElement : undefined,
      openerRing: ringOnReturn(activeElement),
      ariaLabel: options.ariaLabel,
      modal: true,
    };

    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = state.stack.indexOf(entry);
        if (index < 0) return;
        if (index === state.stack.length - 1) popTop(undefined);
        else {
          state.stack.splice(index, 1);
          releaseHistory(entry);
          entry.dispose?.();
          entry.container.remove();
          entry.resolve?.(undefined);
        }
      };
      entry.resolve = (value) => {
        options.signal?.removeEventListener("abort", abort);
        if (!options.history) {
          resolve(value as T | undefined);
          return;
        }
        // After every pending history sync, so a caller that navigates or opens the next dialog finds the history settled.
        // This holds for a marker forgotten during island disposal too, while an earlier synthetic Back is on its way.
        queueMicrotask(() => void historySettled().then(() => resolve(value as T | undefined)));
      };
      const closeTyped: DialogClose<T> = (result) => {
        if (state.stack[state.stack.length - 1] !== entry) return;
        popTop(result);
      };

      if (options.history) pushHistory(entry);
      state.stack.push(entry);
      try {
        entry.dispose = render(
          () =>
            createComponent(RenderErrorBoundary, {
              content: () =>
                view(closeTyped, {
                  dialog,
                  setModal: (modal) => {
                    entry.modal = modal;
                    applyPresentation(entry);
                  },
                  setPosition: (position) => {
                    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) return;
                    entry.position = position;
                    applyPresentation(entry);
                  },
                  requestDismiss: () => requestDismiss(entry),
                  setDismissHandler: (handler) => {
                    entry.dismissHandler = handler;
                  },
                }),
              onClose: () => closeTyped(undefined),
              onError: () => {
                entry.panelClassName = RENDER_ERROR_PANEL_CLASS;
                container.className = DEFAULT_CONTENT_CLASS;
                if (state.stack[state.stack.length - 1] === entry) dialog.className = RENDER_ERROR_PANEL_CLASS;
              },
            }),
          container,
        );
        applyPresentation(entry);
        applyAccessibleName(dialog, entry);
        applyCancelBehavior(dialog, () => void requestDismiss(entry), cancelBehavior);

        if (state.stack.length === 1) {
          // The native dialog returns focus to the element focused when it
          // opened, with a ring of the browser's choosing. Opening from a
          // blurred document leaves the return to popTop and its opener ring.
          if (activeElement instanceof HTMLElement) activeElement.blur();
          if (typeof dialog.showModal === "function") {
            if (entry.modal) dialog.showModal();
            else dialog.show();
          } else dialog.setAttribute("open", "");
          observeConnection();
        }
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        // Where opening left focus, the native dialog's own pick included. Focus that the content or a person moved
        // before the next frame stays: a browser can hold that frame back while keys already arrive.
        const opened = document.activeElement;
        schedule(() => {
          if (state.stack[state.stack.length - 1] !== entry) return;
          if (document.activeElement !== opened && !focusUnclaimed(dialog)) return;
          resolveInitialFocusTarget(entry, dialog)?.focus();
        });
      } catch (error) {
        entry.resolve = undefined;
        if (state.stack[state.stack.length - 1] === entry) popTop(undefined);
        reject(error);
      }
    });
  };

  const close: DialogCore["close"] = (result) => {
    let first = true;
    while (state.stack.length > 0) {
      popTop(first ? result : undefined);
      first = false;
    }
  };

  return {
    open,
    close,
    isOpen: () => state.stack.length > 0,
    holdHistory,
    historySettled,
  };
};

const { holdHistory, historySettled, ...publicDialogCore } = createDialogCore();
export const dialogCore: DialogCore = publicDialogCore;

/**
 * Internal: transient UI shares dialogs' Back handling without exposing another public dialog capability.
 * Same-URL traversals are suppressed with the Navigation API; without it, only the synthetic Back on release is suppressed.
 * Release during island disposal forgets the marker without traversing; the router may replace the remaining entry.
 */
export const holdDialogHistory = holdHistory;
/** Internal: waits until released holders have left history or were forgotten during island disposal. */
export const dialogHistorySettled = historySettled;
