import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, InlineGuidance, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import { chatMessages } from "../messages";
import { createSearchApi, type SearchHit, type SearchResult } from "./search-api";
import { containerIcon, systemMembers } from "./system-chats";
import { threadHref } from "./threads";

type ChatHit = Extract<SearchHit, { kind: "chat" }>;
type ThreadHit = Extract<SearchHit, { kind: "thread" }>;
type SystemHit = Extract<SearchHit, { kind: "system" }>;

/** Typing pauses this long before the list asks; each new letter cancels the question before it. */
const SEARCH_DELAY_MS = 200;

/**
 * One search for the whole list, however many places show it (the sidebar and the phone's list page): it asks once
 * per pause in typing, cancels the question before, and keeps the last answer while the next one loads.
 */
export const createChatSearch = (query: Accessor<string>) => {
  const api = createSearchApi();
  const [settled, setSettled] = createSignal("");
  createEffect(
    on(query, (next) => {
      if (!next) return setSettled("");
      const timer = setTimeout(() => setSettled(next), SEARCH_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  const [attempt, setAttempt] = createSignal(0);
  const [answer, setAnswer] = createSignal<{ q: string; result: SearchResult } | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  createEffect(
    on([settled, attempt], ([q]) => {
      if (!q) {
        setAnswer(null);
        setStatus("loading");
        return;
      }
      const request = new AbortController();
      onCleanup(() => request.abort());
      setStatus("loading");
      api.search(q, request.signal).then(
        (result) => {
          setAnswer({ q, result });
          setStatus("ready");
        },
        () => {
          if (!request.signal.aborted) setStatus("failed");
        },
      );
    }),
  );
  return {
    answer,
    /** "loading" also while the reader is still typing, so a stale "nothing found" never stands for the new text. */
    status: () => (query() !== settled() ? "loading" : status()),
    /** Asks again with the same text, after a failure or an action that changed a hit. */
    retry: () => setAttempt((value) => value + 1),
  };
};
export type ChatSearchState = ReturnType<typeof createChatSearch>;

/**
 * What the list's search finds, in place of the list: chats and channels as their ordinary rows, threads with their provider icon and container, and containers whose chat nobody has started yet. The hits of the last
 * answer stay while the next one loads, so typing moves nothing. When a resource provider cannot answer, the other hits
 * still show, with a line that says what is missing.
 */
export default function ChatSearch(props: {
  search: ChatSearchState;
  basePath: string;
  /** The open thread, so its hit carries the selection like its row in the list. */
  active: { chatId: string | null; view: string };
  chatRow: (row: ChatHit["conversation"]) => JSX.Element;
  onThread: (chatId: string, thread: string, navigation: LinkNavigateEvent) => void | Promise<void>;
  /** Starts the chat of a container nobody has written in yet, and opens it. */
  onSystem: (ref: SystemHit["ref"]) => void | Promise<void>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const answer = () => props.search.answer();
  const status = () => props.search.status();
  const retry = () => props.search.retry();
  const items = () => answer()?.result.items ?? [];
  const place = (hit: ThreadHit) => {
    const title = hit.conversation.title;
    return t().searchThreadIn({ title });
  };
  const threadIcon = (hit: ThreadHit) => hit.thread.resource?.icon ?? "ti ti-hash";

  return (
    <div class="chat-search" aria-busy={status() === "loading"}>
      <div class="chat-list-feedback">
        <p role="status" aria-live="polite" class="chat-list-status">
          {status() === "loading" && answer() === null ? t().searching : ""}
          <Show when={status() === "ready" && items().length > 0}>
            <span class="sr-only">{t().searchResultCount({ count: items().length })}</span>
          </Show>
        </p>
        <Show when={status() === "failed"}>
          <InlineGuidance role="alert" tone="danger" class="chat-list-error">
            {t().searchFailed}
            <Button size="sm" variant="ghost" onClick={retry}>
              {t().retry}
            </Button>
          </InlineGuidance>
        </Show>
      </div>
      <Show
        when={items().length > 0}
        fallback={
          <Show when={answer() && status() === "ready"}>
            <p class="chat-search__empty" role="status">
              {t().searchNoResults({ q: answer()?.q ?? "" })}
            </p>
          </Show>
        }
      >
        <AppWorkspace.SidebarSection title={t().searchResults}>
          <For each={items()}>
            {(hit) => (
              <Switch>
                <Match when={hit.kind === "chat" && hit}>{(chat) => props.chatRow(chat().conversation)}</Match>
                <Match when={hit.kind === "system" && hit.conversation}>{(conversation) => props.chatRow(conversation())}</Match>
                <Match when={hit.kind === "system" && hit}>
                  {(system) => (
                    <AppWorkspace.SidebarItem
                      onClick={() => void props.onSystem(system().ref)}
                      icon={containerIcon(system().icon)}
                      description={<span class="chat-list__preview">{systemMembers(system().ref.type, t())}</span>}
                    >
                      {system().name}
                    </AppWorkspace.SidebarItem>
                  )}
                </Match>
                <Match when={hit.kind === "thread" && hit}>
                  {(thread) => (
                    <AppWorkspace.SidebarItem
                      href={threadHref(thread().conversation.id, thread().thread.id, null, props.basePath)}
                      navigation="enhanced"
                      onNavigate={(navigation) => props.onThread(thread().conversation.id, thread().thread.id, navigation)}
                      active={props.active.chatId === thread().conversation.id && props.active.view === thread().thread.id}
                      icon={threadIcon(thread())}
                      description={<span class="chat-list__preview">{place(thread())}</span>}
                    >
                      {thread().thread.name}
                    </AppWorkspace.SidebarItem>
                  )}
                </Match>
              </Switch>
            )}
          </For>
        </AppWorkspace.SidebarSection>
      </Show>
      <Show when={status() !== "failed" && answer()?.result.systemUnavailable}>
        <InlineGuidance role="alert" tone="danger" class="chat-list-error">
          {t().searchSystemUnavailable}
          <Button size="sm" variant="ghost" disabled={status() === "loading"} onClick={retry}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
    </div>
  );
}
