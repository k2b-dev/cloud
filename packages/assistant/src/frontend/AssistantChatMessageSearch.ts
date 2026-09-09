import { openSpotlightSearch, type PromptSearchItem } from "@k2b/ui";
import type { AiConversationTimelineEntry, AiStoredMessage } from "@k2b/cloud/ai";
import { assistantApi } from "../api/client";
import { assistantMessages } from "./messages";

const messageText = (stored: AiStoredMessage): string => {
  if (stored.message.role === "tool_result") return "";
  return stored.message.content
    .flatMap((part) => (typeof part === "string" ? [part] : part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
};

const messageKind = (message: AiStoredMessage, locale = "en"): { label: string; icon: string } => {
  const t = assistantMessages.resolve([locale]).t;
  if (message.kind === "summary") return { label: t.contextSummary, icon: "ti ti-brain" };
  if (message.message.role === "user") return { label: t.you, icon: "ti ti-user" };
  if (message.message.role === "assistant") return { label: t.assistant, icon: "ti ti-sparkles" };
  return { label: t.system, icon: "ti ti-info-circle" };
};

export const assistantMessageSearchItem = (message: AiStoredMessage, locale = "en"): PromptSearchItem<AiStoredMessage> => {
  const t = assistantMessages.resolve([locale]).t;
  const kind = messageKind(message, locale);
  return {
    value: message,
    label: messageText(message) || `${kind.label} ${t.message}`,
    desc: `${kind.label} · ${t.messageNumber({ seq: message.seq })}`,
    icon: kind.icon,
  };
};

export const assistantMessageAnchorSeq = (message: AiStoredMessage, timeline: readonly AiConversationTimelineEntry[]): number => {
  if (message.message.role === "user") return message.seq;
  const sameTurn = message.loopId ? timeline.find((entry) => entry.loopId === message.loopId) : undefined;
  if (sameTurn) return sameTurn.seq;
  return timeline.findLast((entry) => entry.seq <= message.seq)?.seq ?? message.seq;
};

export const openAssistantChatMessageSearch = async (conversationId: string, locale = "en"): Promise<AiStoredMessage | undefined> => {
  const t = assistantMessages.resolve([locale]).t;
  const selected = await openSpotlightSearch<AiStoredMessage>({
    title: t.searchThisChat,
    placeholder: t.searchMessages,
    minQueryLength: 1,
    emptyText: t.typeToSearchChat,
    noResultsText: t.noMatchingMessages,
    resolve: async ({ query, abortSignal }) => {
      const page = await assistantApi.searchMessages({
        conversationId,
        q: query.trim(),
        limit: 20,
        signal: abortSignal,
      });
      return page.messages.map((message) => assistantMessageSearchItem(message, locale));
    },
  });
  return selected?.value;
};
