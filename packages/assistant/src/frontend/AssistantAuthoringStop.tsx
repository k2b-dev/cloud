import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { useAiChatActions } from "@k2b/cloud/ai/ui";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { assistantMessages } from "./messages";

/** A terminal receipt, never model-authored progress. The normal send path preserves the person's composer draft. */
export default function AssistantAuthoringStop(props: { state: AiCodeAuthoringStop; continuable: () => boolean }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const actions = useAiChatActions();
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const disabled = () => !props.continuable() || !actions.onContinueTurn || actions.actionDisabled?.() || sending() || sent();
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
  return (
    <NoticeCard
      tone="warning"
      class="ai-turn__notice"
      actions={
        <Button variant="text" size="md" class="h-9 min-h-9" disabled={disabled()} loading={sending()} onClick={() => void continueWork()}>
          <i class="ti ti-player-play" aria-hidden="true" /> {t().authoringContinue}
        </Button>
      }
    >
      <div role="status" aria-live="polite">
        <p>{props.state.reason === "repeated_error" ? t().authoringStopRepeated : t().authoringStopBudget}</p>
        <p>{t().authoringStopDone({ steps: props.state.completedSteps, drafts: props.state.drafts })}</p>
        <Show when={props.state.drafts > 0}>
          <p>{t().authoringStopOpen({ checks: props.state.unchecked, tests: props.state.untested, versions: props.state.unsubmitted })}</p>
        </Show>
        {/* Recovery shares the final line's space so the action never moves. */}
        <p class="grid">
          <span class="col-start-1 row-start-1" classList={{ invisible: failed() }} aria-hidden={failed()}>
            {props.state.drafts === 0
              ? t().authoringStopNoDraft
              : props.state.unsubmitted > 0
                ? t().authoringStopSaved({ drafts: props.state.drafts })
                : t().authoringStopSubmitted({ versions: props.state.drafts })}
          </span>
          <span class="col-start-1 row-start-1 invisible" aria-hidden="true">
            {t().authoringContinueFailed}
          </span>
          <span class="col-start-1 row-start-1" role="alert">
            <Show when={failed()}>{t().authoringContinueFailed}</Show>
          </span>
        </p>
      </div>
    </NoticeCard>
  );
}
