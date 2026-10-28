import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  ButtonLink,
  createHoverPreview,
  HoverPreview,
  IconButton,
  NoticeCard,
  Placeholder,
  ProgressRing,
  PullToRefresh,
  ScrollArea,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Mailbox } from "../../contracts";
import type { ResolvedMailSearchRoute } from "../../search-url";
import type { LocalTag } from "../../service/local-tags";
import type { MailFolderView } from "../../service/messages";
import type { SavedConversationView } from "../../service/saved-views";
import type { MailListError, MailListMode } from "../../service/workspace";
import MailConversationQuickLook from "./MailConversationQuickLook";
import MailConversationRow from "./MailConversationRow";
import { type MailActionId, spamActionForConversation } from "./mail-actions";
import { mailConversationListMessages } from "./mail-conversation-list-messages";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { mailboxHealthPresentation } from "./mail-health-presentation";
import { mailListRowKey } from "./mail-list-projection";
import { buildMailListHref, buildMailSearchClearHref, buildMailSelectionHref, type MailListItem, mailRouteUrl } from "./mail-navigation";
import { createMailQuickLookLoader, mailQuickLookKey } from "./mail-quick-look";
import { type MailDayGroup, mailDayGroupStarts } from "./mail-view-mode";

/** Width of the fixed quick look card, which opens 8px beside the list and keeps 8px to the frame edge. */
const QUICK_LOOK_WIDTH_REM = 22;
const QUICK_LOOK_GAP_PX = 8;
/** A resting mouse opens the card after this many milliseconds and starts its request after the shorter rest. */
const QUICK_LOOK_OPEN_DELAY = 200;
const QUICK_LOOK_PREFETCH_DELAY = 80;

