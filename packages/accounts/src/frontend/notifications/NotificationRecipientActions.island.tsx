import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, dialogCore, PanelDialog, panelDialogOptions, prompts } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type AccountsMessages, useAccountsMessages } from "../messages";

type Props = {
  batchId: string;
  userId: string;
  status: string;
  error: string | null;
};

const readError = async (res: Response, fallback: string) => {
  try {
    const data = await res.json();
    return data.message ?? data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

const showError = (error: string | null, messages: AccountsMessages) => {
  void dialogCore.open<void>(
    (close) => (
      <PanelDialog>
        <PanelDialog.Header
          title={messages.deliveryError}
          subtitle={messages.deliveryErrorDescription}
          icon="ti ti-alert-triangle"
          close={close}
        />
        <PanelDialog.Body>
          <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-primary">
            {error || messages.noDeliveryError}
          </pre>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button size="sm" variant="secondary" onClick={() => close()}>
            {messages.close}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    ),
    panelDialogOptions,
  );
};

export default function NotificationRecipientActions(props: Props) {
  const messages = useAccountsMessages();
  const [retrying, setRetrying] = createSignal(false);

  const retry = async () => {
    setRetrying(true);
    try {
      const res = await apiClient.notifications.batches[":id"].recipients[":userId"].retry.$post({
        param: { id: props.batchId, userId: props.userId },
      });
      if (!res.ok) throw new Error(await readError(res, messages().retryRecipientFailed));
      refreshCurrentPath();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Show when={props.status === "error"}>
      <div class="flex justify-end gap-1.5">
        <Button size="sm" variant="subtle" onClick={() => showError(props.error, messages())} disabled={retrying()}>
          <i class="ti ti-alert-circle" />
          <span>{messages().error}</span>
        </Button>
        <Button size="sm" variant="subtle" onClick={retry} disabled={retrying()}>
          <i class={retrying() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
          <span>{retrying() ? messages().sending : messages().sendAgain}</span>
        </Button>
      </div>
    </Show>
  );
}
