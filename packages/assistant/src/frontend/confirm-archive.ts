import type { AiConversation } from "@k2b/cloud/ai";
import { prompts } from "@k2b/ui";
import { assistantApi } from "../api/client";
import { assistantCopyFor } from "./ui-copy";

/** Shared archive confirmation, loaded only when needed on the phone. Unknown queue counts stay explicit. */
export const confirmAssistantArchive = async (
  conversation: Pick<AiConversation, "id" | "title">,
  locale: string,
  queuedMessageCount?: number,
) => {
  const copy = assistantCopyFor(locale);
  const text = (value: string) => copy.text({ value });
  const routines = await assistantApi.listChatTasks({ chatId: conversation.id, state: "active", limit: 100 }).catch(() => null);
  const message =
    routines === null
      ? copy.archiveChatAnyRoutines
      : routines.length
        ? copy.archiveChatRoutines({ names: routines.map((routine) => routine.name) })
        : copy.archiveChat({ title: conversation.title });
  return prompts.confirm([message, copy.archiveQueuedMessages({ count: queuedMessageCount })].filter(Boolean).join("\n\n"), {
    title: routines?.length !== 0 ? copy.archiveChat({ title: conversation.title }) : text("Archive chat"),
    icon: "ti ti-archive",
    confirmText: text(routines?.length ? "Archive anyway" : "Archive"),
    cancelText: text("Cancel"),
  });
};
