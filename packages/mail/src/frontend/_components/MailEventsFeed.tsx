import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Button, Dropdown, FilterChip, FilterToggle, Placeholder, ScrollArea, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onMount, Show, untrack } from "solid-js";
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
const SKELETON_ROWS = 8;

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
  // Opening a conversation moves the feed beside the reader; the new place continues where the person was.
  let scrollTop = 0;
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
        if (!sameList) scrollTop = 0;
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
    scrollTop: () => scrollTop,
    keepScrollTop: (value: number) => {
      scrollTop = value;
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
  localTags: readonly LocalTag[];
  onOpenHref: (href: string) => void;
  onOpenConversation: (href: string, conversationId: string, subject: string) => void;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailEventsMessages.resolve([locale()]).t);
  const pages = () => props.feed.pages();
  const loadingMore = () => props.feed.loadingMore();
  const loadMoreError = () => props.feed.loadMoreError();
  const loadOlder = () => props.feed.loadOlder();
  let scroller: HTMLDivElement | undefined;
  onMount(() => {
    const top = props.feed.scrollTop();
    if (!scroller || top <= 0) return;
    scroller.scrollTop = top;
    // A pane that opens with the reader gets its height in the next frame.
    requestAnimationFrame(() => {
      if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    });
  });

  // A refresh presents every row again; an unchanged row keeps its object, so `For` keeps its element and the feed
  // keeps its scroll position and focus.
  let shownRows = new Map<string, { key: string; row: PresentedMailEvent }>();
  const rows = createMemo(() => {
    const next = new Map<string, { key: string; row: PresentedMailEvent }>();
    const presented = presentMailEvents(pages()?.items ?? [], {
      locale: locale(),
      currentUserId: props.currentUserId,
      dateConfig: props.dateConfig,
      now: new Date(),
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
  const actorName = () => {
    const actorId = props.filter.actorId;
    if (!actorId) return null;
    return (
      people().find((person) => person.id === actorId)?.displayName ??
      pages()?.items.find((item) => item.actor.id === actorId)?.actor.displayName ??
      t().person
    );
  };

  const open = (event: MouseEvent, row: PresentedMailEvent) => {
    const conversationId = row.event.conversationId;
    if (!conversationId || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    props.onOpenConversation(eventHref(conversationId), conversationId, row.subject ?? "");
  };

  const rowContent = (row: PresentedMailEvent) => (
    <>
      <Show
        when={row.automated}
        fallback={
          <Avatar
            name={row.actorLabel}
            src={row.event.actor.kind === "user" ? cloudAvatarSource(row.event.actor.id, row.event.actor.avatarHash) : undefined}
            icon={row.event.actor.kind === "system" ? "ti ti-mail" : undefined}
            size="sm"
          />
        }
      >
        <span class="mail-event__robot" aria-hidden="true">
          <i class="ti ti-robot" />
        </span>
      </Show>
      <span class="mail-event__text">
        <span class="mail-event__line">
          <span class="mail-event__icon" data-tone={row.tone} aria-hidden="true">
            <i class={row.icon} />
          </span>
          <b class="mail-event__actor">{row.actorLabel}</b> {row.before}
          <Show when={row.subject}>{(subject) => <span class="mail-event__subject">{subject()}</span>}</Show>
          {row.after}
          <Show when={row.count > 1}>
            <span class="mail-event__count"> · {t().times({ count: row.count })}</span>
          </Show>
        </span>
        <Show when={row.detail}>{(detail) => <span class="mail-event__detail">{detail()}</span>}</Show>
      </span>
      <time class="mail-event__time" dateTime={row.event.createdAt} title={dates.formatDateTime(row.event.createdAt, props.dateConfig)}>
        {row.time}
      </time>
    </>
  );

  return (
    <section class="mail-events" aria-label={t().feedLabel} aria-busy={props.loading || loadingMore()} data-mail-events>
      <div class="mail-events__filters" data-mail-events-filters>
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
        <Dropdown.Root
          position="bottom-left"
          width="18rem"
          label={t().person}
          search={{ label: t().findPerson }}
          items={[
            {
              label: t().anyPerson,
              icon: "ti ti-users",
              choice: "radio" as const,
              checked: props.filter.actorId === null,
              action: () => setFilter({ actorId: null }),
            },
            ...people().map((person) => ({
              label: person.id === props.currentUserId ? `${person.displayName} (${t().you})` : person.displayName,
              icon: person.type === "service_account" ? "ti ti-robot" : "ti ti-user",
              choice: "radio" as const,
              checked: props.filter.actorId === person.id,
              action: () => setFilter({ actorId: person.id }),
            })),
          ]}
        >
          <Dropdown.Trigger
            appearance="plain"
            class="k2b-filter-chip"
            data-active={props.filter.actorId ? "true" : undefined}
            label={actorName() ? t().personValue({ name: actorName()! }) : t().person}
            data-mail-events-person
          >
            <i class="ti ti-user" aria-hidden="true" />
            <span class="k2b-filter-chip__label">{actorName() ? t().personValue({ name: actorName()! }) : t().person}</span>
            <i class="ti ti-chevron-down k2b-filter-chip__chevron" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
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
      </div>
      <ScrollArea
        class="mail-events__scroll"
        ref={(element: HTMLDivElement) => {
          scroller = element;
        }}
        onScroll={(event) => props.feed.keepScrollTop(event.currentTarget.scrollTop)}
      >
        <Show
          when={!props.loading}
          fallback={
            <div class="mail-events__skeleton" role="status" aria-live="polite">
              <span class="sr-only">{t().loading}</span>
              <For each={Array.from({ length: SKELETON_ROWS }, (_, index) => index)}>
                {(index) => (
                  <div class="mail-event mail-event--skeleton">
                    <Skeleton class="mail-event__skeleton-avatar" />
                    <Skeleton class={`mail-event__skeleton-line mail-event__skeleton-line--${index % 3}`} />
                    <Skeleton class="mail-event__skeleton-time" />
                  </div>
                )}
              </For>
            </div>
          }
        >
          <Show
            when={pages()}
            fallback={<Placeholder state="error" title={t().loadFailed} description={props.error ?? undefined} onRetry={props.onRetry} />}
          >
            <Show
              when={rows().length > 0}
              fallback={
                mailEventsFiltered(props.filter) ? (
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
                ) : (
                  <Placeholder icon="ti ti-history" title={t().emptyTitle} description={t().emptyText} />
                )
              }
            >
              <ol class="mail-events__list" data-mail-events-list>
                <For each={rows()}>
                  {(row, index) => (
                    <>
                      <Show when={index() === 0 || rows()[index() - 1]!.day !== row.day}>
                        <li class="mail-day-group" aria-hidden="true">
                          <span class="k2b-list-group-heading">{row.day}</span>
                        </li>
                      </Show>
                      <li data-mail-event={row.event.id} data-tone={row.tone}>
                        <Show when={row.event.conversationId} fallback={<div class="mail-event">{rowContent(row)}</div>}>
                          {(conversationId) => (
                            <a
                              class="mail-event mail-event--link"
                              href={eventHref(conversationId())}
                              aria-current={conversationId() === props.selectedConversationId ? "true" : undefined}
                              title={t().openConversation({ subject: row.subject ?? "" })}
                              onClick={(event) => open(event, row)}
                            >
                              {rowContent(row)}
                            </a>
                          )}
                        </Show>
                      </li>
                    </>
                  )}
                </For>
              </ol>
              <div class="mail-events__more">
                <Show when={loadMoreError()}>
                  {(message) => (
                    <Placeholder
                      variant="inline"
                      state="error"
                      title={t().loadMoreFailed}
                      description={message()}
                      onRetry={() => void loadOlder()}
                    />
                  )}
                </Show>
                <Show when={pages()?.nextCursor && !loadMoreError()}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={loadingMore()}
                    onClick={() => void loadOlder()}
                    data-mail-events-more
                  >
                    <i class="ti ti-chevron-down" aria-hidden="true" />
                    {loadingMore() ? t().loadingOlder : t().loadOlder}
                  </Button>
                </Show>
              </div>
            </Show>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
