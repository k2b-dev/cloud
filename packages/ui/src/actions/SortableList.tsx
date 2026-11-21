import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, onCleanup, onMount, type Signal, untrack } from "solid-js";
import type { DropdownSection } from "./Dropdown";
import { activeDrag, announce, bindDragSource, registerDropTarget, setDragStatus } from "./drag-and-drop";
import { type DragAndDropMessages, useDragAndDropMessages } from "./drag-and-drop-messages";
import { PHONE_SHEET_QUERY } from "./phone-sheet";
import { type SortableListMessages, useSortableListMessages } from "./sortable-list-messages";
import { clampIndex, gapAt, gapForIndex, indexForGap, placeCount } from "./sortable-place";

/** One move a list reports through `onMove`. */
export type SortableMove = {
  /** The `listKey` the row came from. */
  from: string;
  /** The `listKey` the row goes to; the same as `from` for a move inside one list. */
  to: string;
  /** The row's index in `from` before the move. */
  fromIndex: number;
  /** Moves the row back where it came from, through the lists' own `onMove`; for the "Undo" of the host's toast. */
  undo: () => void;
};

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

type Entry = {
  group: string;
  key: string;
  label: () => string;
  list: HTMLUListElement;
  area: HTMLElement;
  keys: () => readonly string[];
  disabled: () => boolean;
  placement: () => ((key: string, from: string) => number) | undefined;
  onMove: (key: string, index: number, move: SortableMove) => void;
  messages: () => SortableListMessages;
};
/** A row on its way: lifted from `from`, and while it is over a list, `index` of `to` is where it would land. */
type Lift = {
  group: string;
  key: string;
  label: string;
  from: string;
  fromIndex: number;
  to?: string;
  index?: number;
  keyboard: boolean;
  messages: DragAndDropMessages;
};

const groups = new Map<string, Set<Entry>>();
/**
 * Made on first use, so the module has no side effects and a bundle that imports `@k2b/ui` without SortableList drops
 * it. `registry` changes when a list joins or leaves a group, so a move menu built before the lists mounted updates.
 */
let shared: { registry: Signal<undefined>; lift: Signal<Lift | undefined> } | undefined;
const sharedState = () => (shared ??= { registry: createSignal(undefined, { equals: false }), lift: createSignal<Lift>() });
const registry = () => sharedState().registry[0]();
const touchRegistry = () => sharedState().registry[1]();
const lift = () => sharedState().lift[0]();
const setLift = (next: Lift | undefined) => sharedState().lift[1](next);
/** The pointer's last place: the engine ends the drag, and with it `lift`, before it calls `drop`. */
let pointerPlan: Lift | undefined;
/** Ends the keyboard lift in progress without a drop. */
let endKeyboard: (() => void) | undefined;

