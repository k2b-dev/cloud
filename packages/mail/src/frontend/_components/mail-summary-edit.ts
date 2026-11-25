import { mutation as mutations } from "@k2b/stdlib/solid";
import { announce, prompts, useLocale } from "@k2b/ui";
import { createMemo, on, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConversationContentSummary } from "../../service/conversation-summary";
import { readApiError } from "./api-response";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";
import { createRetryToasts } from "./mail-feedback";
import { captureMailWorkspaceRefreshError } from "./mail-workspace-refresh";

type SummaryEdit = { mailboxId: string; conversationId: string; expectedSummaryRevision: number; summary: string };

/**
 * A person writes the open conversation's summary: the form, the save and the update of the view. A failed save keeps
 * the typed text behind Retry, a failed update after a save repeats only the update, and a change of mailbox aborts
 * the save. The v1 reader and the v2 pilot edit a summary through this.
 */
export function createMailSummaryEdit(props: {
  mailboxId: () => string;
  conversationId: () => string | null;
  summary: () => ConversationContentSummary | null;
  /** Shows the saved summary in the view; read when a save succeeds. */
  onSaved: () => (conversationId: string, summary: ConversationContentSummary) => Promise<void>;
  /**
   * Asks for the text in the reader's own dialog (Mail's v2 pilot); v1's form by default. Resolves with the text, ""
   * to remove the summary, `null` when the person closed the dialog.
   */
  ask?: (text: { title: string; label: string; hint: string; confirm: string; cancel: string }, value: string) => Promise<string | null>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const save = createMemo(
    on(props.mailboxId, () => {
      let active = true;
      const retryToasts = createRetryToasts();
      /** The summary was saved, only the view is stale, so Retry repeats the refresh, not the save. */
      const reportRefreshFailure = (error: Error, refresh: () => Promise<void>): void =>
        retryToasts(error.message, {
          title: t().summaryRefreshFailed,
          retryLabel: t().retry,
          retry: async () => {
            const next = await captureMailWorkspaceRefreshError(refresh);
            if (next && active) reportRefreshFailure(next, refresh);
          },
        });
      const current = mutations.create<{ refreshError: Error | null; refresh: () => Promise<void> }, SummaryEdit, { edit: SummaryEdit }>({
        onBefore: (edit) => ({ edit }),
        mutation: async ({ mailboxId, conversationId, expectedSummaryRevision, summary }, { abortSignal }) => {
          if (!active) throw new DOMException("Mailbox changed", "AbortError");
          const onSaved = props.onSaved();
          const response = await apiClient.mailboxes[":mailboxId"].conversations[":conversationId"].summary.$put(
            { param: { mailboxId, conversationId }, json: { expectedSummaryRevision, summary } },
            { init: { signal: abortSignal } },
          );
          if (!response.ok) throw new Error(await readApiError(response, t().updateSummaryFailed));
          const updated = await response.json();
          abortSignal.throwIfAborted();
          const refresh = () => onSaved(conversationId, updated);
          return { refreshError: await captureMailWorkspaceRefreshError(refresh), refresh };
        },
        // The summary shows the saved text; focus is back on the button that opened the form, which does not say so.
        onSuccess: ({ refreshError, refresh }) => {
          if (refreshError) reportRefreshFailure(refreshError, refresh);
          else announce(t().summarySaved);
        },
        // The form has closed, so Retry sends the captured text again instead of losing it.
        onError: (error, context) =>
          retryToasts(error.message, { retryLabel: t().retry, retry: () => context && current.mutate(context.edit) }),
      });
      onCleanup(() => {
        active = false;
        current.abort();
      });
      return current;
    }),
  );
  const saving = () => save().loading();
  const edit = async () => {
    const instance = save();
    const conversationId = props.conversationId();
    const current = props.summary();
    if (!conversationId || !current || instance.loading()) return;
    const ask = props.ask;
    const typed = ask
      ? await ask(
          {
            title: current.summary ? t().editSummary : t().createSummary,
            label: t().summary,
            hint: t().summaryDescription,
            confirm: current.summary ? t().saveSummary : t().createSummary,
            cancel: t().cancel,
          },
          current.summary ?? "",
        )
      : await askInForm(current);
    // Another mailbox or conversation opened while the form was open: its summary is not this one.
    if (typed === null || disposed || instance !== save() || conversationId !== props.conversationId()) return;
    await instance.mutate({
      mailboxId: props.mailboxId(),
      conversationId,
      expectedSummaryRevision: current.summaryRevision,
      summary: typed,
    });
  };
  /** v1's form for the summary. */
  const askInForm = async (current: ConversationContentSummary): Promise<string | null> => {
    const values = await prompts.form({
      title: current.summary ? t().editSummary : t().createSummary,
      icon: "ti ti-notes",
      size: "large",
      fields: {
        summary: {
          type: "text",
          label: t().summary,
          description: t().summaryDescription,
          default: current.summary ?? "",
          multiline: true,
          lines: 8,
          maxLength: 50_000,
          markdown: true,
        },
      },
      confirmText: current.summary ? t().saveSummary : t().createSummary,
    });
    return values ? String(values.summary ?? "") : null;
  };
  return { edit, saving, abort: () => save().abort() };
}
