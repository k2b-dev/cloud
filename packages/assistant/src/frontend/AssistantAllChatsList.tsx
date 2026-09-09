import { Link, type LinkNavigateEvent, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { IconButton, Placeholder, prompts, StatusBadge, Tooltip } from "@k2b/ui";
import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { formatDateTime as formatUpdatedAt } from "@k2b/cloud/shared";
import { createEffect, createSignal, For, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { openAssistantConversationEditor } from "./AssistantConversationEditor";
import { assistantConversationHref, type ConversationOpenResult, shouldCommitConversationNavigation } from "./assistant-navigation";
import { ConversationStatusMeta } from "./conversation-status";
import { useAssistantCopy, useAssistantText } from "./ui-copy";

type Props = {
  conversations: AiConversation[];
  projects?: readonly AiProject[];
  archived?: boolean;
  onOpenConversation: (conversation: AiConversation) => Promise<ConversationOpenResult>;
  onChanged?: () => void;
};

function ConversationSummary(props: { conversation: AiConversation; projectName?: string }) {
  const copy = useAssistantCopy();
  return (
    <>
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-2">
          <span class="min-w-0 truncate font-medium text-primary">{props.conversation.title}</span>
          <Show when={props.projectName}>
            {(name) => <StatusBadge tone="neutral" variant="chip" icon={null} label={name()} class="shrink-0" />}
          </Show>
        </span>
        <span class="block truncate text-xs text-dimmed">
          {props.conversation.description || copy().updatedAt({ value: formatUpdatedAt(props.conversation.updatedAt) })}
        </span>
      </span>
    </>
  );
}

export default function AssistantAllChatsList(props: Props) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const [conversations, setConversations] = createSignal(props.conversations);
  createEffect(() => setConversations(props.conversations));
  const [restoringId, setRestoringId] = createSignal<string | null>(null);
  const projectName = (conversation: AiConversation) =>
    conversation.projectId ? props.projects?.find((project) => project.id === conversation.projectId)?.name : undefined;
  const restore = mutation.create<AiConversation, AiConversation>({
    mutation: (conversation) => {
      setRestoringId(conversation.id);
      return assistantApi.restoreConversation(conversation.id);
    },
    onSuccess: (conversation) => {
      setRestoringId(null);
      setConversations((current) => current.filter((item) => item.id !== conversation.id));
      if (props.onChanged) props.onChanged();
      else refreshCurrentPath();
    },
    onError: (error) => {
      setRestoringId(null);
      void prompts.error(error.message);
    },
  });

  const openEditor = async (conversation: AiConversation) => {
    const result = await openAssistantConversationEditor(conversation);
    if (!result) return;

    if (result.action === "save") {
      setConversations((prev) => prev.map((item) => (item.id === result.conversation.id ? result.conversation : item)));
      if (props.onChanged) props.onChanged();
      else refreshCurrentPath();
      return;
    }

    setConversations((prev) => prev.filter((item) => item.id !== result.conversation.id));
    if (props.onChanged) props.onChanged();
    else refreshCurrentPath();
  };

  const openConversation = async (conversation: AiConversation, nav: LinkNavigateEvent) => {
    const result = await props.onOpenConversation(conversation);
    if (shouldCommitConversationNavigation(result, window.location.href, nav.url.href)) {
      nav.push(undefined, { scroll: "manual" });
    }
  };

  return (
    <div class="space-y-0.5">
      <For each={conversations()}>
        {(conversation) => (
          <div class="group flex min-w-0 items-center gap-3 rounded-md px-2 py-2.5 text-sm transition-colors hover:bg-[var(--ui-surface-subtle)] focus-within:bg-[var(--ui-surface-subtle)]">
            <Show
              when={!props.archived}
              fallback={
                <span class="flex min-w-0 flex-1 cursor-default items-center gap-3 text-left">
                  <ConversationSummary conversation={conversation} projectName={projectName(conversation)} />
                </span>
              }
            >
              <Link
                href={assistantConversationHref("/app/assistant", conversation.id)}
                scroll="manual"
                onNavigate={(nav) => openConversation(conversation, nav)}
                class="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <ConversationSummary conversation={conversation} projectName={projectName(conversation)} />
              </Link>
            </Show>
            <ConversationStatusMeta conversation={conversation} labels />
            <span class="hidden shrink-0 text-xs text-dimmed sm:block">{formatUpdatedAt(conversation.updatedAt)}</span>
            <Tooltip.Anchor content={text(props.archived ? "Restore chat" : "Edit chat")}>
              <IconButton
                size="sm"
                variant="ghost"
                class="shrink-0 opacity-60 group-focus-within:opacity-100"
                label={props.archived ? copy().restoreNamed({ name: conversation.title }) : copy().editNamed({ name: conversation.title })}
                disabled={restore.loading()}
                loading={props.archived && restoringId() === conversation.id}
                loadingLabel={copy().restoringNamed({ name: conversation.title })}
                onClick={() => (props.archived ? void restore.mutate(conversation) : void openEditor(conversation))}
              >
                <i class={`ti ${props.archived ? "ti-restore" : "ti-settings"}`} aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </div>
        )}
      </For>
      <Show when={conversations().length === 0}>
        <Placeholder align="left" description={text("No chats left on this page.")} />
      </Show>
    </div>
  );
}
