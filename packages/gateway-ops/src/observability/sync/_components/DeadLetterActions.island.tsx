import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";

type Props = {
  kind: "queue" | "job" | "topic";
  appId: string;
  store: string;
  messageId: string;
  consumer?: string;
  tenantId: string;
  replayAvailable?: boolean;
};

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

export default function DeadLetterActions(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const param = () => ({ app: props.appId, kind: props.kind, store: props.store });

  const isTopic = () => props.kind === "topic";
  const retryLabel = () => (isTopic() ? t.syncReplay : t.syncRequeue);

  const requeue = mutation.create<boolean, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(
        isTopic()
          ? t.syncReplayConfirm({ messageId: props.messageId, store: props.store, consumer: props.consumer ?? "" })
          : t.syncRequeueConfirm({ messageId: props.messageId, store: props.store }),
        {
          title: retryLabel(),
          icon: "ti ti-refresh",
          confirmText: retryLabel(),
        },
      );
      if (!confirmed) return false;
      let response: Response;
      if (props.kind === "topic") {
        const consumer = props.consumer;
        if (!props.replayAvailable || !consumer) throw new Error(t.syncReplayUnavailable);
        response = await syncApiClient["dead-letters"][":app"].topic[":store"].replay.$post({
          param: { app: props.appId, store: props.store },
          json: { messageId: props.messageId, consumer, tenantId: props.tenantId },
        });
      } else {
        response = await syncApiClient["dead-letters"][":app"][":kind"][":store"].requeue.$post({
          param: param(),
          json: { messageId: props.messageId },
        });
      }
      if (!response.ok) throw new Error(await readErrorMessage(response, isTopic() ? t.syncReplayFailed : t.syncRequeueFailed));
      return true;
    },
    onSuccess: (done) => {
      if (!done) return;
      toast.success(isTopic() ? t.syncReplayed : t.syncRequeued);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const remove = mutation.create<boolean, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(t.syncDeleteConfirm({ messageId: props.messageId, store: props.store }), {
        title: t.syncDeleteDeadLetter,
        icon: "ti ti-trash",
        confirmText: t.syncDeleteDeadLetter,
        variant: "danger",
      });
      if (!confirmed) return false;
      const response = await syncApiClient["dead-letters"][":app"][":kind"][":store"][":messageId"].$delete({
        param: { ...param(), messageId: props.messageId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.syncDeleteFailed));
      return true;
    },
    onSuccess: (done) => {
      if (!done) return;
      toast.success(t.syncDeadLetterDeleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  const busy = () => requeue.loading() || remove.loading();

  return (
    <div class="flex items-center justify-end gap-1">
      <Button
        type="button"
        variant="secondary"
        size="xs"
        disabled={busy() || (isTopic() && (!props.replayAvailable || !props.consumer))}
        title={isTopic() && !props.replayAvailable ? t.syncReplayUnavailable : undefined}
        onClick={() => requeue.mutate()}
      >
        <i class={`ti ${requeue.loading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} />
        {retryLabel()}
      </Button>
      <Button type="button" variant="danger" size="xs" disabled={busy()} onClick={() => remove.mutate()}>
        <i class={`ti ${remove.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} />
        {t.remove}
      </Button>
    </div>
  );
}
