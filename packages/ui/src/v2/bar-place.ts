import { createContext, onCleanup, useContext } from "solid-js";
import type { MenuEntry } from "./menu";

/** What marks a bar: a title, a toolbar (a filter bar) or a path in its start, the "…" or a search at its end. */
export type BarMark = "title" | "toolbar" | "path" | "more" | "search";

/** A place of a `Bar`, its start or its end, which hears what stands in it. */
type BarPlace = {
  place: "start" | "end";
  mark: (what: BarMark) => () => void;
  /**
   * At the end of a workspace's head: a main action (`variant="primary"`; `undefined` while it is none) as an entry of
   * the one "+" its bar makes of several.
   */
  create?: (entry: () => MenuEntry | undefined) => () => void;
  /** At the end: whether a search there holds words (it then shows them, so its head shows). */
  filled?: (holds: () => boolean) => () => void;
  /** In the start: whether a title there only repeats the page the sidebar names. */
  repeats?: (repeats: () => boolean) => () => void;
};

export const BarPlaceContext = createContext<BarPlace>();

/**
 * Tells the bar what stands in one of its places, already as the server renders it: a `Text` in its start names the
 * page (the bar's `data-title`), a filter bar there is its toolbar (`data-toolbar`), the "…" at its end takes in what
 * gives way (`data-more`). The head's rules ask these marks instead of a `:has()`, which a change deep in the page
 * would make the browser check again and again.
 */
export const markBarPlace = (place: "start" | "end", what: BarMark) => {
  const bar = useContext(BarPlaceContext);
  // the mark goes with the part that made it
  if (bar?.place === place) onCleanup(bar.mark(what));
};

/**
 * A main action at the end of a workspace's head: where the head holds more than one, it shows them as one "+" menu,
 * each an entry with its name and deed, and the actions themselves give way (Valentin 26.11.: one create action at the
 * head's end). The entry is `undefined` while the action is no main action.
 */
export const markBarCreate = (entry: () => MenuEntry | undefined) => {
  const bar = useContext(BarPlaceContext);
  if (bar?.place !== "end" || !bar.create) return;
  onCleanup(bar.create(entry));
};

/** A search at the end of a bar tells it whether it holds words. */
export const markBarFilled = (holds: () => boolean) => {
  const bar = useContext(BarPlaceContext);
  if (bar?.place === "end" && bar.filled) onCleanup(bar.filled(holds));
};

/** A title in the start of a bar tells it whether it only repeats the page the sidebar names. */
export const markBarRepeats = (repeats: () => boolean) => {
  const bar = useContext(BarPlaceContext);
  if (bar?.place === "start" && bar.repeats) onCleanup(bar.repeats(repeats));
};

/** A toolbar row in the status place of a pane: its filter bar or its status row. */
export type StatusRowKind = "filter" | "status";

/** The status place of a pane, which hears the toolbar rows that stand in it, in their order. */
export const StatusPlaceContext = createContext<(row: StatusRowKind) => () => void>();

/**
 * Tells the pane which toolbar row stands in its status place, already as the server renders it: a pane at the top of
 * a workspace, under the workspace's head, makes the head and these rows one block (`data-block`).
 */
export const markStatusRow = (row: StatusRowKind) => {
  const hear = useContext(StatusPlaceContext);
  if (hear) onCleanup(hear(row));
};

/** The sidebar tells its workspace the words of its current entry: the page the sidebar already names. */
export const SidebarPlaceContext = createContext<(name: () => string | undefined) => void>();

/**
 * The head of a workspace: the words of the sidebar's current entry, which a title of the same words repeats, and
 * where the head's bar tells its main actions, so the round button of the phone offers them all.
 */
export type HeadPlace = {
  place: () => string | undefined;
  creates: (entries: () => readonly MenuEntry[]) => void;
  /** A path in the head's start tells the words of the open item, its last step. */
  names: (name: () => string | undefined) => void;
};

/**
 * A host that names the page in a bar of its own (Cloud's shell on the phone) hears the open item a workspace's head
 * shows where it stands (the last step of its path), already as the server renders it: the page itself has no title
 * then, such as the Assistant's open chat.
 */
export const PageNameContext = createContext<(name: () => string | undefined) => void>();

export const HeadPlaceContext = createContext<HeadPlace>();

/** Whether a part stands in the start of a bar (where a `Text` is the bar's title). */
export const inBarStart = () => useContext(BarPlaceContext)?.place === "start";
