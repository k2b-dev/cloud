import { Button, Chat, type ChatActivityInfo, type ChatActivityMetaTone, useLocale } from "@k2b/ui";
import { children, createContext, createMemo, createSignal, For, type JSX, Show, useContext } from "solid-js";
import { type AiActionCheck, preferredActionCheck } from "../action-review";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome, toolSubject, useReaderTimeZone } from "./action-sentences";
import { useAiChatActions } from "./message-actions";
import { aiToolIcon, displayToolName, isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { useToolActionCard } from "./tool-action";
import { waitsForUser } from "./turn-layout";
import { WebsiteReceipts, websiteReceipts } from "./web-tools";
import { stepFailure } from "./work-summary";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type Messages = ReturnType<typeof aiChatMessages>;

/**
 * Calls whose step still shows its own detail view: code tools, whose steps feat/code words as a progress of their own,
 * and image inspections, whose step shows the image. Every other call is a step in words.
 */
export const keepsStepDetail = (name: string): boolean => name.startsWith("code_") || name === "view_image";

const resultSummary = (block: ToolBlock): string => {
  const value = isRecord(block.result) ? block.result.summary : undefined;
  return typeof value === "string" && value.trim().length <= 500 ? value.trim() : "";
};

/** Why a call did not go through, in the reader's words; the app's codes and messages stay in the data. */
const failureReason = (block: ToolBlock, t: Messages): string => {
  const kind = stepFailure(block);
  return kind === "denied"
    ? t.stepNoAccess
    : kind === "not_found"
      ? t.stepNotFound
      : kind === "timeout"
        ? t.stepTimedOut
        : t.stepDidNotWork;
};

/** What the opened work knows about its turn, for each of its steps. */
export type AiWorkContextValue = {
  /** Whether the turn went on after a step, so a failed step says "Went on without this result" only when it did. */
  followed: (id: string) => boolean;
  /** How the turn ended when it did not end normally; a call still running then was stopped or cut off with it. */
  ending: () => "stopped" | "failed" | null;
  /** The running step's time on the work clock, formatted, while the turn works. */
  liveDuration: () => string | undefined;
  /** The turn, for a step that offers to check an outcome Cloud could not see. */
  turnId: () => string | undefined;
};

export const AiWorkContext = createContext<AiWorkContextValue>({
  followed: () => false,
  ending: () => null,
  liveDuration: () => undefined,
  turnId: () => undefined,
});

/** A step's outcome as one word in the meta column, in its colour. A step that went through says nothing there. */
export type AiStepOutcome = { word: string; tone?: ChatActivityMetaTone };

export const stepOutcome = (
  block: ToolBlock,
  t: Messages,
  ending: "stopped" | "failed" | null,
  check: AiActionCheck | undefined,
): AiStepOutcome | null => {
  if (waitsForUser(block)) return { word: t.stepOutcomeWaiting, tone: "ai" };
  if (block.status === "rejected") return { word: t.stepOutcomeRejected };
  // A call still running or running in the browser on its own when the turn ended was stopped or cut off with it.
  if (block.status === "running" || block.status === "awaiting_client")
    return ending ? { word: ending === "stopped" ? t.stepOutcomeStopped : t.stepOutcomeCancelled } : null;
  const failure = stepFailure(block);
  // A check settles an unclear outcome: done went through, not done did not happen.
  if (failure === "unknown" && check?.state === "done") return null;
  if (failure === "unknown" && check?.state === "not_done") return { word: t.stepOutcomeNotDone, tone: "danger" };
  if (failure === "unknown") return { word: t.stepOutcomeUnclear, tone: "warning" };
  if (failure === "denied") return { word: t.stepOutcomeNoAccess, tone: "warning" };
  return failure ? { word: t.stepOutcomeFailed, tone: "danger" } : null;
};

/** The file name of a path; a step never shows a path. */
const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1) || value;

