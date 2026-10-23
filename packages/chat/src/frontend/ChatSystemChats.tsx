import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, InlineGuidance, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { chatMessages } from "../messages";
import ChatList from "./ChatList";
import { loadSystemChats, type SystemChatPage } from "./system-chats";

/** Shared by the desktop sidebar and phone list; no browser request before hydration. */
export function createSystemChatList() {
  const [page, setPage] = createSignal<SystemChatPage>();
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  const [more, setMore] = createSignal(false);
  let controller: AbortController | undefined;
  const load = async (append = false) => {
    controller?.abort();
    const request = new AbortController();
    controller = request;
    setStatus("loading");
    setMore(append);
    try {
      const previous = page();
      const next = await loadSystemChats(
        append ? { spacesCursor: previous?.spacesCursor ?? undefined, notebooksCursor: previous?.notebooksCursor ?? undefined } : {},
        request.signal,
      );
      if (request.signal.aborted) return;
      if (append && previous) {
        const items = new Map(previous.items.map((item) => [`${item.ref.type}:${item.ref.id}`, item]));
        for (const item of next.items) items.set(`${item.ref.type}:${item.ref.id}`, item);
        next.items = [...items.values()];
      }
      setPage(next);
      setStatus("ready");
    } catch {
      if (!request.signal.aborted) setStatus("failed");
    }
  };
  onMount(() => void load());
  onCleanup(() => controller?.abort());
  return { page, status, more, load };
}

export default function ChatSystemChats(props: {
  state: ReturnType<typeof createSystemChatList>;
  list: Omit<Parameters<typeof ChatList>[0], "rows" | "hasMore" | "onMore">;
  current: Parameters<typeof ChatList>[0]["rows"][number] | null;
  updates: Parameters<typeof ChatList>[0]["rows"];
  unavailableId: string | null;
  expanded: boolean;
  onExpanded: (open: boolean) => void;
  onOpen: (id: string, navigation: LinkNavigateEvent) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  createEffect(
    on(
      () => (props.current?.kind === "system" ? props.current.id : null),
      (id) => {
        if (id) props.onExpanded(true);
      },
    ),
  );
  const rows = createMemo(() => {
    const rows = new Map(props.updates.filter((row) => row.kind === "system").map((row) => [row.id, row]));
    const current = props.current;
    if (current?.kind === "system") rows.set(current.id, current);
    if (props.unavailableId) rows.delete(props.unavailableId);
    return [...rows.values()];
  });
  const unread = () => rows().reduce((sum, row) => sum + row.unread, 0);
  return (
    <AppWorkspace.SidebarSection
      class={`chat-system-chats${unread() === 0 ? " chat-system-chats--read" : ""}`}
      title={t().systemChats}
      count={unread()}
      collapsible
      open={props.expanded}
      onOpenChange={props.onExpanded}
    >
      <Show when={props.expanded}>
        <Show when={props.state.status() === "loading" && !props.state.page()}>
          <div class="chat-system-chats__loading" aria-busy="true">
            <For each={[0, 1, 2]}>{() => <Skeleton class="chat-system-chats__skeleton" />}</For>
          </div>
        </Show>
        <ChatList system {...props.list} rows={rows()} onOpen={props.onOpen} hasMore={false} onMore={() => {}} />
        <Show when={props.state.status() === "failed"}>
          <InlineGuidance tone="danger" role="status">
            {t().systemChatsFailed}{" "}
            <Button variant="text" size="xs" onClick={() => void props.state.load(props.state.more())}>
              {t().retry}
            </Button>
          </InlineGuidance>
        </Show>
        <Show when={props.state.status() === "ready" && rows().length === 0}>
          <p class="chat-system-chats__empty">{t().systemChatsEmpty}</p>
        </Show>
        <Show when={props.state.page()?.spacesCursor || props.state.page()?.notebooksCursor}>
          <Button variant="ghost" size="sm" loading={props.state.status() === "loading"} onClick={() => void props.state.load(true)}>
            {t().showMoreChats}
          </Button>
        </Show>
      </Show>
    </AppWorkspace.SidebarSection>
  );
}
