import type { AiConversation } from "@k2b/cloud/ai";
import { calendarDaysBefore } from "./chat-sidebar-model";
import { assistantMessages } from "./messages";

export type ConversationStatusTone = "progress" | "attention" | "danger" | "accent" | "muted";

/** One status per chat for lists: label for tooltips and screen readers, icon, and a semantic tone the CSS colors. */
export const conversationStatusPresentation = (
  conversation: AiConversation,
  locale = "en",
  active = false,
): { label: string; icon: string; tone: ConversationStatusTone } | null => {
  const t = assistantMessages.resolve([locale]).t;
  const spinner = "ti ti-loader-2 animate-spin motion-reduce:animate-none";
  if (conversation.runStatus === "waiting_for_browser") {
    return { label: active ? t.running : t.waitingForBrowser, icon: active ? spinner : "ti ti-browser", tone: "progress" };
  }
  if (conversation.runStatus === "needs_attention") return { label: t.needsAttention, icon: "ti ti-hand-stop", tone: "attention" };
  if (conversation.runStatus === "running" || conversation.runStatus === "queued") {
    return { label: conversation.runStatus === "queued" ? t.queued : t.running, icon: spinner, tone: "progress" };
  }
  if (conversation.runStatus === "failed") return { label: t.failed, icon: "ti ti-alert-circle", tone: "danger" };
  if (conversation.unreadCompletion) return { label: t.newResponse, icon: "ti ti-point-filled", tone: "accent" };
  return null;
};

/**
 * Whether "New chat" may hand this chat back while it is still empty: a plain Assistant chat that is open and nobody
 * shaped yet. A Project, an app launch with its tool ceiling, a chosen title or description, a pin, and a done or
 * archived chat all make the next chat a different one, so New chat creates it.
 */
export const isPlainChat = (conversation: AiConversation): boolean =>
  !conversation.projectId &&
  !conversation.launchedByAppId &&
  !conversation.allowedTools &&
  conversation.titleSource !== "user" &&
  conversation.descriptionSource !== "user" &&
  !conversation.pinnedAt &&
  !conversation.isDone &&
  !conversation.archivedAt;

export type ConversationAgeGroup = "pinned" | "today" | "yesterday" | "week" | "month" | "older";

/**
 * Splits the open chat list into the sections the sidebar shows: pinned chats first, then by the calendar day the
 * chat was last used, in the viewer's time zone. The input order stays inside each section, and empty sections are
 * left out.
 */
export const groupConversationsByAge = (
  conversations: readonly AiConversation[],
  now: string,
  timeZone: string,
): { group: ConversationAgeGroup; conversations: AiConversation[] }[] => {
  const order: ConversationAgeGroup[] = ["pinned", "today", "yesterday", "week", "month", "older"];
  const groups = new Map<ConversationAgeGroup, AiConversation[]>();
  for (const conversation of conversations) {
    const days = calendarDaysBefore(conversation.lastUsedAt, now, timeZone);
    const group: ConversationAgeGroup = conversation.pinnedAt
      ? "pinned"
      : days === 0
        ? "today"
        : days === 1
          ? "yesterday"
          : days < 7
            ? "week"
            : days < 30
              ? "month"
              : "older";
    groups.set(group, [...(groups.get(group) ?? []), conversation]);
  }
  return order.filter((group) => groups.has(group)).map((group) => ({ group, conversations: groups.get(group)! }));
};
