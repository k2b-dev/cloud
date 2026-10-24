import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
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
 * What the list's search finds, in place of the list: chats and channels as their ordinary rows, threads with the kind
 * of their item and where they live, and Spaces and notebooks whose chat nobody has started yet. The hits of the last
 * answer stay while the next one loads, so typing moves nothing. When Spaces or Notebooks cannot answer, the other hits
 * still show, with a line that says what is missing.
 */
export default function ChatSearch(props: {
  query: string;
  basePath: string;
  /** The open thread, so its hit carries the selection like its row in the list. */
  active: { chatId: string | null; view: string };
  chatRow: (row: ChatHit["conversation"]) => JSX.Element;
  onThread: (chatId: string, thread: string, navigation: LinkNavigateEvent) => void | Promise<void>;
  /** Starts the chat of a Space or notebook nobody has written in yet, and opens it. */
  onSystem: (ref: SystemHit["ref"]) => void | Promise<void>;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const api = createSearchApi();
  const [query, setQuery] = createSignal(props.query);
  createEffect(
    on(
      () => props.query,
      (next) => {
        const timer = setTimeout(() => setQuery(next), SEARCH_DELAY_MS);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );
  const [attempt, setAttempt] = createSignal(0);
  const [answer, setAnswer] = createSignal<{ q: string; result: SearchResult } | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  createEffect(
    on([query, attempt], ([q]) => {
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
  const retry = () => setAttempt((value) => value + 1);
  const items = () => answer()?.result.items ?? [];
  const place = (hit: ThreadHit) => {
    const title = hit.conversation.title;
    switch (hit.thread.resource?.kind) {
      case "task":
        return t().searchTaskIn({ title });
      case "event":
        return t().searchEventIn({ title });
      case "note":
        return t().searchNoteIn({ title });
      default:
        return t().searchThreadIn({ title });
    }
  };
  const threadIcon = (hit: ThreadHit) => {
    const resource = hit.thread.resource;
    if (!resource) return "ti ti-hash";
    if (resource.kind === "event") return "ti ti-calendar-event";
    if (resource.kind === "note") return "ti ti-note";
    return resource.done ? "ti ti-circle-check" : "ti ti-circle";
  };

  return (
    <div class="chat-search" aria-busy={status() === "loading"}>
      <div class="chat-list-feedback">
        <p role="status" aria-live="polite" class="chat-list-status">
          {status() === "loading" && answer() === null ? t().searching : ""}
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
          <Show when={answer() && status() !== "failed"}>
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
                      icon={containerIcon(system().ref.type)}
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
