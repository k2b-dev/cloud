import type { AiStoredMessage } from "@k2b/cloud/ai";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { createSignal, type JSX, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

const loadLines = () => import("./AssistantCodeDecisionLine");
const loadActivation = () => import("./code-activation");
type Lines = Awaited<ReturnType<typeof loadLines>>;

/**
 * The event line of a decision on a version, drawn for `meta.codeDecision` and `meta.codeReviewStart`. Its code loads
 * with the first such line, so it stays out of the first download; until then the line keeps its own height.
 * `messages` are the chat's stored messages: a later line about the same version decides whether this one still acts.
 * A line that would act asks Core first whether a newer version replaced its version; the line then stays history,
 * because a replaced version has no action, and it appears once that answer is in, so no action comes and goes.
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
  const [replaced, setReplaced] = createSignal(false);
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
    later().some(
      (message) => message.meta?.codeDecision?.versionId === decision.versionId && message.meta.codeDecision.outcome === "activated",
    );
  const automatic = () =>
    decision?.outcome === "changes_requested" && later().some((message) => message.meta?.codeReviewStart?.versionId === decision.versionId);
  onMount(() => {
    // Core says which version is the newest, as it does for the card; a failed read leaves the line as it was.
    const asks = decision && decision.outcome !== "activated" && !settled() && !automatic() ? decision : null;
    const preview = asks
      ? importOnDemand(loadActivation).then((activation) => activation?.loadCodeVersionPreview(asks.codeId, asks.versionId))
      : undefined;
    void Promise.all([importOnDemand(loadLines), preview]).then(([loaded, read]) => {
      if (asks && read && typeof read === "object") setReplaced(read.latest > asks.number);
      if (loaded) setLines(() => loaded);
    });
  });
  // The decision line before it names the version; the start line repeats only its number.
  const startNumber = () => {
    if (!start) return null;
    const all = messages();
    const index = all.findIndex((message) => message.id === entry.id);
    const before = index < 0 ? all : all.slice(0, index);
    return before.findLast((message) => message.meta?.codeDecision?.versionId === start.versionId)?.meta?.codeDecision?.number ?? null;
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
            settled={settled() || replaced()}
            automatic={automatic()}
          />
        ) : start ? (
          <Dynamic component={loaded().AssistantCodeReviewStartLine} number={startNumber()} />
        ) : null
      }
    </Show>
  );
}
