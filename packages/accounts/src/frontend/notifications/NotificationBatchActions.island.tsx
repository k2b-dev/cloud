import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, Checkbox, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { formatNumber } from "@valentinkolb/cloud/shared";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../messages";

type SelectionPayload = {
  userIds?: string[];
  groupIds?: string[];
};

type Props = {
  batchId: string;
  status: string;
  selection: SelectionPayload;
  selectionHash: string;
  errorCount: number;
  finalizeDisabledReason?: string;
};

type RecipientPreview = {
  deliverableCount: number;
  skippedNoEmailCount: number;
  recipientHash: string;
};

const readError = async (res: Response, fallback: string) => {
  try {
    const data = await res.json();
    return data.message ?? data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

function FinalizeDialog(props: {
  deliverableCount: number;
  skippedNoEmailCount: number;
  onConfirm: () => Promise<void>;
  close: () => void;
}) {
  const messages = useAccountsMessages();
  const locale = useLocale();
  const [confirmed, setConfirmed] = createSignal(false);
  const [loading, setLoading] = createSignal(false);

  const confirm = async () => {
    if (!confirmed()) return;
    setLoading(true);
    try {
      await props.onConfirm();
      props.close();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="flex min-w-0 flex-col gap-4">
      <NoticeCard tone="warning" icon={false} bodyClass="flex min-w-0 items-start gap-2">
        <i class="ti ti-alert-triangle mt-0.5 shrink-0" />
        <span class="min-w-0 break-words">
          {messages().deliveryWarning({
            deliverable: formatNumber(props.deliverableCount, { locale: locale() }),
            skipped: formatNumber(props.skippedNoEmailCount, { locale: locale() }),
          })}
        </span>
      </NoticeCard>
      <Checkbox
        label={messages().confirmRecipients}
        value={confirmed}
        onValueChange={setConfirmed}
        description={messages().finalizeDescription}
      />
      <div class="flex flex-wrap justify-end gap-2 pt-1">
        <Button size="sm" variant="secondary" onClick={props.close} disabled={loading()}>
          {messages().cancel}
        </Button>
        <Button size="sm" onClick={confirm} disabled={!confirmed() || loading()}>
          <i class={loading() ? "ti ti-loader-2 animate-spin" : "ti ti-send"} />
          <span>{loading() ? messages().starting : messages().finalizeAndSend}</span>
        </Button>
      </div>
    </div>
  );
}

export default function NotificationBatchActions(props: Props) {
  const messages = useAccountsMessages();
  const [loadingAction, setLoadingAction] = createSignal<"finalize" | "delete" | "retry" | null>(null);
  const isLoading = () => loadingAction() !== null;
  const finalizeBlocked = () => Boolean(props.finalizeDisabledReason);

  const finalize = async () => {
    if (props.finalizeDisabledReason) {
      prompts.error(props.finalizeDisabledReason);
      return;
    }
    setLoadingAction("finalize");
    try {
      const previewRes = await apiClient.notifications.batches.preview.$post({ json: { selection: props.selection } });
      if (!previewRes.ok) throw new Error(await readError(previewRes, messages().previewRecipientsFailed));
      const preview = (await previewRes.json()) as RecipientPreview;
      if (preview.deliverableCount === 0) {
        prompts.error(messages().noDeliverableBatch);
        return;
      }
      await prompts.dialog<void>(
        (close) => (
          <FinalizeDialog
            deliverableCount={preview.deliverableCount}
            skippedNoEmailCount={preview.skippedNoEmailCount}
            close={close}
            onConfirm={async () => {
              const res = await apiClient.notifications.batches[":id"].finalize.$post({
                param: { id: props.batchId },
                json: {
                  expectedSelectionHash: props.selectionHash,
                  expectedDeliverableCount: preview.deliverableCount,
                  expectedRecipientHash: preview.recipientHash,
                },
              });
              if (!res.ok) throw new Error(await readError(res, messages().finalizeBatchFailed));
              refreshCurrentPath();
            }}
          />
        ),
        { title: messages().finalizeNotificationBatch, icon: "ti ti-send" },
      );
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAction(null);
    }
  };

  const retryFailed = async () => {
    setLoadingAction("retry");
    try {
      const res = await apiClient.notifications.batches[":id"]["retry-failed"].$post({ param: { id: props.batchId } });
      if (!res.ok) throw new Error(await readError(res, messages().retryRecipientsFailed));
      refreshCurrentPath();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAction(null);
    }
  };

  const deleteDraft = async () => {
    const confirmed = await prompts.confirm(messages().deleteDraftConfirm, {
      title: messages().deleteDraft,
      confirmText: messages().deleteDraft,
      variant: "danger",
    });
    if (!confirmed) return;

    setLoadingAction("delete");
    try {
      const res = await apiClient.notifications.batches[":id"].$delete({ param: { id: props.batchId } });
      if (!res.ok) throw new Error(await readError(res, messages().deleteDraftFailed));
      navigateTo("/app/accounts/notifications");
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAction(null);
    }
  };

  return (
    <div class="flex flex-wrap justify-end gap-2">
      <Show when={props.status === "draft"}>
        <Button size="sm" variant="danger" onClick={deleteDraft} disabled={isLoading()}>
          <i class={loadingAction() === "delete" ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} />
          <span>{messages().deleteDraft}</span>
        </Button>
        <Button
          size="sm"
          class={finalizeBlocked() ? "opacity-60" : undefined}
          onClick={finalize}
          disabled={isLoading()}
          aria-disabled={finalizeBlocked() ? "true" : undefined}
        >
          <i class={loadingAction() === "finalize" ? "ti ti-loader-2 animate-spin" : "ti ti-send"} />
          <span>{loadingAction() === "finalize" ? messages().checking : messages().finalize}</span>
        </Button>
      </Show>
      <Show when={props.errorCount > 0 && props.status !== "draft"}>
        <Button size="sm" variant="subtle" onClick={retryFailed} disabled={isLoading()}>
          <i class={loadingAction() === "retry" ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
          <span>{messages().retryFailed}</span>
        </Button>
      </Show>
    </div>
  );
}
