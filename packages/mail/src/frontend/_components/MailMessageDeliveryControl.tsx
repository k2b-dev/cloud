import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { CancelScheduledSendResult, DeliveryRecoveryRecipientMode, MailDraft } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import { readApiError } from "./api-response";
import { mailDraftHref } from "./mail-compose-route";
import { messageDeliveryControlLabel, undoSendSecondsRemaining } from "./mail-message-presentation";
import { buildMailListHref } from "./mail-navigation";

type MessageDelivery = NonNullable<MessageDetail["delivery"]>;

const deliveryExplanation = (delivery: MessageDelivery): string => {
  if (delivery.lastErrorCode === "SMTP_PARTIAL_ACCEPTANCE") {
    return "The receiving server accepted some recipients but not others. Review the remaining recipients before sending again. Mail will not resend automatically, which avoids duplicate messages.";
  }
  if (delivery.state === "unknown" || delivery.lastErrorCode === "AMBIGUOUS_SMTP_OUTCOME") {
    return "The connection ended before the receiving server confirmed the result. Mail will not send again automatically because that could create a duplicate.";
  }
  if (delivery.state === "scheduled" && delivery.lastErrorCode) {
    return `${delivery.attempt} of ${delivery.maxAttempts} delivery attempts did not succeed. Mail will try again automatically.`;
  }
  if (["SENT_APPEND_FAILED", "SENT_COPY_LEASE_EXPIRED", "SENT_RECONCILIATION_FAILED"].includes(delivery.lastErrorCode ?? "")) {
    return "The message was sent, but Mail could not save its copy in the Sent folder. Do not send it again.";
  }
  if (["failed", "reconciled_unsent"].includes(delivery.state)) {
    const code = delivery.lastErrorCode ?? "";
    const reason = ["SMTP_NO_RECIPIENTS_ACCEPTED", "EENVELOPE"].includes(code)
      ? "The receiving server rejected the recipients."
      : code.includes("AUTH") || code.includes("CREDENTIAL")
        ? "Mail could not authenticate with the sending account."
        : code.includes("SIZE") || code === "SMTP_DSN_UNSUPPORTED"
          ? "The message or one of its requested delivery options is not supported by this sending account."
          : code.includes("ACCESS") || code.includes("IDENTITY")
            ? "The sending account or its permissions changed before delivery."
            : "The message was not delivered.";
    return `${reason} It is still available as a draft so you can check it, edit it, and send it again.`;
  }
  return "This delivery needs attention before Mail can treat it as complete.";
};

const failedActionLabel = (delivery: MessageDelivery): string => {
  const code = delivery.lastErrorCode ?? "";
  if (["SMTP_NO_RECIPIENTS_ACCEPTED", "EENVELOPE"].includes(code)) return "Review recipients";
  if (code === "SMTP_DSN_UNSUPPORTED") return "Review delivery options";
  if (code.includes("SIZE")) return "Edit message";
  return "Review and resend";
};

