import { getK2bPortalRoot } from "../internal/portal";

export type ToastVariant = "default" | "success" | "error";

export type ToastAction = {
  label: string;
} & ({ href: string } | { onClick: () => void });

export type ToastOptions = {
  variant?: ToastVariant;
  duration?: number;
  iconClass?: string;
  title?: string;
  action?: ToastAction | null;
  /** Fraction from 0 to 1, or an indeterminate activity indicator. null removes it. */
  progress?: number | "indeterminate" | null;
  dismissLabel?: string;
};

export type ToastHandle = {
  dismiss: () => void;
  update: (description: string, options?: ToastOptions) => void;
};

export interface ToastFn {
  (description: string, options?: ToastOptions): ToastHandle;
  success: (description: string, options?: Omit<ToastOptions, "variant">) => ToastHandle;
  error: (description: string, options?: Omit<ToastOptions, "variant">) => ToastHandle;
  dismissAll: () => void;
}

const DEFAULT_DURATION_MS = 3000;
const MAX_VISIBLE_TOASTS = 5;
const ANIMATION_MS = 200;
export const K2B_TOAST_CONTAINER_ID = "k2b-ui-toast-container";
const CONTAINER_ATTRIBUTE = "data-k2b-toast-container";

type VariantStyle = {
  tone: "info" | "success" | "danger";
  iconClass: string;
  defaultTitle: string;
};

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  default: {
    tone: "info",
    iconClass: "ti-info-circle",
    defaultTitle: "Info",
  },
  success: {
    tone: "success",
    iconClass: "ti-check",
    defaultTitle: "Success",
  },
  error: {
    tone: "danger",
    iconClass: "ti-x",
    defaultTitle: "Error",
  },
};

const normalizedIconClass = (iconClass: string): string => {
  const tokens = iconClass
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token !== "ti");
  return ["ti", ...tokens].join(" ");
};

const applyIconClass = (icon: HTMLElement, iconClass: string): void => {
  icon.className = normalizedIconClass(iconClass);
};

const applyLiveRegion = (element: HTMLElement, variant: ToastVariant): void => {
  const isError = variant === "error";
  element.setAttribute("role", isError ? "alert" : "status");
  element.setAttribute("aria-live", isError ? "assertive" : "polite");
  element.setAttribute("aria-atomic", "true");
};

const liveToasts = new Set<ToastHandle>();

const ensureContainer = (): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  const root = getK2bPortalRoot();
  let container = root.querySelector<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`);
  if (container) return container;

  container = document.createElement("div");
  container.id = K2B_TOAST_CONTAINER_ID;
  container.setAttribute(CONTAINER_ATTRIBUTE, "");
  container.setAttribute("popover", "manual");
  // Keep the source rail geometry inline: it must defeat UA popover defaults
  // even when a consumer has not loaded the optional package stylesheet yet.
  container.style.cssText =
    "position:fixed;top:auto;left:auto;bottom:env(safe-area-inset-bottom,0px);right:env(safe-area-inset-right,0px);" +
    "z-index:50;box-sizing:border-box;display:flex;flex-direction:column;gap:0.5rem;" +
    "width:min(22rem,calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px)));" +
    "height:auto;max-width:100vw;" +
    "max-height:calc(100dvh - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));" +
    "margin:0;padding:1rem;border:0;background:transparent;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;" +
    "pointer-events:none;";
  root.appendChild(container);
  return container;
};

const promoteToTopLayer = (container: HTMLElement): HTMLElement => {
  if (typeof container.showPopover !== "function" || !container.isConnected) return container;
  let active = container;
  try {
    if (container.matches(":popover-open") || document.querySelector("dialog:modal")) {
      const next = container.cloneNode(false) as HTMLElement;
      while (container.firstChild) next.appendChild(container.firstChild);
      const root = container.parentElement ?? getK2bPortalRoot();
      container.remove();
      root.appendChild(next);
      active = next;
    }
    if (!active.matches(":popover-open")) active.showPopover();
  } catch {
    active.removeAttribute("popover");
  }
  return active;
};

/** Close every empty rail so an emptied container does not linger in the top
 *  layer. Rails are resolved at call time on purpose: `promoteToTopLayer`
 *  swaps the element for a fresh clone, so a container captured when the toast
 *  was created can already be detached by the time the toast is dismissed. */
const hideEmptyContainers = (): void => {
  if (typeof document === "undefined") return;
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`))) {
    if (container.childElementCount > 0 || typeof container.hidePopover !== "function") continue;
    try {
      if (container.matches(":popover-open")) container.hidePopover();
    } catch {
      // Already hidden or disconnected.
    }
  }
};

