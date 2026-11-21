import { createSignal, type Signal } from "solid-js";
import { setDragStatus } from "./drag-and-drop";
import type { DragAndDropMessages } from "./drag-and-drop-messages";
import type { SortableListMessages } from "./sortable-list-messages";
import { clampIndex, indexForGap, placeCount } from "./sortable-place";

/** The lists of each group and the row on its way, shared by SortableList, its keyboard module, and the move menu. */

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

export type Entry = {
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
export type Lift = {
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

export const groups = new Map<string, Set<Entry>>();
/**
 * Made on first use, so the module has no side effects and a bundle that imports `@k2b/ui` without SortableList drops
 * it. `registry` changes when a list joins or leaves a group, so a move menu built before the lists mounted updates.
 */
let shared: { registry: Signal<undefined>; lift: Signal<Lift | undefined> } | undefined;
const sharedState = () => (shared ??= { registry: createSignal(undefined, { equals: false }), lift: createSignal<Lift>() });
export const registry = () => sharedState().registry[0]();
export const touchRegistry = () => sharedState().registry[1]();
export const lift = () => sharedState().lift[0]();
export const setLift = (next: Lift | undefined) => sharedState().lift[1](next);
/** Ends the keyboard lift in progress without a drop; set by the keyboard module while a row is lifted. */
export const keyboardLift: { end?: () => void } = {};

export const listsOf = (group: string): Entry[] => {
  registry();
  return [...(groups.get(group) ?? [])]
    .filter((entry) => entry.list.isConnected)
    .sort((a, b) => (a.area.compareDocumentPosition(b.area) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
};
export const find = (group: string, key: string | undefined) =>
  key === undefined ? undefined : listsOf(group).find((entry) => entry.key === key);
export const placesIn = (entry: Entry, key: string) => placeCount(entry.keys().length, entry.keys().includes(key));
/** Where the row lands in `entry`: the sorted place, or the one the gap shows. */
export const landing = (entry: Entry, state: Lift, gap: number) => {
  const count = placesIn(entry, state.key);
  const sorted = entry.placement();
  if (sorted) return clampIndex(sorted(state.key, state.from), count);
  return clampIndex(indexForGap(gap, entry.keys().indexOf(state.key)), count);
};
export const place = (entry: Entry, state: Lift, index: number) => ({
  position: index + 1,
  count: placesIn(entry, state.key),
  list: entry.label(),
});
export const showStatus = (state: Lift) => {
  const entry = find(state.group, state.to);
  const lead = state.messages.statusLead({ label: state.label, count: 1 });
  if (!entry || state.index === undefined) {
    setDragStatus({ lead, detail: state.messages.statusIdle });
    return;
  }
  const at = { position: state.index + 1, list: entry.label() };
  setDragStatus({ lead, detail: entry.messages().statusPlace(at) });
};
export const moveOf = (group: string, key: string, from: string, to: string, fromIndex: number, index: number): SortableMove => ({
  from,
  to,
  fromIndex,
  undo: () => find(group, from)?.onMove(key, fromIndex, moveOf(group, key, to, from, index, fromIndex)),
});
/** Hands the move to the target list; false when nothing would change. */
export const commit = (state: Lift): boolean => {
  const to = find(state.group, state.to);
  if (!to || state.index === undefined) return false;
  if (state.to === state.from && state.index === to.keys().indexOf(state.key)) return false;
  to.onMove(state.key, state.index, moveOf(state.group, state.key, state.from, to.key, state.fromIndex, state.index));
  return true;
};
/** The grip of `key` takes focus again once the host has rendered the move, also in another list of the group. */
export const refocus = (group: string, key: string, attempt = 0) => {
  const handle = listsOf(group)
    .flatMap((entry) => [...entry.list.querySelectorAll<HTMLButtonElement>("[data-sortable-handle]")])
    .find((element) => element.dataset.sortableHandle === key);
  if (handle) {
    if (handle.ownerDocument.activeElement !== handle) handle.focus({ preventScroll: true });
    handle.scrollIntoView({ block: "nearest", inline: "nearest" });
  } else if (attempt < 2) requestAnimationFrame(() => refocus(group, key, attempt + 1));
};
