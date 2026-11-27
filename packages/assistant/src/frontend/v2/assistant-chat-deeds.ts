import type { AiConversation, AiProject } from "@k2b/cloud/ai";
import { confirm, useToast } from "@k2b/ui/v2";
import { assistantApi } from "../../api/client";
import type { AssistantSidebarChat } from "../../sidebar";
import type { AssistantArchiveBlocker } from "../archive-blocker";
import type { AssistantLiveHub } from "../assistant-live";
import { assistantMessages } from "../messages";
import { openAssistantAllChatsDialog, openAssistantConversationEditor } from "../rare-dialogs";
import { assistantCopyFor } from "../ui-copy";
import { assistantV2Messages } from "./assistant-v2-messages";

export type AssistantChatDeedsOptions = {
  basePath: string;
  locale: () => string;
  live: AssistantLiveHub;
  projects: () => readonly AiProject[];
  conversations: () => readonly AssistantSidebarChat[];
  activeConversationId: () => string | null;
  archiveBlocker: (conversation: AssistantSidebarChat) => AssistantArchiveBlocker;
  queuedMessageCount: (conversation: AssistantSidebarChat) => number | undefined;
  openConversation: (conversationId: string) => Promise<boolean>;
  /** The chat as the server saved it. */
  onUpdated: (conversation: AiConversation) => void;
  onArchived: (conversation: Pick<AssistantSidebarChat, "id">) => void;
};

/**
 * What the person does to one chat from its "…", in the sidebar and in the head: edit its name, description and pin
 * (v1's chat settings), archive it after asking, and open the list of every chat.
 */
export const createAssistantChatDeeds = (options: AssistantChatDeedsOptions) => {
  const toast = useToast();
  const t = () => assistantMessages.resolve([options.locale()]).t;
  const text = (value: string) => assistantCopyFor(options.locale()).text({ value });
  const v2 = () => assistantV2Messages.resolve([options.locale()]).t;
  const latest = (conversation: AssistantSidebarChat) =>
    options.conversations().find((item) => item.id === conversation.id) ?? conversation;

  const edit = async (conversation: AssistantSidebarChat) => {
    const blocker = options.archiveBlocker(conversation);
    const result = await openAssistantConversationEditor(latest(conversation), {
      archiveDisabled: blocker !== null,
      queuedMessageCount: () => options.queuedMessageCount(conversation),
      archiveDisabledReason: blocker === "waiting" ? t().decideBeforeArchive : blocker === "running" ? t().stopBeforeArchive : undefined,
    });
    if (!result) return;
    if (result.action === "save") options.onUpdated(result.conversation);
    else options.onArchived(result.conversation);
  };

  const archive = async (conversation: AssistantSidebarChat) => {
    const agreed = await confirm({
      title: v2().archiveTitle({ title: conversation.title }),
      description: text("Remove this chat from active lists. You can restore it later from All Chats."),
      confirm: text("Archive chat"),
    });
    if (!agreed) return;
    try {
      await assistantApi.archiveConversation(conversation.id);
      options.onArchived(conversation);
      toast(text("Chat archived"), { status: "ok" });
    } catch {
      toast(v2().archiveFailed, { status: "bad", retry: () => archive(conversation) });
    }
  };

  const openAll = () =>
    void openAssistantAllChatsDialog(
      async (conversation) => {
        if (conversation.id === options.activeConversationId()) return "unchanged";
        return (await options.openConversation(conversation.id)) ? "opened" : "stale";
      },
      options.live,
      options.projects,
      "all",
      options.basePath,
    ).catch(() => toast(v2().allChatsFailed, { status: "bad", retry: openAll }));

  return { edit, archive, openAll };
};
