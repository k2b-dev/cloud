import type { DateContext } from "@k2b/stdlib";
import {
  ActivityList,
  Button,
  FilterChip,
  FilterToggle,
  Placeholder,
  ScrollArea,
  useLocale,
  VirtualFeed,
  type VirtualFeedController,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import { apiClient } from "../../api/client";
import { isMailActivityKind, MAIL_ACTIVITY_KINDS, type MailActivityKind } from "../../mail-activity-kinds";
import {
  EMPTY_MAIL_EVENTS_FILTER,
  type MailEventsFilter,
  mailEventsFiltered,
  mailEventsHref,
  mailEventsQuery,
} from "../../mail-events-route";
import type { LocalTag } from "../../service/local-tags";
import type { MailEventsPage } from "../../service/workspace";
import { readApiError } from "./api-response";
import { mailEventsMessages } from "./mail-events-messages";
import { type MailEventPages, mergeMailEventPages, type PresentedMailEvent, presentMailEvents } from "./mail-events-presentation";

const PAGE_SIZE = "50";
/** Row heights in px: the avatar row, and one with a detail line below it. Day headings come on top. */
const EVENT_ESTIMATE = 44;
const EVENT_WITH_DETAIL_ESTIMATE = 64;

const cloudAvatarSource = (userId: string | null, avatarHash: string | null): string | undefined =>
  userId && avatarHash ? `/api/accounts/users/${encodeURIComponent(userId)}/avatar?rev=${encodeURIComponent(avatarHash)}` : undefined;

const sameFilter = (left: MailEventsFilter, right: MailEventsFilter) =>
  left.kind === right.kind && left.actorId === right.actorId && left.mine === right.mine;

export type MailEventsFeedState = ReturnType<typeof createMailEventsFeed>;

/**
 * The feed's pages for one mailbox: the server's first page, and older pages loaded below it. It lives with the
 * mailbox, not with the feed's place on screen, so opening a conversation beside the feed keeps what was loaded.
 */
export function createMailEventsFeed(input: { mailboxId: string; page: () => MailEventsPage | null; failedMessage: () => string }) {
  // The workspace store updates its snapshot in place, so the feed follows a copy of the page, read in full: a new
  // first page or filter then always reaches it, and later store writes cannot change what it shows.
  const snapshot = createMemo(
    () => {
      const page = input.page();
      // Serializing reads every field through the store, so any change of the page reruns this.
      return page ? { key: JSON.stringify(page), page: structuredClone(unwrap(page)) } : null;
    },
    undefined,
    { equals: (left, right) => left?.key === right?.key },
  );
  const copy = (value: ReturnType<typeof snapshot>): MailEventsPage | null => value?.page ?? null;
  const initial = copy(untrack(snapshot));
  const [pages, setPages] = createSignal<MailEventPages | null>(initial ? { items: initial.items, nextCursor: initial.nextCursor } : null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadMoreError, setLoadMoreError] = createSignal<string | null>(null);
  let loadedFilter = initial?.filter ?? EMPTY_MAIL_EVENTS_FILTER;
  let loadGeneration = 0;
  // Opening a conversation moves the feed beside the reader; the new place continues at the event the person was at.
  let topKey: string | null = null;
  createEffect(
    on(
      snapshot,
      (value) => {
        const page = copy(value);
        loadGeneration += 1;
        setLoadingMore(false);
        setLoadMoreError(null);
        if (!page) return setPages(null);
        const first = { items: page.items, nextCursor: page.nextCursor };
        const sameList = sameFilter(loadedFilter, page.filter);
        // "Concerns me" follows who is assigned now, so an older loaded page may no longer match; it starts over.
        setPages((shown) => (sameList && !page.filter.mine ? mergeMailEventPages(shown, first) : first));
        if (!sameList) topKey = null;
        loadedFilter = page.filter;
      },
      { defer: true },
    ),
  );
  const loadOlder = async () => {
    const cursor = pages()?.nextCursor;
    if (!cursor || loadingMore()) return;
    const generation = loadGeneration;
    const filter = loadedFilter;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const response = await apiClient.mailboxes[":mailboxId"].activity.$get({
        param: { mailboxId: input.mailboxId },
        query: { ...mailEventsQuery(filter), cursor, limit: PAGE_SIZE },
      });
      if (!response.ok) throw new Error(await readApiError(response, input.failedMessage()));
      const next = await response.json();
      if (generation !== loadGeneration) return;
      // A failed or late page keeps everything already shown.
      setPages((shown) => ({ items: [...(shown?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
    } catch (error) {
      if (generation === loadGeneration) setLoadMoreError(error instanceof Error ? error.message : input.failedMessage());
    } finally {
      if (generation === loadGeneration) setLoadingMore(false);
    }
  };
  return {
    pages,
    loadingMore,
    loadMoreError,
    loadOlder,
    topKey: () => topKey,
    keepTopKey: (value: string | null) => {
      topKey = value;
    },
  };
}

/**
 * The mailbox's event feed for the Events tab: who assigned, sent, drafted, completed, commented, and what automations
 * did, newest first and grouped by day. The server filters and pages; a click opens the conversation beside the feed.
 */
export function MailEventsFeed(props: {
  mailboxId: string;
  /** The current workspace route, which filter and event links change only where they must. */
  requestPath: string;
  feed: MailEventsFeedState;
  /** The first page the server rendered for `filter`; null while it could not load. */
  page: MailEventsPage | null;
  filter: MailEventsFilter;
  error: string | null;
  loading: boolean;
  selectedConversationId: string | null;
  currentUserId: string;
  dateConfig: DateContext;
  /** The server's clock for the first render; one feed clock then updates all visible rows. */
  now?: string;
  localTags: readonly LocalTag[];
  onOpenHref: (href: string) => void;
  onOpenConversation: (href: string, conversationId: string, subject: string) => void;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const [now, setNow] = createSignal(props.now ? new Date(props.now) : new Date());
  onMount(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    onCleanup(() => clearInterval(timer));
  });
  const t = createMemo(() => mailEventsMessages.resolve([locale()]).t);
  const pages = () => props.feed.pages();
  const loadingMore = () => props.feed.loadingMore();
  const loadMoreError = () => props.feed.loadMoreError();
  /** Loads the next older page; a failure reaches the list's end, which offers "Try again". */
  const loadOlder = async () => {
    await props.feed.loadOlder();
    const failure = loadMoreError();
    if (failure) throw new Error(`${t().loadMoreFailed} ${failure}`);
  };
  // The feed opens at the event the person was at when it moved; its first rows render on the server.
  const continueAt = props.feed.topKey();
  const resume = (controller: VirtualFeedController) => {
    if (!continueAt) return;
    controller.scrollToKey(continueAt, { align: "start" });
    // A pane that opens with the reader gets its height in the next frame.
    requestAnimationFrame(() => controller.scrollToKey(continueAt, { align: "start" }));
  };

  // A refresh presents every row again; an unchanged row keeps its object, so `For` keeps its element and the feed
  // keeps its scroll position and focus.
  let shownRows = new Map<string, { key: string; row: PresentedMailEvent }>();
  const rows = createMemo(() => {
    const next = new Map<string, { key: string; row: PresentedMailEvent }>();
    const presented = presentMailEvents(pages()?.items ?? [], {
      locale: locale(),
      currentUserId: props.currentUserId,
      dateConfig: props.dateConfig,
      now: now(),
      tagName: (id) => props.localTags.find((tag) => tag.id === id)?.name,
    }).map((row) => {
      const key = JSON.stringify(row);
      const shown = shownRows.get(row.event.id);
      const kept = shown?.key === key ? shown.row : row;
      next.set(row.event.id, { key, row: kept });
      return kept;
    });
    shownRows = next;
    return presented;
  });

  // Neighbouring rows of the selected conversation join into one surface: the shared edge loses its corners. A day
  // heading between them keeps them apart.
  const selectedJoins = createMemo(() => {
    const joins = new Map<string, "above" | "below" | "both">();
    const list = rows();
    const selected = (row: PresentedMailEvent | undefined) =>
      row !== undefined && row.event.conversationId !== null && row.event.conversationId === props.selectedConversationId;
    list.forEach((row, index) => {
      if (!selected(row)) return;
      const previous = list[index - 1];
      const next = list[index + 1];
      const above = selected(previous) && previous!.day === row.day;
      const below = selected(next) && next!.day === row.day;
      if (above || below) joins.set(row.event.id, above && below ? "both" : above ? "above" : "below");
    });
    return joins;
  });

  const filterHref = (filter: MailEventsFilter) => mailEventsHref(props.requestPath, { filter });
  const eventHref = (conversationId: string) => mailEventsHref(props.requestPath, { conversationId });
  const setFilter = (change: Partial<MailEventsFilter>) => props.onOpenHref(filterHref({ ...props.filter, ...change }));
  const kindLabel = (kind: MailActivityKind) =>
    ({
      assignment: t().kindAssignment,
      sent: t().kindSent,
      draft: t().kindDraft,
      status: t().kindStatus,
      comment: t().kindComment,
      automation: t().kindAutomation,
    })[kind];
  const people = () => props.page?.people ?? [];
  // The chosen person keeps a name in the chip even when this page lists no event of theirs.
  const personOptions = () => {
    const options = people().map((person) => ({
      value: person.id,
      label: person.id === props.currentUserId ? `${person.displayName} (${t().you})` : person.displayName,
      icon: person.type === "service_account" ? "ti ti-robot" : "ti ti-user",
    }));
    const actorId = props.filter.actorId;
    if (!actorId || options.some((option) => option.value === actorId)) return options;
    const label = pages()?.items.find((item) => item.actor.id === actorId)?.actor.displayName ?? t().person;
    return [...options, { value: actorId, label, icon: "ti ti-user" }];
  };

  const open = (event: MouseEvent, row: PresentedMailEvent) => {
    const conversationId = row.event.conversationId;
    if (!conversationId || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    props.onOpenConversation(eventHref(conversationId), conversationId, row.subject ?? "");
  };

  const activityRow = (row: PresentedMailEvent) => (
    <ActivityList.Row
      class="mail-events__row"
      dateConfig={props.dateConfig}
      now={now()}
      selected={row.event.conversationId !== null && row.event.conversationId === props.selectedConversationId}
      onNavigate={(event) => open(event, row)}
      entry={{
        at: row.event.createdAt,
        actor: row.actorLabel,
        avatar: {
          name: row.actorLabel,
          kind:
            row.automated || row.event.actor.kind === "service_account"
              ? "service"
              : row.event.actor.kind === "user"
                ? row.event.actor.id
                  ? "person"
                  : "deleted"
                : "system",
          src: row.event.actor.kind === "user" ? cloudAvatarSource(row.event.actor.id, row.event.actor.avatarHash) : undefined,
        },
        icon: row.icon,
        tone: row.tone === "error" ? "danger" : row.tone === "warning" ? "warning" : "neutral",
        text: (
          <>
            {row.before}
            <Show when={row.subject}>{(subject) => <span>{subject()}</span>}</Show>
            {row.after}
            <Show when={row.count > 1}> · {t().times({ count: row.count })}</Show>
          </>
        ),
        detail: row.detail,
        href: row.event.conversationId ? eventHref(row.event.conversationId) : undefined,
      }}
    />
  );

  return (
    <section class="mail-events" aria-label={t().feedLabel} aria-busy={props.loading || loadingMore()} data-mail-events>
      <ScrollArea orientation="horizontal" class="mail-events__filters" data-mail-events-filters>
        <FilterChip
          label={props.filter.kind ? t().kindValue({ kind: kindLabel(props.filter.kind) }) : t().kind}
          icon="ti ti-filter"
          isActive={props.filter.kind !== null}
          options={[{ options: MAIL_ACTIVITY_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) })) }]}
          value={props.filter.kind ? [props.filter.kind] : []}
          onValueChange={(value) => {
            const kind = value.at(-1);
            setFilter({ kind: isMailActivityKind(kind) ? kind : null });
          }}
        />
        <FilterChip
          label={t().person}
          icon="ti ti-user"
          class="mail-events__person"
          showValue
          search={{ label: t().findPerson }}
          options={[{ options: personOptions() }]}
          value={props.filter.actorId ? [props.filter.actorId] : []}
          onValueChange={(value) => setFilter({ actorId: value.at(-1) ?? null })}
        />
        <FilterToggle
          label={t().concernsMe}
          icon="ti ti-at"
          active={props.filter.mine}
          href={filterHref({ ...props.filter, mine: !props.filter.mine })}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            setFilter({ mine: !props.filter.mine });
          }}
        />
        <Show when={mailEventsFiltered(props.filter)}>
          <Button type="button" size="sm" variant="ghost" onClick={() => props.onOpenHref(filterHref(EMPTY_MAIL_EVENTS_FILTER))}>
            {t().reset}
          </Button>
        </Show>
      </ScrollArea>
      <Show
        when={!props.loading && pages() && rows().length > 0}
        fallback={
          <ScrollArea class="mail-events__scroll">
            <Show
              when={!props.loading}
              fallback={
                <div class="mail-events__skeleton">
                  <ActivityList.Loading label={t().loading} />
                </div>
              }
            >
              <Show
                when={pages()}
                fallback={
                  <Placeholder state="error" title={t().loadFailed} description={props.error ?? undefined} onRetry={props.onRetry} />
                }
              >
                <Show
                  when={mailEventsFiltered(props.filter)}
                  fallback={<Placeholder icon="ti ti-history" title={t().emptyTitle} description={t().emptyText} />}
                >
                  <Placeholder
                    state="no-results"
                    icon="ti ti-filter-off"
                    title={t().filteredEmptyTitle}
                    action={
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => props.onOpenHref(filterHref(EMPTY_MAIL_EVENTS_FILTER))}
                      >
                        {t().resetFilter}
                      </Button>
                    }
                  />
                </Show>
              </Show>
            </Show>
          </ScrollArea>
        }
      >
        {/* Newest first: the list opens at the top, keeps its place when new events arrive there, keeps each day's
            heading in view, and loads older days at its end. */}
        <VirtualFeed
          anchor="start"
          class="mail-events__feed"
          items={rows()}
          getKey={(row) => row.event.id}
          estimateSize={(row) => (row.detail ? EVENT_WITH_DETAIL_ESTIMATE : EVENT_ESTIMATE)}
          label={t().feedLabel}
          separator={(row, previous) => (previous?.day === row.day ? undefined : row.day)}
          stickySeparators
          hasMore={Boolean(pages()?.nextCursor)}
          onLoadMore={loadOlder}
          onVisibleChange={(visible) => props.feed.keepTopKey(visible?.first.event.id ?? null)}
          controller={resume}
        >
          {(row) => (
            <div data-mail-event={row.event.id} data-tone={row.tone} data-selected-join={selectedJoins().get(row.event.id)}>
              {activityRow(row)}
            </div>
          )}
        </VirtualFeed>
      </Show>
    </section>
  );
}
