import type { AiStoredMessage } from "@k2b/cloud/ai";
import type { ChatComposerSuggestion } from "@k2b/ui";
import { createSignal } from "solid-js";

export type AssistantNextMessageInput = {
  conversationId: () => string | null;
  messages: () => readonly Pick<AiStoredMessage, "id" | "kind" | "message" | "suggestedNextMessage">[];
  /** A response runs, a question or approval waits, messages are queued, or this is a Project composer. */
  blocked: () => boolean;
  dismiss: (conversationId: string, messageId: string) => Promise<unknown>;
  /** Recording a dismissal failed; `retry` records it again. Until then a reload would bring the suggestion back. */
  onDismissFailed: (retry: () => void) => void;
};

/**
 * The suggested next message of the chat's latest answer, for the composer. Only the person who started that answer
 * receives it (the server projects it); it stands only while nothing else asks for their attention. Escape sets it
 * aside at once and records that on the server, so a reload keeps it dismissed; a failed record is reported with a
 * way to try again.
 */
export const createAssistantNextMessage = (input: AssistantNextMessageInput) => {
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  return (): ChatComposerSuggestion | undefined => {
    const conversationId = input.conversationId();
    if (!conversationId || input.blocked()) return undefined;
    const last = input.messages().at(-1);
    const suggestion = last?.kind === "message" && last.message.role === "assistant" ? last.suggestedNextMessage : undefined;
    if (!last || !suggestion || suggestion.dismissedAt || dismissed().has(last.id)) return undefined;
    return {
      text: suggestion.text,
      onAccept: () => {},
      onDismiss: () => {
        setDismissed((ids) => new Set(ids).add(last.id));
        const record = () => void input.dismiss(conversationId, last.id).catch(() => input.onDismissFailed(record));
        record();
      },
    };
  };
};
