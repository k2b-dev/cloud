import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Nav, type NavGroup, type NavItem, type NavSearch, useToast } from "@k2b/ui/v2";
import { createMemo, createSignal, lazy, Show } from "solid-js";
import { setPinnedSpaceIds } from "../[id]/_components/settings/SpaceSettingsStore";
import {
  createPinnedSpaces,
  SIDEBAR_SEARCH_FROM,
  type SidebarSpace,
  type SpacesSidebarCurrent,
  type SpacesSidebarData,
  sidebarSpaceList,
} from "../[id]/_components/sidebar/spaces-navigation";
import { overviewMessages } from "../overview-messages";

export type SpacesNavProps = SpacesSidebarData & { current: SpacesSidebarCurrent; canCreate: boolean };

/** The symbol of a Space wherever it stands: in the sidebar, in its head, beside its work. */
export const SPACE_MARK_ICON = "layout-kanban";

/**
 * The places of Spaces on v2: "My work", the calendar of all Spaces, and the Spaces with their open counts: pinned
 * first, then the ones opened last, at most 20 before a search and "+n more" for the rest; from 8 Spaces the sidebar
 * holds a search by name. A Space's "…" pins or unpins it; the pins live in the settings cookie and reach the phone menu
 * at once.
 */
export function useSpacesNav(props: SpacesNavProps) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  // Counts in the reader's digits: a Space with 12,840 open items reads as such, not as 12840.
  const count = (value: number) => new Intl.NumberFormat(locale()).format(value);
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
  const [query, setQuery] = createSignal("");
  const openSearch = () => openGlobalSearch({ scope: { appId: "spaces", label: "Spaces", icon: "ti ti-layout-kanban" } });
  const spaceItem = (space: SidebarSpace): NavItem => {
    const isPinned = pinned().includes(space.id);
    return {
      label: space.name,
      icon: SPACE_MARK_ICON,
      color: space.color ?? undefined,
      href: `/app/spaces/${space.id}`,
      count: count(space.openItemCount),
      current: props.current.kind === "space" && props.current.id === space.id,
      menu: [
        {
          label: isPinned ? t().unpin({ name: space.name }) : t().pin({ name: space.name }),
          icon: isPinned ? "pinned-off" : "pin",
          onClick: () => togglePin(space),
        },
      ],
    };
  };
  const groupsFor = (search: string): NavGroup[] => {
    const list = sidebarSpaceList(props.spaces, {
      pinned: pinned(),
      recent: props.recentSpaceIds,
      currentId: props.current.kind === "space" ? props.current.id : undefined,
      query: search,
      locale: locale(),
      unlisted: props.unlistedSpaceCount,
    });
    return [
      {
        items: [
          {
            label: t().myWork,
            icon: "checkbox",
            href: "/app/spaces",
            count: count(props.myWorkCount),
            current: props.current.kind === "overview",
          },
          { label: t().calendar, icon: "calendar", href: "/app/spaces/calendar", current: props.current.kind === "calendar" },
        ],
      },
      {
        label: "Spaces",
        action: props.canCreate ? { label: t().newSpace, icon: "plus", onClick: () => setCreating(true) } : undefined,
        // Each Space carries one mark, the same in the head of the Space: the symbol of a Space on its colour. Pinned
        // Spaces come first, then the ones opened last; the pin is a deed in the entry's menu, not a second kind of mark.
        // The rest stay one search away: "+10 more" opens the search of Spaces, which the phone menu reaches too.
        // k2b-ui gap: a Mark has no initial ("P" on the Space colour) for things without a symbol of their own.
        items: [
          ...list.shown.map(spaceItem),
          ...(list.hidden > 0 ? [{ label: t().moreSpaces({ count: count(list.hidden) }), icon: "dots", onClick: openSearch }] : []),
        ],
      },
    ];
  };
  // The sidebar's search filters its own entries; the phone menu, which has no search field, keeps the first ones.
  const groups = createMemo(() => groupsFor(query()));
  const menuGroups = createMemo(() => groupsFor(""));
  const search = (): NavSearch | undefined =>
    props.spaces.length + props.unlistedSpaceCount >= SIDEBAR_SEARCH_FROM
      ? { label: t().findSpace, value: query(), onInput: setQuery }
      : undefined;
  return { groups, menuGroups, search, creating, setCreating };
}

/** Loaded only when someone starts a new Space, so the page script stays small. */
const CreateSpaceDialog = lazy(() => import("./CreateSpaceDialog"));

/** The sidebar of every Spaces page, the same entries in the shell's phone menu, and the "New space" dialog. */
export default function SpacesNav(props: { nav: ReturnType<typeof useSpacesNav>; label?: string }) {
  return (
    <>
      {/* The phone bar names the open place, such as the Space, and opens the same entries as the sidebar. */}
      <V2WorkspaceNavigation label={props.label ?? "Spaces"} groups={props.nav.menuGroups()} />
      <Nav title="Spaces" icon="layout-kanban" search={props.nav.search()} groups={props.nav.groups()} />
      <Show when={props.nav.creating()}>
        <CreateSpaceDialog open onClose={() => props.nav.setCreating(false)} />
      </Show>
    </>
  );
}
