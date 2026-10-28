import { createEffect, createSignal, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { returnFocus, ringOnReturn } from "../internal/focus-return";

export type AnchoredPopoverProps = {
  /** The control the panel belongs to. The panel is open while this is set. */
  anchor: HTMLElement | null | undefined;
  /** Called on Escape, a click outside, another press of the anchor, and when the anchor leaves the page. */
  onClose: () => void;
  /** The panel's accessible name; it is a non-modal dialog. */
  label: string;
  children: JSX.Element;
  /** Which edge lines up with the anchor. Defaults to `end`, like a menu at the end of a toolbar. */
  align?: "start" | "end";
  /** The side tried first; the panel flips only when the other side has more room. Defaults to `below`. */
  side?: "below" | "above";
  /**
   * The tallest the panel gets while open, in px, such as a list it can switch to. The side is chosen for this height
   * and kept, so a panel that grows never flips. Defaults to its height when it opens.
   */
  plannedHeight?: number;
  /** Width of the panel on wide screens, such as `21rem`. On a phone it is a bottom sheet across the screen. */
  width?: string;
  /** Moves the focus into the panel when it opens; defaults to the panel itself. */
  initialFocus?: () => HTMLElement | null | undefined;
  class?: string;
};

const GAP = 6;
const MARGIN = 8;
const sheetQuery = "(max-width: 47.999rem)";

/**
 * A panel anchored to a control, for content that is more than a menu, such as a card with a slider. It opens on the
 * side with room and keeps that side while open, so a panel that changes its content never jumps to the other side.
 * Escape, a click outside and another press of the anchor close it; the focus returns to where it was. On a phone it
 * is a bottom sheet.
 */
export function AnchoredPopover(props: AnchoredPopoverProps): JSX.Element {
  let surface: HTMLDivElement | undefined;
  let previous: HTMLElement | null = null;
  let ring = false;
  let pressedAnchor: HTMLElement | undefined;
  /** The side chosen when the panel opened; kept until it closes. */
  let openedAbove: boolean | undefined;
  const [shown, setShown] = createSignal<HTMLElement>();
  const [sheet, setSheet] = createSignal(false);

  const place = () => {
    const anchor = shown();
    if (!surface || !anchor) return;
    if (!anchor.isConnected) {
      hide();
      props.onClose();
      return;
    }
    if (sheet()) {
      surface.style.left = "";
      surface.style.top = "";
      return;
    }
    const viewport = window.visualViewport;
    const view = {
      top: (viewport?.offsetTop ?? 0) + MARGIN,
      bottom: (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - MARGIN,
      left: (viewport?.offsetLeft ?? 0) + MARGIN,
      right: (viewport ? viewport.offsetLeft + viewport.width : window.innerWidth) - MARGIN,
    };
    const box = anchor.getBoundingClientRect();
    const size = surface.getBoundingClientRect();
    const roomAbove = box.top - GAP - view.top;
    const roomBelow = view.bottom - box.bottom - GAP;
    if (openedAbove === undefined) {
      const planned = Math.max(size.height, props.plannedHeight ?? 0);
      openedAbove =
        (props.side ?? "below") === "above" ? planned <= roomAbove || roomAbove > roomBelow : planned > roomBelow && roomAbove > roomBelow;
    }
    surface.style.setProperty("--k2b-anchored-popover-room", `${Math.round(Math.max(120, openedAbove ? roomAbove : roomBelow))}px`);
    const top = openedAbove ? box.top - GAP - size.height : box.bottom + GAP;
    const left = (props.align ?? "end") === "end" ? box.right - size.width : box.left;
    surface.style.left = `${Math.round(Math.max(view.left, Math.min(left, view.right - size.width)))}px`;
    surface.style.top = `${Math.round(Math.max(view.top, Math.min(top, view.bottom - size.height)))}px`;
  };

  const restoreFocus = () => {
    const focused = document.activeElement;
    if (focused && focused !== document.body && !surface?.contains(focused)) return;
    if (previous?.isConnected) returnFocus(previous, ring);
  };

  const hide = () => {
    restoreFocus();
    if (surface?.matches(":popover-open")) surface.hidePopover();
    openedAbove = undefined;
    setShown(undefined);
  };

  const pressed = (event: PointerEvent) => {
    const anchor = shown();
    pressedAnchor = anchor && event.target instanceof Node && anchor.contains(event.target) ? anchor : undefined;
  };
  const clicked = (event: MouseEvent) => {
    const anchor = shown();
    if (!anchor || !(event.target instanceof Node) || !anchor.contains(event.target)) return;
    pressedAnchor = anchor;
    hide();
    props.onClose();
  };

  createEffect(() => {
    const anchor = props.anchor ?? undefined;
    untrack(() => {
      if (!anchor) {
        if (shown()) hide();
        return;
      }
      if (anchor === pressedAnchor) {
        pressedAnchor = undefined;
        props.onClose();
        return;
      }
      if (shown() === anchor || !surface) return;
      if (!shown()) {
        previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ring = ringOnReturn(previous ?? anchor);
      }
      setSheet(typeof matchMedia === "function" && matchMedia(sheetQuery).matches);
      setShown(anchor);
      if (!surface.matches(":popover-open")) surface.showPopover();
      place();
      queueMicrotask(() => (props.initialFocus?.() ?? surface)?.focus({ preventScroll: true }));
    });
  });

  const scrolled = (event: Event) => {
    if (!(event.target instanceof Node && surface?.contains(event.target))) place();
  };

  onMount(() => {
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scrolled, true);
    window.visualViewport?.addEventListener("resize", place);
    document.addEventListener("pointerdown", pressed, true);
    document.addEventListener("click", clicked, true);
    const observer = typeof ResizeObserver === "function" && surface ? new ResizeObserver(place) : undefined;
    if (surface) observer?.observe(surface);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scrolled, true);
      window.visualViewport?.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", pressed, true);
      document.removeEventListener("click", clicked, true);
      if (surface?.matches(":popover-open")) hide();
    });
  });

  return (
    <div
      ref={surface}
      popover="auto"
      role="dialog"
      aria-label={props.label}
      tabIndex={-1}
      class={["k2b-anchored-popover", props.class].filter(Boolean).join(" ")}
      data-sheet={sheet() ? "" : undefined}
      style={props.width ? { "--k2b-anchored-popover-width": props.width } : undefined}
      onToggle={(event) => {
        if ((event as ToggleEvent).newState === "open") return;
        if (shown()) {
          openedAbove = undefined;
          setShown(undefined);
          restoreFocus();
          props.onClose();
        }
        setTimeout(() => {
          pressedAnchor = undefined;
        });
      }}
    >
      <Show when={shown()}>{props.children}</Show>
    </div>
  );
}
