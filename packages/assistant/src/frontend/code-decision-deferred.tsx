import type { AiStoredMessage } from "@k2b/cloud/ai";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

const loadLines = () => import("./AssistantCodeDecisionLine");
type Lines = Awaited<ReturnType<typeof loadLines>>;

/**
 * The event line of a decision on a version, drawn for `meta.codeDecision` and `meta.codeReviewStart`. Its code loads
 * with the first such line, so it stays out of the first download; until then the line keeps its own height.
 * `messages` are the chat's stored messages: a later line about the same version decides whether this one still acts.
 */
export function AssistantCodeDecisionEntry(props: {
  entry: AiStoredMessage;
  messages: () => readonly AiStoredMessage[];
  timeZone: string;
}): JSX.Element {
  const entry = props.entry;
  const messages = props.messages;
  const timeZone = props.timeZone;
  const [lines, setLines] = createSignal<Lines>();
  onMount(() => void importOnDemand(loadLines).then((loaded) => loaded && setLines(() => loaded)));
  const decision = entry.meta?.codeDecision;
  const start = entry.meta?.codeReviewStart;
  const later = () => {
    const all = messages();
    const index = all.findIndex((message) => message.id === entry.id);
    return index < 0 ? [] : all.slice(index + 1);
  };
  // "Approved" is history once the person switched the version on; "changes requested" has no action while Gustav
  // revises by himself, which a following start line says.
  const settled = () =>
    decision?.outcome === "approved" &&
    later().some((message) => message.meta?.codeDecision?.versionId === decision.versionId && message.meta.codeDecision.outcome === "activated");
  const automatic = () =>
    decision?.outcome === "changes_requested" && later().some((message) => message.meta?.codeReviewStart?.versionId === decision.versionId);
  const text = () => {
    const content: unknown = (entry.message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    return (Array.isArray(content) ? content : [])
      .flatMap((part: unknown) =>
        typeof part === "object" && part && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string"
          ? [part.text]
          : [],
      )
      .join(" ");
  };
  return (
    <Show when={lines()} fallback={<div class="assistant-code-decision" aria-hidden="true" />}>
      {(loaded) =>
        decision ? (
          <Dynamic
            component={loaded().default}
            decision={decision}
            at={decision.at ?? entry.createdAt}
            timeZone={timeZone}
            settled={settled()}
            automatic={automatic()}
          />
        ) : start ? (
          <Dynamic component={loaded().AssistantCodeReviewStartLine} text={text()} />
        ) : null
      }
    </Show>
  );
}
