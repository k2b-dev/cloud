import { markHintSeen } from "@k2b/cloud/browser/hints";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { NavigationItem } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import type { overviewMessages } from "../../../overview-messages";

export type SidebarSpace = { id: string; name: string; color: string; description: string | null; openItemCount: number };
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

export const createSpacesNavigationItems = (props: {
  spaces: SidebarSpace[];
  pinnedSpaceIds: string[];
  current: SpacesSidebarCurrent;
  canCreate: boolean;
  myWorkLabel: string;
  calendarLabel: string;
  newSpaceLabel: string;
}): NavigationItem[] => [
  { id: "my-work", label: props.myWorkLabel, icon: "ti ti-checkbox", href: "/app/spaces", active: props.current.kind === "overview" },
  {
    id: "all-calendars",
    label: props.calendarLabel,
    icon: "ti ti-calendar",
    href: "/app/spaces/calendar",
    active: props.current.kind === "calendar",
  },
  ...orderSidebarSpaces(props.spaces, props.pinnedSpaceIds).map((space) => ({
    id: space.id,
    label: space.name,
    color: space.color,
    icon: props.pinnedSpaceIds.includes(space.id) ? "ti ti-flag" : "ti ti-circle-filled",
    href: `/app/spaces/${space.id}`,
    active: props.current.kind === "space" && props.current.id === space.id,
  })),
  ...(props.canCreate ? [{ id: "new-space", label: props.newSpaceLabel, icon: "ti ti-plus", action: "new-space" }] : []),
];

export function createNewSpace(t: ReturnType<typeof overviewMessages.resolve>["t"]) {
  const [pending, setPending] = createSignal(false);
  return async () => {
    if (pending()) return;
    setPending(true);
    try {
      const dialog = await importOnDemand(() => import("../../../create-space-dialog"));
      if (dialog) await dialog.createSpaceCreation(t)();
    } finally {
      setPending(false);
    }
  };
}

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
