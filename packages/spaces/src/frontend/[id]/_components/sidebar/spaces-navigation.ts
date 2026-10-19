import { markHintSeen } from "@k2b/cloud/browser/hints";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { NavigationItem } from "@k2b/ui";
import { createSignal } from "solid-js";
import type { overviewMessages } from "../../../overview-messages";

export type SidebarSpace = { id: string; name: string; color: string; description: string | null; openItemCount: number };
export type SpacesSidebarCurrent = { kind: "overview" } | { kind: "space"; id: string };
export type SpacesSidebarData = { spaces: SidebarSpace[]; pinnedSpaceIds: string[]; myWorkCount: number };

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
  newSpaceLabel: string;
}): NavigationItem[] => [
  { id: "my-work", label: props.myWorkLabel, icon: "ti ti-checkbox", href: "/app/spaces", active: props.current.kind === "overview" },
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
