import { createMemo, createUniqueId, For, type JSX, untrack } from "solid-js";
import { activeDrag, DragSource, DropTarget } from "./DragAndDrop";
import { announce } from "./drag-and-drop";
import { useSortableListMessages } from "./sortable-list-messages";

export type SortableListProps<Item> = {
  items: readonly Item[];
  /** Stable identity of an item. Rows are keyed by it, so a newer copy of an item keeps its row and focus. */
  itemKey: (item: Item) => string;
  /** Names the item for its handle, the drag preview, and announcements. */
  itemLabel: (item: Item) => string;
  /** Tabler class for the drag preview; defaults to the grip. */
  itemIcon?: (item: Item) => string | undefined;
  /** Moves the item to `index` of the list as it is now. The host owns the order and saves it. */
  onMove: (key: string, index: number) => void;
  /** Names the list for assistive technology. */
  label?: string;
  disabled?: boolean;
  class?: string;
  /**
   * Renders one row, once per key; place `handle` where the row's grip belongs. Read the item through `item`, which
   * always returns the current copy, so the row updates in place and its grip keeps focus.
   */
  children: (item: () => Item, handle: JSX.Element) => JSX.Element;
};

/**
 * An ordered list whose rows move by their grip: drag it, or focus it and use the arrow keys, Home, or End. Moves go
 * through `onMove`; the list renders `items` as given, so the host's order is the only order.
 */
export function SortableList<Item>(props: SortableListProps<Item>): JSX.Element {
  const messages = useSortableListMessages();
  const type = `k2b-sortable-${createUniqueId()}`;
  const hintId = `${type}-hint`;
  let list!: HTMLUListElement;
  const keys = createMemo(() => props.items.map((item) => props.itemKey(item)), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  });
  const itemFor = (key: string) => props.items.find((item) => props.itemKey(item) === key);
  const dragged = () => {
    const drag = activeDrag();
    return drag?.type === type ? drag.value : undefined;
  };
  const move = (key: string, index: number, spoken: boolean) => {
    const count = keys().length;
    const target = Math.max(0, Math.min(count - 1, index));
    const from = keys().indexOf(key);
    const item = itemFor(key);
    if (from < 0 || from === target || props.disabled || item === undefined) return;
    props.onMove(key, target);
    if (!spoken) return;
    // Moving a row re-inserts its element, which drops focus; the grip keeps it, and the list says where it is now.
    queueMicrotask(() => {
      const handle = [...list.querySelectorAll<HTMLButtonElement>("[data-sortable-handle]")].find(
        (element) => element.dataset.sortableHandle === key,
      );
      if (handle && document.activeElement !== handle) handle.focus({ preventScroll: true });
      announce(list, messages().moved({ label: props.itemLabel(item), position: keys().indexOf(key) + 1, count }));
    });
  };
  return (
    <>
      <span id={hintId} hidden>
        {messages().hint}
      </span>
      <ul ref={list} class={`k2b-sortable-list${props.class ? ` ${props.class}` : ""}`} aria-label={props.label}>
        <For each={keys()}>
          {(key, index) => {
            // A key leaves `keys` before its item goes, so the last copy stands in while the row unmounts.
            let last = itemFor(key)!;
            const item = () => {
              last = itemFor(key) ?? last;
              return last;
            };
            const label = () => props.itemLabel(item());
            const onKeyDown = (event: KeyboardEvent) => {
              const step = { ArrowUp: index() - 1, ArrowDown: index() + 1, Home: 0, End: keys().length - 1 }[event.key];
              if (step === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
              event.preventDefault();
              move(key, step, true);
            };
            const handle = (
              <DragSource
                class="k2b-sortable-list__grip"
                disabled={props.disabled}
                payload={{ type, value: key, label: label(), icon: props.itemIcon?.(item()) ?? "ti ti-grip-vertical" }}
              >
                <button
                  type="button"
                  class="k2b-sortable-list__handle"
                  data-sortable-handle={key}
                  aria-label={messages().handle({ label: label() })}
                  aria-describedby={hintId}
                  disabled={props.disabled}
                  onKeyDown={onKeyDown}
                >
                  <i class="ti ti-grip-vertical" aria-hidden="true" />
                </button>
              </DragSource>
            );
            // While a row of this list is dragged, every other row shows on which side it would land.
            const side = () => {
              const value = dragged();
              if (value === undefined || value === key) return undefined;
              return keys().indexOf(value) < index() ? "after" : "before";
            };
            return (
              <li class="k2b-sortable-list__item" data-sortable-dragging={dragged() === key ? "" : undefined} data-sortable-side={side()}>
                <DropTarget
                  class="k2b-sortable-list__target"
                  accept={[type]}
                  label={label()}
                  disabled={props.disabled}
                  onDrop={(payload) => move(payload.value, index(), false)}
                >
                  {/* Once per key: a newer copy of the item reaches the row through `item`, never by rebuilding it. */}
                  {untrack(() => props.children(item, handle))}
                </DropTarget>
              </li>
            );
          }}
        </For>
      </ul>
    </>
  );
}
