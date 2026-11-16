import type { AiQuoteMarker } from "@k2b/cloud/ai/browser";
import { SelectionAction } from "@k2b/ui";
import type { JSX } from "solid-js";

// The draft's quote rows share this chunk: a draft has quotes only once it loaded.
export { ChatComposerQuotes } from "@k2b/ui";

/**
 * "Quote" at text selected in the chat, loaded with the first selection there. Gustav's finished answers and the
 * person's own messages are passages; steps, notes between them, statuses, and messages on their way are none.
 */
export default function AssistantQuoteSelection(props: {
  root: HTMLElement;
  label: string;
  onQuote: (quote: AiQuoteMarker) => void;
}): JSX.Element {
  return (
    <SelectionAction
      root={props.root}
      label={props.label}
      icon="ti ti-quote"
      within={(node) => {
        const element = node instanceof Element ? node : node.parentElement;
        return (
          element?.closest<HTMLElement>(".ai-turn__text[data-answer]") ??
          element?.closest<HTMLElement>('.k2b-chat-message[data-role="user"][data-status="complete"] .ai-user-text') ??
          null
        );
      }}
      onAction={({ text, element }) => props.onQuote({ from: element.matches(".ai-turn__text") ? "assistant" : "user", text })}
    />
  );
}
