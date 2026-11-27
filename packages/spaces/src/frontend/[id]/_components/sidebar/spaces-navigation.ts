import { markHintSeen } from "@k2b/cloud/browser/hints";
import { createSignal, onCleanup, onMount } from "solid-js";

export type SidebarSpace = { id: string; name: string; color: string; openItemCount: number };
export type SpacesSidebarCurrent = { kind: "overview" } | { kind: "calendar" } | { kind: "space"; id: string };
export type SpacesSidebarData = { spaces: SidebarSpace[]; pinnedSpaceIds: string[]; myWorkCount: number };

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

/** Pin order is shared by the desktop rows and the phone title menu. */
export const orderSidebarSpaces = (spaces: SidebarSpace[], pinnedSpaceIds: string[]) =>
  [...spaces].sort((left, right) => {
    const a = pinnedSpaceIds.indexOf(left.id);
    const b = pinnedSpaceIds.indexOf(right.id);
    if (a === -1 && b === -1) return 0;
    if (a === -1) return 1;
    if (b === -1) return -1;
    return a - b;
  });

/** Phone navigation lives in the Cloud shell, outside the sidebar island. */
export const listenSpacesNavigationHints = (document: Document, spaces: SidebarSpace[]) => {
  const hrefs = new Set(spaces.map((space) => `/app/spaces/${space.id}`));
  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a");
    if (!anchor || !hrefs.has(anchor.getAttribute("href") ?? "")) return;
    markHintSeen("spaces.sidebar-switch");
    markHintSeen("spaces.overview-sidebar");
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
};
