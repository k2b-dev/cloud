import {
  Chat,
  type ChatDecisionAnswer,
  type ChatDecisionFact,
  type ChatDecisionReason,
  type ChatOutcomeTone,
  LocaleProvider,
  Skeleton,
} from "@k2b/ui";
import { createMemo, type JSX } from "solid-js";
import type { ActionText } from "../ai/chat/action-card";
import { actionMessages } from "../ai/chat/action-messages";
import { ActionTextView } from "../ai/chat/action-question";

/** `loading` shows the head with the word "Loading" and placeholder lines; the others are the question's states. */
export type ApprovalFrameState = "open" | "sending" | "decided" | "expired" | "loading";

/** The state as a word at the end of the head. The frame chooses the icon from the tone, so a state looks alike everywhere. */
export type ApprovalFrameStatus = { tone: ChatOutcomeTone | "expired"; label: string };

/**
 * The drawing part of every approval: head "Approval · App" with its state, one sentence, the reason, the details on
 * the surface colour, notes, and the answer row. It knows no Capability: the Capability approval (`ApprovalCard`), a
 * Code version, and an admin review fill it with data. It takes no class, style, or variant
 * (`scripts/checks/approval-card-calls.ts`), sets its own AI colour scope, and keeps its answer row at the bottom of
 * the view while a tall question is in view.
 */
export type ApprovalFrameProps = {
  /** The language of Cloud's own words on the frame, such as "Approval" and "Loading". */
  locale: string;
  state: ApprovalFrameState;
  /** `edit` is the same frame while the person still changes its details: "Draft", a raised island, editable fields. */
  mode?: "approve" | "edit";
  /** Who asks: the app's name and icon, its icon tile in `accent`. */
  source: { name: string; icon: string; accent?: string };
  /** Shown in every state but an open question; a `loading` frame says "Loading" by itself. */
  status?: ApprovalFrameStatus;
  /** The question, or in a closed state nothing: `outcome` takes its place. Text and chips, never markup. */
  sentence?: ActionText;
  /** Why it is asked, in the platform's words. */
  reason: ChatDecisionReason;
  /** The thing itself under its label, such as "Details from Mail"; `note` is one quiet line under it. */
  details?: { label: string; content: JSX.Element; note?: { text: string; icon?: string } };
  /** Lines after the details, such as what happens now and what holds until then. */
  notes?: readonly ChatDecisionReason[];
  /** Quiet facts at the start of the answer row; `success` and `warning` colour a result such as tried examples. */
  meta?: readonly ChatDecisionFact[];
  /** The one filled answer. */
  confirm?: ChatDecisionAnswer;
  decline?: ChatDecisionAnswer;
  /** A quiet text answer, such as "Change". */
  back?: ChatDecisionAnswer;
  /** A quiet text link, such as "See everything". */
  link?: { label: string; href: string };
  /** Further answers on the surface colour, such as "Withdraw". */
  more?: readonly ChatDecisionAnswer[];
  /** "Don't ask again here": checked, `confirm` calls this answer instead. */
  remember?: ChatDecisionAnswer;
  /** Turns the confirming answers off; this reason replaces `reason`. */
  unavailable?: ChatDecisionReason;
  /** Turns every answer off until it clears, such as without a connection. */
  waiting?: ChatDecisionReason;
  /** The result line of every closed state, usually `Chat.Outcome`. */
  outcome?: JSX.Element;
  onAnswerError?: (error: unknown) => void;
  anchorId?: string | number;
};

const STATUS_ICONS: Record<ApprovalFrameStatus["tone"], string> = {
  running: "ti ti-loader-2",
  done: "ti ti-circle-check",
  off: "ti ti-circle-x",
  waiting: "ti ti-clock",
  warning: "ti ti-alert-triangle",
  error: "ti ti-alert-circle",
  expired: "ti ti-clock-x",
};

export function ApprovalFrame(props: ApprovalFrameProps): JSX.Element {
  const t = () => actionMessages(props.locale);
  // A memo, so moving between closed states (sending, decided) does not rebuild the outcome line: it keeps its node,
  // its focus and its live region while only its words change.
  const loading = createMemo(() => props.state === "loading");
  // Passed as a memo, never as an expression: the decision then draws its outcome line before its focus effect runs.
  const state = createMemo(() => (props.state === "loading" ? "decided" : props.state));
  const editing = createMemo(() => props.mode === "edit" && props.state === "open");
  const mode = createMemo(() => (editing() ? "edit" : "approve"));
  const status = createMemo(() => {
    if (loading()) return { label: t().statusLoading, icon: STATUS_ICONS.running, tone: "running" as const };
    const given = props.status;
    if (!given) return undefined;
    return { label: given.label, icon: STATUS_ICONS[given.tone], tone: given.tone === "expired" ? ("off" as const) : given.tone };
  });
  return (
    <LocaleProvider locale={props.locale}>
      <Chat.Decision
        state={state()}
        mode={mode()}
        anchorId={props.anchorId}
        kind={editing() ? { label: t().draftKind, icon: "ti ti-pencil" } : { label: t().approvalKind, icon: "ti ti-shield-check" }}
        source={props.source}
        status={status()}
        sentence={<ActionTextView text={props.sentence ?? []} accent={props.source.accent} />}
        reason={props.reason}
        details={props.details}
        notes={props.notes}
        meta={props.meta}
        confirm={props.confirm}
        decline={props.decline}
        back={props.back}
        link={props.link}
        more={props.more}
        remember={props.remember}
        unavailable={props.unavailable}
        waiting={props.waiting}
        onAnswerError={props.onAnswerError}
        outcome={
          loading() ? (
            <div class="cloud-approval-frame__loading" aria-busy="true">
              <Skeleton />
              <Skeleton />
            </div>
          ) : (
            props.outcome
          )
        }
      />
    </LocaleProvider>
  );
}
