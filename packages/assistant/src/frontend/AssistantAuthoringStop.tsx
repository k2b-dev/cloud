import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { useAiChatActions } from "@k2b/cloud/ai/ui";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { assistantMessages } from "./messages";

/** A Cloud receipt, with one sentence and one quiet line. Continuing uses the normal send path. */
export default function AssistantAuthoringStop(props: { state: AiCodeAuthoringStop; continuable: () => boolean }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const actions = useAiChatActions();
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  const available = () => props.continuable() && Boolean(actions.onContinueTurn) && !sent();
  // Only a card that had an action reserves its place when a later turn removes that action.
  const hadAction = createMemo((seen: boolean) => available() || seen, false);
  const busy = () => Boolean(actions.actionDisabled?.());
  const disabled = () => !available() || busy() || sending();
  const title = () => (props.state.reason === "repeated_error" ? t().authoringStopRepeatedTitle : t().authoringStopTitle);
  const reason = () =>
    props.state.reason === "repeated_error"
      ? t().authoringStopRepeated
      : props.state.reason === "model_calls"
        ? t().authoringStopSteps
        : t().authoringStopTried;
  const saved = () =>
    props.state.drafts === 0
      ? t().authoringStopNoDraft
      : props.state.unsubmitted > 0 && props.state.unsubmitted < props.state.drafts
        ? t().authoringStopPartlySubmitted({
            unsubmitted: props.state.unsubmitted,
            submitted: props.state.drafts - props.state.unsubmitted,
          })
        : props.state.unsubmitted > 0
          ? t().authoringStopSaved({ drafts: props.state.drafts })
          : t().authoringStopSubmitted({ drafts: props.state.drafts });
  const receipt = () => `${reason()} · ${saved()}`;
  const quiet = () =>
    sending()
      ? t().authoringContinueSending
      : !available()
        ? receipt()
        : busy()
          ? t().authoringContinueBlocked
          : failed()
            ? t().authoringContinueFailed
            : receipt();
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
      tone="neutral"
      icon="ti ti-player-pause"
      layout="card"
      class="ai-turn__notice assistant-authoring-stop"
      title={title()}
      actions={
        <Show when={hadAction()}>
          <Button
            variant="primary"
            size="md"
            classList={{ "assistant-authoring-stop__retired": !available() }}
            aria-hidden={!available() || undefined}
            tabIndex={available() ? undefined : -1}
            disabled={disabled()}
            loading={sending()}
            onClick={() => void continueWork()}
          >
            {t().authoringContinue}
          </Button>
        </Show>
      }
    >
      <p class="assistant-authoring-stop__meta">
        {/* All feedback shares one cell. Long translations stay readable, without clipping. */}
        <For each={[receipt(), t().authoringContinueSending, t().authoringContinueFailed, t().authoringContinueBlocked]}>
          {(text) => (
            <span aria-hidden="true" class="assistant-authoring-stop__measure">
              {text}
            </span>
          )}
        </For>
        <span role={failed() && available() && !busy() && !sending() ? "alert" : "status"} aria-atomic="true">
          {quiet()}
        </span>
      </p>
    </NoticeCard>
  );
}
