import { createEffect, createMemo, createSignal, type JSX, onCleanup } from "solid-js";
import { ContextMenuBase } from "./ContextMenu";
import type { DropdownItem } from "./Dropdown";

export type ListContextMenuProps = {
  /** Selects one row of the list, for example `[data-row-id]`. */
  row: string;
  /** The menu of a row, usually the same entries as its "…" menu. A row without entries keeps the browser's own menu. */
  items: (row: HTMLElement) => readonly DropdownItem[];
  /** Names the menu for assistive technology, for example "Conversation actions". */
  label?: string;
  /** Runs as the menu opens for a row, for example to hide the row's native tooltip until it closes. */
  onOpen?: (row: HTMLElement) => void;
  onClose?: () => void;
  class?: string;
  children: JSX.Element;
};

/**
 * One context menu for all rows of a list: right-click opens the menu of the row under the pointer, the Context Menu
 * key or Shift+F10 the menu of the row that holds focus, beside it. Outside a row, and on a row without entries, the
 * browser keeps its own menu; a context menu nested in a row keeps its own. The open row carries
 * `data-context-menu-open`, so it can look as it does on hover, and the menu closes when its row leaves the list or
 * loses its entries.
 */
export function ListContextMenu(props: ListContextMenuProps): JSX.Element {
  const [row, setRow] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let closeMenu: (() => void) | undefined;
  const entries = () => {
    const current = row();
    return current ? props.items(current) : [];
  };
  // The menu's own handlers ask first; a nested menu already handled and stopped its event.
  const accept = (event: MouseEvent | KeyboardEvent) => {
    const origin = event instanceof KeyboardEvent ? document.activeElement : event.target;
    const found = origin instanceof Element ? origin.closest<HTMLElement>(props.row) : null;
    if (!found || !host?.contains(found) || props.items(found).length === 0) return false;
    setRow(found);
    return true;
  };
  // An open menu keeps its last entries until it closes, so the focused entry stays while focus returns to the list.
  let shown: readonly DropdownItem[] = [];
  const menuItems = createMemo(() => {
    const next = entries();
    if (next.length > 0 || !open()) shown = next;
    return shown;
  });
  createEffect(() => {
    const current = row();
    if (open() && current && (!current.isConnected || entries().length === 0)) closeMenu?.();
  });
  const opened = () => {
    const current = row();
    if (!current) return;
    current.setAttribute("data-context-menu-open", "");
    setOpen(true);
    props.onOpen?.(current);
  };
  const closed = () => {
    row()?.removeAttribute("data-context-menu-open");
    setOpen(false);
    props.onClose?.();
  };
  onCleanup(() => row()?.removeAttribute("data-context-menu-open"));
  return (
    <div ref={host} class={props.class}>
      <ContextMenuBase
        items={menuItems()}
        tabIndex={-1}
        label={props.label}
        accept={accept}
        closeWith={(close) => {
          closeMenu = close;
        }}
        onOpen={opened}
        onClose={closed}
      >
        {props.children}
      </ContextMenuBase>
    </div>
  );
}

export default ListContextMenu;
