import { For, type JSX } from "solid-js";
import { MessageQuote } from "../content/MessageQuote";
import { useQuoteMessages } from "../content/quote-messages";
import type { ChatComposerQuote } from "./ChatComposer";

/**
 * The passages a draft quotes, for `ChatComposer`'s `above`: each with the quote icon, at most two lines, its author,
 * and a button that removes it. Several scroll in their own area. Load it with the first quote, so composers that never
 * quote carry none of its code.
 */
export function ChatComposerQuotes(props: { quotes: readonly ChatComposerQuote[] }): JSX.Element {
  const t = useQuoteMessages();
  return (
    <div class="k2b-chat-composer__quotes">
      <For each={props.quotes}>
        {(quote) => (
          <div class="k2b-chat-composer__quote">
            <MessageQuote quote={quote} />
            <button
              type="button"
              class="k2b-chat-composer__icon-action k2b-chat-composer__quote-remove"
              aria-label={t().removeQuote}
              title={t().removeQuote}
              // A press keeps the focus in the field, as the composer's other buttons do.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => quote.onRemove()}
            >
              <i class="ti ti-x" aria-hidden="true" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
