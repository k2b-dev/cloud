import { createEffect, type JSX, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import { Toolbar } from "./Toolbar";

export type SelectionToolbarProps = {
  /**
   * The selection's box in viewport coordinates, or nothing while the toolbar is closed. It is read again on every
   * scroll and resize while the toolbar is open, so a function that measures the selection keeps it attached.
   */
  anchor: () => DOMRect | null | undefined;
  label: string;
  /**
   * `above` (default) places the toolbar over the selection and below it when the space above is too small. `below`
   * always places it below, for touch, where the system's own selection menu sits above.
   */
  placement?: "above" | "below";
  /** The area the toolbar stays in, such as the editor's scroll area under its toolbar: it goes below the selection when the space above inside this area is too small. */
  boundary?: () => HTMLElement | null | undefined;
  /** Escape inside the toolbar; the application closes it and returns focus to the text. */
  onEscape?: () => void;
  children: JSX.Element;
  class?: string;
};

const GAP = 8;
const EDGE = 8;

/** Where the toolbar goes for a selection box: centered on its first line, inside the viewport. */
export const selectionToolbarPosition = (
  anchor: Pick<DOMRect, "top" | "bottom" | "left" | "width">,
  toolbar: { width: number; height: number },
  viewport: { width: number; height: number; top?: number },
  placement: "above" | "below" = "above",
): { left: number; top: number; side: "above" | "below" } => {
  const left = Math.max(EDGE, Math.min(anchor.left + anchor.width / 2 - toolbar.width / 2, viewport.width - toolbar.width - EDGE));
  const above = anchor.top - toolbar.height - GAP;
  const side = placement === "below" || above < (viewport.top ?? 0) + EDGE ? "below" : "above";
  const top = side === "above" ? above : Math.min(anchor.bottom + GAP, viewport.height - toolbar.height - EDGE);
  return { left, top, side };
};

const keepsFocus = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true']");

/**
 * A toolbar that floats at a text selection, such as formatting and comment actions over selected text. It lies in
 * the top layer, so no scroll container clips it, and pressing its buttons keeps the selection.
 */
export function SelectionToolbar(props: SelectionToolbarProps): JSX.Element {
  let root!: HTMLDivElement;
  const place = () => {
    const anchor = props.anchor();
    if (!anchor) return false;
    const boundary = props.boundary?.()?.getBoundingClientRect();
    const size = root.getBoundingClientRect();
    const { left, top, side } = selectionToolbarPosition(
      anchor,
      size,
      { width: document.documentElement.clientWidth, height: window.innerHeight, top: boundary?.top },
      props.placement,
    );
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.dataset.side = side;
    return true;
  };

  if (!isServer)
    createEffect(() => {
      const open = !!props.anchor();
      if (!open) {
        if (root.matches(":popover-open")) root.hidePopover();
        return;
      }
      if (!root.matches(":popover-open")) root.showPopover();
      place();
      let frame = 0;
      const follow = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (!place() && root.matches(":popover-open")) root.hidePopover();
        });
      };
      window.addEventListener("scroll", follow, { capture: true, passive: true });
      window.addEventListener("resize", follow, { passive: true });
      const observer = new ResizeObserver(follow);
      observer.observe(root);
      onCleanup(() => {
        cancelAnimationFrame(frame);
        window.removeEventListener("scroll", follow, { capture: true });
        window.removeEventListener("resize", follow);
        observer.disconnect();
      });
    });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the toolbar inside is the keyboard target; the frame only keeps the selection on press and forwards Escape.
    <div
      ref={root}
      popover="manual"
      class={`k2b-selection-toolbar ${props.class ?? ""}`}
      onPointerDown={(event) => {
        // A press on a button would otherwise move focus and clear the selection the actions apply to.
        if (!keepsFocus(event.target)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !props.onEscape) return;
        event.preventDefault();
        event.stopPropagation();
        props.onEscape();
      }}
    >
      <Toolbar label={props.label}>{props.children}</Toolbar>
    </div>
  );
}