const listsOf = (group: string): Entry[] => {
  registry();
  return [...(groups.get(group) ?? [])]
    .filter((entry) => entry.list.isConnected)
    .sort((a, b) => (a.area.compareDocumentPosition(b.area) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
};
const find = (group: string, key: string | undefined) =>
  key === undefined ? undefined : listsOf(group).find((entry) => entry.key === key);
const placesIn = (entry: Entry, key: string) => placeCount(entry.keys().length, entry.keys().includes(key));
/** Where the row lands in `entry`: the sorted place, or the one the gap shows. */
const landing = (entry: Entry, state: Lift, gap: number) => {
  const count = placesIn(entry, state.key);
  const sorted = entry.placement();
  if (sorted) return clampIndex(sorted(state.key, state.from), count);
  return clampIndex(indexForGap(gap, entry.keys().indexOf(state.key)), count);
};
const place = (entry: Entry, state: Lift, index: number) => ({
  position: index + 1,
  count: placesIn(entry, state.key),
  list: entry.label(),
});
const showStatus = (state: Lift) => {
  const entry = find(state.group, state.to);
  const lead = state.messages.statusLead({ label: state.label, count: 1 });
  if (!entry || state.index === undefined) {
    setDragStatus({ lead, detail: state.messages.statusIdle });
    return;
  }
  const at = { position: state.index + 1, list: entry.label() };
  setDragStatus({ lead, detail: state.keyboard ? entry.messages().statusPlaceKeyboard(at) : entry.messages().statusPlace(at) });
};
const moveOf = (group: string, key: string, from: string, to: string, fromIndex: number, index: number): SortableMove => ({
  from,
  to,
  fromIndex,
  undo: () => find(group, from)?.onMove(key, fromIndex, moveOf(group, key, to, from, index, fromIndex)),
});
/** Hands the move to the target list; false when nothing would change. */
const commit = (state: Lift): boolean => {
  const to = find(state.group, state.to);
  if (!to || state.index === undefined) return false;
  if (state.to === state.from && state.index === to.keys().indexOf(state.key)) return false;
  to.onMove(state.key, state.index, moveOf(state.group, state.key, state.from, to.key, state.fromIndex, state.index));
  return true;
};
/** The grip of `key` takes focus again once the host has rendered the move, also in another list of the group. */
const refocus = (group: string, key: string, attempt = 0) => {
  const handle = listsOf(group)
    .flatMap((entry) => [...entry.list.querySelectorAll<HTMLButtonElement>("[data-sortable-handle]")])
    .find((element) => element.dataset.sortableHandle === key);
  if (handle) {
    if (handle.ownerDocument.activeElement !== handle) handle.focus({ preventScroll: true });
    handle.scrollIntoView({ block: "nearest", inline: "nearest" });
  } else if (attempt < 2) requestAnimationFrame(() => refocus(group, key, attempt + 1));
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
    if (state?.to !== listKey || state.index === undefined) return undefined;
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
    area = list.closest<HTMLElement>("[data-sortable-column]") ?? list;
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
      if (mine()?.to === listKey) area.dataset.sortableTarget = "";
      else delete area.dataset.sortableTarget;
    });
    onCleanup(() => {
      target.dispose();
      delete area.dataset.sortableTarget;
      members.delete(entry);
      if (!members.size) groups.delete(group);
      touchRegistry();
      const state = lift();
      if (state?.group === group && state.keyboard && (state.from === listKey || state.to === listKey)) endKeyboard?.();
    });
  });

  /** One step at once, without lifting: the existing quick path for the grip's arrow keys, Home, and End. */
  const step = (key: string, index: number) => {
    const count = keys().length;
    const target = clampIndex(index, count);
    const from = keys().indexOf(key);
    const item = itemFor(key);
    if (from < 0 || from === target || props.disabled || item === undefined) return;
    props.onMove(key, target, moveOf(group, key, listKey, listKey, from, target));
    queueMicrotask(() => {
      refocus(group, key);
      announce(list, messages().moved({ label: props.itemLabel(item), position: keys().indexOf(key) + 1, count }));
    });
  };

  const startLift = (key: string, label: string) => {
    if (props.disabled) return;
    endKeyboard?.();
    const fromIndex = keys().indexOf(key);
    const state: Lift = {
      group,
      key,
      label,
      from: listKey,
      fromIndex,
      to: listKey,
      index: fromIndex,
      keyboard: true,
      messages: dragMessages(),
    };
    setLift(state);
    showStatus(state);
    announce(list, messages().lifted({ label, ...place(entry, state, fromIndex) }));
    const doc = list.ownerDocument;
    const win = doc.defaultView!;
    const end = () => {
      if (endKeyboard !== end) return;
      endKeyboard = undefined;
      doc.removeEventListener("pointerdown", cancel, true);
      win.removeEventListener("blur", cancel);
      const current = lift();
      if (current?.keyboard) setLift(undefined);
      setDragStatus(undefined);
    };
    const cancel = () => {
      const current = lift();
      end();
      if (current) announce(list, messages().cancelled({ label: current.label }));
    };
    endKeyboard = end;
    doc.addEventListener("pointerdown", cancel, true);
    win.addEventListener("blur", cancel);
  };

  /** Keys while a row is lifted: choose a place, drop, or cancel. Nothing moves until the drop. */
  const liftedKey = (event: KeyboardEvent, state: Lift) => {
    const target = find(group, state.to) ?? entry;
    const count = placesIn(target, state.key);
    const choose = (to: Entry, index: number) => {
      const next = { ...state, to: to.key, index };
      setLift(next);
      showStatus(next);
      announce(list, to.messages().position(place(to, next, index)));
      requestAnimationFrame(() => {
        const line = to.list.querySelector("[data-sortable-line]") ?? to.list;
        line.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };
    const sorted = target.placement();
    const at = state.index ?? 0;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End": {
        const wanted = { ArrowUp: at - 1, ArrowDown: at + 1, Home: 0, End: count - 1 }[event.key];
        choose(target, sorted ? landing(target, state, 0) : clampIndex(wanted, count));
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        const lists = listsOf(group).filter((other) => other === target || !other.disabled());
        const next = lists[lists.indexOf(target) + (event.key === "ArrowLeft" ? -1 : 1)] ?? target;
        const nextSorted = next.placement();
        choose(next, nextSorted ? landing(next, state, 0) : clampIndex(at, placesIn(next, state.key)));
        break;
      }
      case "Enter":
      case " ": {
        endKeyboard?.();
        const moved = commit(state);
        const to = find(group, state.to);
        if (to && state.index !== undefined)
          announce(list, to.messages().dropped({ label: state.label, ...place(to, state, state.index) }));
        if (moved) queueMicrotask(() => refocus(group, state.key));
        break;
      }
      case "Escape": {
        endKeyboard?.();
        announce(list, messages().cancelled({ label: state.label }));
        break;
      }
      case "Tab":
        endKeyboard?.();
        announce(list, messages().cancelled({ label: state.label }));
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <>
      <span id={hintId} hidden>
        {messages().hint}
      </span>
      <ul
        ref={list}
        class={`k2b-sortable-list${props.class ? ` ${props.class}` : ""}`}
        aria-label={props.label}
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
            const onKeyDown = (event: KeyboardEvent) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const state = mine();
              // A held Space or Enter repeats; only the first press lifts or drops.
              if (event.repeat && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                return;
              }
              if (state?.keyboard && state.key === key) {
                liftedKey(event, state);
                return;
              }
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                startLift(key, label());
                return;
              }
              const wanted = { ArrowUp: index() - 1, ArrowDown: index() + 1, Home: 0, End: keys().length - 1 }[event.key];
              if (wanted === undefined || event.shiftKey) return;
              event.preventDefault();
              step(key, wanted);
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
          if (commit(state)) announce(entry.list, messages().position(at));
        },
      }));
    return items.length ? { sectionLabel: messages().moveTo, items } : undefined;
  };
}