/** What a call acts on when it has no sentence of its own: the file, name, query, or title it was given. */
const target = (block: ToolBlock): string => {
  const args = isRecord(block.args) ? block.args : {};
  if (typeof args.path === "string" && args.path.trim()) return basename(args.path.trim());
  const value = [args.name, args.query, args.title].find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value.trim() : "";
};

/**
 * "Check status" in the card of a step whose outcome Cloud could not see. It asks the app once per press, like the
 * question's own check; Gustav never repeats the step on its own. Only an app that declares a check offers it.
 */
function StepCheck(props: { block: ToolBlock; turnId: string; onChecked: (check: AiActionCheck) => void }): JSX.Element {
  const locale = useLocale();
  const actions = useAiChatActions();
  const card = useToolActionCard(() => props.block);
  const [checking, setChecking] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const check = async (button: HTMLElement) => {
    if (!actions.onCheckAction || checking()) return;
    setChecking(true);
    setFailed(false);
    try {
      const check = await actions.onCheckAction({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
      // A settled outcome removes this button; the focus stays in the card, which now says what the check found.
      if (check.state === "done" || check.state === "not_done") button.closest<HTMLElement>("[role=dialog]")?.focus();
      props.onChecked(check);
      if (check.state === "failed") setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  };
  return (
    <Show when={card().hasCheck && actions.onCheckAction}>
      <Button size="sm" variant="secondary" loading={checking()} onClick={(event) => void check(event.currentTarget)}>
        {aiChatMessages(locale()).stepCheckStatus}
      </Button>
      <Show when={failed()}>
        <p role="alert" class="ai-step-card__alert">
          {aiChatMessages(locale()).stepCheckFailed}
        </p>
      </Show>
    </Show>
  );
}

/**
 * One step of the opened work: its icon in its app's colour, what it did in one line, its outcome as a word in meta,
 * and an ⓘ whose card holds what came of it. A step that did not go through says why in the card and, when the turn
 * went on after it, the consequence. The row itself never opens.
 */
export function AiWorkStep(props: { block: ToolBlock; busy: boolean }): JSX.Element {
  const locale = useLocale();
  const work = useContext(AiWorkContext);
  const timeZone = useReaderTimeZone();
  const t = () => aiChatMessages(locale());
  const failure = () => (props.block.status === "rejected" ? null : stepFailure(props.block));
  // A finished Query says what it did: the app's past form, else its title marked done. The chat knows no app.
  const doneQuery = () => {
    const presentation = props.block.presentation;
    if (presentation?.capabilityKind !== "query" || props.block.status !== "completed" || failure()) return null;
    return presentation.doneTitle ?? t().stepDone({ title: presentation.title });
  };
  const sentence = () => {
    const status = props.block.status;
    const outcome =
      status === "completed" && !props.block.isError
        ? toolOutcome(props.block, "done", locale(), timeZone)
        : status === "rejected"
          ? toolOutcome(props.block, "rejected", locale(), timeZone)
          : null;
    return outcome ?? toolSubject(props.block, locale(), timeZone);
  };
  const label = () => sentence() ?? doneQuery() ?? props.block.presentation?.title ?? displayToolName(props.block.name, locale());
  // The check this window asked for, until the stored one is as new or settled; the same rule as the question's card.
  const [checked, setChecked] = createSignal<AiActionCheck | null>(null);
  const check = () => {
    const local = checked();
    return local ? preferredActionCheck(props.block.check, local) : props.block.check;
  };
  const settled = () => check()?.state === "done" || check()?.state === "not_done";
  const outcome = () => stepOutcome(props.block, t(), props.busy ? null : work.ending(), check());
  // A call the browser runs on its own works like a running one; only a question or approval waits for the person.
  const working = () => props.block.status === "running" || (props.block.status === "awaiting_client" && !waitsForUser(props.block));
  const duration = () => (props.busy && working() ? work.liveDuration() : undefined);
  const lines = createMemo(() => {
    const kind = failure();
    if (kind === "unknown")
      return [
        check()?.state === "done" ? t().stepCheckedDone : check()?.state === "not_done" ? t().stepCheckedNotDone : t().stepUnclearDetail,
      ];
    if (kind)
      return [failureReason(props.block, t()), work.followed(props.block.id) ? t().stepConsequence({ consequence: t().stepWentOn }) : ""];
    return [
      props.block.status === "running" ? (props.block.progress ?? "") : "",
      props.block.status === "completed" ? resultSummary(props.block) : "",
    ];
  });
  const shown = () => lines().filter(Boolean);
  const checkable = () => failure() === "unknown" && !settled() && work.turnId() !== undefined;
  // A step that waits for the person leads to its approval or question, with the landing of "Waiting for you".
  const chatActions = useAiChatActions();
  const showable = () => waitsForUser(props.block) && Boolean(chatActions.onShowQuestion);
  // Built once: the card keeps its content and its check button while the step updates around them.
  const content = <For each={shown()}>{(line) => <p class="ai-step-card__line">{line}</p>}</For>;
  const actions = (
    <>
      <Show when={checkable() ? work.turnId() : undefined}>
        {(turnId) => <StepCheck block={props.block} turnId={turnId()} onChecked={setChecked} />}
      </Show>
      <Show when={showable()}>
        <Button size="sm" variant="secondary" onClick={() => chatActions.onShowQuestion?.(props.block.id)}>
          {props.block.status === "awaiting_approval" ? t().stepShowApproval : t().stepShowQuestion}
        </Button>
      </Show>
    </>
  );
  const info = createMemo((): ChatActivityInfo | undefined =>
    shown().length > 0 || checkable() || showable()
      ? {
          label: t().stepDetails({ step: label() }),
          title: label(),
          detail: [outcome()?.word, duration()].filter(Boolean).join(" · ") || undefined,
          content,
          actions,
        }
      : undefined,
  );
  return (
    <>
      <Chat.Activity
        class="ai-work-step"
        icon={aiToolIcon(props.block.name, props.block.presentation?.appIcon)}
        accent={props.block.presentation?.appAccent}
        label={label()}
        // A call without a sentence of its own names what it acts on after its name; the row stays one line.
        description={sentence() ? undefined : target(props.block) || undefined}
        meta={outcome()?.word}
        metaTone={outcome()?.tone}
        duration={duration()}
        info={info()}
        busy={props.busy && working()}
      />
      <Show when={websiteReceipts(props.block).length > 0}>
        <WebsiteReceipts block={props.block} />
      </Show>
    </>
  );
}

/**
 * Gustav's own step in words, such as "Thought it over": the icon in the third grey, one line, and the whole text
 * behind its ⓘ, where a long text scrolls. Used for reasoning and for what Gustav wrote between two steps.
 */
export function AiNoteStep(props: { label: string; busy: boolean; icon?: string; children?: JSX.Element }): JSX.Element {
  const locale = useLocale();
  const work = useContext(AiWorkContext);
  const details = children(() => props.children);
  const content = <div class="ai-step-card__note">{details()}</div>;
  return (
    <Chat.Activity
      class="ai-work-step"
      icon={props.icon ?? "ti ti-bulb"}
      label={props.label}
      duration={props.busy ? work.liveDuration() : undefined}
      info={
        details.toArray().length > 0
          ? { label: aiChatMessages(locale()).stepDetails({ step: props.label }), title: props.label, content }
          : undefined
      }
      busy={props.busy}
    />
  );
}

/** Thinking is a step: "Thought it over", and its reasoning in the card. */
export function AiThoughtStep(props: { block: Extract<AiTurnBlock, { kind: "thinking" }>; busy: boolean }): JSX.Element {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const text = () => props.block.text.trim();
  return (
    <Show when={text()} fallback={<AiNoteStep label={t().stepThinking} busy={props.busy} />}>
      <AiNoteStep label={props.busy ? t().stepThinking : t().stepThought} busy={props.busy}>
        <p class="ai-turn-steps__thought">{text()}</p>
      </AiNoteStep>
    </Show>
  );
}
