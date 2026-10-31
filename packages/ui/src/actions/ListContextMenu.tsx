import { createSignal, type JSX, onCleanup, onMount } from "solid-js";
import { ContextMenu } from "./ContextMenu";
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

const opensMenu = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

/**
 * One context menu for all rows of a list: right-click opens the menu of the row under the pointer, the Context Menu
 * key or Shift+F10 the menu of the row that holds focus, beside it. Outside a row, and on a row without entries, the
 * browser keeps its own menu. The open row carries `data-context-menu-open`, so it can look as it does on hover.
 */
export function ListContextMenu(props: ListContextMenuProps): JSX.Element {
  const [row, setRow] = createSignal<HTMLElement>();
  let wrapper: HTMLDivElement | undefined;
  let openRow: HTMLElement | undefined;
  onMount(() => {
    // Capture runs before the menu's own handler: it picks the row, and without entries the event never reaches the menu.
    const target = (event: Event, element: EventTarget | null) => {
      const found = element instanceof Element ? element.closest<HTMLElement>(props.row) : null;
      if (found && wrapper?.contains(found) && props.items(found).length > 0) setRow(found);
      else event.stopPropagation();
    };
    const fromPointer = (event: MouseEvent) => target(event, event.target);
    const fromKey = (event: KeyboardEvent) => {
      if (opensMenu(event)) target(event, document.activeElement);
    };
    wrapper?.addEventListener("contextmenu", fromPointer, true);
    wrapper?.addEventListener("keydown", fromKey, true);
    onCleanup(() => {
      wrapper?.removeEventListener("contextmenu", fromPointer, true);
      wrapper?.removeEventListener("keydown", fromKey, true);
    });
  });
  const opened = () => {
    openRow = row();
    if (!openRow) return;
    openRow.setAttribute("data-context-menu-open", "");
    props.onOpen?.(openRow);
  };
  const closed = () => {
    openRow?.removeAttribute("data-context-menu-open");
    openRow = undefined;
    props.onClose?.();
  };
  onCleanup(() => openRow?.removeAttribute("data-context-menu-open"));
  return (
    <div ref={wrapper} class={props.class}>
      <ContextMenu items={row() ? props.items(row()!) : []} tabIndex={-1} label={props.label} onOpen={opened} onClose={closed}>
        {props.children}
      </ContextMenu>
    </div>
  );
}

export default ListContextMenu;
