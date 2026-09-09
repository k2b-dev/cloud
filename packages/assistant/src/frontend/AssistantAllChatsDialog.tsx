import { query as solidQuery } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, Placeholder, panelDialogFixedOptions, SegmentedControl, TextInput } from "@k2b/ui";
import type { AiConversation, AiConversationPage, AiConversationStatusFilter, AiProject } from "@k2b/cloud/ai";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { assistantApi } from "../api/client";
import AssistantAllChatsList from "./AssistantAllChatsList";
import {
  type AssistantLiveHub,
  type AssistantLiveInvalidation,
  AssistantLiveProvider,
  matchesAssistantInvalidation,
  useAssistantLive,
} from "./assistant-live";
import type { ConversationOpenResult } from "./assistant-navigation";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

type ChatView = "all" | "running" | "needs_attention" | "failed" | "unread" | "archived";

const PER_PAGE = 20;

const emptyViewText = (view: ChatView, search: string, text: (value: string) => string): string => {
  if (search) return text("No chats match your search.");
  if (view === "archived") return text("No archived chats.");
  if (view === "running") return text("No chats are running.");
  if (view === "needs_attention") return text("No chats need attention.");
  if (view === "failed") return text("No failed chats.");
  if (view === "unread") return text("No new responses.");
  return text("No chats yet.");
};

function AssistantAllChatsDialog(props: {
  close: () => void;
  openConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>;
  projects: () => readonly AiProject[];
}) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const chatViews: ReadonlyArray<{ value: ChatView; label: string }> = [
    { value: "all", label: text("All") },
    { value: "running", label: text("Running") },
    { value: "needs_attention", label: text("Needs attention") },
    { value: "failed", label: text("Failed") },
    { value: "unread", label: text("New responses") },
    { value: "archived", label: text("Archived") },
  ];
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal<ChatView>("all");
  const [page, setPage] = createSignal(1);
  const [requestQuery, setRequestQuery] = createSignal("");
  let latestOpenRequestId = 0;
  const source = createMemo(() => JSON.stringify({ query: requestQuery(), view: view(), page: page() }));
  const result = solidQuery.create<string, AiConversationPage, AssistantLiveInvalidation>({
    source,
    load: async (serialized, { abortSignal }) => {
      const input = JSON.parse(serialized) as { query: string; view: ChatView; page: number };
      const status = input.view !== "all" && input.view !== "archived" ? (input.view as AiConversationStatusFilter) : undefined;
      return assistantApi.listConversationsPage({
        q: input.query || undefined,
        page: input.page,
        perPage: PER_PAGE,
        archived: input.view === "archived",
        status,
        signal: abortSignal,
      });
    },
  });
  const live = useAssistantLive();
  const unregister = live.register({
    matches: matchesAssistantInvalidation(["conversation-list", "project-list"]),
    invalidate: (invalidation) => result.invalidate(invalidation),
  });
  onCleanup(unregister);

  createEffect(() => {
    const value = query().trim();
    const timer = window.setTimeout(() => setRequestQuery(value), 180);
    onCleanup(() => window.clearTimeout(timer));
  });

  createEffect(() => {
    const value = result.data();
    if (!value) return;
    const lastPage = Math.max(1, Math.ceil(value.total / value.perPage));
    if (value.page > lastPage) setPage(lastPage);
  });

  const selectView = (next: ChatView) => {
    setPage(1);
    setView(next);
  };
  const totalPages = () => Math.max(1, Math.ceil((result.data()?.total ?? 0) / (result.data()?.perPage ?? PER_PAGE)));
  const openConversation = async (conversation: AiConversation): Promise<ConversationOpenResult> => {
    const requestId = ++latestOpenRequestId;
    const result = await props.openConversation(conversation);
    if (requestId !== latestOpenRequestId) return "stale";
    if (result !== "stale") props.close();
    return result;
  };
  onCleanup(() => {
    latestOpenRequestId += 1;
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={text("All chats")}
        subtitle={result.data() ? copy().chatsCount({ count: result.data()!.total }) : text("Search and manage your history")}
        icon="ti ti-messages"
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-all-chats-dialog">
        <div class="flex flex-col gap-3">
          <TextInput
            type="search"
            icon="ti ti-search"
            activeIcon="ti ti-search"
            aria-label={text("Search chats")}
            placeholder={text("Search chats…")}
            value={query}
            onValueChange={(value) => {
              setPage(1);
              setQuery(value);
            }}
            clearable
            onClear={() => {
              setPage(1);
              setQuery("");
            }}
          />
          <SegmentedControl
            options={chatViews}
            value={view}
            onValueChange={selectView}
            ariaLabel={text("Chat filters")}
            size="sm"
            class="max-w-full overflow-x-auto"
          />
        </div>

        <Show when={result.data() ? result.error() : null}>
          {(error) => (
            <div class="rounded-[var(--ui-radius-surface)] bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
              {error().message}
            </div>
          )}
        </Show>

        <div aria-busy={result.loading() || result.refreshing()}>
          <Show
            when={result.data() && result.data()!.items.length > 0}
            fallback={
              <Show
                when={!result.data() ? result.error() : null}
                fallback={
                  <Placeholder
                    state={result.loading() && !result.data() ? "loading" : "empty"}
                    variant="panel"
                    title={result.loading() && !result.data() ? text("Loading chats…") : emptyViewText(view(), query().trim(), text)}
                  />
                }
              >
                {(error) => (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={text("Could not load chats")}
                    description={error().message}
                    action={
                      <Button size="sm" variant="secondary" onClick={() => void result.refresh()}>
                        {text("Retry")}
                      </Button>
                    }
                  />
                )}
              </Show>
            }
          >
            <AssistantAllChatsList
              conversations={result.data()!.items}
              archived={view() === "archived"}
              projects={props.projects()}
              onChanged={() => void result.refresh()}
              onOpenConversation={openConversation}
            />
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span class="text-xs text-dimmed">
          {text("Page")} {page()} {text("of")} {totalPages()}
        </span>
        <nav class="flex items-center gap-1" aria-label={text("Chat history pages")}>
          <Button
            variant="ghost"
            size="sm"
            disabled={page() <= 1 || result.loading() || result.refreshing()}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
            {text("Previous")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!result.data()?.hasNext || result.loading() || result.refreshing()}
            onClick={() => setPage((value) => value + 1)}
          >
            {text("Next")}
            <i class="ti ti-chevron-right" aria-hidden="true" />
          </Button>
        </nav>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openAssistantAllChatsDialog = (
  openConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>,
  live: AssistantLiveHub,
  projects: () => readonly AiProject[] = () => [],
): Promise<void | undefined> =>
  dialogCore.open<void>(
    (close) => (
      <AssistantLiveProvider value={live}>
        <AssistantAllChatsDialog close={() => close()} openConversation={openConversation} projects={projects} />
      </AssistantLiveProvider>
    ),
    panelDialogFixedOptions,
  );
