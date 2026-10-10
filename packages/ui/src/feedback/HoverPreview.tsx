import { type Accessor, createEffect, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show } from "solid-js";
import { returnFocus, ringOnReturn } from "../internal/focus-return";
import { positionTooltipSurface } from "./tooltip-position";

/** A resting pointer moving from one anchor to another swaps the card this fast. */
const SWAP_DELAY = 90;
/** Grace period for the pointer to travel from an anchor into the card. */
const CLOSE_DELAY = 180;
/** Distance to the region and to the boundary edges. */
const GAP = 8;
/** Keys the wiring between a controller and its `<HoverPreview>`. */
const INTERNALS = Symbol("k2b-hover-preview");

/**
 * Where the card opens. By default it opens to the right of its anchor,
 * centered on it or aligned with its bottom edge, and flips or clamps to stay
 * in the viewport. With `beside`, it opens right of that region, such as a list
 * column, top-aligned with the anchor and clamped into `within` (default: the
 * viewport); when the card does not fit there, it does not open at all.
 */
export type HoverPreviewPlacement =
  | { align?: "center" | "end" }
  | { beside: () => HTMLElement | null | undefined; within?: () => HTMLElement | null | undefined };

export type HoverPreviewOptions<T> = {
  /** Milliseconds a resting mouse waits on an anchor before the card opens. Defaults to 250. */
  openDelay?: number;
  /**
   * How keyboard users open the card: `"space"` (default) toggles it with Space
   * on the focused anchor and leaves focus there; `"focus"` opens it after the
   * open delay whenever an anchor receives focus.
   */
  keyboard?: "space" | "focus";
  placement?: HoverPreviewPlacement;
  /** Anchors whose value is disabled open no card; an open card closes once its value becomes disabled. */
  disabled?: (value: T) => boolean;
  /** Runs whenever the card opens or closes, including light dismissal by the browser. */
  onOpenChange?: (open: boolean) => void;
};

export type HoverPreviewController<T> = {
  /** Id of the card element, for `aria-controls`. */
  readonly id: string;
  /**
   * Registers an anchor element for `value`; use the result as a `ref`.
   * `trigger` is the control that toggles the card for this anchor; Escape
   * returns focus there when focus is inside the card. Defaults to the anchor.
   */
  anchor: (value: T, trigger?: () => HTMLElement | null | undefined) => (element: HTMLElement) => void;
  /** The value whose card is open, or `undefined` while closed. */
  active: Accessor<T | undefined>;
  /** Opens the card for `value` at once and moves focus into it, or closes it when it is already pinned open. */
  toggle: (value: T) => void;
  /** Closes the card; it reopens for the same anchor only after the pointer left it. */
  close: () => void;
  /** Wiring for `<HoverPreview>`; not part of the public contract. */
  readonly [INTERNALS]: Internals<T>;
};

type Anchor<T> = { value: T; element: HTMLElement; trigger?: () => HTMLElement | null | undefined };

type Internals<T> = {
  current: Accessor<Anchor<T> | undefined>;
  bind: (surface: HTMLElement) => void;
  enterSurface: () => void;
  leave: () => void;
  focusOut: (event: FocusEvent) => void;
  toggled: (open: boolean) => void;
};

/** Elements that use Space themselves; Space on them never toggles the card. */
const OWNS_SPACE = [
  "button, input, select, textarea, summary, [contenteditable]:not([contenteditable='false'])",
  ...["button", "checkbox", "switch", "radio", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem"].map(
    (role) => `[role='${role}']`,
  ),
].join(", ");

/** Open light-dismiss popovers, such as a menu or a date picker, close when another one opens. */
const AUTO_POPOVER = ":is([popover=''], [popover='auto' i]):popover-open";

/**
 * Creates the behavior of one hover preview card shared by a group of anchors,
 * such as the rows of a list. Render the card with `<HoverPreview preview={…}>`.
 */
