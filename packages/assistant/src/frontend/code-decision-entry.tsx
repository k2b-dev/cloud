import type { AiStoredMessage } from "@k2b/cloud/ai";
import { importOnDemand } from "@k2b/cloud/browser/reload";
import { useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { codeDecisionMessages } from "./code-decision-messages";
import type { CodeDecisionPages } from "./code-decision-pages";

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
  const locale = useLocale();
  const pageText = createMemo(() => codeDecisionMessages.resolve([locale()]).t);
  const entry = props.entry;
  const messages = props.messages;
  const timeZone = props.timeZone;
  const [lines, setLines] = createSignal<Lines>();
  const [pages, setPages] = createSignal<CodeDecisionPages | null | "failed">(null);
  const pageRead = new AbortController();
  onCleanup(() => pageRead.abort());
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
  const superseded = () =>
    decision?.outcome === "activated" &&
    later().some((message) => message.meta?.codeDecision?.codeId === decision.codeId && message.meta.codeDecision.outcome === "activated");
  const hasPages = () => decision?.outcome === "activated" && !superseded() && decision.pageCount !== 0;
  onMount(() => {
    // Core says which version is the newest, as it does for the card; a failed read leaves the line as it was.
    const asks = decision && decision.outcome !== "activated" && !settled() && !automatic() ? decision : null;
    const preview = asks
      ? importOnDemand(loadActivation).then((activation) => activation?.loadCodeVersionPreview(asks.codeId, asks.versionId))
      : undefined;
    const loadedLines = importOnDemand(loadLines);
    const pageSnapshot = hasPages()
      ? loadedLines.then((loaded) => loaded?.loadCodeDecisionPages(decision!.codeId, decision!.versionId, pageRead.signal))
      : null;
    void Promise.all([loadedLines, preview, pageSnapshot]).then(([loaded, read, snapshot]) => {
      if (pageRead.signal.aborted) return;
      setPages(snapshot ?? null);
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
    <Show
      when={lines()}
      fallback={
        <div class="assistant-code-decision" data-outcome={decision?.outcome} aria-busy="true">
          <span class="assistant-code-decision__placeholder-sentence" />
          <Show when={hasPages()}>
            <div
              class="assistant-code-decision__pages assistant-code-decision__pages-pending"
              data-multiple={(decision?.pageCount ?? 1) > 1 || undefined}
              role="status"
            >
              <span>{pageText().loading}</span>
            </div>
          </Show>
        </div>
      }
    >
      {(loaded) =>
        decision ? (
          <Dynamic
            component={loaded().default}
            decision={decision}
            at={decision.at ?? entry.createdAt}
            timeZone={timeZone}
            settled={settled() || replaced()}
            automatic={automatic()}
            pages={pages()}
            superseded={superseded()}
          />
        ) : start ? (
          <Dynamic component={loaded().AssistantCodeReviewStartLine} number={startNumber()} />
        ) : null
      }
    </Show>
  );
}
