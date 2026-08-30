import { type HotkeyMap, hotkeys } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  openSpotlightSearch,
  SPOTLIGHT_SHORTCUT,
  SPOTLIGHT_SHORTCUT_TITLE,
  SpotlightButton,
  type SpotlightButtonVariant,
} from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { ItemFilter, SpaceColumn, SpaceItem } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";

type Props = {
  spaceId: string;
  spaceName: string;
  columns: SpaceColumn[];
  query: string;
  variant?: SpotlightButtonVariant;
  registerShortcut?: boolean;
};

const PAGE_SIZE = 20;

const buildItemHref = (spaceId: string, query: string, itemId: string) => {
  const params = new URLSearchParams(query);
  params.set("item", itemId);
  params.delete("mode");
  const search = params.toString();
  return `/app/spaces/${spaceId}${search ? `?${search}` : ""}`;
};

const itemIcon = (item: SpaceItem) => (item.startsAt && item.endsAt ? "ti ti-calendar-event" : "ti ti-checkbox");

const compactDescription = (value: string | null | undefined, query: string): string | undefined => {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;

  const needle = query.trim().toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (index === -1) return text.slice(0, 120);

  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + needle.length + 80);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
};

const searchRequest = (query: string): ItemFilter => ({
  type: "all",
  status: "all",
  activity: "all",
  assignedTo: "all",
  deadlineFilter: "all",
  search: query,
  sort: "updated",
  sortDesc: true,
  groupBy: "none",
  page: 1,
  pageSize: PAGE_SIZE,
});

export default function SearchButton(props: Props) {
  const t = useSpaceMessages();
  const itemDescription = (item: SpaceItem, query: string): string | undefined => {
    const column = props.columns.find((entry) => entry.id === item.columnId);
    const priority = item.priority ? { urgent: t.urgent, high: t.high, medium: t.medium, low: t.low }[item.priority] : undefined;
    const meta = [
      item.startsAt && item.endsAt ? t.event : t.task,
      column?.name,
      item.completedAt ? t.completed : undefined,
      priority,
    ].filter(Boolean);
    const snippet = compactDescription(item.description, query);
    return [...meta, snippet].join(" · ") || undefined;
  };
  const openSearch = async () => {
    const selected = await openSpotlightSearch<SpaceItem>({
      title: t.searchInSpace({ space: props.spaceName }),
      icon: "ti ti-layout-kanban",
      placeholder: t.searchItems,
      minQueryLength: 1,
      noResultsText: t.noItemsFound,
      resolve: async ({ query, abortSignal }) => {
        const trimmed = query.trim();
        if (!trimmed) return [];

        const response = await apiClient[":id"].items.filter.$post(
          {
            param: { id: props.spaceId },
            json: searchRequest(trimmed),
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) return [];

        const payload = await response.json();
        return payload.items.map((item) => ({
          value: item,
          label: item.title,
          desc: itemDescription(item, trimmed),
          icon: itemIcon(item),
        }));
      },
    });

    if (selected?.value) {
      requestSpacesRouteNavigation(buildItemHref(props.spaceId, props.query, selected.value.id), { scroll: "preserve" });
    }
  };

  const runSearch = () => {
    if (!document.querySelector("dialog[open]")) void openSearch();
  };
  hotkeys.create(
    (): HotkeyMap =>
      props.registerShortcut
        ? {
            [SPOTLIGHT_SHORTCUT]: {
              label: t.searchItemsCommand,
              desc: t.searchItemsCommandDescription,
              run: runSearch,
            },
            "/": {
              label: t.searchItemsCommand,
              desc: t.searchItemsCommandDescription,
              run: runSearch,
            },
          }
        : {},
  );

  if (props.variant === "icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon="ti ti-search"
        label={t.searchItemsWithShortcut({ shortcut: `${SPOTLIGHT_SHORTCUT_TITLE} · /` })}
        onClick={() => void openSearch()}
      />
    );
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t.searchItemsLabel}
      onClick={openSearch}
      title={t.searchItemsWithShortcut({ shortcut: `${SPOTLIGHT_SHORTCUT_TITLE} · /` })}
      ariaLabel={t.searchItems}
    />
  );
}