export default function MailConversationList(props: {
  mailbox: Mailbox;
  mailboxId: string;
  requestUrl: string;
  query: string;
  search: ResolvedMailSearchRoute;
  title: string;
  /** Where the list is already named, or null when its heading must stay visible. */
  namedBy: "tabs" | "sidebar" | null;
  items: MailListItem[];
  leavingKeys?: ReadonlySet<string>;
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
  /** A folder set to "Only in the folder" whose mail this view leaves out, until this person dismisses the hint. */
  folderOnlyHint?: { folder: MailFolderView; dismiss: () => void } | null;
  listMode: MailListMode;
  loading: boolean;
  liveDegraded: boolean;
  onCollapse: () => void;
  onOpenHealth: () => void;
  onOpenDeliverySettings: () => void;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
  onNavigateItem: (href: string, item: MailListItem, activation: "keyboard" | "pointer") => void | Promise<void>;
  onToggleSelectionMode: () => void;
  onToggleSelection: (item: MailListItem, range: boolean) => void;
  onClearSelection: () => void;
  onAddTags?: () => void | Promise<void>;
  /** Absent for a person who sees only assigned conversations. */
  onAssign?: () => void | Promise<void>;
  onBulkAction: (actionId: MailActionId) => void | Promise<void>;
  onItemAction: (item: MailListItem, actionId: MailActionId) => void | Promise<void>;
  onManageTags: (item: MailListItem) => void | Promise<void>;
  onMergeItem?: (item: MailListItem) => void | Promise<void>;
  onOpenHref: (href: string, replace?: boolean) => void | Promise<void>;
  /** A new search intent can supersede a pending mailbox switch before its debounce fires. */
  onNavigationStart?: () => void;
  searchDiscoveryHint?: () => void;
  onLoadMore: (href: string) => boolean | Promise<boolean>;
  onRefresh: () => Promise<void>;
  /** The columns view (F2): a header and one line per conversation. Absent for today's rows. */
  columns?: { shared: boolean; assigneeNames: (userIds: readonly string[]) => string[] };
  /** Conversations done today and how many still need action; drives the done line and "All done." */
  doneToday?: { done: number; automated: number; open: number; logHref: string } | null;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailConversationListMessages.resolve([locale()]).t);
  const rowMessages = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const spamAction = (item: MailListItem) =>
    spamActionForConversation({ viewFolderId: props.viewFolderId, activeFolderIds: item.activeFolderIds, folders: props.folders });
  const requestUrl = () => mailRouteUrl(props.requestUrl);
  let listColumn: HTMLDivElement | undefined;
  let listHeading: HTMLHeadingElement | undefined;
  // Dismissing the last hint removes the focused close button with it, so focus moves to the list's heading instead
  // of falling out of the page. Another hint takes its place and keeps the focus on its close button.
  const dismissFolderOnlyHint = (hint: { dismiss: () => void }) => {
    hint.dismiss();
    if (!props.folderOnlyHint && listHeading?.isConnected) listHeading.focus();
  };
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
  // Prefetch and opening are one attempt for this pointer stay. A fast syncing
  // answer (or error) must not start another request when the card opens or the
  // pointer moves. A new stay, explicit keyboard opening, or item version may retry.
  let hoverAttempt: string | null = null;
  let activeAttempt: string | null = null;
  const attemptKey = (item: MailListItem) => `${props.mailboxId}:${mailQuickLookKey(item)}`;
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
    const key = item ? attemptKey(item) : null;
    if (key === activeAttempt) return;
    activeAttempt = key;
    if (item && key !== hoverAttempt) {
      hoverAttempt = key;
      quickLookData.load(item);
    }
  });
  const quickLookLabel = () => {
    const item = conversationItem(quickLook.active());
    return item ? rowMessages().quickLookNamed({ subject: item.subject || rowMessages().noSubject }) : rowMessages().quickLook;
  };
  const openFromQuickLook = (item: MailListItem) => {
    quickLook.close();
    void props.onNavigateItem(buildMailSelectionHref(requestUrl(), item), item, "pointer");
  };
  const [loadMoreElement, setLoadMoreElement] = createSignal<HTMLDivElement>();
  const [failedLoadHref, setFailedLoadHref] = createSignal<string | null>(null);
  let listScrollElement: HTMLDivElement | undefined;
  let requestedLoadHref: string | null = null;
  const listHref = () => buildMailListHref(requestUrl());
  const searchActive = () => Boolean(props.query.trim() || requestUrl().searchParams.has("search") || props.activeSavedViewId);
  // Day headings follow the person's calendar; a search may sort by relevance, so it shows none.
  /** An empty list after a day with completed work: "All done." takes the placeholder's place. */
  const allDone = () => props.items.length === 0 && !searchActive() && (props.doneToday?.done ?? 0) > 0;
  const dayStarts = createMemo(() =>
    searchActive()
      ? new Map<number, MailDayGroup>()
      : mailDayGroupStarts(
          props.items,
          new Date(),
          props.dateConfig.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          props.dateConfig.firstDayOfWeek ?? props.dateConfig.weekStartsOn ?? 1,
        ),
  );
  const dayLabel = (group: MailDayGroup) =>
    group === "today"
      ? messages().dayToday
      : group === "yesterday"
        ? messages().dayYesterday
        : group === "week"
          ? messages().dayWeek
          : messages().dayEarlier;
  const healthPresentation = createMemo(() => mailboxHealthPresentation(props.mailbox, locale()));

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
      <h1 data-mail-list-heading ref={listHeading} tabIndex={-1} class="sr-only">
        {props.title}
      </h1>
      <Show when={props.loading}>
        <span class="sr-only" role="status">
          {messages().loadingView}
        </span>
      </Show>
      <Show when={healthPresentation() || props.folderOnlyHint || props.searchDiscoveryHint}>
        <header class="flex shrink-0 flex-col gap-2 p-3">
          <Show when={props.searchDiscoveryHint}>
            {(dismiss) => (
              <div class="flex items-center gap-2 text-xs text-muted" data-mail-search-hint>
                <span class="min-w-0 flex-1">{messages().searchMoved}</span>
                <IconButton
                  type="button"
                  size="xs"
                  label={messages().dismissHint}
                  onClick={() => {
                    dismiss()();
                    listHeading?.focus({ preventScroll: true });
                  }}
                >
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              </div>
            )}
          </Show>
          <Show when={healthPresentation()}>
            {(health) => (
              <NoticeCard
                tone={health().tone}
                role="status"
                data-mailbox-health={props.mailbox.health}
                title={health().title}
                detail={health().message}
              >
                <Show when={props.canAdmin && health().action && health().actionLabel}>
                  <Button
                    type="button"
                    variant="subtle"
                    size="xs"
                    aria-label={health().actionLabel ?? undefined}
                    title={health().actionLabel ?? undefined}
                    onClick={() => (health().action === "delivery" ? props.onOpenDeliverySettings() : props.onOpenHealth())}
                  >
                    <i class="ti ti-activity" aria-hidden="true" />
                    <span>{health().action === "health" ? messages().status : health().actionLabel}</span>
                  </Button>
                </Show>
              </NoticeCard>
            )}
          </Show>
          <Show when={props.folderOnlyHint}>
            {(hint) => (
              <NoticeCard tone="neutral" data-mail-folder-only-hint>
                <div class="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
                  {/* 13rem keeps the semibold folder action beside the text in a desktop list column. */}
                  <p class="min-w-0 flex-[1_1_13rem]">
                    <strong class="font-semibold text-primary">{messages().folderOnlyHintTitle({ name: hint().folder.name })}</strong>{" "}
                    {messages().folderOnlyHintDetail}
                  </p>
                  <div class="flex shrink-0 items-center gap-1">
                    <Show when={hint().folder.selectable}>
                      <ButtonLink
                        href={`/app/mail/${props.mailboxId}?folder=${hint().folder.id}`}
                        variant="ghost"
                        size="xs"
                        navigation="enhanced"
                        onNavigate={props.onNavigate}
                        scroll="preserve"
                      >
                        {messages().openFolder({ name: hint().folder.name })}
                      </ButtonLink>
                    </Show>
                    <Tooltip.Anchor content={messages().dismissHint}>
                      <IconButton type="button" size="xs" label={messages().dismissHint} onClick={() => dismissFolderOnlyHint(hint())}>
                        <i class="ti ti-x" aria-hidden="true" />
                      </IconButton>
                    </Tooltip.Anchor>
                  </div>
                </div>
              </NoticeCard>
            )}
          </Show>
        </header>
      </Show>

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
                  href={props.error === "invalid_search" ? buildMailSearchClearHref(requestUrl()) : listHref()}
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
          ) : allDone() && props.doneToday ? (
            <div class="mail-all-done" data-mail-all-done>
              <span class="mail-all-done-mark" aria-hidden="true">
                <i class="ti ti-check" />
              </span>
              <h2>{messages().allDoneTitle}</h2>
              <p>{messages().allDoneText({ done: props.doneToday.done, automated: props.doneToday.automated })}</p>
              <ButtonLink href={props.doneToday.logHref} variant="secondary" size="sm">
                <i class="ti ti-history" aria-hidden="true" /> {messages().allDoneLog}
              </ButtonLink>
            </div>
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
              description={
                searchActive()
                  ? messages().changeFilters
                  : props.mailbox.accessScope === "assigned"
                    ? messages().appearsOnceAssigned
                    : messages().newMailAppears
              }
              action={
                searchActive() ? (
                  <ButtonLink
                    href={buildMailSearchClearHref(requestUrl())}
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
            <>
              <Show when={!searchActive() && props.doneToday && props.doneToday.done > 0 ? props.doneToday : null}>
                {(done) => (
                  <p class="mail-done-line" data-mail-done-line>
                    <ProgressRing
                      value={(done().done / Math.max(1, done().done + done().open)) * 100}
                      tone="accent"
                      label={messages().doneRing({ done: done().done, total: done().done + done().open })}
                    />
                    <b>{messages().doneToday({ count: done().done })}</b>
                    <Show when={done().automated > 0}>
                      <span>· {messages().doneAutomated({ count: done().automated })}</span>
                    </Show>
                  </p>
                )}
              </Show>
              <Show when={props.columns}>
                {(columns) => (
                  <div class="mail-columns-head" classList={{ "mail-columns-personal": !columns().shared }} aria-hidden="true">
                    <span />
                    <span class="mail-columns-head-cells">
                      <span>{messages().columnFrom}</span>
                      <span>{messages().columnSubject}</span>
                      <Show when={columns().shared}>
                        <span>{messages().columnAssignees}</span>
                        <span>{messages().columnStatus}</span>
                      </Show>
                      <span class="text-right">{messages().columnTime}</span>
                    </span>
                  </div>
                )}
              </Show>
              <div
                class="flex flex-col gap-0.5"
                classList={{ "mail-columns": Boolean(props.columns), "mail-columns-personal": props.columns?.shared === false }}
                style={{ opacity: props.loading ? 0.5 : undefined }}
                role="list"
                aria-label={
                  props.listMode === "conversations"
                    ? messages().conversationListLabel({ title: props.title })
                    : messages().messageListLabel({ title: props.title })
                }
              >
                <For each={props.items}>
                  {(item, index) => (
                    <>
                      <Show when={dayStarts().get(index())}>
                        {(group) => (
                          <div role="listitem" class="mail-day-group" data-mail-day-group={group()}>
                            <h3>{dayLabel(group())}</h3>
                          </div>
                        )}
                      </Show>
                      <MailConversationRow
                        item={item}
                        columns={
                          props.columns
                            ? { assignees: props.columns.shared ? props.columns.assigneeNames(item.assigneeUserIds) : null }
                            : undefined
                        }
                        leaving={props.leavingKeys?.has(mailListRowKey(item))}
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
                          begin: () => {
                            cancelPrefetch();
                            hoverAttempt = null;
                          },
                          // Every mouse move restarts the rest, so the card usually opens with its data.
                          prefetch: (item, row, pointer) => {
                            cancelPrefetch();
                            if (props.selectionMode || item.conversationId === props.selectedConversationId) return;
                            prefetchTimer = setTimeout(() => {
                              prefetchTimer = undefined;
                              // The list may have moved another row under the still mouse before its scroll event.
                              const hit = document.elementFromPoint(pointer.clientX, pointer.clientY);
                              if (!hit || !row.contains(hit) || !roomForQuickLook()) return;
                              const key = attemptKey(item);
                              if (key === hoverAttempt) return;
                              hoverAttempt = key;
                              quickLookData.load(item);
                            }, QUICK_LOOK_PREFETCH_DELAY);
                          },
                          release: (item) => {
                            cancelPrefetch();
                            if (quickLook.active() !== item.conversationId) {
                              if (hoverAttempt === attemptKey(item)) hoverAttempt = null;
                              quickLookData.cancel(item);
                            }
                          },
                        }}
                      />
                    </>
                  )}
                </For>
              </div>
            </>
          )}
          <Show when={!allDone()}>
            <p class="px-2 py-3 text-xs text-muted" data-mail-list-count>
              {messages().shown({ count: props.items.length })}
            </p>
          </Show>
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
