import { confirm } from "@k2b/ui/v2";
import { gatewayOpsMessages } from "../../../messages";
import { syncApiClient } from "../client";

/** What a deed on one retained dead letter needs. The API checks admin access and the OAuth admin scope. */
export type DeadLetterTarget = {
  kind: "queue" | "job" | "topic";
  appId: string;
  store: string;
  messageId: string;
  tenantId: string;
  consumer?: string;
  replayAvailable?: boolean;
};

const readErrorMessage = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

/** A topic entry is retried for its consumer; a queue or job message goes back into its store. */
export const canRetry = (target: DeadLetterTarget) => target.kind !== "topic" || Boolean(target.replayAvailable && target.consumer);

/**
 * Asks, then requeues (queue, job) or retries the consumer (topic). Resolves `false` when the person declined and
 * throws with the server's reason when the deed failed.
 */
export const retryDeadLetter = async (target: DeadLetterTarget, locale: string): Promise<boolean> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const topic = target.kind === "topic";
  const label = topic ? t.syncReplay : t.syncRequeue;
  const agreed = await confirm({
    title: label,
    description: topic
      ? t.syncReplayConfirm({ messageId: target.messageId, store: target.store, consumer: target.consumer ?? "" })
      : t.syncRequeueConfirm({ messageId: target.messageId, store: target.store }),
    confirm: label,
  });
  if (!agreed) return false;
  const consumer = target.consumer;
  if (topic && (!target.replayAvailable || !consumer)) throw new Error(t.syncReplayUnavailable);
  const response =
    topic && consumer
      ? await syncApiClient["dead-letters"][":app"].topic[":store"].replay.$post({
          param: { app: target.appId, store: target.store },
          json: { messageId: target.messageId, consumer, tenantId: target.tenantId },
        })
      : await syncApiClient["dead-letters"][":app"][":kind"][":store"].requeue.$post({
          param: { app: target.appId, kind: target.kind, store: target.store },
          json: { messageId: target.messageId },
        });
  if (!response.ok) throw new Error(await readErrorMessage(response, topic ? t.syncReplayFailed : t.syncRequeueFailed));
  return true;
};

/** Asks, then deletes the retained dead letter. Resolves `false` when the person declined. */
export const deleteDeadLetter = async (target: DeadLetterTarget, locale: string): Promise<boolean> => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const agreed = await confirm({
    title: t.syncDeleteDeadLetter,
    description: t.syncDeleteConfirm({ messageId: target.messageId, store: target.store }),
    confirm: t.syncDeleteDeadLetter,
  });
  if (!agreed) return false;
  const response = await syncApiClient["dead-letters"][":app"][":kind"][":store"][":messageId"].$delete({
    param: { app: target.appId, kind: target.kind, store: target.store, messageId: target.messageId },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, t.syncDeleteFailed));
  return true;
};
