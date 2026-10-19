import { Dropdown, FilterChip, useLocale, ViewTabs } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { mailTagSearch, type ResolvedMailSearchRoute } from "../../search-url";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { MailListMode } from "../../service/workspace";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { buildMailSearchClearHref, buildMailSearchHref, mailRouteUrl } from "./mail-navigation";
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

/**
 * Filters of the open list as chips: a tag, and a structured search while one applies. Both are mailbox-wide
 * searches, so clearing one returns to the place the search started from.
 */
export function MailboxHeadFilters(props: {
  requestUrl: string;
  search: ResolvedMailSearchRoute;
  folders: MailFolderView[];
  localTags: LocalTag[];
  onOpenHref: (href: string) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const url = () => mailRouteUrl(props.requestUrl);
  /** The searched tag, while the Tag chip can name it; a deleted tag stays a Search chip with its summary. */
  const activeTagId = () => {
    const expression = props.search.expression;
    return expression?.type === "local_tag_id" && props.localTags.some((tag) => tag.id === expression.tagId) ? expression.tagId : null;
  };
  const searchSummary = () => {
    const expression = props.search.expression;
    if (!expression || activeTagId()) return null;
    return summarizeMailSearchExpression(expression, locale(), { folders: props.folders, tags: props.localTags });
  };
  const chooseTag = (value: string[]) => {
    const tagId = value.at(-1);
    const search = tagId ? mailTagSearch(tagId) : null;
    props.onOpenHref(search?.ok ? buildMailSearchHref(url(), { search: search.value }) : buildMailSearchClearHref(url()));
  };
  return (
    <>
      <Show when={props.localTags.length > 0}>
        <FilterChip
          label={messages().tag}
          icon="ti ti-tag"
          showValue
          options={[{ options: props.localTags.map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })) }]}
          value={activeTagId() ? [activeTagId()!] : []}
          onValueChange={chooseTag}
        />
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
