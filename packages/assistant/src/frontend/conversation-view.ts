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
  // Work in progress carries the AI's plum, in every list and in the phone navigation, whose tones have no AI color.
  const spinner = "ti ti-loader-2 animate-spin motion-reduce:animate-none assistant-chat-progress";
  if (conversation.runStatus === "waiting_for_browser") {
    return {
      label: active ? t.running : t.waitingForBrowser,
      icon: active ? spinner : "ti ti-browser assistant-chat-progress",
      tone: "progress",
    };
  }
  // A chat that waits for an answer, such as an open question, carries the dot of "Waiting for you" above the composer.
  // It is drawn by CSS: the icon font has no filled glyphs.
  if (conversation.runStatus === "needs_attention") return { label: t.needsAttention, icon: "assistant-chat-waiting", tone: "attention" };
  if (conversation.runStatus === "running" || conversation.runStatus === "queued") {
    return { label: conversation.runStatus === "queued" ? t.queued : t.running, icon: spinner, tone: "progress" };
  }
  if (conversation.runStatus === "failed") return { label: t.failed, icon: "ti ti-alert-circle assistant-chat-failed", tone: "danger" };
  // A CSS dot as well, in the action color of unread marks.
  if (conversation.unreadCompletion) return { label: t.newResponse, icon: "assistant-chat-unread", tone: "accent" };
  return null;
};

/** Whether a chat's run still goes on: it cannot be marked done until it ends or is stopped. */
export const isConversationBusy = (conversation: AiConversation): boolean =>
  ["queued", "running", "needs_attention", "waiting_for_browser"].includes(conversation.runStatus);

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
