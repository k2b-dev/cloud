import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { Format } from "@k2b/ui";
import { Button, Dialog, Empty, Failed, Input, List, Loading, Menu, Row, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { assistantApi } from "../../api/client";
import { type ChatView, createAllChats, emptyViewText } from "../all-chats-state";
import { assistantConversationHref, type ConversationOpenResult, shouldCommitConversationNavigation } from "../assistant-navigation";
import { useAssistantText } from "../ui-copy";

/**
 * All chats on v2 (screen brief 3, recipe "dialogs"): the search leads, one quiet filter beside it, then the page of
 * chats as rows of one shape (title, its Project, the time at the end) and the pages at the foot. An archived chat is
 * restored from its row; any other row opens its chat and closes the dialog. The same state as v1 (`createAllChats`).
 */
export default function AssistantAllChatsDialogV2(props: {
  basePath?: string;
  initialView?: ChatView;
  projects: () => readonly AiProject[];
  openConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>;
  onClose: () => void;
}) {
  const text = useAssistantText();
  const toast = useToast();
  const all = createAllChats({ close: props.onClose, initialView: props.initialView, openConversation: props.openConversation });
  const [restoring, setRestoring] = createSignal<string | null>(null);
  const projectName = (chat: AiConversation) =>
    chat.projectId ? props.projects().find((project) => project.id === chat.projectId)?.name : undefined;
  const viewLabel = () => all.chatViews().find((entry) => entry.value === all.view())?.label ?? text("All chats");
  const archived = () => all.view() === "archived";
  const restore = async (chat: AiConversation) => {
    if (restoring()) return;
    setRestoring(chat.id);
    try {
      await assistantApi.restoreConversation(chat.id);
      void all.result.refresh();
    } catch {
      toast(text("Could not restore chat"), { status: "bad", retry: () => restore(chat) });
    } finally {
      setRestoring(null);
    }
  };
  const busy = () => all.result.loading() || all.result.refreshing();

  return (
    <Dialog
      title={text("All chats")}
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      foot={
        <>
          <Text muted>
            {text("Page")} {all.page()} {text("of")} {all.totalPages()}
          </Text>
          <Button icon="chevron-left" disabled={all.page() <= 1 || busy()} onClick={() => all.setPage((value) => Math.max(1, value - 1))}>
            {text("Previous")}
          </Button>
          <Button icon="chevron-right" disabled={!all.result.data()?.hasNext || busy()} onClick={() => all.setPage((value) => value + 1)}>
            {text("Next")}
          </Button>
        </>
      }
    >
      <div class="assistant-all-chats-v2__filters">
        <Input
          type="search"
          icon="search"
          label={text("Search chats")}
          placeholder={text("Search chats…")}
          value={all.query()}
          onInput={all.search}
        />
        {/* A single choice: the button names the chosen filter, the menu closes on a choice. */}
        <Menu
          label={text("Chat filters")}
          icon="filter"
          items={all.chatViews().map((entry) => ({ label: entry.label, onClick: () => all.selectView(entry.value) }))}
        >
          {viewLabel()}
        </Menu>
      </div>
      <Show
        when={all.result.data()}
        fallback={
          <Show when={all.result.error()} fallback={<Loading rows={6} lines={1} />}>
            {(error) => <Failed text={`${text("Could not load chats")} ${error().message}`} onRetry={() => void all.result.refresh()} />}
          </Show>
        }
      >
        {(page) => (
          <Show
            when={page().items.length > 0}
            fallback={<Empty icon="messages" text={emptyViewText(all.view(), all.query().trim(), text)} />}
          >
            <List label={`${text("All chats")} · ${text("Page")} ${all.page()} ${text("of")} ${all.totalPages()}`}>
              <For each={page().items}>
                {(chat) => (
                  <Row
                    icon={archived() ? "archive" : "message-circle"}
                    // One shape for every row: the title, its Project as a quiet note after it.
                    lines={[chat.title]}
                    meta={projectName(chat)}
                    time={<Format.RelativeTime value={all.view() === "done" ? chat.lastUsedAt : chat.updatedAt} />}
                    {...(archived()
                      ? {
                          action: {
                            label: text("Restore chat"),
                            icon: "restore",
                            disabled: restoring() !== null,
                            onClick: () => void restore(chat),
                          },
                        }
                      : {
                          href: assistantConversationHref(props.basePath ?? "/app/assistant", chat.id),
                          onNavigate: async (nav) => {
                            const opened = await all.openConversation(chat);
                            if (shouldCommitConversationNavigation(opened, window.location.href, nav.url.href))
                              nav.push(undefined, { scroll: "manual" });
                          },
                        })}
                  />
                )}
              </For>
            </List>
          </Show>
        )}
      </Show>
    </Dialog>
  );
}
