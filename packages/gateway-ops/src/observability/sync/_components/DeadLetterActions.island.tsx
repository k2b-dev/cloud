import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";

type Props = { kind: "queue" | "job"; appId: string; store: string; messageId: string };

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

export default function DeadLetterActions(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const param = () => ({ app: props.appId, kind: props.kind, store: props.store });

  const requeue = mutation.create<boolean, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(t.syncRequeueConfirm({ messageId: props.messageId, store: props.store }), {
        title: t.syncRequeue,
        icon: "ti ti-refresh",
        confirmText: t.syncRequeue,
      });
      if (!confirmed) return false;
      const response = await syncApiClient["dead-letters"][":app"][":kind"][":store"].requeue.$post({
        param: param(),
        json: { messageId: props.messageId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.syncRequeueFailed));
      return true;
    },
    onSuccess: (done) => {
      if (!done) return;
      toast.success(t.syncRequeued);
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
      <Button type="button" variant="secondary" size="xs" disabled={busy()} onClick={() => requeue.mutate()}>
        <i class={`ti ${requeue.loading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} />
        {t.syncRequeue}
      </Button>
      <Button type="button" variant="danger" size="xs" disabled={busy()} onClick={() => remove.mutate()}>
        <i class={`ti ${remove.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} />
        {t.remove}
      </Button>
    </div>
  );
}