export function createHoverPreview<T>(options: HoverPreviewOptions<T> = {}): HoverPreviewController<T> {
  const id = `k2b-hover-preview-${createUniqueId()}`;
  const anchors = new Set<Anchor<T>>();
  const [current, setCurrent] = createSignal<Anchor<T>>();
  const [open, setOpen] = createSignal(false);
  let surface: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The anchor whose open delay runs while the card is closed. */
  let pending: Anchor<T> | undefined;
  /** The anchor that Space or `toggle()` opened the card for; only it outlasts the pointer leaving. */
  let pinned: Anchor<T> | undefined;
  let dismissed: Anchor<T> | undefined;
  /** Where the mouse last moved on an anchor; a mouse rest checks this point when its delay ends. */
  let mouse: { x: number; y: number } | undefined;
  let ring = true;
  let observer: ResizeObserver | undefined;

  const placement = (): HoverPreviewPlacement => options.placement ?? {};
  const region = () => {
    const value = placement();
    return "beside" in value ? value : undefined;
  };
  const focusTarget = (anchor: Anchor<T>) => anchor.trigger?.() ?? anchor.element;
  const anchorOf = (node: Node) => [...anchors].find((anchor) => anchor.element.contains(node));
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending && !open()) document.removeEventListener("keydown", escape);
    pending = undefined;
  };
  /** A passive card never closes a menu or another popover someone opened on purpose. */
  const blocked = () =>
    [...document.querySelectorAll(AUTO_POPOVER)].some((popover) => popover !== surface && !(surface && popover.contains(surface)));

  /** The boundary rectangle, never larger than the viewport. */
  const bounds = (within: Element | null | undefined) => {
    const rect = within?.getBoundingClientRect();
    return {
      top: Math.max(0, rect?.top ?? 0),
      right: Math.min(window.innerWidth, rect?.right ?? window.innerWidth),
      bottom: Math.min(window.innerHeight, rect?.bottom ?? window.innerHeight),
    };
  };
  /** Room right of the region for the card plus a gap on both sides. Works while the card is hidden. */
  const hasRoom = () => {
    const beside = region();
    if (!beside || !surface) return true;
    const area = beside.beside()?.getBoundingClientRect();
    if (!area) return false;
    const width = surface.getBoundingClientRect().width || Number.parseFloat(getComputedStyle(surface).width) || 0;
    return bounds(beside.within?.()).right - area.right >= width + 2 * GAP;
  };
  const position = () => {
    const anchor = current();
    if (!surface || !anchor) return;
    const beside = region();
    if (beside) {
      const area = beside.beside()?.getBoundingClientRect() ?? anchor.element.getBoundingClientRect();
      const box = bounds(beside.within?.());
      const height = surface.getBoundingClientRect().height;
      const top = anchor.element.getBoundingClientRect().top;
      surface.style.left = `${Math.round(area.right + GAP)}px`;
      surface.style.top = `${Math.round(Math.max(box.top + GAP, Math.min(top, box.bottom - height - GAP)))}px`;
      return;
    }
    positionTooltipSurface(surface, anchor.element, "right");
    const value = placement();
    if (!("beside" in value) && value.align === "end") {
      const height = surface.getBoundingClientRect().height;
      const bottom = anchor.element.getBoundingClientRect().bottom;
      surface.style.top = `${Math.round(Math.max(8, Math.min(bottom - height, window.innerHeight - height - 8)))}px`;
    }
  };

  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (!open()) {
      // Escape during the open delay works as if the card had opened and closed.
      if (pending) dismissed = pending;
      clear();
      return;
    }
    // Focus in the card goes back to the trigger: handled here, so the browser
    // neither returns it itself nor lights the ring for this key. A card the
    // pointer opened leaves the key to other handlers, such as an open modeless dialog.
    if (surface?.contains(document.activeElement)) event.preventDefault();
    dismiss();
  };
  // A card beside a region belongs to a row of a scrolling list: once the list
  // scrolls, another row sits under the pointer, so the card closes. A card
  // beside its anchor follows it.
  const scroll = (event: Event) => {
    const target = event.target;
    if (!region()) return position();
    if (!(target instanceof Node) || surface?.contains(target)) return;
    const anchor = current();
    if (!anchor || target.contains(anchor.element)) hide();
  };
  const resize = () => {
    if (hasRoom()) position();
    else hide();
  };
  const listen = (on: boolean) => {
    if (on) {
      document.addEventListener("keydown", escape);
      window.addEventListener("scroll", scroll, true);
      window.addEventListener("resize", resize);
      return;
    }
    document.removeEventListener("keydown", escape);
    window.removeEventListener("scroll", scroll, true);
    window.removeEventListener("resize", resize);
  };

  const hide = () => {
    clear();
    pinned = undefined;
    if (!open()) return;
    setOpen(false);
    listen(false);
    try {
      surface?.hidePopover();
    } catch {
      // The card may already be disconnected during cleanup.
    }
  };
  const dismiss = () => {
    const anchor = current();
    dismissed = anchor;
    // Before hiding, so the popover does not return focus on its own.
    if (anchor && surface?.contains(document.activeElement)) returnFocus(focusTarget(anchor), ring);
    hide();
  };
  /**
   * Opens the card for `anchor` or moves it there; `pin` keeps it open after
   * the pointer leaves. Moving the card to another anchor drops an earlier pin.
   * Returns whether it is open for `anchor`.
   */
  const show = (anchor: Anchor<T>, pin: boolean): boolean => {
    clear();
    if (!surface || dismissed === anchor) return false;
    if (options.disabled?.(anchor.value) || !hasRoom()) {
      hide();
      return false;
    }
    if (!open() || current() !== anchor) {
      ring = ringOnReturn(focusTarget(anchor));
      setCurrent(anchor);
      if (!open()) {
        try {
          surface.showPopover();
        } catch {
          return false;
        }
        setOpen(true);
        listen(true);
      }
      position();
      pinned = undefined;
    }
    if (pin) pinned = anchor;
    return true;
  };
  /**
   * Whether the mouse still rests on `anchor`. A scrolling list or a layout
   * change moves rows under a still mouse before the browser reports another
   * pointer event; WebKit reports it only several scroll steps later.
   */
  const restsOn = (anchor: Anchor<T>) => {
    if (!mouse) return false;
    // Inside a shadow root, the document reports only the shadow host.
    const root = anchor.element.getRootNode();
    const hit = (root instanceof ShadowRoot ? root : document).elementFromPoint(mouse.x, mouse.y);
    return hit !== null && anchor.element.contains(hit);
  };
  /**
   * Shows `anchor` after `delay`; a keyboard swap (`follow`) carries an existing
   * pin along. A mouse rest (`rest`) shows the anchor only if it still lies
   * under the mouse.
   */
  const schedule = (anchor: Anchor<T>, delay: number, follow = false, rest = false) => {
    clear();
    if (!open()) {
      pending = anchor;
      document.addEventListener("keydown", escape);
    }
    timer = setTimeout(() => {
      if (rest && !restsOn(anchor)) clear();
      else if (open()) show(anchor, follow && pinned !== undefined);
      else if (blocked()) clear();
      else show(anchor, false);
    }, delay);
  };
  const leave = () => {
    clear();
    dismissed = undefined;
    if (pinned && pinned === current()) return;
    timer = setTimeout(() => {
      // Focus holds the card open inside it, and on the anchor where focus opens it.
      const focused = document.activeElement;
      const held = surface?.contains(focused) || (options.keyboard === "focus" && current()?.element.contains(focused));
      if (!held) hide();
    }, CLOSE_DELAY);
  };
  const focusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (surface?.contains(next) || anchorOf(next))) return;
    pinned = undefined;
    leave();
  };

  createEffect(() => {
    const anchor = current();
    if (open() && anchor && options.disabled?.(anchor.value)) hide();
  });
  // Only an open card holds global listeners, so a server render that
  // disposes the controller touches no browser globals.
  onCleanup(() => {
    hide();
    observer?.disconnect();
  });

  const anchor =
    (value: T, trigger?: () => HTMLElement | null | undefined) =>
    (element: HTMLElement): void => {
      const entry: Anchor<T> = { value, element, trigger };
      anchors.add(entry);
      const pointerEnter = (event: PointerEvent) => {
        // Touch and pen have no resting hover; the card stays a mouse affordance.
        if (event.pointerType !== "mouse") return;
        mouse = { x: event.clientX, y: event.clientY };
        clear();
        if ((open() && current() === entry) || dismissed === entry) return;
        schedule(entry, open() ? SWAP_DELAY : (options.openDelay ?? 250), false, true);
      };
      // The open delay counts from the moment the mouse rests. An open card
      // swaps on entering another anchor; movement inside it only moves the
      // position that the swap checks.
      const pointerMove = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        mouse = { x: event.clientX, y: event.clientY };
        if (!open() && dismissed !== entry) schedule(entry, options.openDelay ?? 250, false, true);
      };
      // A press acts on the row, such as opening it or its menu; a card about to open stays closed.
      const pointerDown = () => clear();
      const focusIn = () => {
        if (open()) {
          if (current() === entry) clear();
          else schedule(entry, SWAP_DELAY, true);
          return;
        }
        clear();
        if (options.keyboard === "focus" && dismissed !== entry) schedule(entry, options.openDelay ?? 250);
      };
      const keyDown = (event: KeyboardEvent) => {
        if (options.keyboard === "focus" || event.key !== " " || event.defaultPrevented) return;
        // Shift+Space keeps scrolling up; other modifiers belong to shortcuts.
        if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        if (event.target instanceof Element && event.target.matches(OWNS_SPACE)) return;
        event.preventDefault();
        // A held key toggles once; its repeats only keep the page from scrolling.
        if (event.repeat) return;
        if (open() && current() === entry) {
          dismiss();
          return;
        }
        dismissed = undefined;
        show(entry, true);
      };
      element.addEventListener("pointerenter", pointerEnter);
      element.addEventListener("pointermove", pointerMove);
      element.addEventListener("pointerdown", pointerDown);
      element.addEventListener("pointerleave", leave);
      element.addEventListener("focusin", focusIn);
      element.addEventListener("focusout", focusOut);
      element.addEventListener("keydown", keyDown);
      onCleanup(() => {
        anchors.delete(entry);
        if (current() === entry) hide();
        element.removeEventListener("pointerenter", pointerEnter);
        element.removeEventListener("pointermove", pointerMove);
        element.removeEventListener("pointerdown", pointerDown);
        element.removeEventListener("pointerleave", leave);
        element.removeEventListener("focusin", focusIn);
        element.removeEventListener("focusout", focusOut);
        element.removeEventListener("keydown", keyDown);
      });
    };

  return {
    id,
    anchor,
    active: () => (open() ? current()?.value : undefined),
    toggle: (value) => {
      const entry = [...anchors].find((candidate) => candidate.value === value);
      if (!entry || !surface) return;
      clear();
      if (open() && pinned === entry && current() === entry) {
        dismiss();
        return;
      }
      // A hover may have opened the card before this click or key press pinned it.
      ring = ringOnReturn(focusTarget(entry));
      dismissed = undefined;
      if (show(entry, true)) surface.focus();
    },
    close: dismiss,
    [INTERNALS]: {
      current,
      bind: (element) => {
        surface = element;
        observer = new ResizeObserver(() => {
          if (open()) position();
        });
        observer.observe(element);
      },
      enterSurface: clear,
      leave,
      focusOut,
      toggled: (visible) => {
        // Light dismissal by the browser: an outside click or another popover.
        // The event of a close this controller made itself arrives later, when
        // the pointer may already wait on the next anchor; that delay stays.
        if (!visible && open()) {
          clear();
          pinned = undefined;
          setOpen(false);
          listen(false);
        }
        options.onOpenChange?.(visible);
      },
    },
  };
}

