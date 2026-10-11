import { markdownReferenceIcon } from "@k2b/ui";
import { Show } from "solid-js";
import type { CloudAiViewReference } from "../view-block";
import { useAiChatActions } from "./message-actions";

/**
 * A Cloud object a view names. It carries no URL: the host resolves it on click with the viewer's access and confirms
 * before it opens. It looks like a reference to Cloud content in Markdown, a calm pill, and stays text without a host.
 * A Cloud reference names an object of the owning app, not a kind the chat knows, such as a task or an event, so the
 * pill keeps the neutral page icon that relative links in chat Markdown also show. Without a reference it only takes
 * the pill's room, for a hidden copy that reserves it.
 */
export function ReferenceText(props: { text: string; reference?: CloudAiViewReference }) {
  const actions = useAiChatActions();
  return (
    <Show when={actions.onOpenReference} fallback={props.text}>
      {(open) => (
        <button
          type="button"
          // The pill's fill reaches past the text without making a compact table row taller than the one reserved.
          class="k2b-reference -my-[0.125em] cursor-pointer text-left"
          data-reference="page"
          onClick={() => {
            const reference = props.reference;
            if (reference) open()(props.text, { type: reference.type, id: reference.id });
          }}
        >
          <i class={`k2b-reference__icon ti ${markdownReferenceIcon("page")}`} aria-hidden="true" />
          {props.text}
        </button>
      )}
    </Show>
  );
}
