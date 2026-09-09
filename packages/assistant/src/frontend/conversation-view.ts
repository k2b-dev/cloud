import type { AiConversation } from "@k2b/cloud/ai";
import { assistantMessages } from "./messages";

export const conversationStatusPresentation = (conversation: AiConversation, locale = "en") => {
  const t = assistantMessages.resolve([locale]).t;
  if (conversation.runStatus === "needs_attention") {
    return { label: t.needsAttention, icon: "ti ti-hand-stop", class: "text-amber-600 dark:text-amber-300" };
  }
  if (conversation.runStatus === "running" || conversation.runStatus === "queued") {
    return {
      label: conversation.runStatus === "queued" ? t.queued : t.running,
      icon: "ti ti-loader-2 animate-spin",
      class: "text-cyan-600 dark:text-cyan-300",
    };
  }
  if (conversation.runStatus === "failed") {
    return { label: t.failed, icon: "ti ti-alert-circle", class: "text-red-600 dark:text-red-400" };
  }
  if (conversation.unreadCompletion) {
    return { label: t.newResponse, icon: "ti ti-circle-filled", class: "text-cyan-600 dark:text-cyan-300" };
  }
  return null;
};
