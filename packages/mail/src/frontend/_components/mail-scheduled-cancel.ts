import { navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { CancelScheduledSendInput, CancelScheduledSendResult } from "../../contracts";
import { readApiError } from "./api-response";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { createRetryToasts } from "./mail-feedback";

/** What becomes of a cancelled send: its draft again, or nothing; `null` keeps it scheduled. */
export type MailScheduledDisposition = CancelScheduledSendInput["disposition"] | null;

/**
 * Cancelling a scheduled send, for the v1 list and the v2 list alike: the person chooses first (`choose`, in the look
 * of the view) whether the message goes back to Drafts or goes away. A message back in Drafts opens in its composer; a
 * discarded one leaves the list after a reload, and a failed reload offers to retry only the reload.
 */
export function createMailScheduledCancel(props: {
  mailboxId: () => string;
  onRefresh: () => Promise<void>;
  /** `null` or `undefined` (a question closed without answer) keeps the send scheduled. */
  choose: () => Promise<MailScheduledDisposition | undefined>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const retryToast = createRetryToasts();
  const [cancellingId, setCancellingId] = createSignal<string | null>(null);
  /** The scheduled send was cancelled, only the list is stale, so Retry repeats the refresh, not the cancellation. */
  const reportRefreshFailure = (error: Error): void => {
    retryToast(error.message, {
      title: t().cancelledRefreshFailed,
      retryLabel: t().retry,
      retry: () => props.onRefresh().catch((next: unknown) => reportRefreshFailure(next instanceof Error ? next : new Error(String(next)))),
    });
  };
  const cancel = mutation.create<
    {
      result: CancelScheduledSendResult;
      disposition: CancelScheduledSendInput["disposition"];
      refreshError: Error | null;
    } | null,
    string
  >({
    onBefore: (scheduledSendId) => setCancellingId(scheduledSendId),
    mutation: async (scheduledSendId, { abortSignal }) => {
      const disposition = await props.choose();
      if (!disposition || abortSignal.aborted) return null;
      const mailboxId = props.mailboxId();
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"].cancel.$post(
        { param: { mailboxId, scheduledSendId }, json: { disposition } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().cancelScheduledFailed));
      const result: CancelScheduledSendResult = await response.json();
      abortSignal.throwIfAborted();
      let refreshError: Error | null = null;
      if (result.disposition !== "draft") {
        try {
          await props.onRefresh();
        } catch (error) {
          refreshError = error instanceof Error ? error : new Error(String(error));
        }
      }
      return { result, disposition, refreshError };
    },
    onSuccess: (value) => {
      if (!value) return;
      const { result, disposition, refreshError } = value;
      toast.success(disposition === "draft" ? t().cancelledDraftRestored : t().scheduledDiscarded);
      if (result.disposition === "draft") {
        const mailboxId = props.mailboxId();
        navigateTo(mailDraftHref(mailboxId, result.draftId, `/app/mail/${mailboxId}?scheduled=1`));
        return;
      }
      if (refreshError) reportRefreshFailure(refreshError);
    },
    onError: (error) => toast.error(error.message),
    onFinally: () => setCancellingId(null),
  });
  onCleanup(cancel.abort);
  return { t, cancellingId, cancel: (scheduledSendId: string) => void cancel.mutate(scheduledSendId) };
}
