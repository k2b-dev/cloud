import type { AiConversationSource } from "@valentinkolb/cloud/ai";
import type { CloudResourceRef } from "@valentinkolb/cloud/contracts";
import type { AssistantChatContextSnapshot } from "../chat-context";

export const splitAssistantConversationSources = (items: AiConversationSource[]) => ({
  sources: items.filter((item) => item.kind === "web" || item.kind === "activity"),
  references: items.filter((item) => item.kind === "resource"),
});

const resourceTypeLabel = (type: string): string =>
  type
    .split(".")
    .filter(Boolean)
    .map((part, index) => (index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join(" ");

export const assistantResourceTypeLabel = (ref: CloudResourceRef, text: (value: string) => string = (value) => value): string => {
  if (ref.type === "core.ai.task") return text("Scheduled AI task");
  if (ref.type === "core.ai.chat") return text("AI conversation");
  return resourceTypeLabel(ref.type) || text("Cloud resource");
};

export const assistantReferenceTitle = (source: AiConversationSource, text?: (value: string) => string): string =>
  source.ref && source.title === `${source.ref.type} ${source.ref.id}` ? assistantResourceTypeLabel(source.ref, text) : source.title;

export const assistantChatContextFor = (
  chatId: string,
  snapshot: AssistantChatContextSnapshot | null | undefined,
): AssistantChatContextSnapshot | null => (snapshot?.chatId === chatId ? snapshot : null);

export const visibleAssistantReferences = (items: AiConversationSource[], chatId: string, visibleTaskId?: string) =>
  items.filter((source) => !(source.ref?.type === "core.ai.chat" && source.ref.id === chatId)
    && !(source.ref?.type === "core.ai.task" && source.ref.id === visibleTaskId));
