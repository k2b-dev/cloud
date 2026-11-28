import { createContext, onCleanup, useContext } from "solid-js";
import type { MenuEntry } from "./menu";

/**
 * A place of a workspace head's `Bar`, its start or its end, which hears what stands in it. Only the head of a
 * workspace has one: a pane's or a section's bar keeps its actions and names what it likes.
 */
type BarPlace = {
  place: "start" | "end";
  /** At the end: a main action (`undefined` while it is none) as an entry of the one "+" its bar makes of several. */
  create?: (entry: () => MenuEntry | undefined) => () => void;
  /** In the start: the words of the page the sidebar's current entry names. */
  named?: () => string | undefined;
  /** In the start: whether a title there only repeats the page the sidebar names. */
  repeats?: (repeats: () => boolean) => () => void;
};

export const BarPlaceContext = createContext<BarPlace>();

/**
 * A main action at the end of a workspace's head: where the head holds more than one, it shows them as one "+" menu,
 * each an entry with its name and deed, and the actions themselves give way (one create action at a head's end). The
 * entry is `undefined` while the action is no main action.
 */
export const markBarCreate = (entry: () => MenuEntry | undefined) => {
  const bar = useContext(BarPlaceContext);
  if (bar?.place === "end" && bar.create) onCleanup(bar.create(entry));
};

/**
 * A title in the start of a workspace's head: whether its words only repeat the page the sidebar's current entry names
 * (`undefined` outside such a start). It tells the bar, which gives way whole where that title is all it holds.
 */
export const useBarRepeats = (words: () => unknown): (() => boolean) | undefined => {
  const bar = useContext(BarPlaceContext);
  if (bar?.place !== "start" || !bar.named || !bar.repeats) return undefined;
  const named = bar.named;
  const repeats = () => {
    const text = words();
    const name = named();
    return typeof text === "string" && name !== undefined && text.trim() === name.trim();
  };
  onCleanup(bar.repeats(repeats));
  return repeats;
};

/** Whether a part stands in the start of a workspace's head (where a title may repeat the sidebar's page). */
export const inHeadStart = () => {
  const bar = useContext(BarPlaceContext);
  return bar?.place === "start" && bar.named !== undefined;
};

/** The sidebar tells its workspace the words of its current entry: the page the sidebar already names. */
export const SidebarPlaceContext = createContext<(name: () => string | undefined) => void>();

/**
 * The head of a workspace: the words of the sidebar's current entry, which a title of the same words repeats, and
 * where the head's bar tells its main actions, so the round button of the phone offers them all.
 */
export type HeadPlace = { named: () => string | undefined; creates: (entries: () => readonly MenuEntry[]) => () => void };

export const HeadPlaceContext = createContext<HeadPlace>();
