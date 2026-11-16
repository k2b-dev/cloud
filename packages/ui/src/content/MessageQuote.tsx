import { type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useQuoteMessages } from "./quote-messages";

/** A quoted passage as a message and the composer show it: icon, at most two lines, and its author. */
export function MessageQuote(props: { quote: { author: string; text: string; onSelect?: () => void } }): JSX.Element {
  const t = useQuoteMessages();
  return (
    <Dynamic
      component={props.quote.onSelect ? "button" : "div"}
      type={props.quote.onSelect ? "button" : undefined}
      class="k2b-message-quote"
      onClick={() => props.quote.onSelect?.()}
    >
      <i class="ti ti-quote" aria-hidden="true" />
      <span class="k2b-message-quote__content">
        <Show when={props.quote.author}>
          <span class="k2b-sr-only">
            {t().quoteFrom} {props.quote.author}:{" "}
          </span>
        </Show>
        <span class="k2b-message-quote__text">{props.quote.text}</span>
        <span class="k2b-message-quote__author" aria-hidden="true">
          {props.quote.author}
        </span>
      </span>
    </Dynamic>
  );
}
