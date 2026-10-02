import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  createHoverPreview,
  Dropdown,
  FilterChip,
  HoverPreview,
  IconButton,
  NoticeCard,
  Placeholder,
  PullToRefresh,
  ScrollArea,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Mailbox } from "../../contracts";
import {
  DEFAULT_MAIL_QUICK_SEARCH_FIELDS,
  MAIL_QUICK_SEARCH_FIELDS,
  MAIL_QUICK_SEARCH_FIELDS_PARAMETER,
  MAIL_SEARCH_PARAMETER,
  type MailQuickSearchField,
  parseMailQuickSearchFields,
  parseMailSearchState,
  resolveMailSearchRoute,
} from "../../search-state";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";
import type { MailListError, MailListMode } from "../../service/workspace";
import MailBulkActionBar from "./MailBulkActionBar";
import MailConversationQuickLook from "./MailConversationQuickLook";
import MailConversationRow from "./MailConversationRow";
import { openMailSearchBuilder } from "./MailSearchBuilder";
import { type MailActionId, spamActionForConversation } from "./mail-actions";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { mailboxHealthPresentation } from "./mail-health-presentation";
import { buildMailListHref, buildMailSelectionHref, type MailListItem, mailRouteUrl } from "./mail-navigation";
import { createMailQuickLookLoader } from "./mail-quick-look";
import { summarizeMailSearchExpression } from "./mail-search-builder-model";

const selectedQuickSearchFields = (url: URL): MailQuickSearchField[] => {
  const fields = parseMailQuickSearchFields(url);
  return fields.length > 0 ? fields : [...DEFAULT_MAIL_QUICK_SEARCH_FIELDS];
};

/** Width of the fixed quick look card, which opens 8px beside the list and keeps 8px to the frame edge. */
const QUICK_LOOK_WIDTH_REM = 22;
const QUICK_LOOK_GAP_PX = 8;
/** A resting mouse opens the card after this many milliseconds and starts its request after the shorter rest. */
const QUICK_LOOK_OPEN_DELAY = 200;
const QUICK_LOOK_PREFETCH_DELAY = 80;

const DEFAULT_QUICK_SEARCH_FIELD_SET = new Set<MailQuickSearchField>(DEFAULT_MAIL_QUICK_SEARCH_FIELDS);
const isDefaultQuickSearch = (fields: MailQuickSearchField[]): boolean =>
  fields.length === DEFAULT_MAIL_QUICK_SEARCH_FIELDS.length && fields.every((field) => DEFAULT_QUICK_SEARCH_FIELD_SET.has(field));

