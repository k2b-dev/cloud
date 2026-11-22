import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, untrack } from "solid-js";
import { useLocale } from "../intl/locale";
import type { DropdownSection } from "./Dropdown";
import { activeDrag, announce, bindDragSource, onPointerPress, registerDropTarget } from "./drag-and-drop";
import { useDragAndDropMessages } from "./drag-and-drop-messages";
import { PHONE_SHEET_QUERY } from "./phone-sheet";
import { preloadWhenIdle } from "./preload-when-idle";
import {
  commit,
  type Entry,
  groups,
  keyboardLift,
  type Lift,
  landing,
  lift,
  listsOf,
  place,
  placesIn,
  refocus,
  type SortableMove,
  setLift,
  showStatus,
  staying,
  touchRegistry,
} from "./sortable-board";
import { useSortableListMessages } from "./sortable-list-messages";
import { clampIndex, gapAt, gapForIndex } from "./sortable-place";

export type { SortableMove } from "./sortable-board";

export type SortableListProps<Item> = {
  items: readonly Item[];
  /** Stable identity of an item. Rows are keyed by it, so a newer copy of an item keeps its row and focus. */
  itemKey: (item: Item) => string;
  /** Names the item for its handle and in announcements. */
  itemLabel: (item: Item) => string;
  /** Tabler class for a label preview; the drag preview shows the row itself, so this shows only without it. */
  itemIcon?: (item: Item) => string | undefined;
  /**
   * Moves the item to `index` of this list as it is after the move. For a row from another list of the `group`,
   * `move.from` names that list, and the host takes the row out of it. The host owns the order and saves it.
   */
  onMove: (key: string, index: number, move: SortableMove) => void;
  /** Names the list for assistive technology. */
  label?: string;
  disabled?: boolean;
  class?: string;
  /**
   * Lists that share a group exchange rows, such as the columns of a board: a row moves by pointer, keyboard, or the
   * `useSortableMoveMenu` entries. On a phone such lists do not drag; the move menu moves there.
   */
  group?: string;
  /** Names this list inside its group, in `SortableMove`; defaults to a generated key. */
  listKey?: string;
  /** Names the list in announcements and the status line, such as "Done"; defaults to `label`. */
  listLabel?: string;
  /**
   * The list is sorted: returns the index at which `key`, coming from list `from`, lands among this list's items
   * without it. The line shows that place wherever the pointer is.
   */
  placement?: (key: string, from: string) => number;
  /** "row" drags the whole row, for cards; "handle" (default) only the grip. The keyboard always uses the grip. */
  dragBy?: "handle" | "row";
  /**
   * Renders one row, once per key; place `handle` where the row's grip belongs. Read the item through `item`, which
   * always returns the current copy, so the row updates in place and its grip keeps focus.
   */
  children: (item: () => Item, handle: JSX.Element) => JSX.Element;
};

/** The pointer's last place: the engine ends the drag, and with it `lift`, before it calls `drop`. */
let pointerPlan: Lift | undefined;
/** Loaded on the first focus of a grip; a lift waits for it. */
let keyboard: typeof import("./sortable-keyboard") | undefined;
const loadKeyboard = () => import("./sortable-keyboard").then((module) => (keyboard = module));
/** Quietly ahead of use; a failure shows when a lift needs the module. */
const preloadKeyboard = () => {
  if (!keyboard) loadKeyboard().catch(() => undefined);
};

