import { createSignal, onCleanup, onMount } from "solid-js";

export type SidebarSpace = { id: string; name: string; color: string; openItemCount: number };
export type SpacesSidebarCurrent = { kind: "overview" } | { kind: "calendar" } | { kind: "space"; id: string };
/**
 * The server sends the Spaces the sidebar shows before a search (the pinned, the recent and the open one, and the first
 * 20 by name); `unlistedSpaceCount` counts the reachable Spaces it left out.
 */
export type SpacesSidebarData = {
  spaces: SidebarSpace[];
  unlistedSpaceCount: number;
  pinnedSpaceIds: string[];
  recentSpaceIds: string[];
  myWorkCount: number;
};

const PINS_CHANGED_EVENT = "spaces-pins-changed";
const PINS_REQUEST_EVENT = "spaces-pins-request";

/**
 * The pins this page shows, shared by the sidebar and the phone title menu, which live in different islands: a pin
 * changed in one shows in the other at once. The cookie keeps them for the next page.
 */
export function createPinnedSpaces(initial: string[]) {
  const [pinned, setPinned] = createSignal(initial);
  let changed = false;
  onMount(() => {
    const onChanged = (event: Event) => {
      if (event instanceof CustomEvent && Array.isArray(event.detail)) setPinned(event.detail);
    };
    const onRequest = () => {
      if (changed) window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: pinned() }));
    };
    window.addEventListener(PINS_CHANGED_EVENT, onChanged);
    // Request before answering so this island cannot overwrite a newer snapshot with its server pins.
    window.dispatchEvent(new Event(PINS_REQUEST_EVENT));
    window.addEventListener(PINS_REQUEST_EVENT, onRequest);
    onCleanup(() => {
      window.removeEventListener(PINS_CHANGED_EVENT, onChanged);
      window.removeEventListener(PINS_REQUEST_EVENT, onRequest);
    });
  });
  const update = (next: string[]) => {
    changed = true;
    setPinned(next);
    window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: next }));
  };
  return [pinned, update] as const;
}

/**
 * The order of the sidebar and the phone menu: pinned Spaces in pin order, then the ones opened last, newest first,
 * then the rest as the server lists them.
 */
export const orderSidebarSpaces = (spaces: SidebarSpace[], pinnedSpaceIds: string[], recentSpaceIds: string[]) => {
  const rank = (space: SidebarSpace): [number, number] => {
    const pin = pinnedSpaceIds.indexOf(space.id);
    if (pin !== -1) return [0, pin];
    const recent = recentSpaceIds.indexOf(space.id);
    return recent === -1 ? [2, 0] : [1, recent];
  };
  return [...spaces].sort((left, right) => {
    const [a, i] = rank(left);
    const [b, j] = rank(right);
    return a - b || i - j;
  });
};

/** The sidebar lists at most this many Spaces before a search (as Grids and Pulse do), and this many matches. */
export const SIDEBAR_SPACES = 20;
export const SIDEBAR_MATCHES = 50;
/** From this many Spaces the sidebar holds a search. */
export const SIDEBAR_SEARCH_FROM = 8;

/**
 * The Spaces the sidebar shows, in `orderSidebarSpaces` order: before a search the first 20, the open Space always
 * among them; a search finds by name among the listed ones, at most 50. `hidden` counts the ones left out, with the
 * `unlisted` ones the server did not send; "+n more" opens the search of all Spaces for them.
 */
export const sidebarSpaceList = (
  spaces: SidebarSpace[],
  options: { pinned: string[]; recent: string[]; currentId?: string; query: string; locale: string; unlisted: number },
): { shown: SidebarSpace[]; hidden: number } => {
  const ordered = orderSidebarSpaces(spaces, options.pinned, options.recent);
  const needle = options.query.trim().toLocaleLowerCase(options.locale);
  if (needle) {
    const matches = ordered.filter((space) => space.name.toLocaleLowerCase(options.locale).includes(needle));
    return { shown: matches.slice(0, SIDEBAR_MATCHES), hidden: Math.max(0, matches.length - SIDEBAR_MATCHES) + options.unlisted };
  }
  let shown = ordered.slice(0, SIDEBAR_SPACES);
  const current = ordered.find((space) => space.id === options.currentId);
  if (current && !shown.includes(current)) shown = [...shown.slice(0, SIDEBAR_SPACES - 1), current];
  return { shown, hidden: ordered.length - shown.length + options.unlisted };
};