export default function MailConversationList(props: {
  mailbox: Mailbox;
  mailboxId: string;
  requestUrl: string;
  query: string;
  title: string;
  items: MailListItem[];
  error: MailListError | null;
  selectedConversationId: string | null;
  selectedMessageId: string | null;
  selectedConversationIds: ReadonlySet<string>;
  selectionMode: boolean;
  nextCursor: string | null;
  dateConfig: DateContext;
  canWrite: boolean;
  canAdmin: boolean;
  /** The folder in view, which decides the folder actions start from; `null` in views across folders. */
  viewFolderId: string | null;
  folders: MailFolderView[];
  localTags: LocalTag[];
  savedViews: SavedConversationView[];
  activeSavedViewId: string | null;
  listMode: MailListMode;
  loading: boolean;
  liveDegraded: boolean;
  onCollapse: () => void;
  onOpenHealth: () => void;
  onOpenDeliverySettings: () => void;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
  onNavigateItem: (href: string, item: MailListItem, activation: "keyboard" | "pointer") => void | Promise<void>;
  onToggleSelectionMode: () => void;
  onListModeChange: (mode: MailListMode) => void;
  onToggleSelection: (item: MailListItem, range: boolean) => void;
  onClearSelection: () => void;
  onAddTags: () => void | Promise<void>;
  onAssign: () => void | Promise<void>;
  onBulkAction: (actionId: MailActionId) => void | Promise<void>;
  onItemAction: (item: MailListItem, actionId: MailActionId) => void | Promise<void>;
  onManageTags: (item: MailListItem) => void | Promise<void>;
  onMergeItem: (item: MailListItem) => void | Promise<void>;
  onOpenHref: (href: string, replace?: boolean) => void | Promise<void>;
  onLoadMore: (href: string) => boolean | Promise<boolean>;
  onRefresh: () => Promise<void>;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  const quickSearchFieldOptions = createMemo(
    () =>
      [
        { value: "any", label: messages().everything, icon: "ti ti-search" },
        { value: "from", label: messages().sender, icon: "ti ti-user-up" },
        { value: "recipients", label: messages().recipients, icon: "ti ti-user-down" },
        { value: "subject", label: messages().subject, icon: "ti ti-letter-case" },
        { value: "body", label: messages().messageBody, icon: "ti ti-align-left" },
        { value: "attachment_name", label: messages().attachmentNames, icon: "ti ti-paperclip" },
      ] satisfies Array<{ value: MailQuickSearchField; label: string; icon: string }>,
  );
  const rowMessages = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const spamAction = (item: MailListItem) =>
    spamActionForConversation({ viewFolderId: props.viewFolderId, activeFolderIds: item.activeFolderIds, folders: props.folders });
  const requestUrl = () => mailRouteUrl(props.requestUrl);
  let listColumn: HTMLDivElement | undefined;
  const workspaceFrame = () => listColumn?.closest<HTMLElement>(".mail-workspace") ?? null;
  const conversationItem = (conversationId: string | undefined) =>
    conversationId
      ? props.items.find((item) => item.selectionKind === "conversation" && item.conversationId === conversationId)
      : undefined;
  // One quick look card for the list: it opens beside the list column for a
  // resting mouse or Space, never for the conversation already in the reader
  // or in selection mode, where a click selects instead of opening, and never
  // covers the list.
  const quickLook = createHoverPreview<string>({
    openDelay: QUICK_LOOK_OPEN_DELAY,
    placement: { beside: () => listColumn, within: workspaceFrame },
    disabled: (conversationId) => props.selectionMode || conversationId === props.selectedConversationId,
  });
  const quickLookData = createMailQuickLookLoader(() => props.mailboxId);
  // The request starts once the mouse rests on a row, before the card opens:
  // a sweep across rows or rows passing under a still pointer while the list
  // scrolls start none.
  let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelPrefetch = () => {
    clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  };
  onCleanup(cancelPrefetch);
  /** The same room rule as the card, so rows without room for it start no request. */
  const roomForQuickLook = () => {
    const list = listColumn?.getBoundingClientRect();
    if (!list) return false;
    const frameRight = Math.min(workspaceFrame()?.getBoundingClientRect().right ?? window.innerWidth, window.innerWidth);
    const width = QUICK_LOOK_WIDTH_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return frameRight - list.right >= width + 2 * QUICK_LOOK_GAP_PX;
  };
  createEffect(() => {
    const item = conversationItem(quickLook.active());
    if (item) quickLookData.load(item);
  });
  const quickLookLabel = () => {
    const item = conversationItem(quickLook.active());
    return item ? rowMessages().quickLookNamed({ subject: item.subject || rowMessages().noSubject }) : rowMessages().quickLook;
  };
  const openFromQuickLook = (item: MailListItem) => {
    quickLook.close();
    void props.onNavigateItem(buildMailSelectionHref(requestUrl(), item), item, "pointer");
  };
  const [searchValue, setSearchValue] = createSignal(props.query);
  const [searchFields, setSearchFields] = createSignal<MailQuickSearchField[]>(selectedQuickSearchFields(requestUrl()));
  const [loadMoreElement, setLoadMoreElement] = createSignal<HTMLDivElement>();
  const [failedLoadHref, setFailedLoadHref] = createSignal<string | null>(null);
  let listScrollElement: HTMLDivElement | undefined;
  let requestedLoadHref: string | null = null;
  const listHref = () => buildMailListHref(requestUrl());
  const parsedSearch = createMemo(() => parseMailSearchState(requestUrl()));
  const activeSavedView = createMemo(() => props.savedViews.find((view) => view.id === props.activeSavedViewId) ?? null);
  const currentSearchState = createMemo(() => {
    const parsed = parsedSearch().state;
    if (parsed) return parsed;
    const saved = activeSavedView()?.filter;
    if (saved) return saved;
    const resolved = resolveMailSearchRoute(requestUrl());
    return resolved.expression ? { expression: resolved.expression, sort: resolved.sort } : null;
  });
  const structuredSummary = createMemo(() => {
    const state = currentSearchState();
    return state ? summarizeMailSearchExpression(state.expression, locale(), { folders: props.folders, tags: props.localTags }) : null;
  });
  const healthPresentation = createMemo(() => mailboxHealthPresentation(props.mailbox, locale()));
  const searchActive = () => Boolean(props.query.trim() || requestUrl().searchParams.has(MAIL_SEARCH_PARAMETER) || props.activeSavedViewId);

  const applyQuickSearch = (query: string, fields: MailQuickSearchField[], replace: boolean) => {
    const currentUrl = requestUrl();
    const next = new URL(buildMailListHref(currentUrl, true), currentUrl.origin);
    const normalizedQuery = query.trim();
    if (normalizedQuery) {
      next.searchParams.set("q", normalizedQuery);
      if (!isDefaultQuickSearch(fields)) next.searchParams.set(MAIL_QUICK_SEARCH_FIELDS_PARAMETER, fields.join(","));
      next.searchParams.delete("savedView");
      next.searchParams.delete("view");
      next.searchParams.delete("folder");
      next.searchParams.delete("scheduled");
    }
    const href = `${next.pathname}${next.search}`;
    if (href === `${currentUrl.pathname}${currentUrl.search}`) return;
    void props.onOpenHref(href, replace);
  };

  const quickSearch = timed.debounce(
    (query: string, fields: MailQuickSearchField[], replace: boolean) => applyQuickSearch(query, fields, replace),
    300,
  );

  createEffect(() => {
    quickSearch.cancel();
    setSearchValue(props.query);
    setSearchFields(selectedQuickSearchFields(requestUrl()));
  });

  const replaceLiveSearchRoute = () => requestUrl().searchParams.has("q");

  const updateSearchValue = (next: string) => {
    setSearchValue(next);
    if (!next.trim()) {
      quickSearch.trigger("", searchFields(), replaceLiveSearchRoute());
      return;
    }
    quickSearch.debouncedFn(next, searchFields(), replaceLiveSearchRoute());
  };

  const submitSearch = (event: SubmitEvent) => {
    event.preventDefault();
    quickSearch.trigger(searchValue(), searchFields(), replaceLiveSearchRoute());
  };

  const updateSearchFields = (next: string[]) => {
    const allowed = new Set<string>(MAIL_QUICK_SEARCH_FIELDS);
    const selected = next.filter((field): field is MailQuickSearchField => allowed.has(field));
    const normalized = selected.length > 0 ? selected : [...DEFAULT_MAIL_QUICK_SEARCH_FIELDS];
    setSearchFields(normalized);
    if (searchValue().trim()) quickSearch.trigger(searchValue(), normalized, replaceLiveSearchRoute());
    else quickSearch.cancel();
  };
  const searchFieldsLabel = () =>
    quickSearchFieldOptions()
      .filter((option) => searchFields().includes(option.value))
      .map((option) => option.label)
      .join(", ");

  const openAdvancedSearch = async () => {
    const result = await openMailSearchBuilder({
      mailboxId: props.mailboxId,
      initialState: currentSearchState(),
      initialQuery: props.query,
      initialSavedView: activeSavedView(),
      canWrite: props.canWrite,
    });
    if (!result) return;
    const currentUrl = requestUrl();
    const next = new URL(buildMailListHref(currentUrl, true), currentUrl.origin);
    if (result.action === "apply") {
      next.searchParams.set(MAIL_SEARCH_PARAMETER, result.serialized);
      next.searchParams.delete("savedView");
      next.searchParams.delete("view");
      next.searchParams.delete("folder");
      next.searchParams.delete("scheduled");
    } else if (result.action === "saved") {
      next.searchParams.set("savedView", result.view.id);
      next.searchParams.delete("view");
      next.searchParams.delete("folder");
      next.searchParams.delete("scheduled");
    } else {
      next.searchParams.delete("savedView");
    }
    next.searchParams.delete("cursor");
    void props.onOpenHref(`${next.pathname}${next.search}`);
  };

  const nextHref = () => {
    if (!props.nextCursor) return null;
    const currentUrl = requestUrl();
    const next = new URL(buildMailListHref(currentUrl), currentUrl.origin);
    next.searchParams.set("cursor", props.nextCursor);
    return `${next.pathname}${next.search}`;
  };

  const loadNextPage = async (href: string) => {
    if (props.loading || requestedLoadHref === href) return;
    requestedLoadHref = href;
    setFailedLoadHref(null);
    const loaded = await props.onLoadMore(href);
    if (!loaded && nextHref() === href) setFailedLoadHref(href);
    if (nextHref() !== href) requestedLoadHref = null;
  };

  createEffect(() => {
    const element = loadMoreElement();
    const href = nextHref();
    if (!element || !href || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextPage(href);
      },
      { root: listScrollElement ?? null, rootMargin: "480px 0px" },
    );
    observer.observe(element);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={(element) => {
        listColumn = element;
        // Scroll events do not bubble; a capture listener sees the list's scroller.
        element.addEventListener("scroll", cancelPrefetch, true);
      }}
      class="flex h-full min-h-0 flex-col bg-[var(--ui-surface)]"
      data-mail-conversation-list
    >
      <header class="flex shrink-0 flex-col gap-2 p-3">
        <Show
          when={props.canWrite && props.selectionMode}
          fallback={
            <div class="flex min-w-0 items-center gap-2">
              <div class="min-w-0 flex-1">
                <h1 class="truncate text-base font-semibold text-primary">{props.title}</h1>
                <p class="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-dimmed">
                  <span class="shrink-0 whitespace-nowrap">{messages().shown({ count: props.items.length })}</span>
                  <Show when={props.loading}>
                    <i class="ti ti-loader-2 shrink-0 animate-spin" aria-hidden="true" />
                    <span class="sr-only">{messages().loadingView}</span>
                  </Show>
                  <Show when={props.liveDegraded}>
                    <span class="inline-flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap" title={messages().updatesPaused}>
                      <i class="ti ti-cloud-off shrink-0" aria-hidden="true" />
                      <span class="truncate">{messages().updatesPaused}</span>
                    </span>
                  </Show>
                </p>
              </div>
              <Show when={props.canWrite && props.listMode === "conversations"}>
                <Tooltip.Anchor content={messages().selectConversations}>
                  <IconButton
                    type="button"
                    label={messages().selectConversations}
                    aria-pressed="false"
                    onClick={props.onToggleSelectionMode}
                  >
                    <i class="ti ti-checkbox" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </Show>
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
                  label={messages().chooseListView}
                  tooltip={props.listMode === "conversations" ? messages().conversationView : messages().messageView}
                >
                  <i class="ti ti-layout-list" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
              <Tooltip.Anchor content={messages().searchFilters}>
                <IconButton
                  type="button"
                  class={structuredSummary() ? "text-[var(--app-accent)]" : undefined}
                  label={messages().searchFilters}
                  aria-pressed={Boolean(structuredSummary())}
                  onClick={openAdvancedSearch}
                >
                  <i class="ti ti-adjustments-search" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Show when={props.selectedConversationId || props.selectedMessageId}>
                <Tooltip.Anchor content={messages().hideList}>
                  <IconButton type="button" class="hidden lg:inline-flex" label={messages().hideList} onClick={props.onCollapse}>
                    <i class="ti ti-layout-sidebar-left-collapse" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </Show>
            </div>
          }
        >
          <MailBulkActionBar
            selectedCount={props.selectedConversationIds.size}
            selectedInJunk={
              props.selectedConversationIds.size > 0 &&
              props.items
                .filter((item) => item.conversationId && props.selectedConversationIds.has(item.conversationId))
                .every((item) => spamAction(item) === "not_spam")
            }
            busy={props.loading}
            onClear={props.onClearSelection}
            onAddTags={props.onAddTags}
            onAssign={props.onAssign}
            onAction={props.onBulkAction}
          />
        </Show>
        <form class="flex min-w-0 items-center gap-2" role="search" onSubmit={submitSearch}>
          <div class="min-w-0 flex-1">
            <TextInput
              type="search"
              name="q"
              aria-label={messages().searchMailboxName({ name: props.mailbox.name })}
              placeholder={messages().searchMailbox}
              icon="ti ti-search"
              activeIcon="ti ti-search"
              value={searchValue}
              onValueChange={updateSearchValue}
              clearable
              onClear={() => {
                setSearchValue("");
                quickSearch.trigger("", searchFields(), replaceLiveSearchRoute());
              }}
              maxLength={500}
            />
          </div>
          <FilterChip
            label={messages().searchInValue({ value: searchFieldsLabel() })}
            icon="ti ti-filter-search"
            options={[{ label: messages().searchIn, options: quickSearchFieldOptions(), multiple: true }]}
            value={searchFields()}
            defaultValue={[...DEFAULT_MAIL_QUICK_SEARCH_FIELDS]}
            isActive={!isDefaultQuickSearch(searchFields())}
            onValueChange={updateSearchFields}
            position="bottom-right"
            iconOnly
          />
        </form>
        <Show when={structuredSummary()}>
          {(summary) => (
            <button
              type="button"
              class="mail-search-summary"
              aria-label={`${messages().editStructuredSearch}: ${summary()}`}
              title={summary()}
              onClick={openAdvancedSearch}
            >
              <i class="ti ti-filter-check" aria-hidden="true" />
              <span class="mail-search-summary__text">{summary()}</span>
            </button>
          )}
        </Show>
        <Show when={healthPresentation()}>
          {(health) => (
            <NoticeCard tone={health().tone} icon={false} role="status" data-mailbox-health={props.mailbox.health}>
              <div class="flex min-w-0 items-start gap-2">
                <i
                  class={`ti ${health().tone === "warning" ? "ti-alert-triangle" : "ti-info-circle"} mt-0.5 shrink-0`}
                  aria-hidden="true"
                />
                <div class="min-w-0">
                  <p>
                    <strong class="font-semibold text-primary">{health().title}.</strong> {health().message}
                  </p>
                  <Show when={props.canAdmin && health().action && health().actionLabel}>
                    <Button
                      type="button"
                      variant="subtle"
                      size="xs"
                      class="mt-2"
                      aria-label={health().actionLabel ?? undefined}
                      title={health().actionLabel ?? undefined}
                      onClick={() => (health().action === "delivery" ? props.onOpenDeliverySettings() : props.onOpenHealth())}
                    >
                      <i class="ti ti-activity" aria-hidden="true" />
                      <span>{health().action === "health" ? messages().status : health().actionLabel}</span>
                    </Button>
                  </Show>
                </div>
              </div>
            </NoticeCard>
          )}
        </Show>
      </header>

      <PullToRefresh class="flex-1" onRefresh={props.onRefresh} disabled={props.loading} label={messages().refreshingList}>
        <ScrollArea
          ref={(element) => {
            listScrollElement = element;
          }}
          class="flex-1 px-2 pb-2"
          scrollPreserveKey={`mail-list-${props.mailboxId}`}
        >
          {props.error ? (
            <Placeholder
              state="error"
              variant="panel"
              title={messages().couldNotLoad}
              description={
                props.error === "invalid_search"
                  ? messages().invalidSearch
                  : props.error === "search_failed"
                    ? messages().searchFailed
                    : messages().loadFailed
              }
              action={
                <ButtonLink
                  href={props.error === "invalid_search" ? buildMailListHref(requestUrl(), true) : listHref()}
                  variant="secondary"
                  size="sm"
                  navigation="enhanced"
                  onNavigate={props.onNavigate}
                  scroll="preserve"
                >
                  {props.error === "invalid_search" ? messages().clearSearch : messages().retry}
                </ButtonLink>
              }
            />
          ) : props.items.length === 0 ? (
            <Placeholder
              icon={searchActive() ? "ti ti-search" : "ti ti-mail-off"}
              variant="panel"
              title={
                searchActive()
                  ? messages().noMatchingMessages
                  : props.listMode === "conversations"
                    ? messages().noConversations
                    : messages().noMessages
              }
              description={searchActive() ? messages().changeFilters : messages().newMailAppears}
              action={
                searchActive() ? (
                  <ButtonLink
                    href={buildMailListHref(requestUrl(), true)}
                    variant="secondary"
                    size="sm"
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    scroll="preserve"
                  >
                    {messages().clearSearch}
                  </ButtonLink>
                ) : undefined
              }
            />
          ) : (
            <div
              class="flex flex-col gap-0.5"
              role="list"
              aria-label={
                props.listMode === "conversations"
                  ? messages().conversationListLabel({ title: props.title })
                  : messages().messageListLabel({ title: props.title })
              }
            >
              <For each={props.items}>
                {(item) => (
                  <MailConversationRow
                    item={item}
                    requestUrl={requestUrl()}
                    state={{
                      selectedConversationId: props.selectedConversationId,
                      selectedMessageId: props.selectedMessageId,
                      selectedConversationIds: props.selectedConversationIds,
                      selectionMode: props.selectionMode,
                      canWrite: props.canWrite,
                      spamAction: spamAction(item),
                      dateConfig: props.dateConfig,
                    }}
                    actions={{
                      navigate: props.onNavigateItem,
                      toggleSelection: props.onToggleSelection,
                      itemAction: props.onItemAction,
                      manageTags: props.onManageTags,
                      merge: props.onMergeItem,
                    }}
                    quickLook={{
                      id: quickLook.id,
                      anchor: quickLook.anchor,
                      active: quickLook.active,
                      // Every mouse move restarts the rest, so the card usually opens with its data.
                      prefetch: (item) => {
                        cancelPrefetch();
                        if (props.selectionMode || item.conversationId === props.selectedConversationId) return;
                        prefetchTimer = setTimeout(() => {
                          prefetchTimer = undefined;
                          if (roomForQuickLook()) quickLookData.load(item);
                        }, QUICK_LOOK_PREFETCH_DELAY);
                      },
                      release: (item) => {
                        cancelPrefetch();
                        if (quickLook.active() !== item.conversationId) quickLookData.cancel(item);
                      },
                    }}
                  />
                )}
              </For>
            </div>
          )}
          <Show when={nextHref()}>
            {(href) => (
              <div ref={(element) => setLoadMoreElement(element)} class="flex min-h-14 items-center justify-center py-3">
                <ButtonLink
                  variant="secondary"
                  size="sm"
                  href={href()}
                  aria-disabled={props.loading}
                  onClick={(event) => {
                    event.preventDefault();
                    if (props.loading) return;
                    requestedLoadHref = null;
                    void loadNextPage(href());
                  }}
                >
                  <i
                    class={
                      props.loading ? "ti ti-loader-2 animate-spin" : failedLoadHref() === href() ? "ti ti-refresh" : "ti ti-chevron-down"
                    }
                    aria-hidden="true"
                  />
                  {props.loading
                    ? messages().loadingConversations
                    : failedLoadHref() === href()
                      ? messages().retryLoading
                      : messages().moreConversations}
                </ButtonLink>
              </div>
            )}
          </Show>
        </ScrollArea>
      </PullToRefresh>
      <HoverPreview preview={quickLook} label={quickLookLabel()} size="fixed" class="mail-quick-look-card">
        {(conversationId) => (
          <Show when={conversationItem(conversationId)}>
            {(item) => (
              <MailConversationQuickLook
                item={item()}
                state={quickLookData.state(item())}
                dateConfig={props.dateConfig}
                onOpen={() => openFromQuickLook(item())}
              />
            )}
          </Show>
        )}
      </HoverPreview>
    </div>
  );
}
