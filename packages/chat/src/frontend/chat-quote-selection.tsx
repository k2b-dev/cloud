import { SelectionAction, toast } from "@k2b/ui";
import type { JSX } from "solid-js";
import { MAX_MESSAGE_REFS, MESSAGE_MAX_CODE_POINTS } from "../service/contracts";
import type { ChatFeedItem } from "./ChatConversation";

/** A passage the draft quotes. All of a draft's quotes and its reply lie in one thread, which the message goes to. */
export type DraftQuote = { key: string; id: string; author: string; text: string; thread: string };

export const itemThread = (item: Pick<ChatFeedItem, "thread">) => item.thread ?? "general";

/**
 * The draft's quotes with a new passage of `item` at the end. A passage from another thread than the draft's quotes or
 * reply replaces them, with a calm notice; ten passages of at most a tenth of a message each always fit one message.
 */
export const addQuote = (
  quotes: readonly DraftQuote[],
  reply: ChatFeedItem | null,
  item: ChatFeedItem,
  text: string,
  notice: string,
): { quotes: DraftQuote[]; keepReply: boolean } | null => {
  if (!item.messageId) return null;
  const id = item.messageId;
  const thread = itemThread(item);
  const elsewhere = quotes.length > 0 && quotes[0]!.thread !== thread;
  const keepReply = !reply || itemThread(reply) === thread;
  if (elsewhere || !keepReply) toast(notice, { iconClass: "ti ti-info-circle" });
  const kept = elsewhere ? [] : quotes.filter((entry) => entry.id !== id || entry.text !== text);
  const passage = [...text].slice(0, MESSAGE_MAX_CODE_POINTS / MAX_MESSAGE_REFS).join("");
  return {
    quotes: [...kept, { key: crypto.randomUUID(), id, author: item.authorName, text: passage, thread }].slice(-MAX_MESSAGE_REFS),
    keepReply,
  };
};

// "Quote" at selected text loads with a reader's first selection in the history, outside Chat's first script.
export default function ChatQuoteSelection(props: {
  root: HTMLElement;
  label: string;
  /** The message's feed key and the selected passage. */
  onQuote: (key: string, text: string) => void;
}): JSX.Element {
  return (
    <SelectionAction
      root={props.root}
      label={props.label}
      icon="ti ti-quote"
      // One stored message's text at a time; names, times, quotes, cards and sends on their way are no passage.
      within={(node) => {
        const text = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".k2b-message-row__text");
        return text?.closest('.k2b-message-row:is([data-status="pending"], [data-status="failed"])') ? null : text;
      }}
      onAction={({ text, element }) => {
        const key = element.closest<HTMLElement>(".k2b-virtual-feed__item")?.dataset.key;
        if (key) props.onQuote(key, text);
      }}
    />
  );
}
