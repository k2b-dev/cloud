import { getK2bPortalRoot } from "../internal/portal";
import { resolveUiMessages } from "../intl/messages";
import { announce, ensureLiveRegions } from "./announce";
import { resolveToastMessages } from "./toast-messages";

export type ToastVariant = "default" | "success" | "warning" | "error";

export type ToastAction = {
  label: string;
  /**
   * A framed button (`secondary`, the default) or a quiet text button (`ghost`), as for Undo. Next to a
   * `secondaryAction` the first action is the primary button and this is ignored.
   */
  variant?: "secondary" | "ghost";
} & ({ href: string } | { onClick: () => void });

/** A link at the end of the message, such as "Open settings". Following it closes the toast. */
export type ToastLink = {
  label: string;
  href: string;
};

export type ToastOptions = {
  variant?: ToastVariant;
  /** Milliseconds until the toast closes; `0` keeps it until it is closed. Omit it for the default by variant, length, and action. */
  duration?: number;
  iconClass?: string;
  /** A short line of context above the message. There is no default title. */
  title?: string;
  action?: ToastAction | null;
  /** A second action. With it, both actions sit in a row under the message: `action` first, as the primary button. */
  secondaryAction?: ToastAction | null;
  link?: ToastLink | null;
  /**
   * Fraction from 0 to 1 with a bar, or `"indeterminate"` for work of unknown length, which shows a spinner in the
   * icon tile. `update()` turns it into the result in place, with the same rows and height. null removes it.
   */
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
  /** Places an application-owned element at the edge of the toast rail, in toast chrome; the caller owns its content and lifetime. */
  custom: (content: HTMLElement) => ToastSlot;
  dismissAll: () => void;
}

/** Toasts in the stack at every width; older ones leave by the eviction rule below. */
const MAX_VISIBLE_TOASTS = 3;
/** The same media query that moves the rail to the top edge in the stylesheet. */
const NARROW_RAIL_QUERY = "(max-width: 47.999rem), (max-height: 29.999rem)";
/** A leaving toast fades in this time, then leaves the document. */
const ANIMATION_MS = 200;
/** Folded, each older toast shows this much of its edge behind the newer one and is this much smaller. */
const STACK_PEEK_PX = 10;
const STACK_SCALE_STEP = 0.05;
/** Fanned out, the toasts and the pinned custom slots keep this gap. */
const STACK_GAP_PX = 10;
/** A toast arrives from, and leaves towards, the rail's edge by this distance. */
const STACK_TRAVEL_PX = 18;
/** A swipe locks its axis after this distance, and dismisses past the distance or above the speed (px/ms). */
const SWIPE_AXIS_PX = 4;
const SWIPE_DISMISS_PX = 45;
const SWIPE_DISMISS_SPEED = 0.11;
/** After a swipe, the click that ends it does not reach the toast's controls. */
const SWIPE_CLICK_GUARD_MS = 350;
/** Focuses the stack from anywhere on the page. */
const STACK_SHORTCUT = "Alt+T";
/** Option+T types "†" on Apple keyboards. Read inline: the shortcut formatter's catalog would grow every island with a toast. */
const appleKeyboard = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
/** Reading time: a short message stays 4 s, longer text about 1 s more per 30 characters, up to 12 s. */
const READ_BASE_MS = 4_000;
const READ_FREE_CHARACTERS = 40;
const READ_MS_PER_CHARACTER = 35;
const READ_MAX_MS = 12_000;
/** Errors and toasts with an action stay long enough to reach them with a keyboard or a screen magnifier. */
const REACHABLE_MS = 8_000;
/** An error longer than this stays until it is closed, so it can be read and copied. */
const STICKY_ERROR_CHARACTERS = 120;
export const K2B_TOAST_CONTAINER_ID = "k2b-ui-toast-container";
const CONTAINER_ATTRIBUTE = "data-k2b-toast-container";

type VariantStyle = {
  tone: "info" | "success" | "warning" | "danger";
  iconClass: string;
};

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  default: { tone: "info", iconClass: "ti-info-circle" },
  success: { tone: "success", iconClass: "ti-check" },
  warning: { tone: "warning", iconClass: "ti-alert-triangle" },
  error: { tone: "danger", iconClass: "ti-alert-circle" },
};

/** How long a toast stays when the caller passes no duration. */
const defaultDuration = (variant: ToastVariant, text: string, hasAction: boolean): number => {
  if (variant === "error" && text.length > STICKY_ERROR_CHARACTERS) return 0;
  const reading = Math.min(READ_MAX_MS, READ_BASE_MS + Math.max(0, text.length - READ_FREE_CHARACTERS) * READ_MS_PER_CHARACTER);
  return variant === "error" || hasAction ? Math.max(REACHABLE_MS, reading) : reading;
};

