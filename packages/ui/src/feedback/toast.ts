import { getK2bPortalRoot } from "../internal/portal";
import { resolveUiMessages } from "../intl/messages";

export type ToastVariant = "default" | "success" | "error";

export type ToastAction = {
  label: string;
} & ({ href: string } | { onClick: () => void });

export type ToastOptions = {
  variant?: ToastVariant;
  /** Milliseconds until the toast closes; `0` keeps it until it is closed. Omit it for the default by variant, length, and action. */
  duration?: number;
  iconClass?: string;
  /** A short line of context above the message. There is no default title. */
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

export type ToastSlot = {
  dismiss: () => void;
};

export interface ToastFn {
  (description: string, options?: ToastOptions): ToastHandle;
  success: (description: string, options?: Omit<ToastOptions, "variant">) => ToastHandle;
  error: (description: string, options?: Omit<ToastOptions, "variant">) => ToastHandle;
  /** Places an application-owned element in the toast rail, in toast chrome; the caller owns its content and lifetime. */
  custom: (content: HTMLElement) => ToastSlot;
  dismissAll: () => void;
}

/** Visible toasts on a wide viewport; the rail's narrow layout shows fewer. */
const MAX_VISIBLE_TOASTS = 3;
const MAX_VISIBLE_TOASTS_NARROW = 2;
/** The same media query that moves the rail to the top edge in the stylesheet. */
const NARROW_RAIL_QUERY = "(max-width: 47.999rem), (max-height: 29.999rem)";
const ANIMATION_MS = 200;
/** Reading time: a short message stays 4 s, longer text about 1 s more per 30 characters, up to 12 s. */
const READ_BASE_MS = 4_000;
const READ_FREE_CHARACTERS = 40;
const READ_MS_PER_CHARACTER = 35;
const READ_MAX_MS = 12_000;
/** Errors and toasts with an action stay long enough to reach them with a keyboard or a screen magnifier. */
const REACHABLE_MS = 8_000;
/** An error longer than this stays until it is closed, so it can be read and copied. */
const STICKY_ERROR_CHARACTERS = 120;
/** A live region needs a moment between being found and being written to. */
const ANNOUNCE_DELAY_MS = 100;
const ANNOUNCEMENT_LIFETIME_MS = 7_000;
export const K2B_TOAST_CONTAINER_ID = "k2b-ui-toast-container";
const CONTAINER_ATTRIBUTE = "data-k2b-toast-container";
const LIVE_ATTRIBUTE = "data-k2b-toast-live";

type VariantStyle = {
  tone: "info" | "success" | "danger";
  iconClass: string;
};

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  default: { tone: "info", iconClass: "ti-info-circle" },
  success: { tone: "success", iconClass: "ti-circle-check" },
  error: { tone: "danger", iconClass: "ti-alert-circle" },
};