const usePhone = () => {
  const [phone, setPhone] = createSignal(false);
  onMount(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(PHONE_SHEET_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  return phone;
};

/**
 * An ordered list whose rows move by pointer or keyboard. While a row moves it stays dimmed in place and a line shows
 * where it lands; no other row moves before the drop. Space on the grip lifts the row, the arrow keys choose the
 * place (left and right reach the other lists of the `group`), Enter drops, and Escape cancels; the arrow keys alone
 * move the row one step at once. Moves go through `onMove`; the list renders `items` as given.
 */
export function SortableList<Item>(props: SortableListProps<Item>): JSX.Element {
  const messages = useSortableListMessages();
  const dragMessages = useDragAndDropMessages();
  const locale = useLocale();
  const id = createUniqueId();
  const group = props.group ?? `k2b-sortable-${id}`;
  const listKey = props.listKey ?? `k2b-sortable-list-${id}`;
  const type = `k2b-sortable:${group}`;
  const hintId = `k2b-sortable-${id}-hint`;
  const phone = usePhone();
  let list!: HTMLUListElement;
  let area!: HTMLElement;
  const keys = createMemo(() => props.items.map((item) => props.itemKey(item)), undefined, {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  });
  const itemFor = (key: string) => props.items.find((item) => props.itemKey(item) === key);
  const listLabel = () => props.listLabel ?? props.label ?? "";
  const entry: Entry = {
    group,
    key: listKey,
    label: listLabel,
    get list() {
      return list;
    },
    get area() {
      return area;
    },
    keys,
    disabled: () => props.disabled === true,
    placement: () => props.placement,
    onMove: (key, index, move) => props.onMove(key, index, move),
    messages,
  };
  const pointerOff = () => props.disabled === true || (props.group !== undefined && phone());
  /** The lift that concerns this list, as its source or its target. */
  const mine = () => {
    const state = lift();
    return state?.group === group ? state : undefined;
  };
  const lineGap = createMemo(() => {
    const state = mine();
    if (state?.to !== listKey || state.index === undefined || staying(state)) return undefined;
    return gapForIndex(state.index, keys().indexOf(state.key));
  });

  // A pointer drag of a row of this group: the source list records the lift; every list forgets it at the end.
  createEffect(() => {
    const drag = activeDrag();
    untrack(() => {
      const state = mine();
      if (drag?.type === type) {
        const from = keys().indexOf(drag.value);
        if (!state && from >= 0)
          setLift({ group, key: drag.value, label: drag.label, from: listKey, fromIndex: from, keyboard: false, messages: dragMessages() });
      } else if (state && !state.keyboard) setLift(undefined);
    });
  });

  const hover = (point: { x: number; y: number } | undefined) => {
    const state = mine();
    if (!state || state.keyboard) return undefined;
    if (!point) {
      if (state.to === listKey) {
        pointerPlan = undefined;
        setLift({ ...state, to: undefined, index: undefined });
      }
      return undefined;
    }
    const rows = [...list.children].filter((row): row is HTMLLIElement => row instanceof HTMLLIElement);
    const boxes = rows.map((row) => row.getBoundingClientRect());
    const index = landing(
      entry,
      state,
      gapAt(
        boxes.map((box) => box.bottom),
        point.y,
      ),
    );
    // Where the line is, so the preview hangs below it; in a sorted list it may be far from the pointer.
    const gap = gapForIndex(index, keys().indexOf(state.key));
    const lineY = boxes[gap]?.top ?? boxes.at(-1)?.bottom ?? list.getBoundingClientRect().top;
    if (state.to === listKey && state.index === index) return lineY;
    const next = { ...state, to: listKey, index };
    pointerPlan = next;
    setLift(next);
    showStatus(next);
    announce(list, messages().position(place(entry, next, index)));
    return lineY;
  };
  const drop = (payload: { value: string }) => {
    const plan = pointerPlan;
    pointerPlan = undefined;
    if (plan?.key === payload.value && plan.to === listKey) commit(plan);
  };

  onMount(() => {
    // The keyboard lift loads while the page is idle and on any press of a drag source, before anyone lifts a row.
    onCleanup(preloadWhenIdle(list.ownerDocument.defaultView!, preloadKeyboard));
    onCleanup(onPointerPress(preloadKeyboard));
    // The nearest column, unless another list lies between, such as a checklist inside a card of a board column.
    const outer = list.parentElement?.closest<HTMLElement>("[data-sortable-column], .k2b-sortable-list");
    area = outer?.hasAttribute("data-sortable-column") ? outer : list;
    const members = groups.get(group) ?? new Set<Entry>();
    groups.set(group, members);
    members.add(entry);
    touchRegistry();
    const read = () => ({
      accept: [type],
      label: listLabel(),
      messages: dragMessages(),
      disabled: props.disabled,
      drop,
      hover,
    });
    const target = registerDropTarget(area, read());
    createEffect(() => target.update(read()));
    // The column around the list is tinted while it is the target, so a host's column head can show it.
    createEffect(() => {
      const state = mine();
      if (state?.to === listKey && !staying(state)) area.dataset.sortableTarget = "";
      else delete area.dataset.sortableTarget;
    });
    onCleanup(() => {
      target.dispose();
      delete area.dataset.sortableTarget;
      members.delete(entry);
      if (!members.size) groups.delete(group);
      touchRegistry();
      const state = lift();
      if (state?.group === group && state.keyboard && (state.from === listKey || state.to === listKey)) keyboardLift.end?.();
    });
  });

  /** A keyboard lift of this list that waits for its module. */
  let lifting: { off: boolean } | undefined;

  return (
    <>
      <span id={hintId} hidden>
        {messages().hint}
      </span>
      <ul
        ref={list}
        class={`k2b-sortable-list${props.class ? ` ${props.class}` : ""}`}
        aria-label={props.label}
        data-sortable-grouped={props.group === undefined ? undefined : ""}
        data-sortable-line={lineGap() !== undefined && keys().length === 0 ? "empty" : undefined}
      >
        <For each={keys()}>
          {(key, index) => {
            // A key leaves `keys` before its item goes, so the last copy stands in while the row unmounts.
            let last = itemFor(key)!;
            const item = () => {
              last = itemFor(key) ?? last;
              return last;
            };
            const label = () => props.itemLabel(item());
            let row!: HTMLLIElement;
            let grip!: HTMLButtonElement;
            // A lifted row that leaves, for example removed by someone else, ends its lift and says so.
            onCleanup(() => {
              const state = lift();
              if (state?.keyboard && state.group === group && state.key === key && state.from === listKey && keys().includes(key) === false)
                keyboardLift.cancel?.();
            });
            const onKeyDown = (event: KeyboardEvent) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const state = mine();
              // A held Space or Enter repeats; only the first press lifts or drops.
              if (event.repeat && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                return;
              }
              if (state?.keyboard && state.key === key) {
                keyboard?.liftedKey(event, state, entry);
                return;
              }
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                if (props.disabled || lifting) return;
                // Keys that come while the module loads would move the row at once; they wait for the lift instead,
                // and Escape or Tab call it off.
                const pending = { off: false };
                lifting = pending;
                void loadKeyboard()
                  .then((module) => {
                    if (!pending.off && grip.ownerDocument.activeElement === grip)
                      module.startLift(entry, key, label(), locale(), dragMessages());
                  })
                  .catch(() => announce(list, dragMessages().unavailable))
                  .finally(() => {
                    if (lifting === pending) lifting = undefined;
                  });
                return;
              }
              if (lifting) {
                if (event.key === "Escape" || event.key === "Tab") lifting.off = true;
                if (event.key !== "Tab") event.preventDefault();
                return;
              }
              // Without a lift, the arrow keys belong to the page, such as moving to the next card.
            };
            /** The part a pointer drags: the grip, or the whole row for cards. */
            const Grab = (grab: { class: string; children: JSX.Element }) => {
              let element!: HTMLDivElement;
              onMount(() =>
                onCleanup(
                  bindDragSource(element, () => ({
                    payload: { type, value: key, label: label(), icon: props.itemIcon?.(item()) ?? "ti ti-grip-vertical" },
                    disabled: pointerOff(),
                    messages: dragMessages(),
                    preview: row,
                    // K7: a held finger lifts a row after 300 ms; before that it scrolls.
                    hold: 300,
                  })),
                ),
              );
              return (
                <div ref={element} class={`k2b-drag-source ${grab.class}`} data-drag-disabled={pointerOff() ? "" : undefined}>
                  {grab.children}
                </div>
              );
            };
            const button = (
              <button
                ref={(element) => {
                  grip = element;
                }}
                type="button"
                class="k2b-sortable-list__handle"
                data-sortable-handle={key}
                aria-label={messages().handle({ label: label() })}
                aria-describedby={hintId}
                disabled={props.disabled}
                onKeyDown={onKeyDown}
                onFocus={() => void loadKeyboard().catch(() => undefined)}
              >
                <i class="ti ti-grip-vertical" aria-hidden="true" />
              </button>
            );
            const byRow = untrack(() => props.dragBy === "row");
            const handle = byRow ? button : <Grab class="k2b-sortable-list__grip">{button}</Grab>;
            const line = () => {
              const gap = lineGap();
              if (gap === undefined) return undefined;
              if (gap === index()) return "before";
              return gap === keys().length && index() === keys().length - 1 ? "after" : undefined;
            };
            const dragged = () => {
              const state = mine();
              return state?.key === key && state.from === listKey;
            };
            // The boxes from the row down to its grip stay undimmed while it moves; the stylesheet dims the rest.
            createEffect(() => {
              const on = dragged();
              if (!row.contains(grip)) return;
              for (let element = grip.parentElement; element && element !== row; element = element.parentElement)
                element.toggleAttribute("data-sortable-path", on);
            });
            return (
              <li ref={row} class="k2b-sortable-list__item" data-sortable-dragging={dragged() ? "" : undefined} data-sortable-line={line()}>
                {/* Once per key: a newer copy of the item reaches the row through `item`, never by rebuilding it. */}
                {byRow ? (
                  <Grab class="k2b-sortable-list__row">{untrack(() => props.children(item, handle))}</Grab>
                ) : (
                  untrack(() => props.children(item, handle))
                )}
              </li>
            );
          }}
        </For>
      </ul>
    </>
  );
}

