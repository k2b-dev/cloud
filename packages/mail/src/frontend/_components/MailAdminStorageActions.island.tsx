import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, onCleanup } from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

export default function MailAdminStorageActions() {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const reconcile = mutation.create<void, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.admin.storage.reconcile.$post(undefined, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, messages().failedReconcileStorage));
    },
    onSuccess: () => {
      toast.success(messages().storageReconciliationQueued);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => reconcile.abort());

  return (
    <Button variant="secondary" size="sm" type="button" disabled={reconcile.loading()} onClick={() => reconcile.mutate()}>
      <i class={`ti ${reconcile.loading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} aria-hidden="true" />
      {messages().refreshStorageSnapshot}
    </Button>
  );
}
