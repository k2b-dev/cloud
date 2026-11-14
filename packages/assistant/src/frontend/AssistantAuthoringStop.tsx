import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { useAiChatActions } from "@k2b/cloud/ai/ui";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { assistantMessages } from "./messages";

type Messages = ReturnType<typeof assistantMessages.resolve>["t"];

/** What the receipt confirms and what remains, in the order the work runs: write, check, test, save a version. */
function authoringProgress(state: AiCodeAuthoringStop, t: Messages) {
  const drafts = state.drafts;
  const done: string[] = [];
  const open: string[] = [];
  if (state.completedSteps > 0) done.push(t.authoringStopSteps({ steps: state.completedSteps }));
  if (drafts === 0) return { done, open: [t.authoringStopWrite] };
  done.push(t.authoringStopWritten({ drafts }));
  if (state.unchecked === 0) done.push(t.authoringStopChecked({ drafts }));
  else open.push(t.authoringStopCheck({ count: state.unchecked, drafts }));
  if (state.untested === 0) done.push(t.authoringStopTested({ drafts }));
  else open.push(t.authoringStopTest({ count: state.untested, drafts }));
  if (state.unsubmitted === 0) done.push(t.authoringStopVersionSaved({ drafts }));
  else open.push(t.authoringStopSave({ count: state.unsubmitted, drafts }));
  return { done, open: open.length ? open : [t.authoringStopReview] };
}

/**
 * A terminal receipt, never model-authored progress. The card renders once from the persisted receipt; sending and a
 * failed send only change the button and the last quiet line, which keeps its height. The normal send path preserves
 * the person's composer draft.
 */
export default function AssistantAuthoringStop(props: { state: AiCodeAuthoringStop; continuable: () => boolean }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const actions = useAiChatActions();
  const id = createUniqueId();
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const disabled = () => !props.continuable() || !actions.onContinueTurn || actions.actionDisabled?.() || sending() || sent();
  const progress = () => authoringProgress(props.state, t());
  const reason = () =>
    props.state.reason === "repeated_error"
      ? t().authoringStopRepeated
      : props.state.reason === "model_calls"
        ? t().authoringStopAttempts
        : t().authoringStopBudget;
  const saved = () =>
    props.state.drafts === 0
      ? t().authoringStopNoDraft
      : props.state.unsubmitted > 0
        ? t().authoringStopSaved({ drafts: props.state.drafts })
        : t().authoringStopSubmitted({ drafts: props.state.drafts });
  const continueWork = async () => {
    if (disabled()) return;
    setSending(true);
    setFailed(false);
    try {
      await actions.onContinueTurn?.(t().authoringContinueMessage);
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  const list = (key: "done" | "open", label: string, items: string[]) => (
    <Show when={items.length > 0}>
      <div class="assistant-authoring-stop__group" data-status={key}>
        <p class="assistant-authoring-stop__label" id={`${id}-${key}`}>
          {label}
        </p>
        <ul class="assistant-authoring-stop__list" aria-labelledby={`${id}-${key}`}>
          <For each={items}>
            {(item) => (
              <li>
                <i class={key === "done" ? "ti ti-check" : "ti ti-circle"} aria-hidden="true" />
                <span>{item}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
  return (
    <NoticeCard
      tone="warning"
      class="ai-turn__notice assistant-authoring-stop"
      role="status"
      aria-live="polite"
      title={t().authoringStopTitle}
      detail={reason()}
      actions={
        <Button variant="secondary" size="md" disabled={disabled()} loading={sending()} onClick={() => void continueWork()}>
          {t().authoringContinue}
        </Button>
      }
    >
      {list("done", t().authoringStopDoneLabel, progress().done)}
      {list("open", t().authoringStopOpenLabel, progress().open)}
      {/* The recovery line shares the saved line's space, so neither the card nor the button moves. */}
      <p class="assistant-authoring-stop__meta">
        <span data-hidden={failed() ? "" : undefined} aria-hidden={failed()}>
          {saved()}
        </span>
        <span data-hidden="" aria-hidden="true">
          {t().authoringContinueFailed}
        </span>
        <span class="assistant-authoring-stop__alert" role="alert">
          <Show when={failed()}>{t().authoringContinueFailed}</Show>
        </span>
      </p>
    </NoticeCard>
  );
}