/**
 * "Move to" entries for a row of `group`, one per other list: the way to move on a phone, where such lists do not
 * drag, and a second way everywhere. Put the section into the row's `Dropdown` or `GestureMenu`. Undefined when the
 * row is in no list of the group or no other list takes it.
 */
export function useSortableMoveMenu(group: string): (key: string) => DropdownSection | undefined {
  const messages = useSortableListMessages();
  const dragMessages = useDragAndDropMessages();
  return (key) => {
    const lists = listsOf(group);
    const from = lists.find((entry) => entry.keys().includes(key));
    if (!from) return undefined;
    const fromIndex = from.keys().indexOf(key);
    const items = lists
      .filter((entry) => entry !== from && !entry.disabled())
      .map((entry) => ({
        label: entry.label(),
        action: () => {
          const base = { group, key, label: key, from: from.key, fromIndex, keyboard: true, messages: dragMessages() };
          const sorted = entry.placement();
          const index = sorted ? clampIndex(sorted(key, from.key), placesIn(entry, key)) : entry.keys().length;
          const state: Lift = { ...base, to: entry.key, index };
          const at = place(entry, state, index);
          if (!commit(state)) return;
          announce(entry.list, messages().position(at));
          // The menu's trigger left with its row; focus follows the row to its new list.
          queueMicrotask(() => refocus(group, key));
        },
      }));
    return items.length ? { sectionLabel: messages().moveTo, items } : undefined;
  };
}
