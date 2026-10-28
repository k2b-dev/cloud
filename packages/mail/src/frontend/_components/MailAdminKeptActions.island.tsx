import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import { apiClient } from "../../api/client";
import { mailKeptAdminMessages } from "../kept-admin-messages";
import { readApiError } from "./api-response";
import { downloadKeptConversations } from "./kept-admin-download";

const REASON_MAX_LENGTH = 500;

/** The detail's actions: download its JSON export, or stop keeping it with an optional reason for the log. */
export default function MailAdminKeptActions(props: { mailboxId: string; conversationId: string }) {
  const locale = useLocale();
  const t = createMemo(() => mailKeptAdminMessages.resolve([locale()]).t);
  const ref = () => ({ mailboxId: props.mailboxId, conversationId: props.conversationId });
  const download = mutation.create<void, void>({
    mutation: (_, { abortSignal }) => downloadKeptConversations([ref()], t().downloadFailed, abortSignal),
    onSuccess: () => toast.success(t().downloadStarted),
    onError: (error) => prompts.error(error.message, { title: t().downloadFailed }),
  });
  const release = mutation.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const values = await prompts.form({
        title: t().stopKeepingTitle,
        icon: "ti ti-lock-open",
        variant: "danger",
        confirmText: t().stopKeeping,
        fields: {
          consequence: { type: "info", content: () => <p class="k2b-prompt-copy">{t().stopKeepingConsequence}</p> },
          reason: {
            type: "text",
            multiline: true,
            label: t().stopKeepingReason,
            description: t().stopKeepingReasonDescription,
            maxLength: REASON_MAX_LENGTH,
          },
        },
      });
      if (!values || abortSignal.aborted) return false;
      const reason = values.reason?.trim();
      const response = await apiClient.admin.kept[":mailboxId"][":conversationId"].$delete(
        { param: ref(), json: reason ? { reason } : {} },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().stopKeepingFailed));
      return true;
    },
    onSuccess: (released) => {
      if (!released) return;
      toast.success(t().stopKeepingDone);
      window.location.assign("/admin/mail/kept");
    },
    onError: (error) => prompts.error(error.message, { title: t().stopKeepingFailed }),
  });

  return (
    <div class="flex flex-wrap gap-2" data-kept-actions>
      <Button variant="secondary" size="sm" loading={download.loading()} onClick={() => void download.mutate()}>
        <i class="ti ti-download" aria-hidden="true" /> {t().downloadJson}
      </Button>
      <Button variant="secondary" size="sm" loading={release.loading()} onClick={() => void release.mutate()}>
        <i class="ti ti-lock-open" aria-hidden="true" /> {t().stopKeeping}
      </Button>
    </div>
  );
}
