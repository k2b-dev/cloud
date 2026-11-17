import type { AiQuoteDraft } from "@k2b/cloud/ai/browser";
import { SelectionAction } from "@k2b/ui";
import type { JSX } from "solid-js";

/**
 * "Quote" at text selected in the chat, loaded with the first selection there. Gustav's finished answers and the
 * person's own messages are passages; steps, notes between them, statuses, and messages on their way are none.
 */
export default function AssistantQuoteSelection(props: {
  root: HTMLElement;
  label: string;
  onQuote: (quote: AiQuoteDraft) => void;
}): JSX.Element {
  return (
    <SelectionAction
      root={props.root}
      label={props.label}
      icon="ti ti-quote"
      within={(node) => {
        const element = node instanceof Element ? node : node.parentElement;
        return (
          element?.closest<HTMLElement>(".ai-turn__text[data-answer][data-quote-source]") ??
          element?.closest<HTMLElement>('.k2b-chat-message[data-role="user"][data-status="complete"] .ai-user-text[data-quote-source]') ??
          null
        );
      }}
      // The quoted message names the passage's source; the server checks it and says whose words they are.
      onAction={({ text, element }) =>
        props.onQuote({
          messageId: element.dataset.quoteSource!,
          from: element.matches(".ai-turn__text") ? "assistant" : "user",
          text,
        })
      }
    />
  );
}
