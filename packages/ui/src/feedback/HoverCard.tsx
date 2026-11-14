import { createEffect, createSignal, createUniqueId, type JSX, onCleanup, onMount, Show, splitProps, untrack } from "solid-js";
import { placeAtAnchor, SHEET_QUERY } from "../internal/anchor-placement";
import { AnchorContext } from "./Tooltip";

/** Milliseconds a resting pointer waits before the card opens; a little longer than a tooltip, as the card is larger. */
const OPEN_DELAY = 400;
/** Grace period for the pointer to travel between the control and the card. */
const CLOSE_DELAY = 200;
/** Controls whose keyboard focus describes them; the first one in an anchor gets the card as its description. */
const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";

export type HoverCardOptions = {
  /** The card's content: a small graphic, a `ProgressPath`, a `DescriptionList`, or a few lines. Information only. */
  content: JSX.Element;
  /** A bold first line, such as the name of what the control shows. */
  title?: JSX.Element;
  /** A quiet line under the title, such as where the thing belongs. */
  detail?: JSX.Element;
  /** A quiet last line, such as what a click on the control does. */
  hint?: JSX.Element;
  /** The side tried first; the card flips only when the other side has more room. Defaults to `below`. */
  side?: "below" | "above";
  /** Which edge of the card lines up with the control. Defaults to `start`. */
  align?: "start" | "end";
  /** Width of the card, such as `32rem`. Defaults to `20rem`; it never gets wider than the screen. */
  width?: string;
  /** Milliseconds a resting pointer waits before the card opens. Defaults to 400. */
  delay?: number;
  /** Keeps the card closed; an open card closes. */
  disabled?: boolean;
  /** Extra class on the card. */
  class?: string;
};

export type HoverCardProps = HoverCardOptions & Omit<JSX.HTMLAttributes<HTMLSpanElement>, "content" | "title">;

export type HoverCardTriggerProps = HoverCardOptions &
  Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "content" | "title" | "class"> & {
    /** Class of the trigger button; `class` styles the card. */
    triggerClass?: string;
  };

type Mode = "anchor" | "trigger";

/**
 * The shared behavior: a resting pointer opens the card after a delay, keyboard focus opens it at once, and it stays
 * open while the pointer is on the control or the card. A trigger also opens it with a press, which pins it open; on a
 * phone a tap opens it as a bottom sheet.
 */
