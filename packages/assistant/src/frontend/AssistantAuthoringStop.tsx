import type { AiCodeAuthoringStop } from "@k2b/cloud/ai";
import { useAiChatActions } from "@k2b/cloud/ai/ui";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { assistantMessages } from "./messages";

/** A Cloud receipt, with one sentence and one quiet line. Continuing uses the normal send path. */
export default function AssistantAuthoringStop(props: {
  state: AiCodeAuthoringStop;
  continuable: () => boolean;
  superseded: () => boolean;
}) {
  let host: HTMLDivElement | undefined;
  const [phone, setPhone] = createSignal(false);
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setPhone((entry?.contentRect.width ?? 0) <= 560));
    if (host) observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const actions = useAiChatActions();
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  let continueButton: HTMLButtonElement | undefined;
  const available = () => !props.superseded() && props.continuable() && Boolean(actions.onContinueTurn) && !sent();
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
  const showFailure = () => failed() && available() && !busy() && !sending();
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
    const heldFocus = continueButton?.ownerDocument.activeElement === continueButton;
    setSending(true);
    setFailed(false);
    try {
      await actions.onContinueTurn?.(t().authoringContinueMessage);
      setSent(true);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
      // Native disabling can move focus to the body. Restore only our lost focus, never another control’s.
      if (heldFocus && failed() && available() && continueButton?.ownerDocument.activeElement === continueButton?.ownerDocument.body) {
        continueButton?.focus();
      }
    }
  };
  // Reserve the action while this is the latest receipt; an overtaken receipt becomes compact.
  return (
    <div class="assistant-authoring-stop-host" ref={host}>
      <NoticeCard
        tone="neutral"
        icon="ti ti-player-pause"
        layout="card"
        class="ai-turn__notice assistant-authoring-stop"
        data-current={!props.superseded() ? "" : undefined}
        title={<span title={title()}>{title()}</span>}
        actions={
          <Show when={!props.superseded() && Boolean(actions.onContinueTurn)}>
            <Button
              ref={(element) => {
                continueButton = element;
              }}
              variant="secondary"
              size={phone() ? "md" : "sm"}
              class={!available() ? "assistant-authoring-stop__retired" : undefined}
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
        <p class="assistant-authoring-stop__meta" title={quiet()}>
          <span role="status" aria-atomic="true">
            {showFailure() ? "" : quiet()}
          </span>
          <span role="alert" aria-atomic="true">
            {showFailure() ? t().authoringContinueFailed : ""}
          </span>
        </p>
      </NoticeCard>
    </div>
  );
}