/**
 * Links in a toast go to web pages, mail, and phone numbers only. A caller's `javascript:` or `data:` URL never runs
 * from a toast: the link is left out, and an action with such a URL becomes a button that only closes the toast.
 */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|[/?#.]|[^:/?#]*(?:[/?#]|$))/i;
const safeHref = (href: string): string | null => (SAFE_HREF.test(href.trim()) ? href.trim() : null);

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
 * What keeps the stack fanned out and every timer paused: a card under a mouse or pen, keyboard focus in a card or
 * on the rail, or a tap on a touch screen. A swipe in progress pauses the timers without fanning the stack out.
 * While anything holds the rail, no toast times out, so nothing moves under the pointer or out from under focus.
 */
const pointerHolds = new Set<HTMLElement>();
const focusHolds = new Set<HTMLElement>();
const tapHolds = new Set<HTMLElement>();
const gestureHolds = new Set<HTMLElement>();
const stackOpen = (): boolean => pointerHolds.size + focusHolds.size + tapHolds.size > 0;
const railHeld = (): boolean => stackOpen() || gestureHolds.size > 0;

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
  for (const holds of [tapHolds, gestureHolds])
    for (const element of Array.from(holds)) if (!element.isConnected) setHold(holds, element, false);
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

function setHold(holds: Set<HTMLElement>, element: HTMLElement, held: boolean): void {
  if (holds.has(element) === held) return;
  const wasHeld = railHeld();
  const wasOpen = stackOpen();
  if (held) holds.add(element);
  else holds.delete(element);
  if (railHeld() !== wasHeld) {
    for (const item of Array.from(liveToasts)) (wasHeld ? item.resume : item.pause)();
    unwatchStaleHolds?.();
    unwatchStaleHolds = wasHeld ? null : watchStaleHolds(element.ownerDocument);
  }
  if (stackOpen() !== wasOpen) scheduleLayout(element.ownerDocument);
  // A released card may be the one the rail limit had to wait for.
  if (!held) enforceCap();
}

const rails = (doc: Document): HTMLElement[] => Array.from(doc.querySelectorAll<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`));

/** The rail that shows at least one open toast or custom slot. */
const shownRail = (doc: Document): HTMLElement | null =>
  rails(doc).find((rail) => Array.from(rail.children).some((slot) => slot instanceof HTMLElement && slot.dataset.state !== "closing")) ??
  null;

/** Where focus was before the shortcut moved it to the stack; Escape on the stack returns it. */
let shortcutOrigin: HTMLElement | null = null;

/** Escape on the focused stack: it folds, unless the pointer still rests on it, and focus goes back. */
const foldStack = (rail: HTMLElement): void => {
  const doc = rail.ownerDocument;
  for (const element of Array.from(tapHolds)) setHold(tapHolds, element, false);
  if (rail.contains(doc.activeElement)) {
    const origin = shortcutOrigin?.isConnected ? shortcutOrigin : null;
    if (origin) origin.focus({ preventScroll: true });
    else (doc.activeElement as HTMLElement | null)?.blur();
  }
  setHold(focusHolds, rail, false);
  shortcutOrigin = null;
};

const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));

/**
 * One listener set per document: the shortcut, a tap beside an open stack, and the edge moving between the top and
 * the bottom (a rotated phone, a modal dialog in a phone shell). They outlive a rail, which moves into a new element
 * whenever it returns to the top layer.
 */
const wiredDocuments = new WeakSet<Document>();
const wireDocument = (doc: Document): void => {
  if (wiredDocuments.has(doc)) return;
  wiredDocuments.add(doc);
  doc.addEventListener("keydown", (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyT" || event.defaultPrevented) return;
    const rail = shownRail(doc);
    if (!rail) return;
    // Option+T types a character on Apple keyboards; there the shortcut leaves text entry alone.
    if (isTextEntry(event.target) && appleKeyboard()) return;
    event.preventDefault();
    const active = doc.activeElement;
    if (active instanceof HTMLElement && !active.closest(`[${CONTAINER_ATTRIBUTE}]`) && active !== doc.body) shortcutOrigin = active;
    rail.focus({ preventScroll: true });
    // Behind a modal dialog the rail is inert and takes no focus; then nothing holds the stack open.
    if (doc.activeElement === rail) setHold(focusHolds, rail, true);
  });
  doc.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "mouse" || tapHolds.size === 0) return;
      if (event.target instanceof Element && event.target.closest(`[${CONTAINER_ATTRIBUTE}]`)) return;
      for (const rail of Array.from(tapHolds)) setHold(tapHolds, rail, false);
    },
    true,
  );
  const view = doc.defaultView;
  const relayout = () => scheduleLayout(doc);
  view?.addEventListener("resize", relayout);
  if (typeof view?.matchMedia === "function") view.matchMedia(NARROW_RAIL_QUERY).addEventListener?.("change", relayout);
  new MutationObserver(relayout).observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["data-k2b-mobile-shell", "data-k2b-mobile-shell-modal"],
  });
};

/** Listeners on the rail element itself; a rail that returns to the top layer is a new element and is wired again. */
const wiredRails = new WeakSet<HTMLElement>();
const wireRail = (rail: HTMLElement): HTMLElement => {
  if (wiredRails.has(rail)) return rail;
  wiredRails.add(rail);
  rail.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.target !== rail || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    foldStack(rail);
  });
  rail.addEventListener("focusout", (event) => {
    if (event.target === rail) setHold(focusHolds, rail, false);
  });
  return rail;
};

const ensureContainer = (): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  // The shared live regions exist before the first toast's text arrives.
  ensureLiveRegions(document);
  wireDocument(document);
  const root = getK2bPortalRoot();
  let container = root.querySelector<HTMLElement>(`[${CONTAINER_ATTRIBUTE}]`);
  if (container) return container;

  const messages = resolveToastMessages();
  container = document.createElement("div");
  container.id = K2B_TOAST_CONTAINER_ID;
  container.setAttribute(CONTAINER_ATTRIBUTE, "");
  container.setAttribute("popover", "manual");
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", `${messages.notifications}, ${STACK_SHORTCUT}`);
  container.setAttribute("aria-keyshortcuts", STACK_SHORTCUT);
  container.tabIndex = -1;
  // Keep the source rail geometry inline: it must defeat UA popover defaults
  // even when a consumer has not loaded the optional package stylesheet yet.
  // The stylesheet only moves the rail to the top edge, and to the full width
  // of a phone, through the rail variables. The toasts lie on top of each
  // other inside it; the stack sets the rail's height to what they cover, so
  // nothing clips their shadows or the close buttons over their corners.
  container.style.cssText =
    "position:fixed;left:var(--k2b-toast-rail-left,auto);right:env(safe-area-inset-right,0px);" +
    "top:var(--k2b-toast-rail-top,auto);bottom:var(--k2b-toast-rail-bottom,env(safe-area-inset-bottom,0px));" +
    "z-index:50;box-sizing:border-box;display:block;" +
    "width:var(--k2b-toast-rail-width,min(25.5rem,calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px))));" +
    "height:0px;max-width:100vw;max-height:none;" +
    "margin:0;padding:var(--k2b-toast-rail-padding,0.75rem 1rem 1rem);border:0;background:transparent;overflow:visible;" +
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
  return (rail: HTMLElement) => {
    for (const [element, top, left] of scrolled) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    // The rail itself held focus after Alt+T: the new rail takes it over.
    const target = focused === container ? rail : focused;
    if (target?.isConnected && rail.contains(target)) target.focus({ preventScroll: true });
  };
};

/** A tap or the shortcut that holds the stack open holds the rail that replaces it in the top layer. */
const handOverHolds = (from: HTMLElement, to: HTMLElement): void => {
  for (const holds of [focusHolds, tapHolds]) if (holds.delete(from)) holds.add(to);
};

const promoteToTopLayer = (container: HTMLElement): HTMLElement => {
  if (typeof container.showPopover !== "function" || !container.isConnected) return wireRail(container);
  let active = container;
  let restore: ((rail: HTMLElement) => void) | null = null;
  try {
    if (container.matches(":popover-open") || document.querySelector("dialog:modal")) {
      restore = captureViewState(container);
      const next = container.cloneNode(false) as HTMLElement;
      while (container.firstChild) next.appendChild(container.firstChild);
      handOverHolds(container, next);
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
  return wireRail(active);
};

/** Close every empty rail so an emptied container does not linger in the top
 *  layer. Rails are resolved at call time on purpose: `promoteToTopLayer`
 *  swaps the element for a fresh clone, so a container captured when the toast
 *  was created can already be detached by the time the toast is dismissed. */
const hideEmptyContainers = (): void => {
  if (typeof document === "undefined") return;
  for (const container of rails(document)) {
    if (container.childElementCount > 0 || typeof container.hidePopover !== "function") continue;
    try {
      if (container.matches(":popover-open")) container.hidePopover();
    } catch {
      // Already hidden or disconnected.
    }
  }
};

/* ------------------------------------------------------------------ stack */

/** Where layout last placed each slot, away from the edge in px; a leaving slot travels on from there. */
const placedAt = new WeakMap<HTMLElement, number>();

/** One pending layout frame per document; every change before it lands in the same layout. */
const layoutFrames = new WeakMap<Document, number>();
function scheduleLayout(doc: Document): void {
  const view = doc.defaultView;
  if (!view || layoutFrames.has(doc) || typeof view.requestAnimationFrame !== "function") return;
  layoutFrames.set(
    doc,
    view.requestAnimationFrame(() => {
      layoutFrames.delete(doc);
      for (const rail of rails(doc)) layoutRail(rail);
    }),
  );
}

/** A card that grows or shrinks, as when `update()` changes its text, moves the cards around it. */
const resizeObservers = new WeakMap<Document, ResizeObserver | null>();
const observeSize = (card: HTMLElement, observed: boolean): void => {
  const doc = card.ownerDocument;
  if (!resizeObservers.has(doc)) {
    const Observer = doc.defaultView?.ResizeObserver;
    resizeObservers.set(doc, typeof Observer === "function" ? new Observer(() => scheduleLayout(doc)) : null);
  }
  const observer = resizeObservers.get(doc);
  if (observed) observer?.observe(card);
  else observer?.unobserve(card);
};

const slotCard = (slot: HTMLElement): HTMLElement | null => (slot.firstElementChild instanceof HTMLElement ? slot.firstElementChild : null);

/** The rail's edge: the stylesheet moves it to the top on narrow and short viewports. */
const railAtTop = (style: CSSStyleDeclaration): boolean => style.getPropertyValue("--k2b-toast-rail-direction").trim() === "column-reverse";

/**
 * Places every slot of a rail. Custom slots are pinned at the edge in the order they came; the toasts stack in front
 * of them, newest nearest the edge. Folded, older toasts show only their edge; fanned out, every toast shows whole,
 * with a gap. Only transform and opacity move, so nothing reflows the page while the stack moves.
 */
const layoutRail = (rail: HTMLElement): void => {
  if (!rail.isConnected) return;
  const style = getComputedStyle(rail);
  const top = railAtTop(style);
  const sign = top ? 1 : -1;
  const open = stackOpen() && shownRail(rail.ownerDocument) === rail;
  rail.dataset.edge = top ? "top" : "bottom";
  rail.dataset.expanded = String(open);
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  const slots = Array.from(rail.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches(".k2b-toast-slot"),
  );
  const present = slots.filter((slot) => slot.dataset.state !== "closing");
  // Natural heights, read in one go before anything is written.
  const heights = new Map(present.map((slot) => [slot, slotCard(slot)?.offsetHeight ?? 0]));
  // A message too long for its toast scrolls inside it; there a finger scrolls it instead of swiping vertically.
  const overflowing = present.map((slot) => {
    const description = slotCard(slot)?.querySelector<HTMLElement>(":scope > .k2b-toast__content > .k2b-toast__description");
    return [slot, !!description && description.scrollHeight > description.clientHeight + 1] as const;
  });
  // Fanned out, the stack stays on screen: when it is taller than the room up to the far edge, the older toasts move
  // closer and overlap, each still showing its top with its close button and title.
  const railBox = rail.getBoundingClientRect();
  const viewHeight = rail.ownerDocument.documentElement.clientHeight;
  const room = (top ? viewHeight - railBox.top : railBox.bottom) - padTop - padBottom;
  const place = (
    slot: HTMLElement,
    y: number,
    options: { scale?: number; opacity?: number; height: number; behind?: boolean; layer: number },
  ) => {
    const entering = slot.dataset.state === "entering";
    const travelled = entering ? y - STACK_TRAVEL_PX : y;
    placedAt.set(slot, y);
    slot.style.left = style.paddingLeft;
    slot.style.right = style.paddingRight;
    slot.style.top = top ? `${padTop}px` : "auto";
    slot.style.bottom = top ? "auto" : `${padBottom}px`;
    slot.style.height = `${options.height}px`;
    slot.style.zIndex = String(options.layer);
    slot.style.setProperty("--k2b-toast-y", `${sign * travelled}px`);
    slot.style.setProperty("--k2b-toast-scale", String(options.scale ?? 1));
    slot.style.setProperty("--k2b-toast-opacity", entering ? "0" : String(options.opacity ?? 1));
    slot.toggleAttribute("data-behind", options.behind === true);
    // A folded toast behind the front one is out of reach until the stack fans out; no hidden focus target.
    slot.inert = options.behind === true;
  };

  let base = 0;
  const sockets = present.filter((slot) => slot.dataset.custom === "true");
  for (const slot of sockets) {
    const height = heights.get(slot) ?? 0;
    place(slot, base, { height, layer: 200 });
    base += height + STACK_GAP_PX;
  }
  const stack = present.filter((slot) => slot.dataset.custom !== "true").reverse();
  const frontHeight = stack[0] ? (heights.get(stack[0]) ?? 0) : 0;
  let offset = 0;
  let previous = 0;
  let extent = 0;
  stack.forEach((slot, index) => {
    const height = heights.get(slot) ?? 0;
    if (open) {
      const natural = base + offset;
      const y = index === 0 ? natural : Math.max(previous + STACK_PEEK_PX, Math.min(natural, room - height));
      place(slot, y, { height, layer: 100 - index });
      offset += height + STACK_GAP_PX;
      previous = y;
      extent = Math.max(extent, y + height);
    } else {
      place(slot, base + index * STACK_PEEK_PX, {
        scale: 1 - index * STACK_SCALE_STEP,
        opacity: index < MAX_VISIBLE_TOASTS ? 1 : 0,
        height: index === 0 ? height : frontHeight,
        behind: index > 0,
        layer: 100 - index,
      });
    }
  });
  const covered =
    stack.length === 0
      ? Math.max(0, base - STACK_GAP_PX)
      : open
        ? extent
        : base + frontHeight + Math.min(stack.length - 1, MAX_VISIBLE_TOASTS - 1) * STACK_PEEK_PX;
  for (const [slot, scrolls] of overflowing) slot.toggleAttribute("data-scrolls", scrolls);
  rail.style.height = covered > 0 ? `${covered + padTop + padBottom}px` : "0px";
};

/**
 * Every toast and custom slot sits in a slot that the stack places. The card carries the chrome and `data-open` /
 * `data-closing`; the slot carries the motion.
 */
type RailItem = {
  slot: HTMLElement;
  open: () => void;
  close: (options?: { swiped?: boolean }) => void;
};

const railItem = (card: HTMLElement): RailItem => {
  card.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "touch") setHold(pointerHolds, card, true);
  });
  card.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "touch") setHold(pointerHolds, card, false);
  });
  card.addEventListener("focusin", () => setHold(focusHolds, card, true));
  card.addEventListener("focusout", (event) => {
    if (!card.contains(event.relatedTarget as Node | null)) setHold(focusHolds, card, false);
  });
  const slot = document.createElement("div");
  slot.className = "k2b-toast-slot";
  slot.dataset.state = "entering";
  if (card.dataset.custom) slot.dataset.custom = card.dataset.custom;
  slot.style.setProperty("--k2b-toast-opacity", "0");
  slot.appendChild(card);
  return {
    slot,
    open: () => {
      observeSize(card, true);
      const rail = slot.parentElement;
      // The entering place must be laid out once before it changes, or nothing transitions.
      if (rail) layoutRail(rail);
      slot.getBoundingClientRect();
      requestAnimationFrame(() => {
        if (card.dataset.closing) return;
        slot.dataset.state = "open";
        card.dataset.open = "true";
        // In the same frame as the state, so the arrival moves from its first frame on.
        if (slot.parentElement) layoutRail(slot.parentElement);
      });
    },
    close: (options) => {
      const wasEntering = slot.dataset.state === "entering";
      slot.dataset.state = "closing";
      card.dataset.closing = "true";
      observeSize(card, false);
      // Unswiped, it fades out towards the edge from where it was.
      if (!options?.swiped && !wasEntering) {
        const sign = slot.parentElement?.dataset.edge === "top" ? 1 : -1;
        slot.style.setProperty("--k2b-toast-y", `${sign * ((placedAt.get(slot) ?? 0) - STACK_TRAVEL_PX)}px`);
      }
      slot.style.setProperty("--k2b-toast-opacity", "0");
      slot.inert = true;
      // A card that leaves under the pointer or with focus no longer holds the rail.
      if (pointerHolds.has(card)) setHold(pointerHolds, card, false);
      if (focusHolds.has(card)) setHold(focusHolds, card, false);
      scheduleLayout(card.ownerDocument);
      setTimeout(() => {
        slot.remove();
        hideEmptyContainers();
        scheduleLayout(card.ownerDocument);
      }, ANIMATION_MS);
    },
  };
};

/** A click that only ends a swipe or a tap does not press the control under the finger. */
const swallowNextClick = (card: HTMLElement): void => {
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  card.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => card.removeEventListener("click", stop, { capture: true }), SWIPE_CLICK_GUARD_MS);
};

/** Wrong-direction travel follows the finger less and less, so the toast resists instead of moving away. */
const resisted = (distance: number): number => distance / (1.5 + Math.abs(distance) / 20);

/**
 * Swiping towards the nearest screen edge dismisses a toast: down or right at the bottom edge, up or sideways at the
 * top. A tap on a touch screen fans the stack out or folds it. Swiping is a shortcut; the close button stays.
 */
const attachGestures = (item: RailItem, card: HTMLElement, dismiss: (swiped: boolean) => void): (() => void) => {
  let gesture: { id: number; x: number; y: number; at: number; axis: "x" | "y" | null; dx: number; dy: number } | null = null;
  const slot = item.slot;
  const rail = () => slot.parentElement;
  const allowed = (direction: "left" | "right" | "up" | "down") =>
    rail()?.dataset.edge === "top" ? direction !== "down" : direction === "right" || direction === "down";

  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || card.dataset.closing) return;
    const target = event.target instanceof Element ? event.target : null;
    // A mouse selects the message and presses the controls; a finger can start a swipe anywhere.
    if (event.pointerType === "mouse" && target?.closest("a, button, .k2b-toast__content")) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, axis: null, dx: 0, dy: 0 };
    setHold(gestureHolds, card, true);
  });
  card.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.axis) {
      if (Math.abs(dx) < SWIPE_AXIS_PX && Math.abs(dy) < SWIPE_AXIS_PX) return;
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      card.setPointerCapture?.(event.pointerId);
      slot.dataset.swiping = "true";
    }
    gesture.dx = dx;
    gesture.dy = dy;
    const x = gesture.axis === "x" ? (allowed(dx > 0 ? "right" : "left") ? dx : resisted(dx)) : 0;
    const y = gesture.axis === "y" ? (allowed(dy > 0 ? "down" : "up") ? dy : resisted(dy)) : 0;
    slot.style.setProperty("--k2b-toast-swipe-x", `${x}px`);
    slot.style.setProperty("--k2b-toast-swipe-y", `${y}px`);
    slot.style.setProperty("--k2b-toast-fade", String(Math.max(0.35, 1 - Math.hypot(x, y) / 220)));
  });
  const release = () => {
    gesture = null;
    delete slot.dataset.swiping;
    slot.style.setProperty("--k2b-toast-fade", "1");
    setHold(gestureHolds, card, false);
  };
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const ended = gesture;
    release();
    const owner = rail();
    if (ended.axis && !cancelled) {
      swallowNextClick(card);
      const distance = ended.axis === "x" ? ended.dx : ended.dy;
      const direction = ended.axis === "x" ? (distance > 0 ? "right" : "left") : distance > 0 ? "down" : "up";
      const speed = Math.abs(distance) / Math.max(1, event.timeStamp - ended.at);
      if (allowed(direction) && (Math.abs(distance) >= SWIPE_DISMISS_PX || speed > SWIPE_DISMISS_SPEED)) {
        slot.style.setProperty(
          ended.axis === "x" ? "--k2b-toast-swipe-x" : "--k2b-toast-swipe-y",
          `${Math.sign(distance) * (ended.axis === "x" ? 110 : 140)}%`,
        );
        dismiss(true);
        return;
      }
    } else if (!ended.axis && !cancelled && event.pointerType !== "mouse" && owner) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("a, button")) setHold(tapHolds, owner, !tapHolds.has(owner));
    }
    slot.style.setProperty("--k2b-toast-swipe-x", "0px");
    slot.style.setProperty("--k2b-toast-swipe-y", "0px");
  };
  card.addEventListener("pointerup", (event) => end(event, false));
  card.addEventListener("pointercancel", (event) => end(event, true));
  card.addEventListener("lostpointercapture", (event) => end(event, true));
  // Before its axis locks, a gesture has no pointer capture: a pointer that leaves the card ends it, so it never pauses the timers for good.
  card.addEventListener("pointerleave", (event) => {
    if (gesture && !gesture.axis) end(event, true);
  });
  // A toast that closes in the middle of a gesture, by its timer's neighbour, an update, or the rail limit, lets go.
  return () => {
    if (gesture) release();
  };
};

/**
 * The rail is full: older timed confirmations leave first, then older errors and sticky toasts. Running progress, the
 * newest toast, and a toast under the pointer or with focus stay; the rail waits until they are released.
 */
function enforceCap(): void {
  while (liveToasts.size > MAX_VISIBLE_TOASTS) {
    const older = Array.from(liveToasts)
      .slice(0, -1)
      .filter((item) => !item.held());
    const victim = older.find((item) => !item.keep()) ?? older.find((item) => !item.progress());
    if (!victim) return;
    victim.dismiss();
  }
}

/** The kind of button an action becomes in its place. */
const actionVariant = (action: ToastAction, paired: boolean, first: boolean): "primary" | "secondary" | "ghost" =>
  paired ? (first ? "primary" : "secondary") : (action.variant ?? "secondary");

const showToast = (description: string, options?: ToastOptions): ToastHandle => {
  const initialContainer = ensureContainer();
  if (!initialContainer) {
    const noop = () => {};
    return { dismiss: noop, update: noop };
  }
  const toastMessages = resolveToastMessages();
  const doc = initialContainer.ownerDocument;
  // Focus returns here when a focused toast closes and no other toast can take it.
  const opener =
    doc.activeElement instanceof HTMLElement && !doc.activeElement.closest(`[${CONTAINER_ATTRIBUTE}]`) ? doc.activeElement : null;

  let dismissed = false;
  let dismissTimer: ReturnType<typeof setTimeout> | null = null;
  let currentVariant: ToastVariant = options?.variant ?? "default";
  let currentProgress = options?.progress ?? null;
  let currentAction = options?.action ?? null;
  let currentSecondary = options?.secondaryAction ?? null;
  let currentLink = options?.link ?? null;
  let currentTitle = options?.title;
  let currentDescription = description;
  let dismissLabel = options?.dismissLabel;
  let explicitDuration = options?.duration;
  let remainingDuration = 0;
  let timerStartedAt = 0;
  let lastAnnouncement = "";

  const toastElement = doc.createElement("div");
  toastElement.className = "k2b-toast";
  toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
  toastElement.dataset.k2bToast = "";

  // The first control in the toast: a round button over its top-left corner.
  const closeButton = doc.createElement("button");
  closeButton.type = "button";
  closeButton.className = "k2b-toast__close";
  const closeIcon = doc.createElement("i");
  closeIcon.className = "ti ti-x";
  closeIcon.setAttribute("aria-hidden", "true");
  closeButton.appendChild(closeIcon);

  const leadElement = doc.createElement("div");
  leadElement.className = "k2b-toast__icon k2b-icon-tile";
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
  const descriptionElement = doc.createElement("div");
  descriptionElement.className = "k2b-toast__description";
  // A titled progress toast places the bar between its title and its summary line.
  const progressElement = doc.createElement("progress");
  progressElement.className = "k2b-toast__progress";
  progressElement.max = 1;
  contentElement.append(titleElement, descriptionElement, progressElement);

  // One action stays beside the message; two go to a row under it.
  const endElement = doc.createElement("div");
  endElement.className = "k2b-toast__end";
  const actionsElement = doc.createElement("div");
  actionsElement.className = "k2b-toast__actions";

  toastElement.append(closeButton, leadElement, contentElement, endElement, actionsElement);
  const item = railItem(toastElement);

  const text = () => [currentTitle, currentDescription].filter(Boolean).join(". ");
  const effectiveDuration = () =>
    explicitDuration ?? defaultDuration(currentVariant, text(), currentAction !== null || currentSecondary !== null);
  /** The error word is read before the message; the actions and the link are left out. */
  const spoken = () => (currentVariant === "error" ? `${resolveUiMessages().error}: ${text()}` : text());
  const say = () => {
    lastAnnouncement = spoken();
    announce(lastAnnouncement, { politeness: currentVariant === "error" ? "assertive" : "polite" });
  };

  const renderClose = () => {
    closeButton.setAttribute("aria-label", dismissLabel ?? toastMessages.dismissNamed({ name: currentTitle || currentDescription }));
  };

  // The message is one text node; the link after it is one element kept across updates, so focus on it survives them.
  const descriptionText = doc.createTextNode("");
  const linkElement = doc.createElement("a");
  linkElement.className = "k2b-toast__link";
  linkElement.addEventListener("click", () => dismiss());
  descriptionElement.append(descriptionText);
  const renderText = () => {
    titleElement.textContent = currentTitle ?? "";
    titleElement.hidden = !currentTitle;
    descriptionText.data = currentDescription;
    const href = currentLink ? safeHref(currentLink.href) : null;
    if (currentLink && href !== null) {
      linkElement.href = href;
      linkElement.textContent = currentLink.label;
      if (!linkElement.isConnected) descriptionElement.append(" ", linkElement);
    } else if (linkElement.isConnected) {
      // A removed link hands its focus to the close button, so the keyboard stays in the toast.
      const focused = linkElement.contains(doc.activeElement);
      descriptionElement.replaceChildren(descriptionText);
      if (focused) closeButton.focus({ preventScroll: true });
    }
    renderClose();
  };
  renderText();

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

  const dismiss = (swiped = false) => {
    if (dismissed) return;
    dismissed = true;
    clearDismissTimer();
    liveToasts.delete(live);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    moveFocusAway();
    cancelGesture();
    item.close({ swiped });
  };

  const renderProgress = () => {
    // Work of unknown length shows the spinner in the tile instead of a bar, so its result keeps the same rows.
    progressElement.hidden = typeof currentProgress !== "number";
    toastElement.dataset.progress = String(currentProgress !== null);
    progressElement.setAttribute("aria-label", currentTitle || currentDescription);
    // With a title, the message is the summary line under the bar ("6 of 12 files"), read instead of a bare percentage.
    if (typeof currentProgress === "number" && currentTitle && currentDescription)
      progressElement.setAttribute("aria-valuetext", currentDescription);
    else progressElement.removeAttribute("aria-valuetext");
    if (typeof currentProgress === "number")
      progressElement.value = Number.isFinite(currentProgress) ? Math.max(0, Math.min(1, currentProgress)) : 0;
    else progressElement.removeAttribute("value");
  };
  renderProgress();

  const createAction = (action: ToastAction, variant: "primary" | "secondary" | "ghost"): HTMLAnchorElement | HTMLButtonElement => {
    let element: HTMLAnchorElement | HTMLButtonElement;
    const href = "href" in action ? safeHref(action.href) : null;
    if (href !== null) {
      element = doc.createElement("a");
      element.href = href;
    } else {
      element = doc.createElement("button");
      element.type = "button";
    }
    element.className = "k2b-toast__action";
    element.dataset.variant = variant;
    element.textContent = action.label;
    element.addEventListener("click", () => {
      if ("onClick" in action) action.onClick();
      else dismiss();
    });
    return element;
  };
  const renderActions = () => {
    const previous = Array.from(toastElement.querySelectorAll<HTMLElement>(".k2b-toast__action"));
    const focusedIndex = previous.findIndex((element) => element.contains(doc.activeElement));
    const actions = [currentAction, currentSecondary].filter((action): action is ToastAction => action !== null);
    const paired = actions.length > 1;
    const elements = actions.map((action, index) => createAction(action, actionVariant(action, paired, index === 0)));
    (paired ? actionsElement : endElement).append(...elements);
    endElement.hidden = paired || elements.length === 0;
    actionsElement.hidden = !paired;
    // The keyboard stays in the toast, on the new action in the same place or the close button, instead of falling to the page.
    if (focusedIndex >= 0) (elements[focusedIndex] ?? elements.at(-1) ?? closeButton).focus({ preventScroll: true });
    for (const element of previous) element.remove();
  };
  renderActions();

  /** A result that replaces the message in place fades in, so the change is seen without the toast moving. */
  const markSwap = () => {
    delete contentElement.dataset.swap;
    void contentElement.offsetWidth;
    contentElement.dataset.swap = "true";
  };

  const update = (nextDescription: string, nextOptions?: ToastOptions) => {
    if (dismissed) return;
    const has = (key: keyof ToastOptions) => nextOptions !== undefined && Object.prototype.hasOwnProperty.call(nextOptions, key);
    const previousProgress = currentProgress;
    currentDescription = nextDescription;

    const variantChanged = nextOptions?.variant !== undefined && nextOptions.variant !== currentVariant;
    if (variantChanged) {
      currentVariant = nextOptions.variant!;
      toastElement.dataset.tone = VARIANT_STYLES[currentVariant].tone;
      renderLead(nextOptions.iconClass);
    } else if (nextOptions?.iconClass !== undefined) {
      applyIconClass(leadIconElement, nextOptions.iconClass);
    }

    if (has("title")) currentTitle = nextOptions!.title;
    if (has("link")) currentLink = nextOptions!.link ?? null;
    if (nextOptions?.dismissLabel) dismissLabel = nextOptions.dismissLabel;
    renderText();
    if (has("action") || has("secondaryAction")) {
      if (has("action")) currentAction = nextOptions!.action ?? null;
      if (has("secondaryAction")) currentSecondary = nextOptions!.secondaryAction ?? null;
      renderActions();
    }
    if (has("duration")) explicitDuration = nextOptions!.duration;
    if (has("progress")) currentProgress = nextOptions!.progress ?? null;
    renderProgress();
    resetDismissTimer();
    if (variantChanged || (previousProgress !== null && currentProgress === null)) markSwap();

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
  const cancelGesture = attachGestures(item, toastElement, (swiped) => dismiss(swiped));

  const handle: ToastHandle = { dismiss: () => dismiss(), update };
  const live: LiveToast = {
    dismiss: () => dismiss(),
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
 * A custom slot shares the rail, chrome, and motion with toasts, and is pinned at the rail's edge: toasts stack in
 * front of it instead of covering it. It has no timer, close button, swipe, or live region of its own, and neither
 * the toast limit nor `dismissAll` removes it: the application that placed it decides when it goes.
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

export { isPointInsideToast } from "./toast-hit";

const toastFn = ((description: string, options?: ToastOptions) => showToast(description, options)) as ToastFn;
toastFn.success = (description, options) => showToast(description, { ...options, variant: "success" });
toastFn.error = (description, options) => showToast(description, { ...options, variant: "error" });
toastFn.custom = showCustom;
toastFn.dismissAll = () => {
  for (const item of Array.from(liveToasts)) item.dismiss();
};

export const toast: ToastFn = toastFn;
