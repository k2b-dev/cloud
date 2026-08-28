import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { onMount, Show } from "solid-js";
import { mailComposerMessages } from "./mail-composer-messages";
import type { MailDraftLifecycleTransition } from "./mail-draft-lifecycle";

export default function MailComposerLifecycleNotice(props: {
  transition: MailDraftLifecycleTransition;
  savingCopy: boolean;
  onCopyText: () => void;
  onSaveAsNew: () => void;
  onOpenMessage: () => void;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const draft = () => props.transition.draft;
  const title = () => {
    const state = draft().state;
    return state === "scheduled"
      ? t().lifecycleScheduledTitle
      : state === "sending"
        ? t().lifecycleSendingTitle
        : state === "sent"
          ? t().lifecycleSentTitle
          : t().lifecycleDiscardedTitle;
  };
  const message = () => {
    const value = draft();
    const name = value.lastEditedByDisplayName;
    return value.state === "scheduled"
      ? t().lifecycleScheduled({ name })
      : value.state === "sending"
        ? t().lifecycleSending({ name })
        : value.state === "sent"
          ? t().lifecycleSent({ name })
          : t().lifecycleDiscarded({ name });
  };
  let notice: HTMLDivElement | undefined;
  onMount(() => notice?.focus({ preventScroll: true }));
  return (
    <div ref={notice} role="group" tabIndex={-1} aria-label={title()}>
      <NoticeCard
        tone={props.transition.hasUnsavedChanges ? "warning" : "info"}
        icon={draft().state === "discarded" ? "ti ti-trash" : "ti ti-send"}
        title={title()}
        class="mx-3 mt-3"
      >
        <div class="flex flex-col gap-3">
          <div class="space-y-1" role="status" aria-live="polite">
            <p>{message()}</p>
            <Show when={props.transition.hasUnsavedChanges}>
              <p class="font-medium">{t().unsavedNotIncluded}</p>
            </Show>
          </div>
          <div class="flex flex-wrap gap-2">
            <Show when={props.transition.hasUnsavedChanges}>
              <Button size="sm" variant="secondary" type="button" onClick={props.onCopyText}>
                <i class="ti ti-copy" aria-hidden="true" /> {t().copyText}
              </Button>
              <Button size="sm" variant="primary" type="button" loading={props.savingCopy} onClick={props.onSaveAsNew}>
                <i class="ti ti-file-plus" aria-hidden="true" /> {t().saveAsNewDraft}
              </Button>
            </Show>
            <Show when={draft().conversationId}>
              <Button size="sm" variant="secondary" type="button" onClick={props.onOpenMessage}>
                <i class="ti ti-external-link" aria-hidden="true" /> {t().openMessage}
              </Button>
            </Show>
          </div>
        </div>
      </NoticeCard>
    </div>
  );
}