/** How long a toast stays when the caller passes no duration. */
const defaultDuration = (variant: ToastVariant, text: string, hasAction: boolean): number => {
  if (variant === "error" && text.length > STICKY_ERROR_CHARACTERS) return 0;
  const reading = Math.min(READ_MAX_MS, READ_BASE_MS + Math.max(0, text.length - READ_FREE_CHARACTERS) * READ_MS_PER_CHARACTER);
  return variant === "error" || hasAction ? Math.max(REACHABLE_MS, reading) : reading;
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

type LiveToast = {
  dismiss: () => void;
  /** Errors, sticky toasts, and running progress stay when the rail is full; older timed confirmations leave first. */
  keep: () => boolean;
  progress: () => boolean;
  /** Under the pointer or holding keyboard focus: the rail limit never removes it. */
  held: () => boolean;
  pause: () => void;
  resume: () => void;
};

const liveToasts = new Set<LiveToast>();

/**
 * Cards under the pointer or holding keyboard focus. While the rail holds any, no toast times out, so nothing moves
 * under the pointer or out from under focus because a neighbour expired.
 */
const pointerHolds = new Set<HTMLElement>();
const focusHolds = new Set<HTMLElement>();
const railHeld = (): boolean => pointerHolds.size + focusHolds.size > 0;

/**
 * Firefox and WebKit fire no focusout when a focused element leaves the document, and WebKit no pointerleave when
 * the hovered element inside a card is removed, as when custom content replaces a button or the rail's scope
 * unmounts. While anything holds the rail, a change to the document or the pointer moving onto something else
 * drops the holds that no longer apply, so one stale hold never freezes the rail.
 */
const releaseStaleHolds = (pointerTarget?: Node | null): void => {
  for (const card of Array.from(pointerHolds))
    if (!card.isConnected || (pointerTarget !== undefined && !card.contains(pointerTarget))) setHold(pointerHolds, card, false);
  for (const card of Array.from(focusHolds))
    if (!card.isConnected || !card.contains(card.ownerDocument.activeElement)) setHold(focusHolds, card, false);
};

const watchStaleHolds = (doc: Document): (() => void) => {
  const observer = new MutationObserver(() => releaseStaleHolds());
  observer.observe(doc, { childList: true, subtree: true });
  const onPointerOver = (event: Event) => releaseStaleHolds(event.target instanceof Node ? event.target : null);
  doc.addEventListener("pointerover", onPointerOver, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("pointerover", onPointerOver, true);
  };
};
let unwatchStaleHolds: (() => void) | null = null;

function setHold(holds: Set<HTMLElement>, card: HTMLElement, held: boolean): void {
  const wasHeld = railHeld();
  if (held) holds.add(card);
  else holds.delete(card);
  if (railHeld() !== wasHeld) {
    for (const item of Array.from(liveToasts)) (wasHeld ? item.resume : item.pause)();
    unwatchStaleHolds?.();
    unwatchStaleHolds = wasHeld ? null : watchStaleHolds(card.ownerDocument);
  }
  // A released card may be the one the rail limit had to wait for.
  if (!held) enforceCap();
}

const VISUALLY_HIDDEN =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;";

/**
 * Two persistent, empty live regions beside the rail: polite for every toast, assertive for errors. A region that
 * already exists when its text arrives is announced reliably, unlike one inserted with its text already inside.
 * They sit outside the rail because the rail moves into a fresh top-layer element for every toast.
 */
const ensureLiveRegions = (root: HTMLElement): HTMLElement => {
  const existing = Array.from(root.children).find((child) => child.hasAttribute(LIVE_ATTRIBUTE));
  if (existing instanceof HTMLElement) return existing;
  const live = document.createElement("div");
  live.setAttribute(LIVE_ATTRIBUTE, "");
  live.style.cssText = VISUALLY_HIDDEN;
  for (const assertive of [false, true]) {
    const region = document.createElement("div");
    region.setAttribute("role", assertive ? "alert" : "status");
    region.setAttribute("aria-live", assertive ? "assertive" : "polite");
    // Both roles are atomic by default, which would read every line still in the region again with each new one.
    region.setAttribute("aria-atomic", "false");
    region.dataset.politeness = assertive ? "assertive" : "polite";
    live.appendChild(region);
  }
  root.appendChild(live);
  return live;
};

/** Each announcement is its own line, so a burst of toasts or a repeated message is still read. */
const announce = (root: HTMLElement | null, text: string, assertive: boolean): void => {
  if (!root || !text) return;
  const region = ensureLiveRegions(root).querySelector<HTMLElement>(`[data-politeness="${assertive ? "assertive" : "polite"}"]`);
  if (!region) return;
  const line = document.createElement("div");
  line.textContent = text;
  setTimeout(() => {
    region.appendChild(line);
    setTimeout(() => line.remove(), ANNOUNCEMENT_LIFETIME_MS);
  }, ANNOUNCE_DELAY_MS);
};

const ensureContainer = (): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  const root = getK2bPortalRoot();
  ensureLiveRegions(root);
  let container = root.querySelector<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`);
  if (container) return container;

  container = document.createElement("div");
  container.id = K2B_TOAST_CONTAINER_ID;
  container.setAttribute(CONTAINER_ATTRIBUTE, "");
  container.setAttribute("popover", "manual");
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", resolveUiMessages().notifications);
  // Keep the source rail geometry inline: it must defeat UA popover defaults
  // even when a consumer has not loaded the optional package stylesheet yet.
  // The stylesheet only moves the rail to the top edge, and to the full width
  // of a phone, through the rail variables.
  container.style.cssText =
    "position:fixed;left:var(--k2b-toast-rail-left,auto);right:env(safe-area-inset-right,0px);" +
    "top:var(--k2b-toast-rail-top,auto);bottom:var(--k2b-toast-rail-bottom,env(safe-area-inset-bottom,0px));" +
    "z-index:50;box-sizing:border-box;display:flex;flex-direction:var(--k2b-toast-rail-direction,column);" +
    "width:var(--k2b-toast-rail-width,min(24rem,calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px))));" +
    "height:auto;max-width:100vw;" +
    "max-height:calc(100dvh - env(safe-area-inset-top,0px) - var(--k2b-toast-offset-top,0px) - env(safe-area-inset-bottom,0px));" +
    "margin:0;padding:var(--k2b-toast-rail-padding,0.75rem 1rem);border:0;background:transparent;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;" +
    "pointer-events:none;";
  root.appendChild(container);
  return container;
};

/** Moving nodes resets their scroll offsets and drops focus; a custom slot can hold a scrolled list or a focused control. */
const captureViewState = (container: HTMLElement) => {
  const focused =
    document.activeElement instanceof HTMLElement && container.contains(document.activeElement) ? document.activeElement : null;
  const scrolled = Array.from(container.querySelectorAll<HTMLElement>("*"))
    .filter((element) => element.scrollTop || element.scrollLeft)
    .map((element) => [element, element.scrollTop, element.scrollLeft] as const);
  const railTop = container.scrollTop;
  return (rail: HTMLElement) => {
    rail.scrollTop = railTop;
    for (const [element, top, left] of scrolled) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    if (focused?.isConnected && rail.contains(focused)) focused.focus({ preventScroll: true });
  };
};

const promoteToTopLayer = (container: HTMLElement): HTMLElement => {
  if (typeof container.showPopover !== "function" || !container.isConnected) return container;
  let active = container;
  let restore: ((rail: HTMLElement) => void) | null = null;
  try {
    if (container.matches(":popover-open") || document.querySelector("dialog:modal")) {
      restore = captureViewState(container);
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
  // Offsets apply only once the rail is rendered again, so after it is shown.
  restore?.(active);
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

/**
 * Every toast and custom slot sits in a slot that grows from and collapses to zero height, so its neighbours glide
 * instead of jumping when it arrives or leaves. The card carries the chrome and `data-open` / `data-closing`.
 */
type RailItem = {
  slot: HTMLElement;
  open: () => void;
  close: (onRemoved?: () => void) => void;
};

const railItem = (card: HTMLElement): RailItem => {
  card.addEventListener("pointerenter", () => setHold(pointerHolds, card, true));
  card.addEventListener("pointerleave", () => setHold(pointerHolds, card, false));
  card.addEventListener("focusin", () => setHold(focusHolds, card, true));
  card.addEventListener("focusout", (event) => {
    if (!card.contains(event.relatedTarget as Node | null)) setHold(focusHolds, card, false);
  });
  const slot = document.createElement("div");
  slot.className = "k2b-toast-slot";
  slot.dataset.state = "entering";
  const clip = document.createElement("div");
  clip.className = "k2b-toast-slot__clip";
  clip.appendChild(card);
  slot.appendChild(clip);
  return {
    slot,
    open: () => {
      // The entering state must be laid out once before it changes, or nothing transitions.
      slot.getBoundingClientRect();
      requestAnimationFrame(() => {
        if (card.dataset.closing) return;
        slot.dataset.state = "open";
        card.dataset.open = "true";
      });
    },
    close: (onRemoved) => {
      slot.dataset.state = "closing";
      card.dataset.closing = "true";
      // A card that leaves under the pointer or with focus no longer holds the rail.
      if (pointerHolds.has(card)) setHold(pointerHolds, card, false);
      if (focusHolds.has(card)) setHold(focusHolds, card, false);
      setTimeout(() => {
        slot.remove();
        hideEmptyContainers();
        onRemoved?.();
      }, ANIMATION_MS);
    },
  };
};

/**
 * The rail is full: older timed confirmations leave first, then older errors and sticky toasts. Running progress, the
 * newest toast, and a toast under the pointer or with focus stay; the rail waits until they are released.
 */
function enforceCap(): void {
  const narrow = typeof matchMedia === "function" && matchMedia(NARROW_RAIL_QUERY).matches;
  const cap = narrow ? MAX_VISIBLE_TOASTS_NARROW : MAX_VISIBLE_TOASTS;
  while (liveToasts.size > cap) {
    const older = Array.from(liveToasts)
      .slice(0, -1)
      .filter((item) => !item.held());
    const victim = older.find((item) => !item.keep()) ?? older.find((item) => !item.progress());
    if (!victim) return;
    victim.dismiss();
  }
}

const showToast = (description: string, options?: ToastOptions): ToastHandle => {
  const initialContainer = ensureContainer();
  if (!initialContainer) {
    const noop = () => {};
    return { dismiss: noop, update: noop };
  }
  const messages = resolveUiMessages();
  const doc = initialContainer.ownerDocument;
  // Focus returns here when a focused toast closes and no other toast can take it.
  const opener =
    doc.activeElement instanceof HTMLElement && !doc.activeElement.closest(`[${CONTAINER_ATTRIBUTE}]`) ? doc.activeElement : null;

  let dismissed = false;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let currentVariant: ToastVariant = options?.variant ?? "default";
  let currentProgress = options?.progress ?? null;
  let currentAction = options?.action ?? null;
  let explicitDuration = options?.duration;
  let remainingDuration = 0;
  let timerStartedAt = 0;
  let lastAnnouncement = "";

  const toastElement = doc.createElement("div");
  toastElement.className = "k2b-toast";
  toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
  toastElement.dataset.k2bToast = "";

  const leadElement = doc.createElement("div");
  leadElement.className = "k2b-toast__icon";
  leadElement.setAttribute("aria-hidden", "true");
  const leadIconElement = doc.createElement("i");
  leadElement.appendChild(leadIconElement);
  const renderLead = (iconClassOverride?: string) => {
    leadElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
    applyIconClass(leadIconElement, iconClassOverride ?? VARIANT_STYLES[currentVariant].iconClass);
  };
  renderLead(options?.iconClass);

  const contentElement = doc.createElement("div");
  contentElement.className = "k2b-toast__content";
  const titleElement = doc.createElement("div");
  titleElement.className = "k2b-toast__title";
  const renderTitle = (title: string | undefined) => {
    titleElement.textContent = title ?? "";
    titleElement.hidden = !title;
  };
  renderTitle(options?.title);
  const descriptionElement = doc.createElement("div");
  descriptionElement.className = "k2b-toast__description";
  descriptionElement.textContent = description;
  contentElement.append(titleElement, descriptionElement);

  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "k2b-toast__close";
  closeButton.setAttribute("aria-label", options?.dismissLabel ?? messages.dismissNotification);
  const closeIcon = doc.createElement("i");
  closeIcon.className = "ti ti-x";
  closeIcon.setAttribute("aria-hidden", "true");
  closeButton.appendChild(closeIcon);

  // Inside the content, so a titled progress toast can place the bar between its title and its summary line.
  const progressElement = doc.createElement("progress");
  progressElement.className = "k2b-toast__progress";
  progressElement.max = 1;
  contentElement.appendChild(progressElement);

  toastElement.append(leadElement, contentElement, closeButton);
  const item = railItem(toastElement);

  const text = () => [titleElement.textContent, descriptionElement.textContent].filter(Boolean).join(". ");
  const effectiveDuration = () => explicitDuration ?? defaultDuration(currentVariant, text(), currentAction !== null);
  /** The error word is read before the message; the action is left out. */
  const spoken = () => (currentVariant === "error" ? `${resolveUiMessages().error}: ${text()}` : text());
  const say = () => {
    lastAnnouncement = spoken();
    announce(item.slot.parentElement?.parentElement ?? null, lastAnnouncement, currentVariant === "error");
  };

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
    if (dismissed || currentProgress !== null || remainingDuration <= 0 || railHeld() || doc.hidden) return;
    clearDismissTimer();
    timerStartedAt = Date.now();
    dismissTimer = setTimeout(() => dismiss(), remainingDuration);
  };

  const resetDismissTimer = () => {
    clearDismissTimer();
    remainingDuration = effectiveDuration();
    // A toast that stays until it is closed or its progress ends; a phone shell keeps the end of its content clear of it.
    if (remainingDuration === 0 || currentProgress !== null) toastElement.dataset.persistent = "true";
    else delete toastElement.dataset.persistent;
    resumeDismissTimer();
  };

  const onVisibilityChange = () => (doc.hidden ? pauseDismissTimer() : resumeDismissTimer());

  /** The close button of the nearest open toast in one direction, past neighbours that are still closing. */
  const nearestOpenClose = (step: (slot: Element) => Element | null): HTMLElement | null => {
    for (let slot = step(item.slot); slot; slot = step(slot)) {
      const button = slot.querySelector<HTMLElement>(".k2b-toast:not([data-closing]) .k2b-toast__close");
      if (button) return button;
    }
    return null;
  };

  /** A focused toast hands focus to its neighbour, or back to where the user was, instead of dropping it on the page. */
  const moveFocusAway = () => {
    if (!toastElement.contains(doc.activeElement)) return;
    const next = nearestOpenClose((slot) => slot.nextElementSibling) ?? nearestOpenClose((slot) => slot.previousElementSibling);
    const target = next ?? (opener?.isConnected ? opener : null);
    if (target) target.focus({ preventScroll: true });
    else (doc.activeElement as HTMLElement | null)?.blur();
  };

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearDismissTimer();
    liveToasts.delete(live);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    moveFocusAway();
    item.close();
  };

  const renderProgress = () => {
    progressElement.hidden = currentProgress === null;
    toastElement.dataset.progress = String(currentProgress !== null);
    const title = titleElement.textContent;
    const summary = descriptionElement.textContent ?? "";
    progressElement.setAttribute("aria-label", title || summary);
    // With a title, the message is the summary line under the bar ("6 of 12 files"), read instead of a bare percentage.
    if (typeof currentProgress === "number" && title && summary) progressElement.setAttribute("aria-valuetext", summary);
    else progressElement.removeAttribute("aria-valuetext");
    if (typeof currentProgress === "number")
      progressElement.value = Number.isFinite(currentProgress) ? Math.max(0, Math.min(1, currentProgress)) : 0;
    else progressElement.removeAttribute("value");
  };
  renderProgress();

  let actionElement: HTMLAnchorElement | HTMLButtonElement | null = null;
  const createAction = (action: ToastAction): HTMLAnchorElement | HTMLButtonElement => {
    let element: HTMLAnchorElement | HTMLButtonElement;
    if ("href" in action) {
      element = doc.createElement("a");
      element.href = action.href;
    } else {
      element = doc.createElement("button");
      element.type = "button";
    }
    element.className = "k2b-toast__action";
    element.textContent = action.label;
    element.addEventListener("click", () => {
      if ("onClick" in action) action.onClick();
      else dismiss();
    });
    return element;
  };
  const renderAction = (action: ToastAction | null | undefined) => {
    const previous = actionElement;
    currentAction = action ?? null;
    actionElement = action ? createAction(action) : null;
    if (actionElement) contentElement.appendChild(actionElement);
    // The keyboard stays in the toast, on the new action or the close button, instead of falling to the page.
    if (previous?.contains(doc.activeElement)) (actionElement ?? closeButton).focus({ preventScroll: true });
    previous?.remove();
  };
  renderAction(options?.action);

  const update = (nextDescription: string, nextOptions?: ToastOptions) => {
    if (dismissed) return;
    const has = (key: keyof ToastOptions) => nextOptions !== undefined && Object.prototype.hasOwnProperty.call(nextOptions, key);
    const previousProgress = currentProgress;
    descriptionElement.textContent = nextDescription;

    const variantChanged = nextOptions?.variant !== undefined && nextOptions.variant !== currentVariant;
    if (variantChanged) {
      currentVariant = nextOptions.variant!;
      toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
      renderLead(nextOptions.iconClass);
    } else if (nextOptions?.iconClass !== undefined) {
      applyIconClass(leadIconElement, nextOptions.iconClass);
    }

    if (has("title")) renderTitle(nextOptions!.title);
    if (has("action")) renderAction(nextOptions!.action);
    if (has("duration")) explicitDuration = nextOptions!.duration;
    if (has("progress")) currentProgress = nextOptions!.progress ?? null;
    if (nextOptions?.dismissLabel) closeButton.setAttribute("aria-label", nextOptions.dismissLabel);
    renderProgress();
    resetDismissTimer();

    // Progress is announced at its start, half way, and its end, never at every step, and only with something new to say.
    // The comparison includes the error word, so a change to an error with the same text is still announced.
    const ticking = previousProgress !== null && currentProgress !== null;
    const halfway =
      typeof currentProgress === "number" && currentProgress >= 0.5 && !(typeof previousProgress === "number" && previousProgress >= 0.5);
    if ((!ticking || halfway || variantChanged) && spoken() !== lastAnnouncement) say();
    // Finished progress or a new duration can make this toast one the rail limit removes.
    enforceCap();
  };

  closeButton.addEventListener("click", () => dismiss());
  toastElement.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  });
  doc.addEventListener("visibilitychange", onVisibilityChange);

  const handle: ToastHandle = { dismiss, update };
  const live: LiveToast = {
    dismiss,
    keep: () => currentVariant === "error" || currentProgress !== null || effectiveDuration() === 0,
    progress: () => currentProgress !== null,
    held: () => pointerHolds.has(toastElement) || focusHolds.has(toastElement),
    pause: pauseDismissTimer,
    resume: resumeDismissTimer,
  };
  liveToasts.add(live);
  promoteToTopLayer(initialContainer).appendChild(item.slot);
  item.open();
  say();
  enforceCap();
  resetDismissTimer();
  return handle;
};

/*
 * A custom slot shares the rail, chrome, and enter/leave motion with toasts, so it stacks beside them in the same
 * corner instead of covering them. It has no timer, close button, or live region of its own, and neither the
 * toast limit nor `dismissAll` removes it: the application that placed it decides when it goes.
 */
const showCustom = (content: HTMLElement): ToastSlot => {
  const initialContainer = ensureContainer();
  if (!initialContainer) return { dismiss: () => {} };
  let dismissed = false;
  const slotElement = document.createElement("div");
  slotElement.className = "k2b-toast";
  slotElement.dataset.k2bToast = "";
  slotElement.dataset.custom = "true";
  // It stays until the application removes it, like a toast without a timer.
  slotElement.dataset.persistent = "true";
  slotElement.append(content);
  const item = railItem(slotElement);
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    item.close();
  };
  promoteToTopLayer(initialContainer).appendChild(item.slot);
  item.open();
  return { dismiss };
};

export const isPointInsideToast = (x: number, y: number): boolean => {
  if (typeof document === "undefined") return false;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>(`[${CONTAINER_ATTRIBUTE}] [data-k2b-toast]`))) {
    const rect = card.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
};

const toastFn = ((description: string, options?: ToastOptions) => showToast(description, options)) as ToastFn;
toastFn.success = (description, options) => showToast(description, { ...options, variant: "success" });
toastFn.error = (description, options) => showToast(description, { ...options, variant: "error" });
toastFn.custom = showCustom;
toastFn.dismissAll = () => {
  for (const item of Array.from(liveToasts)) item.dismiss();
};

export const toast: ToastFn = toastFn;
