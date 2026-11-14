import { Dropdown, type DropdownItem, MovedHint, useLocale, ViewTabs } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { MailSearchState } from "../../contracts";
import { mailFolderNames } from "../../folder-names";
import { DEFAULT_MAIL_QUICK_SEARCH_FIELDS, type ResolvedMailSearchRoute } from "../../search-url";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import {
  emptyMailHeadFilters,
  type MailHeadFilters,
  mailHeadFilterDayCount,
  mailHeadFilterDays,
  mailHeadFilterHref,
  mailHeadFilterSource,
  mailHeadFilterState,
  readMailHeadFilters,
} from "./mail-head-filters";
import { buildMailSearchClearHref, mailRouteUrl } from "./mail-navigation";
import { mailSidebarMessages } from "./mail-sidebar-messages";
import { openViewTabsInPlace } from "./mail-view-tabs";
import { type createMailboxSearch, isDefaultQuickSearch } from "./mailbox-search";

/** The mailbox's head tabs. A plain click opens the view in place, as the sidebar's places do. */
export function MailboxViewTabs(props: {
  items: Parameters<typeof ViewTabs>[0]["items"];
  current: string;
  onOpenHref: (href: string) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  openViewTabsInPlace(
    () => props.items,
    (href) => props.onOpenHref(href),
  );
  // A direct child of the head's views slot, so the shared head rules size and scroll the strip. Every view may stand
  // in the strip: how many do follows the head's room, and the rest wait under More.
  return <ViewTabs label={messages().mailboxViews} items={props.items} current={props.current} max={props.items.length} fit />;
}

/** Everything the filter button changes lives in the URL, so old links, reload, and Back keep working. */
type MailSearchFilterProps = {
  requestUrl: string;
  search: ResolvedMailSearchRoute;
  folders: MailFolderView[];
  /** The effective folder from the canonical workspace response, after route precedence. */
  folderId: string | null;
  localTags: LocalTag[];
  /** The mailbox's search: while it runs, "Search in" and the place join the menu. */
  quickSearch: Pick<
    ReturnType<typeof createMailboxSearch>,
    | "searchValue"
    | "searchFields"
    | "quickSearchFieldOptions"
    | "updateSearchFields"
    | "scopeFolderId"
    | "originFolder"
    | "updateScope"
    | "structuredSummary"
    | "openAdvancedSearch"
    | "searchBuilderLoading"
  >;
  onOpenHref: (href: string) => void;
  onEditSearch: (state: MailSearchState, source: URL) => void;
  /** The one-time note that the filters moved here from the head's chips. */
  hint: { open: boolean; onDismiss: () => void };
};

/**
 * F9: one filter button at the search field holds what the head's chips did: Unread, Flagged, With attachment, the
 * date range and a tag, and while searching "Search in" and the place. A count on the button and Reset beside it show
 * an active filter. Arbitrary search trees stay in the search builder under "More filters".
 */
export function MailSearchFilter(props: MailSearchFilterProps) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const listText = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  const workspaceText = createMemo(() => mailWorkspaceMessages.resolve([locale()]).t);
  const folderName = createMemo(() => mailFolderNames(locale()));
  const url = () => mailRouteUrl(props.requestUrl);
  const quick = createMemo(() => readMailHeadFilters(url(), props.search, props.folderId));
  const folder = () => props.folders.find((candidate) => candidate.id === quick()?.folderId);
  const knownQuick = () => {
    const value = quick();
    if (folder()?.role === "sent" && (value?.unread || value?.flagged)) return null;
    return value && (!value.folderId || folder()) && (!value.tagId || props.localTags.some((tag) => tag.id === value.tagId)) ? value : null;
  };
  /** Unread, Flagged, With attachment and the date range need the folder they filter in. */
  const folderFilters = () => Boolean(folder() && knownQuick());
  const update = (change: Partial<MailHeadFilters>) => {
    const current = knownQuick();
    if (current) props.onOpenHref(mailHeadFilterHref(url(), { ...current, ...change }, current));
  };
  const setTag = (tagId: string | null) => {
    const current = knownQuick() ?? emptyMailHeadFilters(props.folderId);
    props.onOpenHref(mailHeadFilterHref(url(), { ...current, tagId }, knownQuick()));
  };
  const dayCount = () => mailHeadFilterDayCount(knownQuick()?.dates ?? []);
  const searching = () => Boolean(props.quickSearch.searchValue().trim());
  /** A search tree the chips cannot show; a running text search is the field's own, not a filter. */
  const structured = () => (knownQuick() || searching() ? null : props.quickSearch.structuredSummary());
  const placeLabel = (folderId: string) => {
    const match = props.folders.find((candidate) => candidate.id === folderId);
    return listText().onlyFolder({ name: match ? folderName()(match) : folderId });
  };
  const placeOptions = () => {
    const scope = props.quickSearch.scopeFolderId();
    const origin = props.quickSearch.originFolder();
    return [
      { value: "", label: listText().wholeMailbox },
      ...(scope && scope !== origin?.id ? [{ value: scope, label: placeLabel(scope) }] : []),
      ...(origin ? [{ value: origin.id, label: placeLabel(origin.id) }] : []),
    ];
  };
  /** How many filters narrow the list: each chip of old, a changed "Search in" or place, and a search tree. */
  const activeCount = () => {
    const value = knownQuick();
    const quickCount = value
      ? [value.unread, value.flagged, value.attachment, value.dates.length > 0, Boolean(value.tagId)].filter(Boolean).length
      : 0;
    const searchCount = searching()
      ? [!isDefaultQuickSearch(props.quickSearch.searchFields()), Boolean(props.quickSearch.scopeFolderId())].filter(Boolean).length
      : 0;
    return quickCount + searchCount + (structured() ? 1 : 0);
  };
  const items = (): DropdownItem[] => {
    const value = knownQuick();
    const sections: DropdownItem[] = [];
    if (folderFilters() && value) {
      sections.push({
        // A direct link may filter another folder than the one the route shows; the section names it then.
        sectionLabel: props.folderId !== folder()?.id ? messages().inFolder({ name: folderName()(folder()!) }) : listText().showOnly,
        items: [
          ...(folder()?.role === "sent"
            ? []
            : [
                {
                  choice: "checkbox" as const,
                  label: messages().unread,
                  icon: "ti ti-point",
                  trailing: folder()?.unread ? <span class="tabular-nums">{folder()!.unread!.toLocaleString(locale())}</span> : undefined,
                  checked: value.unread,
                  closeOnSelect: false,
                  action: () => update({ unread: !value.unread }),
                },
                {
                  choice: "checkbox" as const,
                  label: messages().flagged,
                  icon: "ti ti-flag",
                  checked: value.flagged,
                  closeOnSelect: false,
                  action: () => update({ flagged: !value.flagged }),
                },
              ]),
          {
            choice: "checkbox" as const,
            label: messages().withAttachment,
            icon: "ti ti-paperclip",
            checked: value.attachment,
            closeOnSelect: false,
            action: () => update({ attachment: !value.attachment }),
          },
        ],
      });
      sections.push({
        sectionLabel: messages().dateRange,
        items: [
          ...([7, 30] as const).map((days) => ({
            choice: "radio" as const,
            label: days === 7 ? messages().lastSevenDays : messages().lastThirtyDays,
            icon: "ti ti-calendar",
            checked: dayCount() === days,
            action: () => update({ dates: mailHeadFilterDays(days, Date.now()) }),
          })),
          {
            label: messages().customDateRange,
            icon: "ti ti-calendar-event",
            action: () => {
              const state = mailHeadFilterState({ ...value, dates: value.dates.length ? value.dates : mailHeadFilterDays(7, Date.now()) });
              if (state) props.onEditSearch(state, mailHeadFilterSource(url(), value));
            },
          },
          ...(value.dates.length ? [{ label: messages().clearDateRange, icon: "ti ti-x", action: () => update({ dates: [] }) }] : []),
        ],
      });
    }
    if (props.localTags.length > 0 && !searching()) {
      const tagId = value?.tagId ?? null;
      sections.push({
        sectionLabel: messages().tag,
        items: props.localTags.map((tag) => ({
          choice: "radio" as const,
          label: tag.name,
          color: tag.color,
          checked: tagId === tag.id,
          action: () => setTag(tagId === tag.id ? null : tag.id),
        })),
      });
    }
    if (searching()) {
      sections.push({
        sectionLabel: listText().searchIn,
        items: props.quickSearch.quickSearchFieldOptions().map((option) => ({
          choice: "checkbox" as const,
          label: option.label,
          icon: option.icon,
          checked: () => props.quickSearch.searchFields().some((field) => field === option.value),
          closeOnSelect: false,
          action: () => {
            const fields: string[] = [...props.quickSearch.searchFields()];
            props.quickSearch.updateSearchFields(
              fields.includes(option.value) ? fields.filter((field) => field !== option.value) : [...fields, option.value],
            );
          },
        })),
      });
      sections.push({
        sectionLabel: listText().place,
        items: placeOptions().map((option) => ({
          choice: "radio" as const,
          label: option.label,
          checked: () => (props.quickSearch.scopeFolderId() ?? "") === option.value,
          closeOnSelect: false,
          action: () => props.quickSearch.updateScope(option.value || null),
        })),
      });
    }
    sections.push({
      items: [
        {
          label: listText().moreFiltersEllipsis,
          icon: "ti ti-adjustments-search",
          description: structured() ?? undefined,
          action: () => void props.quickSearch.openAdvancedSearch(),
        },
        ...(activeCount() > 0 ? [{ label: listText().resetFilters, icon: "ti ti-filter-off", action: reset }] : []),
      ],
    });
    return sections;
  };
  /** Reset clears what narrows the list: while searching the search options, otherwise the filters in the URL. */
  const reset = () => {
    if (searching()) {
      props.quickSearch.updateSearchFields([...DEFAULT_MAIL_QUICK_SEARCH_FIELDS]);
      props.quickSearch.updateScope(null);
      return;
    }
    props.onOpenHref(buildMailSearchClearHref(url()));
  };
  let trigger: HTMLElement | undefined;
  const label = () => (activeCount() > 0 ? listText().filtersActive({ count: activeCount() }) : listText().filters);
  return (
    <span class="mail-search-filter" ref={(element) => (trigger = element)} data-mail-search-filter>
      <Dropdown.Root position="bottom-right" width="18rem" items={items()} label={listText().filters} phone="sheet">
        <Dropdown.Trigger
          iconOnly
          type="button"
          variant="ghost"
          label={label()}
          tooltip={label()}
          data-active={activeCount() > 0 ? "true" : undefined}
          // The search builder loads on first use; the button says so and keeps its place and focus meanwhile.
          aria-busy={props.quickSearch.searchBuilderLoading() ? "true" : undefined}
          data-mail-filter-button
        >
          <i
            class={props.quickSearch.searchBuilderLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-adjustments-horizontal"}
            aria-hidden="true"
          />
          <span class="mail-search-filter-count" aria-hidden="true">
            {activeCount() > 0 ? activeCount() : ""}
          </span>
        </Dropdown.Trigger>
      </Dropdown.Root>
      <MovedHint
        open={props.hint.open}
        onDismiss={props.hint.onDismiss}
        target={() => trigger?.querySelector<HTMLElement>("[data-mail-filter-button]") ?? undefined}
        action={{
          label: workspaceText().showFilters,
          onClick: () => queueMicrotask(() => trigger?.querySelector<HTMLElement>("[data-mail-filter-button]")?.click()),
        }}
      >
        {workspaceText().filtersHint}
      </MovedHint>
    </span>
  );
}