function useHoverCard(options: HoverCardOptions, mode: Mode, target: () => HTMLElement | undefined) {
  const id = `k2b-hover-card-${createUniqueId()}`;
  const [open, setOpen] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  let surface: HTMLDivElement | undefined;
  let focusHost: HTMLElement | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Why the card is open: the pointer rests on control or card, the control has keyboard focus, or a press pinned it. */
  let hovered = false;
  let focused = false;
  let pinned = false;
  /** Escape or using the control closes the card until the pointer and the focus left the control. */
  let dismissed = false;
  /** The side chosen when the card opened; kept until it closes, so the card never jumps. */
  let above: boolean | undefined;
  let pressType = "";

  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = undefined;
  };

  const place = () => {
    const anchor = target();
    if (!surface || !anchor || !open()) return;
    if (sheet()) {
      surface.style.left = "";
      surface.style.top = "";
      return;
    }
    above = placeAtAnchor(surface, anchor, { side: options.side, align: options.align ?? "start", above }).above;
    surface.dataset.side = above ? "above" : "below";
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open()) return;
    event.preventDefault();
    dismiss();
  };
  // A card the pointer opened closes when the page scrolls under it; a focused or pinned one follows its control.
  const scrolled = (event: Event) => {
    if (event.target instanceof Node && surface?.contains(event.target)) return;
    if (pinned || focused || sheet()) place();
    else hide();
  };
  // A press outside closes a pinned card. The backdrop of a sheet belongs to the card, so a press on it counts by place.
  const pressedOutside = (event: PointerEvent) => {
    const node = event.target instanceof Node ? event.target : null;
    if (node && target()?.contains(node)) return;
    if (node && surface?.contains(node) && node !== surface) return;
    if (node === surface && surface) {
      const box = surface.getBoundingClientRect();
      const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (inside) return;
    }
    hide();
  };
  // Only an open card holds global listeners, so a server render touches no browser globals.
  const listen = (on: boolean) => {
    if (on) {
      document.addEventListener("keydown", keyDown);
      document.addEventListener("pointerdown", pressedOutside, true);
      window.addEventListener("scroll", scrolled, true);
      window.addEventListener("resize", place);
      return;
    }
    document.removeEventListener("keydown", keyDown);
    document.removeEventListener("pointerdown", pressedOutside, true);
    window.removeEventListener("scroll", scrolled, true);
    window.removeEventListener("resize", place);
  };

  const show = (asSheet: boolean) => {
    clearTimers();
    if (options.disabled || dismissed || !surface || open()) return;
    setSheet(asSheet);
    // Without the popover API, as in test DOMs, the card stays in the flow instead of the top layer.
    try {
      if (typeof surface.showPopover === "function") surface.showPopover();
    } catch {
      return;
    }
    setOpen(true);
    above = undefined;
    // Placed in the same task as it opens, so it never paints at a wrong place first.
    place();
    listen(true);
  };

  const hide = () => {
    clearTimers();
    hovered = false;
    pinned = false;
    if (!open()) return;
    setOpen(false);
    listen(false);
    try {
      if (surface?.matches(":popover-open")) surface.hidePopover();
    } catch {
      // The card may already be disconnected during cleanup.
    }
  };

  const dismiss = () => {
    dismissed = true;
    focused = false;
    hide();
  };

  /** Closes the card once nothing holds it open anymore. */
  const settle = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!hovered && !focused && !pinned) hide();
    }, CLOSE_DELAY);
  };

  const pointerEnter = (event: PointerEvent) => {
    // Touch has no resting pointer; a tap on a trigger opens the card instead.
    if (event.pointerType === "touch") return;
    hovered = true;
    clearTimeout(closeTimer);
    if (open() || dismissed || options.disabled) return;
    clearTimeout(openTimer);
    const delay = options.delay ?? OPEN_DELAY;
    if (delay <= 0) show(false);
    else openTimer = setTimeout(() => show(false), delay);
  };
  const pointerLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = false;
    clearTimeout(openTimer);
    if (!focused) dismissed = false;
    if (open()) settle();
  };
  const surfaceEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = true;
    clearTimeout(closeTimer);
  };

  const focusIn = (event: FocusEvent) => {
    // Only visible focus, as from the keyboard, opens the card; focus from a click or a tap does not.
    const element = event.target instanceof Element ? event.target : null;
    if (!element?.matches(":focus-visible")) return;
    focused = true;
    show(false);
  };
  const focusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (next instanceof Node && (target()?.contains(next) || surface?.contains(next))) return;
    focused = false;
    if (!hovered) dismissed = false;
    if (open() && !pinned && !hovered) hide();
  };

  // An anchor wraps a control with its own action: using it closes the card, as for a tooltip.
  const used = () => {
    if (mode !== "anchor") return;
    dismiss();
  };
  const usedByKey = (event: KeyboardEvent) => {
    if (event.key === " " || event.key === "Enter") used();
  };

  // A trigger exists for the card: a press toggles it and pins it open, a tap on a phone opens it as a sheet.
  const pressed = (event: PointerEvent) => {
    pressType = event.pointerType;
  };
  const clicked = () => {
    if (mode !== "trigger") return;
    const type = pressType;
    pressType = "";
    if (open() && pinned) {
      dismiss();
      return;
    }
    dismissed = false;
    pinned = true;
    const touch = type === "touch" || type === "pen";
    show(touch && typeof matchMedia === "function" && matchMedia(SHEET_QUERY).matches);
  };

  createEffect(() => {
    if (options.disabled) untrack(hide);
  });

  onMount(() => {
    const anchor = target();
    if (!anchor) return;
    focusHost = mode === "anchor" ? (anchor.querySelector<HTMLElement>(FOCUSABLE) ?? anchor) : anchor;
    // The card describes the control that has focus, so screen readers read it with the control's own name and role.
    const original = focusHost.getAttribute("aria-describedby");
    if (mode === "anchor") focusHost.setAttribute("aria-describedby", [original, id].filter(Boolean).join(" "));
    anchor.addEventListener("pointerenter", pointerEnter);
    anchor.addEventListener("pointerleave", pointerLeave);
    anchor.addEventListener("pointerdown", pressed);
    anchor.addEventListener("pointerdown", used);
    anchor.addEventListener("keydown", usedByKey, true);
    anchor.addEventListener("click", clicked);
    anchor.addEventListener("focusin", focusIn);
    anchor.addEventListener("focusout", focusOut);
    const observer = typeof ResizeObserver === "function" && surface ? new ResizeObserver(place) : undefined;
    if (surface) observer?.observe(surface);
    onCleanup(() => {
      hide();
      observer?.disconnect();
      if (mode === "anchor" && focusHost) {
        if (original) focusHost.setAttribute("aria-describedby", original);
        else focusHost.removeAttribute("aria-describedby");
      }
      anchor.removeEventListener("pointerenter", pointerEnter);
      anchor.removeEventListener("pointerleave", pointerLeave);
      anchor.removeEventListener("pointerdown", pressed);
      anchor.removeEventListener("pointerdown", used);
      anchor.removeEventListener("keydown", usedByKey, true);
      anchor.removeEventListener("click", clicked);
      anchor.removeEventListener("focusin", focusIn);
      anchor.removeEventListener("focusout", focusOut);
    });
  });

  const Card = () => (
    <div
      ref={(element) => {
        surface = element;
      }}
      id={id}
      role="tooltip"
      popover="manual"
      class={options.class ? `k2b-hover-card ${options.class}` : "k2b-hover-card"}
      data-sheet={sheet() ? "" : undefined}
      style={options.width ? { "--k2b-hover-card-width": options.width } : undefined}
      onPointerEnter={surfaceEnter}
      onPointerLeave={pointerLeave}
    >
      <Show when={options.title || options.detail}>
        <div class="k2b-hover-card__head">
          <Show when={options.title}>
            <strong class="k2b-hover-card__title">{options.title}</strong>
          </Show>
          <Show when={options.detail}>
            <span class="k2b-hover-card__detail">{options.detail}</span>
          </Show>
        </div>
      </Show>
      <div class="k2b-hover-card__body">{options.content}</div>
      <Show when={options.hint}>
        <p class="k2b-hover-card__hint">{options.hint}</p>
      </Show>
    </div>
  );

  return { id, open, Card };
}