export default function MailMessageDeliveryControl(props: {
  mailboxId: string;
  requestUrl: string;
  delivery: MessageDelivery;
  canWrite: boolean;
  dateConfig: DateContext;
  onReconcile: () => Promise<void>;
}) {
  const [now, setNow] = createSignal(Date.now());
  let expiryTimer: number | undefined;
  let reconciledSubmissionId: string | null = null;
  let scheduledDialogOpen = false;
  let closeScheduledDialog: (() => void) | null = null;

  const clearExpiryTimer = () => {
    if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    expiryTimer = undefined;
  };
  const remainingSeconds = createMemo(() => undoSendSecondsRemaining(props.delivery.undoUntil, now()));
  const visible = createMemo(() => {
    if (!messageDeliveryControlLabel(props.delivery, props.canWrite)) return false;
    return props.delivery.state !== "undo_window" || remainingSeconds() !== 0;
  });
  const label = createMemo(() => {
    const action = messageDeliveryControlLabel(props.delivery, props.canWrite);
    const remaining = remainingSeconds();
    return action && props.delivery.state === "undo_window" && remaining !== null ? `${action} · ${remaining}s` : action;
  });

  const reconcileAfterExpiry = () => {
    if (reconciledSubmissionId === props.delivery.submissionId) return;
    reconciledSubmissionId = props.delivery.submissionId;
    void props.onReconcile().catch(() => undefined);
  };

  createEffect(() => {
    clearExpiryTimer();
    const submissionId = props.delivery.submissionId;
    const undoUntil = props.delivery.state === "undo_window" ? props.delivery.undoUntil : null;
    if (reconciledSubmissionId !== submissionId) reconciledSubmissionId = null;
    if (!undoUntil || typeof window === "undefined") return;
    const deadline = Date.parse(undoUntil);
    if (!Number.isFinite(deadline)) return;

    const tick = () => {
      const current = Date.now();
      setNow(current);
      const remainingMilliseconds = deadline - current;
      if (remainingMilliseconds <= 0) {
        clearExpiryTimer();
        reconcileAfterExpiry();
        return;
      }
      const nextSecond = remainingMilliseconds % 1000 || 1000;
      expiryTimer = window.setTimeout(tick, Math.min(remainingMilliseconds, nextSecond + 20));
    };
    tick();
  });

  const cancel = mutations.create<CancelScheduledSendResult, { submissionId: string }, { state: MessageDelivery["state"] }>({
    onBefore: () => ({ state: props.delivery.state }),
    mutation: async ({ submissionId }, { abortSignal }) => {
      const route = apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"];
      const response = await route.cancel.$post(
        {
          param: { mailboxId: props.mailboxId, scheduledSendId: submissionId },
          json: { disposition: "draft" },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Could not undo this send"));
      return await response.json();
    },
    onSuccess: (result, context) => {
      toast.success(context?.state === "scheduled" ? "Scheduled send cancelled. The message was restored as a draft." : "Send undone.");
      const returnHref = buildMailListHref(new URL(props.requestUrl, window.location.origin));
      navigateTo(mailDraftHref(props.mailboxId, result.draftId, returnHref));
    },
    onError: (error) => toast.error(error.message),
  });

  const recoveryDraft = mutations.create<MailDraft, { mode: DeliveryRecoveryRecipientMode }>({
    mutation: async ({ mode }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"]["recovery-draft"].$post(
        {
          param: { mailboxId: props.mailboxId, scheduledSendId: props.delivery.submissionId },
          json: { recipientMode: mode, includeAttachments: true, idempotencyKey: crypto.randomUUID() },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Could not prepare a recovery draft"));
      return response.json();
    },
    onSuccess: (draft) => {
      const returnHref = buildMailListHref(new URL(props.requestUrl, window.location.origin));
      navigateTo(mailDraftHref(props.mailboxId, draft.id, returnHref));
    },
    onError: (error) => toast.error(error.message),
  });

  const openDeliveryDetails = async () => {
    if (scheduledDialogOpen) return;
    scheduledDialogOpen = true;
    const submissionId = props.delivery.submissionId;
    const scheduledAt = props.delivery.scheduledAt;
    const dateConfig = props.dateConfig;
    const retrying = props.delivery.state === "scheduled" && Boolean(props.delivery.lastErrorCode);
    const scheduled = props.delivery.state === "scheduled" && !retrying;
    const failed = props.delivery.state === "failed" || props.delivery.state === "reconciled_unsent";
    const partial = props.delivery.lastErrorCode === "SMTP_PARTIAL_ACCEPTANCE";
    const unclear = props.delivery.state === "unknown" || props.delivery.lastErrorCode === "AMBIGUOUS_SMTP_OUTCOME";
    const sentCopyProblem = ["SENT_APPEND_FAILED", "SENT_COPY_LEASE_EXPIRED", "SENT_RECONCILIATION_FAILED"].includes(
      props.delivery.lastErrorCode ?? "",
    );
    try {
      await prompts.dialog<void>(
        (close) => {
          closeScheduledDialog = () => close();
          const cancelQueuedSend = async () => {
            await cancel.mutate({ submissionId });
            if (!cancel.error()) close();
          };

          const editDraft = () => {
            close();
            const returnHref = buildMailListHref(new URL(props.requestUrl, window.location.origin));
            navigateTo(mailDraftHref(props.mailboxId, props.delivery.draftId, returnHref));
          };

          const prepareRecoveryDraft = async (mode: DeliveryRecoveryRecipientMode) => {
            if (mode === "all") {
              const confirmed = await prompts.confirm(
                partial
                  ? "Some recipients already received this message and may receive a duplicate if you send the new draft."
                  : "The previous delivery may have succeeded. Sending a new draft could create a duplicate message.",
                { title: "Create a draft for everyone again?", confirmText: "Create draft" },
              );
              if (!confirmed) return;
            }
            close();
            recoveryDraft.mutate({ mode });
          };

          const checkAgain = async () => {
            await props.onReconcile();
            close();
          };

          return (
            <div class="flex flex-col gap-4">
              <Show when={props.delivery.state === "scheduled"}>
                <div class="rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2">
                  <p class="text-xs font-medium text-dimmed">{retrying ? "Next delivery attempt" : "Scheduled delivery"}</p>
                  <p class="mt-1 text-sm font-semibold text-primary">{dates.formatDateTime(scheduledAt, dateConfig)}</p>
                  <p class="mt-1 text-xs text-dimmed">Time zone: {dateConfig.timeZone}</p>
                </div>
              </Show>
              <p class="text-sm text-secondary">
                {scheduled
                  ? "Cancel delivery to return this message to Drafts. You can edit it there or schedule it again."
                  : deliveryExplanation(props.delivery)}
              </p>
              <Show when={partial && (props.delivery.acceptedRecipients.length > 0 || props.delivery.rejectedRecipients.length > 0)}>
                <div class="grid gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2 text-xs">
                  <Show when={props.delivery.acceptedRecipients.length > 0}>
                    <div>
                      <p class="font-semibold text-primary">Accepted by server</p>
                      <p class="mt-1 break-words text-secondary">{props.delivery.acceptedRecipients.join(", ")}</p>
                    </div>
                  </Show>
                  <Show when={props.delivery.rejectedRecipients.length > 0}>
                    <div>
                      <p class="font-semibold text-primary">Not accepted</p>
                      <p class="mt-1 break-words text-secondary">{props.delivery.rejectedRecipients.join(", ")}</p>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={props.delivery.lastErrorCode || props.delivery.lastErrorMessage}>
                <details class="text-xs text-dimmed">
                  <summary class="cursor-pointer select-none font-medium">Technical details</summary>
                  <div class="mt-2 break-words rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2">
                    <Show when={props.delivery.lastErrorCode}>
                      <p>{props.delivery.lastErrorCode}</p>
                    </Show>
                    <Show when={props.delivery.lastErrorMessage}>
                      <p class="mt-1">{props.delivery.lastErrorMessage}</p>
                    </Show>
                  </div>
                </details>
              </Show>
              <div class="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={cancel.loading() || recoveryDraft.loading()}
                  onClick={() => close()}
                >
                  {scheduled || retrying ? "Keep delivery" : "Close"}
                </Button>
                <Show when={props.canWrite && (scheduled || retrying)}>
                  <Button variant="danger" size="sm" type="button" disabled={cancel.loading()} onClick={() => void cancelQueuedSend()}>
                    <i class={`ti ${cancel.loading() ? "ti-loader-2 animate-spin" : "ti-calendar-cancel"}`} aria-hidden="true" />
                    {retrying ? "Cancel retry and edit" : "Cancel send"}
                  </Button>
                </Show>
                <Show when={props.canWrite && failed}>
                  <Button variant="primary" size="sm" type="button" onClick={editDraft}>
                    <i class="ti ti-pencil" aria-hidden="true" />
                    {failedActionLabel(props.delivery)}
                  </Button>
                </Show>
                <Show when={props.canWrite && partial}>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={recoveryDraft.loading()}
                    onClick={() => void prepareRecoveryDraft("all")}
                  >
                    Review everyone again…
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    loading={recoveryDraft.loading()}
                    loadingLabel="Preparing draft"
                    onClick={() => void prepareRecoveryDraft("remaining")}
                  >
                    Review remaining recipients
                  </Button>
                </Show>
                <Show when={unclear}>
                  <Button variant="secondary" size="sm" type="button" onClick={() => void checkAgain()}>
                    Check again
                  </Button>
                  <Show when={props.canWrite}>
                    <Button
                      variant="warning"
                      size="sm"
                      type="button"
                      disabled={recoveryDraft.loading()}
                      onClick={() => void prepareRecoveryDraft("all")}
                    >
                      Review resend draft…
                    </Button>
                  </Show>
                </Show>
              </div>
            </div>
          );
        },
        {
          title: scheduled
            ? "Scheduled message"
            : retrying
              ? "Delivery delayed"
              : partial
                ? "Partially sent"
                : unclear
                  ? "Delivery status unclear"
                  : sentCopyProblem
                    ? "Sent, but not saved"
                    : failed
                      ? "Couldn’t send"
                      : "Delivery needs attention",
          icon: scheduled ? "ti ti-calendar-time" : failed ? "ti ti-alert-circle" : "ti ti-alert-triangle",
        },
      );
    } finally {
      scheduledDialogOpen = false;
      closeScheduledDialog = null;
    }
  };

  onCleanup(() => {
    clearExpiryTimer();
    closeScheduledDialog?.();
    closeScheduledDialog = null;
    cancel.abort();
    recoveryDraft.abort();
  });

  return (
    <Show when={visible() && label()}>
      {(actionLabel) => (
        <div class="flex flex-wrap items-center gap-2 px-3 pb-1">
          <Button
            type="button"
            variant={
              props.delivery.state === "undo_window" || (props.delivery.state === "scheduled" && Boolean(props.delivery.lastErrorCode))
                ? "warning"
                : props.delivery.state === "failed" || props.delivery.state === "reconciled_unsent"
                  ? "danger"
                  : "subtle"
            }
            size="xs"
            loading={cancel.loading()}
            data-mail-undo-send={props.delivery.state === "undo_window" ? "" : undefined}
            data-mail-scheduled-send={props.delivery.state === "scheduled" ? "" : undefined}
            aria-label={
              props.delivery.state === "undo_window" && remainingSeconds() !== null
                ? `Undo send, ${remainingSeconds()} seconds remaining`
                : "View delivery details"
            }
            title={
              props.delivery.state === "undo_window"
                ? "Cancel delivery and restore this message as a draft"
                : props.delivery.state === "scheduled"
                  ? `Scheduled for ${dates.formatDateTime(props.delivery.scheduledAt, props.dateConfig)}`
                  : "View delivery details"
            }
            onClick={() =>
              props.delivery.state !== "undo_window"
                ? void openDeliveryDetails()
                : void cancel.mutate({ submissionId: props.delivery.submissionId })
            }
          >
            <Show when={!cancel.loading()}>
              <i
                class={`ti ${
                  props.delivery.state === "undo_window"
                    ? "ti-arrow-back-up"
                    : props.delivery.state === "scheduled" && !props.delivery.lastErrorCode
                      ? "ti-clock"
                      : props.delivery.state === "scheduled"
                        ? "ti-refresh"
                        : props.delivery.state === "failed" || props.delivery.state === "reconciled_unsent"
                          ? "ti-alert-circle"
                          : "ti-alert-triangle"
                }`}
                aria-hidden="true"
              />
            </Show>
            <span>{actionLabel()}</span>
          </Button>
        </div>
      )}
    </Show>
  );
}
