import { Chat, type ChatOutcomeLine, LocaleProvider } from "@k2b/ui";
import { createMemo, type JSX } from "solid-js";
import type { ActionCard, ActionText } from "./action-card";
import { ActionTextView } from "./action-sentence";

/**
 * The words and details of an Action approval and its outcome lines: one sentence with chips, Cloud's list of what
 * changes, the app's view blocks, and after the answer one outcome line in the same place. `ApprovalCard` draws them in
 * every place from an `ActionCard`.
 */

// ---------------------------------------------------------------------------
// Sentence
// ---------------------------------------------------------------------------

export { ActionTextView } from "./action-sentence";

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** One outcome line: what happened, in the card's sentence, with Cloud's detail under it. */
export type ActionLine = Omit<ChatOutcomeLine, "text" | "detail"> & { text: ActionText; detail?: JSX.Element };

/**
 * The line's sentence, closed with a full stop when a detail follows it: a short form such as "Not run: Create note" ends
 * without one, so the detail would read as part of it.
 */
const closedSentence = (text: ActionText): ActionText => {
  const last = text.at(-1);
  return last?.kind === "text" && /[.!?…]["“”»«]?\s*$/.test(last.text) ? text : [...text, { kind: "text", text: "." }];
};

/**
 * The outcome line of one call. Pass every line one flow can reach (running and done, or the lines of a check): they
 * share one cell, so switching between them moves nothing.
 */
export function ActionReceipt(props: {
  card: ActionCard;
  lines: Readonly<Record<string, ActionLine>>;
  current: string;
  class?: string;
  anchorId?: string | number;
}) {
  const lines = createMemo(() =>
    Object.fromEntries(
      Object.entries(props.lines).map(([key, line]) => [
        key,
        {
          ...line,
          text: <ActionTextView text={line.detail ? closedSentence(line.text) : line.text} accent={props.card.app.accent} />,
        } satisfies ChatOutcomeLine,
      ]),
    ),
  );
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Outcome class={`cloud-action-outcome ${props.class ?? ""}`} lines={lines()} current={props.current} anchorId={props.anchorId} />
    </LocaleProvider>
  );
}