const OPTION_KEYS = ["content", "title", "detail", "hint", "side", "align", "width", "delay", "disabled", "class"] as const;

/**
 * A larger hint with rich content beside a control that already has its own action, such as a link or a chip that
 * filters. A resting pointer or keyboard focus opens it; using the control closes it. Touch keeps the control's tap.
 */
function HoverCardAnchor(props: HoverCardProps): JSX.Element {
  const [options, local, rest] = splitProps(props, OPTION_KEYS, ["children"]);
  let anchor: HTMLSpanElement | undefined;
  const card = useHoverCard(options, "anchor", () => anchor);
  return (
    <>
      <span {...rest} ref={anchor} class="k2b-hover-card-anchor">
        <AnchorContext.Provider value={true}>{local.children}</AnchorContext.Provider>
      </span>
      <card.Card />
    </>
  );
}

/**
 * A button that exists to show the card, around content without its own control, such as a small graphic. Hover and
 * keyboard focus open the card, a press pins it open, and a tap on a phone opens it as a bottom sheet.
 */
function HoverCardTrigger(props: HoverCardTriggerProps): JSX.Element {
  const [options, local, rest] = splitProps(props, OPTION_KEYS, ["children", "triggerClass", "ref"]);
  let button: HTMLButtonElement | undefined;
  const card = useHoverCard(options, "trigger", () => button);
  const register = (element: HTMLButtonElement) => {
    button = element;
    if (typeof local.ref === "function") local.ref(element);
  };
  return (
    <>
      <button
        type="button"
        {...rest}
        ref={register}
        class={local.triggerClass ? `k2b-hover-card-trigger ${local.triggerClass}` : "k2b-hover-card-trigger"}
        aria-describedby={card.id}
        aria-expanded={card.open()}
        data-open={card.open() ? "" : undefined}
      >
        <AnchorContext.Provider value={true}>{local.children}</AnchorContext.Provider>
      </button>
      <card.Card />
    </>
  );
}

type HoverCardComponent = ((props: HoverCardProps) => JSX.Element) & {
  Trigger: (props: HoverCardTriggerProps) => JSX.Element;
};

/**
 * A card with rich details beside its control: a title, a small graphic, steps with labels, or rows of facts. It is
 * the large sibling of `Tooltip`. Wrap a control with its own action in `HoverCard`; use `HoverCard.Trigger` when the
 * content has no control of its own.
 */
export const HoverCard = HoverCardAnchor as HoverCardComponent;
HoverCard.Trigger = HoverCardTrigger;

export default HoverCard;
