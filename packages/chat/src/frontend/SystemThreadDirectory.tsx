import { type LinkNavigateEvent, listenPopState, navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, Button, FilterToggle, InlineGuidance, Skeleton, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { chatMessages } from "../messages";
import type { Conversation } from "./chat-dialog";
import { listTime } from "./chat-format";
import { loadSystemThreads, type ThreadQuery } from "./system-chats";
import ThreadMetadata from "./ThreadMetadata";
import { byActivity, type ThreadList, type ThreadView, threadHref, threadIcon } from "./threads";

/** The same server-filtered, paged directory in the overview and the wide thread column. */
export default function SystemThreadDirectory(props: {
  conversation: Conversation;
  basePath?: string;
  view?: ThreadView;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  revision: number;
  onOpen: (view: ThreadView, navigation: LinkNavigateEvent) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [input, setInput] = createSignal("");
  const [filter, setFilter] = createSignal<ThreadQuery["filter"]>();
  const [mounted, setMounted] = createSignal(false);
  const [directory, setDirectory] = createStore<{ page: ThreadList | undefined }>({ page: undefined });
  const page = () => directory.page;
  const setPage = (next: ThreadList | undefined) => setDirectory("page", reconcile(next, { key: "id" }));
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  const [appending, setAppending] = createSignal(false);
  let controller: AbortController | undefined;
  let loadedPages = 0;
  const readAddress = () => {
    const params = new URL(location.href).searchParams;
    setInput((params.get("q") ?? "").slice(0, 100));
    const value = params.get("filter");
    setFilter(value === "open" || value === "done" || value === "unread" ? value : undefined);
  };
  createEffect(
    on(
      () => props.conversation.id,
      (id) => {
        if (!mounted()) return;
        if (location.pathname.startsWith(`${props.basePath ?? "/app/chat"}/c/${id}`)) readAddress();
        else {
          setInput("");
          setFilter(undefined);
        }
      },
      { defer: true },
    ),
  );
  onMount(() => {
    readAddress();
    setMounted(true);
    onCleanup(listenPopState(readAddress));
  });
  const address = () => {
    const url = new URL(location.href);
    if (input().trim()) url.searchParams.set("q", input().trim());
    else url.searchParams.delete("q");
    if (filter()) url.searchParams.set("filter", filter()!);
    else url.searchParams.delete("filter");
    navigate(url.pathname + url.search, { replace: true, scroll: "preserve", viewTransition: false });
  };
  const load = async (append = false) => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    setStatus("loading");
    setAppending(append);
    try {
      // A revision re-reads exactly the depth the reader loaded. Only "More" extends it.
      const depth = append ? 1 : Math.max(1, loadedPages);
      const items = new Map((append ? (page()?.items ?? []) : []).map((thread) => [thread.id, thread]));
      let cursor = append ? (page()?.nextCursor ?? undefined) : undefined;
      let next: ThreadList | undefined;
      let pages = 0;
      const seen = new Set<string>();
      for (; pages < depth; pages++) {
        request.signal.throwIfAborted();
        next = await loadSystemThreads(props.conversation.id, { q: input().trim() || undefined, filter: filter(), cursor }, request.signal);
        if (request.signal.aborted) return;
        for (const thread of next.items) items.set(thread.id, thread);
        cursor = next.nextCursor ?? undefined;
        if (cursor === undefined) {
          pages++;
          break;
        }
        if (seen.has(cursor)) throw new Error("Repeated directory cursor");
        seen.add(cursor);
      }
      if (!next) return;
      loadedPages = append ? loadedPages + pages : pages;
      setPage({ ...next, items: byActivity([...items.values()]) });
      setStatus("ready");
    } catch {
      if (!request.signal.aborted) setStatus("failed");
    }
  };
  createEffect(
    on([mounted, input, filter, () => props.conversation.id, () => props.revision], ([ready], previous) => {
      if (!ready) return;
      controller?.abort();
      // Old search results never remain actionable while a different query loads.
      const changed = !previous || previous[1] !== input() || previous[2] !== filter() || previous[3] !== props.conversation.id;
      if (changed) {
        setPage(undefined);
        loadedPages = 0;
      }
      setStatus("loading");
      const timer = setTimeout(() => void load(), changed ? 200 : 0);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  onCleanup(() => controller?.abort());
  return (
    <div class="chat-system-directory">
      <AppWorkspace.SidebarItem
        href={threadHref(props.conversation.id, "all", null, props.basePath)}
        navigation="enhanced"
        active={props.view === "all"}
        onNavigate={(event) => props.onOpen("all", event)}
        icon="ti ti-messages"
        data={{ thread: "all" }}
      >
        {t().allThreads}
      </AppWorkspace.SidebarItem>
      <div class="chat-system-directory__controls">
        <TextInput
          type="search"
          icon="ti ti-search"
          aria-label={t().searchThreads}
          placeholder={t().searchThreads}
          maxLength={100}
          value={input}
          onValueChange={(value) => {
            setInput(value);
            address();
          }}
        />
        <div class="chat-system-directory__filters">
          <For
            each={
              [
                { value: "open", label: t().threadsOpen, icon: "ti ti-circle" },
                { value: "done", label: t().threadsDone, icon: "ti ti-check" },
                { value: "unread", label: t().threadsUnread, icon: "ti ti-mail" },
              ] as const
            }
          >
            {(item) => (
              <FilterToggle
                label={item.label}
                icon={item.icon}
                active={filter() === item.value}
                onClick={() => {
                  setFilter(filter() === item.value ? undefined : item.value);
                  address();
                }}
              />
            )}
          </For>
        </div>
      </div>
      <div class="chat-system-directory__results" aria-busy={status() === "loading"}>
        <Show when={!page() && status() === "loading"}>
          <For each={[0, 1, 2]}>{() => <Skeleton class="chat-system-chats__skeleton" />}</For>
        </Show>
        <For each={page()?.items ?? []}>
          {(thread) => (
            <AppWorkspace.SidebarItem
              href={threadHref(props.conversation.id, thread.id, null, props.basePath)}
              navigation="enhanced"
              active={props.view === thread.id}
              onNavigate={(event) => props.onOpen(thread.id, event)}
              data={{ thread: thread.id }}
              description={
                <span class="chat-system-directory__description">
                  <Show when={thread.resource} fallback={<span class="chat-list__preview">{thread.description ?? ""}</span>}>
                    {(resource) => (
                      <span class="chat-list__preview">
                        <span>{resource().status}</span>
                        <ThreadMetadata resource={resource()} dateConfig={props.dateConfig} />
                      </span>
                    )}
                  </Show>
                  <span class="chat-list__preview">
                    {thread.lastMessage
                      ? `${thread.lastMessage.author.id === props.viewerId ? t().you : thread.lastMessage.author.name.split(" ")[0]}: ${thread.lastMessage.preview}`
                      : t().noMessagesYet}
                  </span>
                </span>
              }
            >
              <AppWorkspace.SidebarItemIcon icon={threadIcon(thread)} />
              <AppWorkspace.SidebarItemLabel marquee={false}>{thread.name}</AppWorkspace.SidebarItemLabel>
              <AppWorkspace.SidebarItemMeta>
                <span class="chat-list__meta">
                  <time class="chat-list__time" datetime={thread.lastActivityAt}>
                    {listTime(thread.lastActivityAt, props.now(), { ...props.dateConfig, locale: locale() })}
                  </time>
                  <span class="chat-system-chats__count">
                    <AppWorkspace.SidebarItemStatus unread={thread.unread > 0 ? thread.unread : undefined} />
                  </span>
                </span>
              </AppWorkspace.SidebarItemMeta>
            </AppWorkspace.SidebarItem>
          )}
        </For>
        <Show when={status() === "failed"}>
          <InlineGuidance tone="danger" role="status">
            {t().threadsLoadFailed}{" "}
            <Button variant="text" size="xs" onClick={() => void load(appending())}>
              {t().retry}
            </Button>
          </InlineGuidance>
        </Show>
        <Show when={status() === "ready" && page()?.items.length === 0 && !page()?.nextCursor}>
          <p class="chat-threads-page__empty">{input() || filter() ? t().noThreadMatches : t().noItemThreads}</p>
        </Show>
        <Show when={page()?.nextCursor}>
          <Button
            class="chat-system-directory__more"
            variant="ghost"
            size="sm"
            loading={status() === "loading"}
            onClick={() => void load(true)}
          >
            {t().moreThreads}
          </Button>
        </Show>
      </div>
    </div>
  );
}