const renderLead = (lead: HTMLElement, variant: ToastVariant, iconClassOverride?: string): HTMLElement => {
  const style = VARIANT_STYLES[variant];
  lead.replaceChildren();
  lead.className = "k2b-toast__icon";
  lead.dataset.tone = style.tone;
  const icon = document.createElement("i");
  applyIconClass(icon, iconClassOverride ?? style.iconClass);
  icon.setAttribute("aria-hidden", "true");
  lead.appendChild(icon);
  return icon;
};

const showToast = (description: string, options?: ToastOptions): ToastHandle => {
  const initialContainer = ensureContainer();
  if (!initialContainer) {
    const noop = () => {};
    return { dismiss: noop, update: noop };
  }

  let dismissed = false;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let currentVariant: ToastVariant = options?.variant ?? "default";
  let currentProgress = options?.progress ?? null;
  let currentDuration = options?.duration ?? DEFAULT_DURATION_MS;
  let remainingDuration = currentDuration;
  let timerStartedAt = 0;
  let pausedByPointer = false;
  let pausedByFocus = false;

  const toastElement = document.createElement("div");
  toastElement.className = "k2b-toast";
  toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
  toastElement.dataset.k2bToast = "";

  const leadElement = document.createElement("div");
  let leadIconElement = renderLead(leadElement, currentVariant, options?.iconClass);

  const contentElement = document.createElement("div");
  contentElement.className = "k2b-toast__content";
  applyLiveRegion(contentElement, currentVariant);

  const titleElement = document.createElement("div");
  titleElement.className = "k2b-toast__title";
  titleElement.textContent = options?.title ?? VARIANT_STYLES[currentVariant].defaultTitle;
  const descriptionElement = document.createElement("div");
  descriptionElement.className = "k2b-toast__description";
  descriptionElement.textContent = description;
  contentElement.append(titleElement, descriptionElement);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "k2b-toast__close";
  closeButton.setAttribute("aria-label", options?.dismissLabel ?? "Dismiss notification");
  const closeIcon = document.createElement("i");
  closeIcon.className = "ti ti-x";
  closeIcon.setAttribute("aria-hidden", "true");
  closeButton.appendChild(closeIcon);

  toastElement.append(leadElement, contentElement, closeButton);

  const clearDismissTimer = () => {
    if (dismissTimer === null) return;
    clearTimeout(dismissTimer);
    dismissTimer = null;
  };

  const pauseDismissTimer = () => {
    if (dismissTimer === null) return;
    remainingDuration = Math.max(0, remainingDuration - (Date.now() - timerStartedAt));
    clearDismissTimer();
  };

  const resumeDismissTimer = () => {
    if (dismissed || currentProgress !== null || currentDuration === 0 || remainingDuration <= 0 || pausedByPointer || pausedByFocus)
      return;
    clearDismissTimer();
    timerStartedAt = Date.now();
    dismissTimer = setTimeout(() => dismiss(), remainingDuration);
  };

  const resetDismissTimer = (duration: number) => {
    clearDismissTimer();
    currentDuration = duration;
    remainingDuration = duration;
    resumeDismissTimer();
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearDismissTimer();
    liveToasts.delete(handle);
    toastElement.dataset.closing = "true";
    setTimeout(() => {
      toastElement.remove();
      hideEmptyContainers();
    }, ANIMATION_MS);
  };

  const progressElement = document.createElement("progress");
  progressElement.className = "k2b-toast__progress";
  progressElement.max = 1;
  const renderProgress = () => {
    progressElement.hidden = currentProgress === null;
    progressElement.setAttribute("aria-label", titleElement.textContent || descriptionElement.textContent || "");
    if (typeof currentProgress === "number")
      progressElement.value = Number.isFinite(currentProgress) ? Math.max(0, Math.min(1, currentProgress)) : 0;
    else progressElement.removeAttribute("value");
  };
  contentElement.append(progressElement);
  renderProgress();
  let actionElement: HTMLAnchorElement | HTMLButtonElement | null = null;
  const renderAction = (action: ToastAction | null | undefined) => {
    actionElement?.remove();
    actionElement = null;
    if (!action) return;
    if ("href" in action) {
      const link = document.createElement("a");
      link.href = action.href;
      actionElement = link;
    } else {
      const button = document.createElement("button");
      button.type = "button";
      actionElement = button;
    }
    actionElement.className = "k2b-toast__action";
    actionElement.textContent = action.label;
    actionElement.addEventListener("click", (event) => {
      event.stopPropagation();
      if ("onClick" in action) action.onClick();
      else dismiss();
    });
    contentElement.appendChild(actionElement);
  };
  renderAction(options?.action);

  const update = (nextDescription: string, nextOptions?: ToastOptions) => {
    if (dismissed) return;
    descriptionElement.textContent = nextDescription;

    const variantChanged = nextOptions?.variant !== undefined && nextOptions.variant !== currentVariant;
    if (variantChanged) {
      currentVariant = nextOptions.variant!;
      toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
      leadIconElement = renderLead(leadElement, currentVariant, nextOptions.iconClass);
      applyLiveRegion(contentElement, currentVariant);
    } else if (nextOptions?.iconClass !== undefined) {
      applyIconClass(leadIconElement, nextOptions.iconClass);
    }

    if (nextOptions && Object.prototype.hasOwnProperty.call(nextOptions, "title")) {
      titleElement.textContent = nextOptions.title ?? "";
    } else if (variantChanged) {
      titleElement.textContent = VARIANT_STYLES[currentVariant].defaultTitle;
    }
    if (nextOptions && Object.prototype.hasOwnProperty.call(nextOptions, "action")) renderAction(nextOptions.action);
    if (nextOptions && Object.prototype.hasOwnProperty.call(nextOptions, "duration")) {
      currentDuration = nextOptions.duration ?? DEFAULT_DURATION_MS;
    }
    if (nextOptions && Object.prototype.hasOwnProperty.call(nextOptions, "progress")) currentProgress = nextOptions.progress ?? null;
    if (nextOptions?.dismissLabel) closeButton.setAttribute("aria-label", nextOptions.dismissLabel);
    renderProgress();
    resetDismissTimer(currentDuration);
  };

  toastElement.addEventListener("click", () => {
    if (currentProgress === null) dismiss();
  });
  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });
  toastElement.addEventListener("pointerenter", () => {
    pausedByPointer = true;
    pauseDismissTimer();
  });
  toastElement.addEventListener("pointerleave", () => {
    pausedByPointer = false;
    resumeDismissTimer();
  });
  toastElement.addEventListener("focusin", () => {
    pausedByFocus = true;
    pauseDismissTimer();
  });
  toastElement.addEventListener("focusout", (event) => {
    if (toastElement.contains(event.relatedTarget as Node | null)) return;
    pausedByFocus = false;
    resumeDismissTimer();
  });

  const handle: ToastHandle = { dismiss, update };
  liveToasts.add(handle);
  if (liveToasts.size > MAX_VISIBLE_TOASTS) liveToasts.values().next().value?.dismiss();
  promoteToTopLayer(initialContainer).appendChild(toastElement);
  requestAnimationFrame(() => {
    if (!dismissed) toastElement.dataset.open = "true";
  });
  resetDismissTimer(currentDuration);
  return handle;
};

export const isPointInsideToast = (x: number, y: number): boolean => {
  if (typeof document === "undefined") return false;
  const containers = Array.from(document.querySelectorAll<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`));
  for (const container of containers) {
    for (const child of Array.from(container.children)) {
      const rect = child.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
  }
  return false;
};

const toastFn = ((description: string, options?: ToastOptions) => showToast(description, options)) as ToastFn;
toastFn.success = (description, options) => showToast(description, { ...options, variant: "success" });
toastFn.error = (description, options) => showToast(description, { ...options, variant: "error" });
toastFn.dismissAll = () => {
  for (const handle of Array.from(liveToasts)) handle.dismiss();
};

export const toast: ToastFn = toastFn;
