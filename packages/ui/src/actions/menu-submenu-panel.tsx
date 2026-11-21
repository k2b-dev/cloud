import { createEffect, type JSX, on, onCleanup } from "solid-js";
import { inheritUiScope } from "../internal/portal-scope";
import { type DropdownItem, DropdownItems, menuEntries } from "./Dropdown";
import { focusMenuRow, focusRowSegment } from "./menu-rows";
import type { MenuLevel } from "./menu-submenu";

/** The least room a menu keeps from the viewport's edge, as every menu does. */
const EDGE = 8;
type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom">;

/**
 * Where a submenu stands: beside its row, its first row level with it, on the side that has room; without room on
 * either side it keeps to the viewport. Too low, it rises until its last row is level with its row's bottom.
 */
export const placeSubmenu = (
  row: Box,
  parent: Pick<DOMRect, "left" | "right">,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  rtl = false,
): { left: number; top: number; side: "left" | "right" } => {
  const right = parent.right - 1;
  const left = parent.left - menu.width + 1;
  const fitsRight = right + menu.width <= viewport.width - EDGE;
  const fitsLeft = left >= EDGE;
  const side: "left" | "right" = rtl ? (fitsLeft || !fitsRight ? "left" : "right") : fitsRight || !fitsLeft ? "right" : "left";
  const x = side === "right" ? right : left;
  // The menu's 1 px edge stands above the row, so its first row lines up with the row that opened it.
  let top = row.top - 1;
  if (top + menu.height > viewport.height - EDGE) top = row.bottom + 1 - menu.height;
  return {
    left: Math.max(EDGE, Math.min(x, viewport.width - menu.width - EDGE)),
    top: Math.max(EDGE, Math.min(top, viewport.height - menu.height - EDGE)),
    side,
  };
};

/**
 * An open submenu beside its row, loaded with the first submenu row so a menu without one carries none of it. It
 * shows in the top layer, owns its keys, and closes with the menu around it or a change of the window's size.
 */
export default function SubmenuPanel(props: {
  id: string;
  row: HTMLButtonElement;
  label: string;
  items: readonly DropdownItem[];
  depth: number;
  close: (restoreFocus?: boolean) => void;
  level: MenuLevel;
  /** Changes whenever the keyboard asks for the first entry. */
  focus: () => number;
  hide: () => void;
}): JSX.Element {
  let panel!: HTMLDivElement;
  const rtl = () => getComputedStyle(props.row).direction === "rtl";
  const place = () => {
    if (!panel.isConnected) return;
    const host = props.row.closest<HTMLElement>("[role='menu'], [role='dialog'], [role='listbox']") ?? props.row;
    const at = placeSubmenu(
      props.row.getBoundingClientRect(),
      host.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      rtl(),
    );
    panel.style.left = `${at.left}px`;
    panel.style.top = `${at.top}px`;
    panel.dataset.side = at.side;
  };
  const onKey = (event: KeyboardEvent) => {
    const items = menuEntries(panel);
    if (focusMenuRow(items, event.key) || focusRowSegment(items, event.key)) {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Escape" || event.key === (rtl() ? "ArrowRight" : "ArrowLeft")) {
      // Only this level closes; the menu around it stays, as the browser's own Escape would close it.
      event.preventDefault();
      event.stopPropagation();
      props.hide();
    }
  };
  // The menu around it closing, the window changing size, or a scroll outside it closes it too: it would come loose
  // from its row.
  const host = props.row.parentElement?.closest<HTMLElement>("[popover]");
  const closed = (event: Event) => {
    if (event.type === "scroll" && event.target instanceof Node && panel.contains(event.target)) return;
    if (event.type !== "toggle" || (event as ToggleEvent).newState === "closed") props.level.set(undefined);
  };
  host?.addEventListener("toggle", closed);
  window.addEventListener("resize", closed);
  window.addEventListener("scroll", closed, true);
  onCleanup(() => {
    host?.removeEventListener("toggle", closed);
    window.removeEventListener("resize", closed);
    window.removeEventListener("scroll", closed, true);
    // Closed by the pointer resting elsewhere or by a resize, with the keyboard inside: the focus goes back to its row
    // rather than to the page.
    if (panel.contains(document.activeElement) && props.row.isConnected) props.row.focus();
  });
  createEffect(
    on(props.focus, (request) => {
      if (request) queueMicrotask(() => focusMenuRow(menuEntries(panel), "Home"));
    }),
  );
  return (
    <div
      ref={(element) => {
        panel = element;
        inheritUiScope(element, props.row);
        queueMicrotask(() => {
          if (!element.isConnected) return;
          if (typeof element.showPopover === "function") element.showPopover();
          place();
        });
      }}
      id={`${props.id}-menu`}
      popover="manual"
      role="menu"
      aria-label={props.label}
      class="k2b-dropdown__menu k2b-dropdown__submenu"
      data-depth={props.depth}
      on:keydown={onKey}
      onPointerEnter={() => props.level.hold()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <DropdownItems items={props.items} close={props.close} depth={props.depth} />
    </div>
  );
}
