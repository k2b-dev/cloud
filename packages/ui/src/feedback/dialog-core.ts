import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { getK2bPortalRoot } from "../internal/portal";
import { isPointInsideToast } from "./toast";

export type DialogClose<T> = (result?: T) => void;

export type OpenDialogOptions = {
  panelClassName?: string;
  contentClassName?: string;
  initialFocus?: "first-input" | "none" | ((dialog: HTMLDialogElement) => HTMLElement | null);
  cancelBehavior?: "resolve-undefined" | "ignore";
  ariaLabel?: string;
};

export type DialogRender<T> = (
  close: DialogClose<T>,
  context: {
    dialog: HTMLDialogElement;
    /** Route Escape/backdrop through the same guarded handler as Cancel and X. */
    setDismissHandler: (handler: () => void | Promise<void>) => void;
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
  ariaLabel?: string;
  dismissHandler?: () => void | Promise<void>;
  dismissPending?: boolean;
};

type DialogState = {
  element?: HTMLDialogElement;
  stack: DialogStackEntry[];
  scrollLocked?: boolean;
  previousBodyOverflow?: string;
  previousHtmlOverflow?: string;
  mouseDownOnDialog?: boolean;
  connectionObserver?: MutationObserver;
};

const DEFAULT_PANEL_CLASS = "k2b-dialog";
const DEFAULT_CONTENT_CLASS = "k2b-dialog__viewport";
let nextDialogTitleId = 0;

const resolveInitialFocusTarget = (entry: DialogStackEntry, dialog: HTMLDialogElement): HTMLElement | null => {
  const { initialFocus } = entry;
  if (initialFocus === "none") return null;
  if (typeof initialFocus === "function") return initialFocus(dialog);
  return entry.container.querySelector<HTMLElement>(
    "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
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
    dialog.setAttribute("aria-label", "Dialog");
    return;
  }
  heading.id ||= `k2b-dialog-title-${++nextDialogTitleId}`;
  dialog.setAttribute("aria-labelledby", heading.id);
};

const schedule = (callback: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
  else queueMicrotask(callback);
};

export const createDialogCore = (): DialogCore => {
  const state: DialogState = { stack: [] };

  const ensureDialogElement = () => {
    if (typeof document === "undefined") throw new Error("@k2b/ui dialogs can only be opened in the browser");
    // Reuse the shared element whenever it is still in the document. Resolving
    // the portal root first would create a second <dialog> when focus has moved
    // into another `.k2b-ui` scope, orphaning the levels already on the stack.
    if (state.element?.isConnected) return state.element;

    const element = document.createElement("dialog");
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

  const stopConnectionObserver = () => {
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
      if (event.target !== dialog) return;
      if (!realBackdropClick) return;
      if (behavior === "ignore") return;
      if (isPointInsideToast(event.clientX, event.clientY)) return;
      close();
    };
  };

  const requestDismiss = async (entry: DialogStackEntry) => {
    if (state.stack[state.stack.length - 1] !== entry || entry.dismissPending) return;
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
    top.dispose?.();
    top.container.remove();

    const dialog = state.element;
    const previous = state.stack[state.stack.length - 1];
    if (previous && dialog) {
      previous.container.style.display = "";
      dialog.className = previous.panelClassName;
      applyAccessibleName(dialog, previous);
      applyCancelBehavior(dialog, () => void requestDismiss(previous), previous.cancelBehavior);
      schedule(() => {
        const target = top.opener?.isConnected ? top.opener : resolveInitialFocusTarget(previous, dialog);
        target?.focus();
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
      schedule(() => {
        if (top.opener?.isConnected) top.opener.focus();
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
      entry.dispose?.();
      entry.container.remove();
      entry.resolve?.(undefined);
    }
  };

  const observeConnection = () => {
    if (state.connectionObserver || typeof MutationObserver === "undefined") return;
    state.connectionObserver = new MutationObserver(resetDisconnectedDialog);
    state.connectionObserver.observe(document.documentElement, { childList: true, subtree: true });
  };

  const open = <T>(view: DialogRender<T>, options: OpenDialogOptions = {}): Promise<T | undefined> => {
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
      ariaLabel: options.ariaLabel,
    };

    return new Promise((resolve, reject) => {
      entry.resolve = (value) => resolve(value as T | undefined);
      const closeTyped: DialogClose<T> = (result) => {
        if (state.stack[state.stack.length - 1] !== entry) return;
        popTop(result);
      };

      state.stack.push(entry);
      try {
        entry.dispose = render(
          () =>
            view(closeTyped, {
              dialog,
              setDismissHandler: (handler) => {
                entry.dismissHandler = handler;
              },
            }),
          container,
        );
        applyAccessibleName(dialog, entry);
        applyCancelBehavior(dialog, () => void requestDismiss(entry), cancelBehavior);

        if (state.stack.length === 1) {
          if (typeof dialog.showModal === "function") dialog.showModal();
          else dialog.setAttribute("open", "");
          lockPageScroll();
          observeConnection();
        }
        schedule(() => {
          if (state.stack[state.stack.length - 1] === entry) resolveInitialFocusTarget(entry, dialog)?.focus();
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
