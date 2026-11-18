import type { AiStoredMessage } from "@k2b/cloud/ai";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

const loadEntry = () => import("./code-decision-entry");
/** Keep event reads and presentation out of the initial Assistant island download. */
export function AssistantCodeDecisionEntry(props: {
  entry: AiStoredMessage;
  messages: () => readonly AiStoredMessage[];
  timeZone: string;
}): JSX.Element {
  const [entry, setEntry] = createSignal<Awaited<ReturnType<typeof loadEntry>>>();
  const decision = props.entry.meta?.codeDecision;
  const hasPages = () => {
    if (decision?.outcome !== "activated" || decision.pageCount === 0) return false;
    const messages = props.messages();
    const index = messages.findIndex((message) => message.id === props.entry.id);
    if (index < 0) return true;
    return !messages
      .slice(index + 1)
      .some((message) => message.meta?.codeDecision?.codeId === decision.codeId && message.meta.codeDecision.outcome === "activated");
  };
  onMount(() => {
    void importOnDemand(loadEntry).then((loaded) => {
      if (loaded) setEntry(() => loaded);
    });
  });
  return (
    <Show
      when={entry()}
      fallback={
        <div class="assistant-code-decision" data-outcome={decision?.outcome} aria-hidden="true">
          <span class="assistant-code-decision__placeholder-sentence" />
          <Show when={hasPages()}>
            <div
              class="assistant-code-decision__pages assistant-code-decision__pages-pending"
              data-multiple={(decision?.pageCount ?? 1) > 1 || undefined}
            />
          </Show>
        </div>
      }
    >
      {(loaded) => <Dynamic component={loaded().AssistantCodeDecisionEntry} {...props} />}
    </Show>
  );
}
