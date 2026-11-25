import { importOnDemand } from "@k2b/cloud/browser/reload";
import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { apiClient } from "../../api/client";
import type { Mailbox } from "../../contracts";
import { mailOverviewMessages } from "../mail-overview-messages";
import { readApiError } from "./api-response";
import type { MailboxCreationContext } from "./create-mailbox-dialog";

type HealthDialog = typeof import("./MailboxHealthDialog");

/**
 * The deeds of the mailbox list: a new mailbox, and the deleted ones with their restore. Both dialogs load with the
 * action that opens them, not with the page. The v1 sidebar and the v2 pilot offer the same deeds through this.
 */
export function createMailboxManagement(props: MailboxCreationContext & { canCreate: boolean }) {
  const locale = useLocale();
  const overviewText = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const owner = getOwner();
  const [creating, setCreating] = createSignal(false);
  let creation: ReturnType<typeof import("./create-mailbox-dialog").createMailboxCreation> | undefined;
  const createMailbox = async () => {
    if (!props.canCreate || creating()) return;
    setCreating(true);
    try {
      const dialog = await importOnDemand(() => import("./create-mailbox-dialog"));
      if (!dialog) return;
      creation ??= runWithOwner(owner, () => dialog.createMailboxCreation(props, overviewText));
      await creation?.mutate();
    } finally {
      setCreating(false);
    }
  };
  // One restore at a time: a second one would drop the first one's result.
  const restoreMailbox = mutations.create<{ mailbox: Mailbox; health?: HealthDialog } | null, string>({
    mutation: async (mailboxId, { abortSignal }) => {
      const confirmed = await prompts.confirm(overviewText().restoreWarning, {
        title: overviewText().restoreMailbox,
        confirmText: overviewText().restoreMailbox,
      });
      if (!confirmed || abortSignal.aborted) return null;
      // As for a new mailbox: the health dialog loads during the request, and without it the mailbox still opens.
      const health = import("./MailboxHealthDialog").catch(() => undefined);
      const response = await apiClient.mailboxes[":mailboxId"].restore.$post({ param: { mailboxId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, overviewText().failedRestoreMailbox));
      return { mailbox: await response.json(), health: await health };
    },
    onSuccess: (restored) => {
      if (!restored) return;
      const { mailbox, health } = restored;
      toast.success(overviewText().mailboxRestored);
      if (!health) return navigateTo(`/app/mail/${mailbox.id}`);
      void health.openMailboxHealthDialog({ mailboxId: mailbox.id }).then(() => navigateTo(`/app/mail/${mailbox.id}`));
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => restoreMailbox.abort());
  const openDeletedMailboxes = async () => {
    if (restoreMailbox.loading()) return;
    const dialog = await importOnDemand(() => import("./DeletedMailboxesDialog"));
    const mailboxId = await dialog?.openDeletedMailboxesDialog();
    if (!mailboxId) return;
    // The closed list returns focus on the next frame; the confirmation opens after it, so Cancel returns focus there.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    restoreMailbox.mutate(mailboxId);
  };
  return { creating, restoring: () => restoreMailbox.loading(), createMailbox, openDeletedMailboxes };
}
