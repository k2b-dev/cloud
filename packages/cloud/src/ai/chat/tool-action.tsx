import { dates } from "@k2b/stdlib";
import { Button, ButtonLink, type ChatDecisionState, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { capabilityUnknownText } from "../../_internal/capability-sentences";
import { CapabilityActionReceiptSchema } from "../../contracts/capabilities";
import { AI_TOOL_CHECK_STALE_MS, type AiActionCheck } from "../action-review";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome } from "../tool-wording";
import { type ActionCard, type ActionText, actionReceiptText, toolActionCard } from "./action-card";
import { actionMessages } from "./action-messages";
import { type ActionLine, ActionQuestion, ActionReceipt } from "./action-question";
import { useReaderTimeZone } from "./action-sentences";
import { useAiChatActions } from "./message-actions";
import { capabilityErrorDescription, isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import type { AiTurnActionState, AiTurnPhase } from "./turn-layout";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * Codes that say Cloud could not see whether the Action happened; nothing may repeat it blindly. Core reports them as
 * ACTION_OUTCOME_UNKNOWN now; older history still carries the transport codes, which prove nothing either.
 */
const UNKNOWN_CODES = new Set([
  "ACTION_OUTCOME_UNKNOWN",
  "IDEMPOTENCY_UNCERTAIN",
  "IDEMPOTENCY_IN_PROGRESS",
  "DEADLINE_EXCEEDED",
  "APP_UNAVAILABLE",
  "REQUEST_CANCELLED",
  "INVALID_APP_RESPONSE",
  "RESPONSE_TOO_LARGE",
  "INTERNAL",
]);

/** The framework code of a failed call, from `CODE: message` or a structured error. */
export const toolErrorCode = (result: unknown): string | null => {
  if (typeof result === "string") return /^([A-Z][A-Z0-9_]{2,}):/.exec(result.trim())?.[1] ?? null;
  if (isRecord(result) && typeof result.code === "string") return result.code;
  return null;
};

/** The message without its code, so the detail under a line reads as a sentence. */
const errorDetail = (result: unknown): string => capabilityErrorDescription(result).replace(/^[A-Z][A-Z0-9_]{2,}:\s*/, "");

/** The application's own short summary of a result, if it fits on one line. */
const resultSummary = (block: ToolBlock): string | undefined => {
  const value = isRecord(block.result) ? block.result.summary : undefined;
  return typeof value === "string" && value.trim() && value.trim().length <= 500 ? value.trim() : undefined;
};

/** The words of a call without an app sentence: Cloud's frames around its catalog sentence or title. */
export const legacyOutcomeWords = (block: ToolBlock, locale: string, timeZone: string) => (subject: string) => {
  const t = aiChatMessages(locale);
  const capability = block.presentation?.kind === "capability";
  return {
    running: t.receiptRunning({ title: subject }),
    // The app's done sentence, else its own summary of the call, else Cloud's frame.
    done:
      toolOutcome(block, "done", locale, timeZone) ??
      resultSummary(block) ??
      (capability ? t.receiptDone({ title: subject }) : t.receiptApproved({ title: subject })),
    rejected: toolOutcome(block, "rejected", locale, timeZone) ?? t.receiptRejected({ title: subject }),
    notRun: toolOutcome(block, "notRun", locale, timeZone) ?? t.receiptNotRun({ title: subject, stopped: false }),
    unknown: capabilityUnknownText(subject, locale),
    unknownStill: capabilityUnknownText(subject, locale, true),
  };
};

/** The card of one tool block in the reader's locale and zone. */
export const useToolActionCard = (block: () => ToolBlock): (() => ActionCard) => {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  return createMemo(() =>
    toolActionCard(block(), { locale: locale(), timeZone, outcome: legacyOutcomeWords(block(), locale(), timeZone) }),
  );
};

type LocalAnswer = "approve" | "decline" | null;

/** Which outcome a call reached and what the person did here, as one key per flow. */
type Flow =
  | { flow: "run"; current: "running" | "done" }
  | { flow: "rejected" }
  | { flow: "expired" }
  | { flow: "stopped" }
  | { flow: "error" }
  | { flow: "lost" }
  | { flow: "check"; current: "checking" | "checkedDone" | "checkedNotDone" | "pending" | "checkFailed" | "noCheck" };

const flowOf = (input: {
  block: ToolBlock;
  state: AiTurnActionState | "open";
  answer: LocalAnswer;
  lost: boolean;
  check: AiActionCheck | undefined;
  phase?: AiTurnPhase;
  /** The stored claim of a running check is older than the stale limit. */
  staleCheck?: boolean;
}): Flow => {
  const { block, check } = input;
  // A lost answer holds only while the question still waits; the server's own outcome always wins over it.
  if (input.lost && block.status === "awaiting_approval") return { flow: "lost" };
  if (block.status === "awaiting_approval") return input.answer === "decline" ? { flow: "rejected" } : { flow: "run", current: "running" };
  // A check runs only inside a live turn and only for a while; one that history still shows as running, or whose
  // claim went stale, was cut off and is open again.
  if (check?.state === "checking")
    return input.staleCheck || input.phase === "completed" || input.phase === "stopped" || input.phase === "failed"
      ? { flow: "check", current: "pending" }
      : { flow: "check", current: "checking" };
  if (check?.state === "done") return { flow: "check", current: "checkedDone" };
  if (check?.state === "not_done") return { flow: "check", current: "checkedNotDone" };
  // An open check stays open whatever the call's own end looked like, such as a turn stopped while it checked.
  if (check?.state === "pending") return { flow: "check", current: "pending" };
  if (check?.state === "failed") return { flow: "check", current: "checkFailed" };
  if (input.state === "rejected") return { flow: "rejected" };
  // A question nobody answered expired; one the person's stop left open, or a call it cut off, was stopped.
  if (input.state === "not_run") return block.approved === false && input.phase !== "stopped" ? { flow: "expired" } : { flow: "stopped" };
  if (input.state === "failed") {
    const code = toolErrorCode(block.result);
    if (code === "ACTION_NOT_DONE") return { flow: "check", current: "checkedNotDone" };
    if (code && UNKNOWN_CODES.has(code)) {
      return { flow: "check", current: "noCheck" };
    }
    return { flow: "error" };
  }
  if (input.state === "done") return { flow: "run", current: "done" };
  return { flow: "run", current: "running" };
};

/**
 * One call in place 4: the open question, then, in the same element, its outcome line. An answer here collapses the
 * question at once to the running or declined line and moves the focus there; the server's outcome replaces it in the
 * same cell. A call that never asked shows only its outcome line.
 */
export function ToolActionView(props: {
  block: ToolBlock;
  turnId: string;
  /** The block's place-4 state from the turn layout; `open` while it waits for this person. */
  state: AiTurnActionState | "open";
  phase?: AiTurnPhase;
}) {
  const actions = useAiChatActions();
  const timeZone = useReaderTimeZone();
  const card = useToolActionCard(() => props.block);
  const t = () => actionMessages(card().locale);
  const [answer, setAnswer] = createSignal<LocalAnswer>(null);
  const [lost, setLost] = createSignal(false);
  const [elsewhere, setElsewhere] = createSignal(false);
  const [checked, setChecked] = createSignal<AiActionCheck | null>(null);
  const [checking, setChecking] = createSignal(false);
  const [checkError, setCheckError] = createSignal(false);
  // A new approval for the same block, such as the next website a code run asks for, starts a fresh question. `on`
  // runs again whenever the block changes, so the call id is compared by hand.
  let answeredCall = props.block.callId;
  createEffect(
    on(
      () => props.block.callId,
      (callId) => {
        if (callId === answeredCall) return;
        answeredCall = callId;
        setAnswer(null);
        setLost(false);
        setElsewhere(false);
      },
    ),
  );
  // A question that leaves this window open without an answer here was decided somewhere else. (`on` with `defer`
  // never passes the first value as the previous one, so this effect runs from the start.)
  createEffect(
    on(
      () => props.block.status === "awaiting_approval",
      (open, wasOpen) => {
        if (wasOpen === true && !open && answer() === null) setElsewhere(true);
        if (!open) setLost(false);
      },
    ),
  );
  const request = () => ({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
  const submit = async (input: { approved: boolean; remember?: "chat" }) => {
    if (answer() !== null || !actions.onApproval) return;
    // A failure belongs to the question it answered: the next question of the same block may already show.
    const submitted = props.block.callId;
    setLost(false);
    setAnswer(input.approved ? "approve" : "decline");
    try {
      await actions.onApproval(request(), input);
    } catch {
      if (props.block.callId === submitted) setLost(true);
    }
  };
  const reopen = () => {
    setLost(false);
    setAnswer(null);
  };
  // The stored check wins once it is settled or newer than the one this card asked for, so another window's check
  // or a reload is never hidden behind an older local answer.
  const check = () => {
    const local = checked();
    const stored = props.block.check;
    if (!local || !stored) return local ?? stored;
    if (stored.state === "done" || stored.state === "not_done") return stored;
    return (stored.at ?? "") > (local.at ?? "") ? stored : local;
  };
  // A stored claim of a running check expires at a known moment; past it the card offers to check again.
  const [now, setNow] = createSignal(Date.now());
  const claimAge = () => {
    const at = check()?.state === "checking" ? check()?.at : undefined;
    return at ? now() - Date.parse(at) : null;
  };
  createEffect(() => {
    const age = claimAge();
    if (age === null || age > AI_TOOL_CHECK_STALE_MS) return;
    const timer = setTimeout(() => setNow(Date.now()), AI_TOOL_CHECK_STALE_MS - age + 50);
    onCleanup(() => clearTimeout(timer));
  });
  const flow = createMemo(() =>
    flowOf({
      block: props.block,
      state: props.state,
      answer: answer(),
      lost: lost(),
      check: check(),
      phase: props.phase,
      staleCheck: (claimAge() ?? 0) > AI_TOOL_CHECK_STALE_MS,
    }),
  );
  const decisionState = (): ChatDecisionState => {
    if (props.block.status === "awaiting_approval") return answer() === null && !lost() ? "open" : "sending";
    return flow().flow === "expired" ? "expired" : "decided";
  };
  const time = () => (props.block.at ? dates.formatTime(props.block.at, { locale: card().locale, timeZone }) : undefined);
  // A line that waits hidden in the cell reserves room for the time it will show, so it cannot wrap later. The widest
  // time of the day stands in until the real one is known.
  const reservedTime = () => time() ?? dates.formatTime("2000-01-01T23:58:00.000Z", { locale: card().locale, timeZone: "UTC" });
  const receiptText = (): ActionText => {
    const result = isRecord(props.block.result) ? props.block.result : null;
    const receipt = CapabilityActionReceiptSchema.safeParse(result?.receipt);
    return receipt.success ? actionReceiptText(receipt.data, card(), timeZone) : card().forms.done;
  };
  const checkAgain = async () => {
    if (!actions.onCheckAction || checking()) return;
    setChecking(true);
    setCheckError(false);
    try {
      setChecked(await actions.onCheckAction(request()));
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  };
  const unknownActions = (withCheck: boolean): JSX.Element => (
    <>
      <Show when={card().open}>
        {(href) => (
          <ButtonLink href={href()} size="sm" variant="subtle">
            <i class={card().app.icon} aria-hidden="true" />
            {t().openIn({ app: card().app.name })}
          </ButtonLink>
        )}
      </Show>
      <Show when={withCheck && card().hasCheck && actions.onCheckAction}>
        <Button size="sm" variant="subtle" loading={checking()} onClick={() => void checkAgain()}>
          <i class="ti ti-refresh" aria-hidden="true" />
          {t().checkAgain}
        </Button>
      </Show>
    </>
  );
  const askAgain = () =>
    actions.onContinueTurn
      ? { label: t().askAgain, onSelect: () => actions.onContinueTurn?.(t().askAgainMessage({ sentence: card().short })) }
      : undefined;
  const lines = createMemo((): Record<string, ActionLine> => {
    const current = flow();
    const c = card();
    const words = t();
    switch (current.flow) {
      case "run":
        return {
          running: { tone: "running", text: c.forms.running },
          done: {
            tone: "done",
            text: receiptText(),
            time: current.current === "done" ? time() : reservedTime(),
            ...(elsewhere() ? { detail: words.approvedElsewhere } : {}),
            ...(resultLinks(props.block).length > 0 ? { actions: <ResultLinks links={resultLinks(props.block)} align="start" /> } : {}),
          },
        };
      case "rejected": {
        const rejected: ActionLine = {
          tone: "off",
          text: c.forms.rejected,
          detail: elsewhere() ? words.declinedElsewhere : words.declined,
          time: time(),
        };
        // The time arrives with the server's answer; a hidden twin with room for it keeps the line from growing then.
        return time() ? { rejected } : { rejected, rejectedTimed: { ...rejected, time: reservedTime() } };
      }
      case "expired":
        return { expired: { tone: "off", icon: "ti ti-clock-x", text: c.forms.notRun, detail: words.expired, action: askAgain() } };
      case "stopped":
        return { stopped: { tone: "off", text: c.forms.notRun, detail: words.stopped } };
      case "error":
        return {
          error: {
            tone: "error",
            text: c.forms.notRun,
            detail: errorDetail(props.block.result) || aiChatMessages(c.locale).actionNotCompleted,
            time: time(),
          },
        };
      case "lost":
        return {
          lost: {
            tone: "warning",
            icon: "ti ti-alert-triangle",
            text: [...splitFrame(words.lostAbout({ subject: "\u0000" }), c.subject)],
            detail: words.lostDetail,
            action: { label: words.answerAgain, onSelect: reopen },
          },
        };
      case "check": {
        const app = c.app.name;
        const settled = check()?.receipt ? actionReceiptText(check()!.receipt!, c, timeZone) : c.forms.done;
        const failedDetail = checkError() ? words.checkAgainFailed : undefined;
        // Only the lines this check can still reach share the cell: a settled outcome stands alone, an open one keeps
        // the room the next check needs.
        const all: Record<string, ActionLine> = {
          checking: { tone: "running", text: c.forms.unknown, detail: words.checking({ app }) },
          checkedDone: { tone: "done", text: settled, detail: words.checkedDone({ app }), time: time() },
          checkedNotDone: { tone: "off", text: c.forms.notRun, detail: words.checkedNotDone({ app }), time: time() },
          pending: {
            tone: "warning",
            icon: "ti ti-help-circle",
            text: c.forms.unknown,
            detail: failedDetail ?? words.checkPending({ app }),
            actions: unknownActions(true),
          },
          checkFailed: {
            tone: "warning",
            icon: "ti ti-help-circle",
            text: c.forms.unknownStill,
            detail: failedDetail ?? words.checkFailed({ app }),
            actions: unknownActions(true),
          },
          noCheck: {
            tone: "warning",
            icon: "ti ti-help-circle",
            text: c.forms.unknown,
            detail: words.noCheck,
            ...(c.open ? { actions: unknownActions(false) } : {}),
          },
        };
        const reachable: Record<typeof current.current, (keyof typeof all)[]> = {
          checking: ["checking", "checkedDone", "checkedNotDone", "pending", "checkFailed"],
          pending: ["pending", "checkFailed", "checkedDone", "checkedNotDone"],
          checkFailed: ["pending", "checkFailed", "checkedDone", "checkedNotDone"],
          checkedDone: ["checkedDone"],
          checkedNotDone: ["checkedNotDone"],
          noCheck: ["noCheck"],
        };
        return Object.fromEntries(reachable[current.current].map((key) => [key, all[key]!]));
      }
    }
  });
  const currentKey = () => {
    const current = flow();
    return "current" in current ? current.current : current.flow;
  };
  const unavailable = () => {
    if (!actions.onApproval) return actionMessages(card().locale).unavailable;
    if (actions.actionDisabled?.()) return actionMessages(card().locale).stopping;
    return undefined;
  };
  const remember = () => {
    const approval = props.block.approval;
    if (!approval?.allowChat) return undefined;
    return {
      label: approval.website ? t().rememberWebsite : t().remember,
      onSelect: () => submit({ approved: true, remember: "chat" }),
    };
  };
  return (
    <ActionQuestion
      card={card()}
      state={decisionState()}
      timeZone={timeZone}
      anchorId={props.block.id}
      unavailable={unavailable()}
      remember={remember()}
      onConfirm={() => submit({ approved: true })}
      onDecline={() => submit({ approved: false })}
      outcome={<ActionReceipt card={card()} lines={lines()} current={currentKey()} />}
    />
  );
}

/** Links a result offers, limited to paths inside this Cloud. */
export const resultLinks = (block: ToolBlock): Record<string, unknown>[] => {
  const value = (isRecord(block.result) ? block.result : null)?.links;
  return Array.isArray(value)
    ? value.filter(
        (link): link is Record<string, unknown> =>
          isRecord(link) && typeof link.href === "string" && /^\/(?![\\/])[^\\\u0000-\u001f\u007f]*$/.test(link.href),
      )
    : [];
};

export function ResultLinks(props: { links: Record<string, unknown>[]; align?: "start" | "end" }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const label = (link: Record<string, unknown>) =>
    typeof link.title === "string" ? link.title : link.rel === "edit" ? t().edit : link.rel === "download" ? t().download : t().open;
  return (
    <span class={`flex min-w-0 flex-wrap items-center gap-1 ${props.align === "start" ? "justify-start" : "justify-end"}`}>
      <For each={props.links}>
        {(link) => (
          <ButtonLink
            class="ai-chat-result-link"
            href={String(link.href)}
            target="_blank"
            rel="noopener noreferrer"
            size="xs"
            variant="ghost"
          >
            {label(link)}
          </ButtonLink>
        )}
      </For>
    </span>
  );
}

/** Puts a sentence into a frame such as "Your answer about \u0000 didn't arrive." */
const splitFrame = (frame: string, inner: ActionText): ActionText => {
  const [before = "", after = ""] = frame.split("\u0000");
  return [
    ...(before ? [{ kind: "text" as const, text: before }] : []),
    ...inner,
    ...(after ? [{ kind: "text" as const, text: after }] : []),
  ];
};
