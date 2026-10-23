import { Dropdown, FilterChip, FilterToggle, useLocale, ViewTabs } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { MailSearchState } from "../../contracts";
import type { ResolvedMailSearchRoute } from "../../search-url";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { MailListMode } from "../../service/workspace";
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
import { summarizeMailSearchExpression } from "./mail-search-builder-model";
import { mailSidebarMessages } from "./mail-sidebar-messages";
import { openViewTabsInPlace } from "./mail-view-tabs";

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
  // A direct child of the head's views slot, so the shared head rules size and scroll the strip.
  return <ViewTabs label={messages().mailboxViews} items={props.items} current={props.current} />;
}

type MailboxFilterContext = {
  requestUrl: string;
  search: ResolvedMailSearchRoute;
  folders: MailFolderView[];
  /** The effective folder from the canonical workspace response, after route precedence. */
  folderId: string | null;
  localTags: LocalTag[];
  onOpenHref: (href: string) => void;
};

const createMailboxFilterContext = (props: MailboxFilterContext) => {
  const url = () => mailRouteUrl(props.requestUrl);
  const quick = createMemo(() => readMailHeadFilters(url(), props.search, props.folderId));
  const folder = () => props.folders.find((folder) => folder.id === quick()?.folderId);
  const knownQuick = () => {
    const value = quick();
    if (folder()?.role === "sent" && (value?.unread || value?.flagged)) return null;
    return value && (!value.folderId || folder()) && (!value.tagId || props.localTags.some((tag) => tag.id === value.tagId)) ? value : null;
  };
  return { url, folder, knownQuick };
};

/** Folder quick filters share the existing search expression. Arbitrary trees remain searches. */
export function MailboxHeadFilters(
  props: MailboxFilterContext & {
    onEditSearch: (state: MailSearchState, source: URL) => void;
  },
) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const { url, folder, knownQuick } = createMailboxFilterContext(props);
  const searchSummary = () => {
    const expression = props.search.expression;
    if (!expression || knownQuick()) return null;
    return summarizeMailSearchExpression(expression, locale(), { folders: props.folders, tags: props.localTags });
  };
  const update = (change: Partial<MailHeadFilters>) => {
    const current = knownQuick();
    if (current) props.onOpenHref(mailHeadFilterHref(url(), { ...current, ...change }, current));
  };
  const dateLabel = () => {
    const days = mailHeadFilterDayCount(knownQuick()?.dates ?? []);
    return days === 7 ? messages().lastSevenDays : days === 30 ? messages().lastThirtyDays : messages().dateRange;
  };
  return (
    <>
      <Show when={folder() && knownQuick()}>
        <Show when={props.folderId !== folder()?.id}>
          <span class="shrink-0 text-sm text-primary" data-mail-filter-folder>
            {messages().inFolder({ name: folder()!.name })}
          </span>
        </Show>
        <Show when={folder()?.role !== "sent"}>
          <FilterToggle
            label={
              <>
                {messages().unread}
                <span class="ml-1 text-muted">{folder()?.unread?.toLocaleString(locale())}</span>
              </>
            }
            icon="ti ti-point"
            active={knownQuick()?.unread ?? false}
            onClick={() => update({ unread: !knownQuick()?.unread })}
          />
          <FilterToggle
            label={messages().flagged}
            icon="ti ti-flag"
            active={knownQuick()?.flagged ?? false}
            onClick={() => update({ flagged: !knownQuick()?.flagged })}
          />
        </Show>
        <FilterToggle
          label={messages().withAttachment}
          icon="ti ti-paperclip"
          active={knownQuick()?.attachment ?? false}
          onClick={() => update({ attachment: !knownQuick()?.attachment })}
        />
        <Dropdown.Root
          position="bottom-left"
          label={messages().dateRange}
          items={[
            ...([7, 30] as const).map((days) => ({
              label: days === 7 ? messages().lastSevenDays : messages().lastThirtyDays,
              icon: "ti ti-calendar",
              choice: "radio" as const,
              checked: mailHeadFilterDayCount(knownQuick()?.dates ?? []) === days,
              action: () => update({ dates: mailHeadFilterDays(days, Date.now()) }),
            })),
            {
              label: messages().customDateRange,
              icon: "ti ti-calendar-event",
              action: () => {
                const current = knownQuick();
                if (!current) return;
                const state = mailHeadFilterState({
                  ...current,
                  dates: current.dates.length ? current.dates : mailHeadFilterDays(7, Date.now()),
                });
                if (state) props.onEditSearch(state, mailHeadFilterSource(url(), current));
              },
            },
            ...(knownQuick()?.dates.length
              ? [{ label: messages().clearDateRange, icon: "ti ti-x", action: () => update({ dates: [] }) }]
              : []),
          ]}
        >
          <Dropdown.Trigger
            appearance="plain"
            class="k2b-filter-chip"
            data-active={knownQuick()?.dates.length ? "true" : undefined}
            label={dateLabel()}
          >
            <i class="ti ti-calendar" aria-hidden="true" />
            <span class="k2b-filter-chip__label">{dateLabel()}</span>
            <i class="ti ti-chevron-down k2b-filter-chip__chevron" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
      <Show when={searchSummary()}>
        {(summary) => (
          <FilterChip
            label={messages().search}
            icon="ti ti-filter-check"
            showValue
            options={[{ options: [{ value: "search", label: summary() }] }]}
            value={["search"]}
            onValueChange={() => props.onOpenHref(buildMailSearchClearHref(url()))}
          />
        )}
      </Show>
    </>
  );
}

/** The tag filter belongs beside Search and selection, while its value stays in the canonical query. */
export function MailboxTagFilter(props: MailboxFilterContext) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const { url, knownQuick } = createMailboxFilterContext(props);
  const activeTag = () => props.localTags.find((tag) => tag.id === knownQuick()?.tagId);
  return (
    <Show when={props.localTags.length > 0}>
      <FilterChip
        label={activeTag() ? messages().tagValue({ name: activeTag()!.name }) : messages().tag}
        icon="ti ti-tag"
        iconOnly
        variant={activeTag() ? "subtle" : "ghost"}
        class="mail-head-tag"
        options={[{ options: props.localTags.map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })) }]}
        value={activeTag() ? [activeTag()!.id] : []}
        onValueChange={(value) => {
          const current = knownQuick() ?? emptyMailHeadFilters(props.folderId);
          props.onOpenHref(mailHeadFilterHref(url(), { ...current, tagId: value.at(-1) ?? null }, knownQuick()));
        }}
      />
    </Show>
  );
}

/** Conversations or messages, at the end of the head row. */
export function MailListModeMenu(props: { listMode: MailListMode; onListModeChange: (mode: MailListMode) => void }) {
  const locale = useLocale();
  const messages = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  return (
    <Dropdown.Root
      position="bottom-right"
      width="14rem"
      items={[
        {
          label: messages().conversationView,
          icon: props.listMode === "conversations" ? "ti ti-check" : "ti ti-messages",
          action: () => props.onListModeChange("conversations"),
        },
        {
          label: messages().messageView,
          icon: props.listMode === "messages" ? "ti ti-check" : "ti ti-mail",
          action: () => props.onListModeChange("messages"),
        },
      ]}
    >
      <Dropdown.Trigger
        iconOnly
        type="button"
        variant="ghost"
        size="sm"
        label={messages().chooseListView}
        tooltip={props.listMode === "conversations" ? messages().conversationView : messages().messageView}
      >
        <i class="ti ti-layout-list" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
