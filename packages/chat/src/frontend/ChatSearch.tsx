import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, InlineGuidance, useLocale } from "@k2b/ui";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { chatMessages } from "../messages";
import type { SearchHit } from "./search-api";
import { containerIcon } from "./system-chats";
import { threadHref } from "./threads";

type ChatHit = Extract<SearchHit, { kind: "chat" }>;
type ThreadHit = Extract<SearchHit, { kind: "thread" }>;
type SystemHit = Extract<SearchHit, { kind: "system" }>;

export { type ChatSearchState, createChatSearch } from "./chat-search-state";

import type { ChatSearchState } from "./chat-search-state";

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
                      description={<span class="chat-list__preview">{t().systemMembers}</span>}
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
      <Show when={status() !== "failed" && (answer()?.result.systemUnavailable || answer()?.result.incomplete)}>
        <InlineGuidance
          role={answer()?.result.systemUnavailable ? "alert" : "status"}
          tone={answer()?.result.systemUnavailable ? "danger" : "neutral"}
          class="chat-list-error"
        >
          {answer()?.result.systemUnavailable ? t().searchSystemUnavailable : t().discussionsIncomplete}
          <Button size="sm" variant="ghost" disabled={status() === "loading"} onClick={retry}>
            {t().retry}
          </Button>
        </InlineGuidance>
      </Show>
    </div>
  );
}
