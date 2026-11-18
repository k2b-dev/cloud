import type { AiConversation } from "@k2b/cloud/ai";
import { prompts } from "@k2b/ui";
import { assistantCopyFor } from "./ui-copy";

/** Shared archive confirmation, loaded only when needed on the phone. Unknown queue counts stay explicit. */
export const confirmAssistantArchive = async (
  conversation: Pick<AiConversation, "id" | "title">,
  locale: string,
  queuedMessageCount?: number,
) => {
  const copy = assistantCopyFor(locale);
  const text = (value: string) => copy.text({ value });
  return prompts.confirm([copy.archiveChat({ title: conversation.title }), copy.archiveQueuedMessages({ count: queuedMessageCount })].filter(Boolean).join("\n\n"), {
    title: text("Archive chat"),
    icon: "ti ti-archive",
    confirmText: text("Archive"),
    cancelText: text("Cancel"),
  });
};
