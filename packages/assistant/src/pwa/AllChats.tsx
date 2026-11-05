import type { AiConversation, AiConversationPage, AiOpenQuestion } from "@k2b/cloud/ai";
import { Link, type LinkNavigateEvent } from "@k2b/ssr/nav";
import { Button, Placeholder, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { assistantApi } from "../api/client";
import { calendarDaysBefore } from "../frontend/chat-sidebar-model";
import { pwaMessages } from "./messages";
import { archiveHref } from "./paths";
import { ChatRows, SkeletonRows } from "./rows";

/** Chats per page, as the web's list of all chats. */
export const ALL_CHATS_PAGE = 20;
/** Typing settles this long before a search runs. */
const SEARCH_DELAY_MS = 250;

/**
 * What the server read for the address: the first page and how many chats the archive holds. `undefined` when the
 * list opened in place and loads now; `null` when the read failed.
 */
export type AllChatsSnapshot = { query: string; page?: AiConversationPage | null; archived?: number | null };

type Section = { key: string; title: string; chats: AiConversation[] };

/**
 * Every chat of the person, newest first and pinned ones on top, or the archive. Older chats load while scrolling.
 * The search field keeps the query in the address; offline the list stays readable and the reserved line under the
 * field says why searching waits.
 */
export function AllChats(props: {
  archived: boolean;
  initial: AllChatsSnapshot;
  questions: readonly AiOpenQuestion[];
  selected: string | null;
  now: string;
  timeZone: string;
  online: boolean;
  onOpen: (chat: AiConversation, event: LinkNavigateEvent) => void;
  onQueryChange: (query: string) => void;
  onArchive: (event: LinkNavigateEvent) => void;
  /** Bumped by the part when chats change, such as through live updates or an archived chat. */
  revision: number;
}) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;
  const [query, setQuery] = createSignal(props.initial.query);
  const [searched, setSearched] = createSignal(props.initial.query);
  const [chats, setChats] = createSignal<AiConversation[]>(props.initial.page?.items ?? []);
  const [hasNext, setHasNext] = createSignal(props.initial.page?.hasNext ?? false);
  const [total, setTotal] = createSignal(props.initial.page?.total ?? 0);
  const [state, setState] = createSignal<"ready" | "loading" | "failed">(
    props.initial.page ? "ready" : props.initial.page === undefined ? "loading" : "failed",
  );
  const [archivedCount, setArchivedCount] = createSignal(props.initial.archived ?? null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  let pageNumber = 1;
  let request: AbortController | undefined;

  const load = async (search: string, quiet = false) => {
    request?.abort();
    const current = new AbortController();
    request = current;
    if (!quiet) setState("loading");
    try {
      const page = await assistantApi.listConversationsPage({
        q: search || undefined,
        page: 1,
        perPage: ALL_CHATS_PAGE,
        archived: props.archived,
        signal: current.signal,
      });
      if (current.signal.aborted) return;
      pageNumber = 1;
      setSearched(search);
      setChats(page.items);
      setHasNext(page.hasNext);
      setTotal(page.total);
      setState("ready");
    } catch {
      if (!current.signal.aborted && !quiet) setState("failed");
    }
  };
  const loadMore = async () => {
    if (!hasNext() || loadingMore() || state() !== "ready" || !navigator.onLine) return;
    setLoadingMore(true);
    try {
      const page = await assistantApi.listConversationsPage({
        q: searched() || undefined,
        page: pageNumber + 1,
        perPage: ALL_CHATS_PAGE,
        archived: props.archived,
      });
      pageNumber += 1;
      const known = new Set(chats().map((chat) => chat.id));
      setChats((current) => [...current, ...page.items.filter((chat) => !known.has(chat.id))]);
      setHasNext(page.hasNext);
    } catch {
      // The line at the end stays; scrolling there again tries once more.
    } finally {
      setLoadingMore(false);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const type = (value: string) => {
    setQuery(value);
    clearTimeout(timer);
    timer = setTimeout(() => {
      props.onQueryChange(value.trim());
      void load(value.trim());
    }, SEARCH_DELAY_MS);
  };
  onCleanup(() => {
    clearTimeout(timer);
    request?.abort();
  });
  createEffect(
    on(
      () => props.revision,
      () => void load(searched(), true),
      { defer: true },
    ),
  );
  onMount(() => {
    if (props.initial.page !== undefined) return;
    void load(searched());
    if (!props.archived)
      void assistantApi
        .listConversationsPage({ page: 1, perPage: 1, archived: true })
        .then((page) => setArchivedCount(page.total))
        .catch(() => undefined);
  });

  // The end of the list loads the next page when it comes into view.
  let end: HTMLParagraphElement | undefined;
  createEffect(() => {
    if (!end || !hasNext() || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void loadMore();
    });
    observer.observe(end);
    onCleanup(() => observer.disconnect());
  });

  const sections = createMemo((): Section[] => {
    if (searched()) return [{ key: "results", title: t().results({ count: total() }), chats: chats() }];
    const pinned = chats().filter((chat) => chat.pinnedAt && !props.archived);
    const rest = chats().filter((chat) => !chat.pinnedAt || props.archived);
    const groups = new Map<string, Section>();
    for (const chat of rest) {
      const recent = calendarDaysBefore(chat.lastUsedAt, props.now, props.timeZone) < 7;
      const date = new Date(chat.lastUsedAt);
      const sameYear =
        new Intl.DateTimeFormat("en", { timeZone: props.timeZone, year: "numeric" }).format(date) ===
        new Intl.DateTimeFormat("en", { timeZone: props.timeZone, year: "numeric" }).format(new Date(props.now));
      const key = recent
        ? "week"
        : new Intl.DateTimeFormat("en", { timeZone: props.timeZone, year: "numeric", month: "2-digit" }).format(date);
      const title = recent
        ? t().thisWeek
        : new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, month: "long", ...(sameYear ? {} : { year: "numeric" }) }).format(
            date,
          );
      const section = groups.get(key) ?? { key, title, chats: [] };
      section.chats.push(chat);
      groups.set(key, section);
    }
    return [...(pinned.length ? [{ key: "pinned", title: t().pinned, chats: pinned }] : []), ...groups.values()];
  });

  return (
    <div class="assistant-pwa-list assistant-pwa-all-chats">
      <div class="assistant-pwa-search">
        <TextInput
          type="search"
          icon="ti ti-search"
          value={query}
          onValueChange={type}
          placeholder={t().searchChats}
          aria-label={t().searchChats}
          aria-describedby="assistant-pwa-search-note"
          disabled={!props.online || (state() !== "ready" && !searched() && chats().length === 0)}
        />
        {/* Always reserved, so going offline moves nothing; the field points at it for screen readers. */}
        <p id="assistant-pwa-search-note" class="assistant-pwa-search__note">
          <Show when={!props.online}>
            <i class="ti ti-wifi-off" aria-hidden="true" /> {t().searchOffline}
          </Show>
        </p>
      </div>
      <Switch>
        <Match when={state() === "loading" && searched() !== query().trim()}>
          <h2 class="assistant-pwa-section">{t().searching}</h2>
          <SkeletonRows count={3} label={t().searching} />
        </Match>
        <Match when={state() === "loading" && chats().length === 0}>
          <h2 class="assistant-pwa-section">{t().pinned}</h2>
          <SkeletonRows count={1} label={t().loadingChats} />
          <h2 class="assistant-pwa-section">{t().thisWeek}</h2>
          <SkeletonRows count={6} label={t().loadingChats} />
        </Match>
        <Match when={state() === "failed"}>
          <Placeholder
            state="error"
            icon="ti ti-alert-circle"
            description={searched() || query().trim() ? t().searchFailed : t().allFailed}
            onRetry={() => void load(query().trim())}
          />
        </Match>
        <Match when={searched() && chats().length === 0}>
          <div class="assistant-pwa-empty assistant-pwa-empty--quiet">
            <i class="ti ti-search-off" aria-hidden="true" />
            <p>{t().noResults({ query: searched() })}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearTimeout(timer);
                setQuery("");
                props.onQueryChange("");
                void load("");
              }}
            >
              {t().clearSearch}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <For each={sections()}>
            {(section) => (
              <>
                <h2 class="assistant-pwa-section">{section.title}</h2>
                <ChatRows
                  chats={section.chats}
                  questions={props.questions}
                  selected={props.selected}
                  now={props.now}
                  timeZone={props.timeZone}
                  onOpen={props.onOpen}
                />
              </>
            )}
          </For>
          <Show when={hasNext()}>
            <p ref={end} class="assistant-pwa-more">
              {props.online ? t().loadingOlder : t().olderOffline}
            </p>
          </Show>
          <Show when={!props.archived && !searched() && archivedCount()}>
            {(count) => (
              <Link class="assistant-pwa-all" href={archiveHref} onNavigate={props.onArchive}>
                <i class="ti ti-archive assistant-pwa-all__lead" aria-hidden="true" /> {t().archive}{" "}
                <span class="assistant-pwa-all__count">{count()}</span>
                <i class="ti ti-chevron-right assistant-pwa-all__chevron" aria-hidden="true" />
              </Link>
            )}
          </Show>
        </Match>
      </Switch>
    </div>
  );
}