export type HoverPreviewProps<T> = {
  preview: HoverPreviewController<T>;
  /** Accessible name of the card. */
  label: string;
  /** `"content"` (default) sizes the card to its content up to 32rem; `"fixed"` keeps one 22rem × 20rem box for every anchor. */
  size?: "content" | "fixed";
  class?: string;
  /** Plain content stays mounted while the card is closed; a function renders the open anchor's value. */
  children: JSX.Element | ((value: T) => JSX.Element);
};

/**
 * A non-modal card that opens beside the anchor a resting mouse points at.
 * Native popover owns the top layer and light dismissal.
 */
export function HoverPreview<T>(props: HoverPreviewProps<T>): JSX.Element {
  const state = props.preview[INTERNALS];
  let surface!: HTMLDivElement;
  onMount(() => state.bind(surface));
  const content = () => {
    const children = props.children;
    if (typeof children !== "function") return children;
    return (
      <Show when={state.current()} keyed>
        {(anchor) => children(anchor.value)}
      </Show>
    );
  };
  return (
    <div
      ref={surface}
      id={props.preview.id}
      popover="auto"
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      class={props.class ? `k2b-hover-preview ${props.class}` : "k2b-hover-preview"}
      data-size={props.size ?? "content"}
      onPointerEnter={() => state.enterSurface()}
      onPointerLeave={() => state.leave()}
      on:focusout={(event) => state.focusOut(event)}
      onToggle={(event) => state.toggled(event.newState === "open")}
    >
      {content()}
    </div>
  );
}
