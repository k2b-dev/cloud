import { markHintSeen } from "@k2b/cloud/browser/hints";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Nav, type NavGroup, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, lazy, Show } from "solid-js";
import { setPinnedSpaceIds } from "../[id]/_components/settings/SpaceSettingsStore";
import {
  createPinnedSpaces,
  orderSidebarSpaces,
  type SidebarSpace,
  type SpacesSidebarCurrent,
  type SpacesSidebarData,
} from "../[id]/_components/sidebar/spaces-navigation";
import { overviewMessages } from "../overview-messages";

export type SpacesNavProps = SpacesSidebarData & { current: SpacesSidebarCurrent; canCreate: boolean };

/**
 * The places of Spaces on v2: "My work", the calendar of all Spaces, and every Space in pin order with its open count.
 * A Space's "…" pins or unpins it; the pins live in the settings cookie and reach the phone menu at once.
 */
export function useSpacesNav(props: SpacesNavProps) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const toast = useToast();
  const [pinned, setPinned] = createPinnedSpaces(props.pinnedSpaceIds);
  const [creating, setCreating] = createSignal(false);
  const pin = (next: string[]) => {
    setPinnedSpaceIds(next);
    setPinned(next);
  };
  const togglePin = (space: SidebarSpace) => {
    const before = pinned();
    const wasPinned = before.includes(space.id);
    pin(wasPinned ? before.filter((id) => id !== space.id) : [space.id, ...before]);
    toast(wasPinned ? t().unpinned({ name: space.name }) : t().pinned({ name: space.name }), { undo: () => pin(before) });
  };
  const visit = () => {
    markHintSeen("spaces.sidebar-switch");
    markHintSeen("spaces.overview-sidebar");
  };
  const groups = createMemo((): NavGroup[] => [
    {
      items: [
        { label: t().myWork, icon: "checkbox", href: "/app/spaces", count: props.myWorkCount, current: props.current.kind === "overview" },
        { label: t().calendar, icon: "calendar", href: "/app/spaces/calendar", current: props.current.kind === "calendar" },
      ],
    },
    {
      label: "Spaces",
      action: props.canCreate ? { label: t().newSpace, icon: "plus", onClick: () => setCreating(true) } : undefined,
      // Each Space carries its mark: its symbol (a pin when pinned) on its colour.
      items: orderSidebarSpaces(props.spaces, pinned()).map((space) => {
        const isPinned = pinned().includes(space.id);
        return {
          label: space.name,
          icon: isPinned ? "pin" : "point-filled",
          color: space.color ?? undefined,
          href: `/app/spaces/${space.id}`,
          onClick: visit,
          count: space.openItemCount,
          current: props.current.kind === "space" && props.current.id === space.id,
          menu: [
            {
              label: isPinned ? t().unpin({ name: space.name }) : t().pin({ name: space.name }),
              icon: isPinned ? "pinned-off" : "pin",
              onClick: () => togglePin(space),
            },
          ],
        };
      }),
    },
  ]);
  return { groups, creating, setCreating };
}

/** Loaded only when someone starts a new Space, so the page script stays small. */
const CreateSpaceDialog = lazy(() => import("./CreateSpaceDialog"));

/** The sidebar of every Spaces page, the same entries in the shell's phone menu, and the "New space" dialog. */
export default function SpacesNav(props: { nav: ReturnType<typeof useSpacesNav> }) {
  return (
    <>
      <V2WorkspaceNavigation label="Spaces" groups={props.nav.groups()} />
      <Nav title="Spaces" icon="layout-kanban" groups={props.nav.groups()} />
      <Show when={props.nav.creating()}>
        <CreateSpaceDialog open onClose={() => props.nav.setCreating(false)} />
      </Show>
    </>
  );
}
