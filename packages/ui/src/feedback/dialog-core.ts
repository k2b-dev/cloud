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
   * instead of leaving the page. Closing the dialog removes the entry again; the returned promise settles after that.
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
/** The history state key that marks a dialog's same-URL entry. */
const HISTORY_MARKER = "k2bDialog";

const historyRecord = (): Record<string, unknown> =>
  typeof history.state === "object" && history.state !== null ? { ...history.state } : {};
const historyMarker = (): unknown => historyRecord()[HISTORY_MARKER];

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

export const createDialogCore = (): DialogCore => {
  const state: DialogState = { stack: [] };
  /** Markers of this core's entries in the browser history, oldest first. */
  let historyIds: number[] = [];
  let nextHistoryId = 0;
  let historySyncScheduled = false;
  let listeningToHistory = false;
  /** Settles when the synthetic Back that removes closed dialogs' entries has arrived. */
  let returning: Promise<void> | undefined;

  /** Closed dialogs leave the history with one Back to the newest dialog that is still open, or to the page. */
  const syncHistory = () => {
    historySyncScheduled = false;
    const openIds = new Set(state.stack.map((entry) => entry.historyId));
    const current = historyIds.at(-1);
    let steps = 0;
    while (historyIds.length > 0 && !openIds.has(historyIds.at(-1))) {
      historyIds.pop();
      steps++;
    }
    // Someone else moved the history meanwhile; leave it alone.
    if (steps === 0 || historyMarker() !== current) return;
    const back = new Promise<void>((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));
    returning = back;
    void back.then(() => {
      if (returning === back) returning = undefined;
    });
    history.go(-steps);
  };

  const releaseHistory = (entry: DialogStackEntry) => {
    if (entry.historyId === undefined || historySyncScheduled) return;
    historySyncScheduled = true;
    queueMicrotask(syncHistory);
  };

  /** Back or Forward moved to another entry: close every dialog opened after the one it shows. */
  const onPopState = () => {
    const marker = historyMarker();
    const index = typeof marker === "number" ? historyIds.indexOf(marker) : -1;
    historyIds = historyIds.slice(0, index + 1);
    const gone = (entry: DialogStackEntry) => entry.historyId !== undefined && !historyIds.includes(entry.historyId);
    while (state.stack.some(gone)) popTop(undefined);
  };

  const pushHistory = (entry: DialogStackEntry) => {
    if (!listeningToHistory) {
      window.addEventListener("popstate", onPopState);
      listeningToHistory = true;
    }
    const previous = historyRecord();
    // A reload or Forward never brings back a dialog or its sensitive transient state.
    if (historyIds.length === 0 && previous[HISTORY_MARKER] !== undefined) {
      delete previous[HISTORY_MARKER];
      history.replaceState(previous, "");
    }
    entry.historyId = ++nextHistoryId;
    historyIds.push(entry.historyId);
    history.pushState({ ...previous, [HISTORY_MARKER]: entry.historyId }, "");
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
    if (options.signal?.aborted) return Promise.resolve(undefined);
    if (options.history) {
      // Dialogs closed just now leave the history first, or this dialog's entry would be the one removed.
      if (historySyncScheduled) syncHistory();
      if (returning) return returning.then(() => open(view, options));
    }
    const dialog = ensureDialogElement();
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
        if (entry.historyId === undefined) {
          resolve(value as T | undefined);
          return;
        }
        // After the history sync, so a caller that navigates or opens the next dialog finds the history settled.
        queueMicrotask(() => void (returning ?? Promise.resolve()).then(() => resolve(value as T | undefined)));
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
  };
};

export const dialogCore = createDialogCore();
