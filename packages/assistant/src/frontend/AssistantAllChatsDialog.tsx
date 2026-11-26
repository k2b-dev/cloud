import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { Button, dialogCore, NoticeCard, PanelDialog, Placeholder, panelDialogFixedOptions, Select, TextInput } from "@k2b/ui";
import { Show } from "solid-js";
import AssistantAllChatsList from "./AssistantAllChatsList";
import { type ChatView, createAllChats, emptyViewText } from "./all-chats-state";
import { type AssistantLiveHub, AssistantLiveProvider } from "./assistant-live";
import type { ConversationOpenResult } from "./assistant-navigation";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

function AssistantAllChatsDialog(props: {
  basePath?: string;
  close: () => void;
  initialView?: ChatView;
  openConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>;
  projects: () => readonly AiProject[];
}) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const { chatViews, query, search, view, selectView, page, setPage, result, totalPages, openConversation } = createAllChats(props);

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={text("All chats")}
        subtitle={result.data() ? copy().chatsCount({ count: result.data()!.total }) : text("Search and manage your history")}
        icon="ti ti-messages"
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-all-chats-dialog">
        <div class="assistant-all-chats-filters">
          <TextInput
            type="search"
            icon="ti ti-search"
            activeIcon="ti ti-search"
            aria-label={text("Search chats")}
            placeholder={text("Search chats…")}
            value={query}
            onValueChange={search}
            clearable
            onClear={() => search("")}
          />
          <Select
            aria-label={text("Chat filters")}
            value={view}
            onValueChange={(value) => selectView((value ?? "all") as ChatView)}
            options={chatViews()}
          />
        </div>

        <Show when={result.data() ? result.error() : null}>{(error) => <NoticeCard tone="danger" title={error().message} />}</Show>

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
              basePath={props.basePath}
              conversations={result.data()!.items}
              archived={view() === "archived"}
              orderedByUse={view() === "done"}
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
  initialView?: ChatView,
  basePath?: string,
): Promise<void | undefined> =>
  dialogCore.open<void>(
    (close) => (
      <AssistantLiveProvider value={live}>
        <AssistantAllChatsDialog
          basePath={basePath}
          close={() => close()}
          openConversation={openConversation}
          projects={projects}
          initialView={initialView}
        />
      </AssistantLiveProvider>
    ),
    panelDialogFixedOptions,
  );
