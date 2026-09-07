import type { QueueDelivery } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger, trace } from "../logging";
import { superviseRuntimeTask } from "../runtime-lifecycle";
import { syncOps } from "../sync-ops";
import { processNotificationDelivery, recoverNotificationDeliveries } from "./dispatcher";

type DeliveryMessage = { deliveryId: string };

const log = logger("notifications:delivery");
const ENQUEUE_DEDUPLICATION_WINDOW_MS = 60_000;
const deliveryQueue = lazySync((sync) => {
  const handle = sync.queue<DeliveryMessage>({
    id: "cloud-notification-deliveries",
    owner: "core",
    delivery: { ackWaitMs: 60_000, maxAttempts: 20 },
    dedupeWindowMs: ENQUEUE_DEDUPLICATION_WINDOW_MS * 2,
  });
  syncOps.registerDeadLetters({ name: "cloud-notification-deliveries", kind: "queue", store: handle.deadLetters });
  return handle;
});

export const enqueueNotificationDelivery = async (deliveryId: string, delayMs?: number): Promise<void> => {
  const bucket = Math.floor(Date.now() / ENQUEUE_DEDUPLICATION_WINDOW_MS);
  await deliveryQueue().send({
    data: { deliveryId },
    ...(delayMs ? { delayMs } : {}),
    // Recovery scans are intentionally repetitive. A time bucket suppresses
    // queue noise without permanently blocking a later recovery attempt.
    idempotencyKey: `delivery:${deliveryId}:${bucket}`,
  });
};

export const enqueueNotificationDeliveries = async (deliveryIds: readonly string[]): Promise<void> => {
  await Promise.all(deliveryIds.map((id) => enqueueNotificationDelivery(id)));
};

const handleDelivery = async (message: QueueDelivery<DeliveryMessage>): Promise<void> => {
  try {
    const result = await trace.withSpan(
      {
        name: "Notification delivery",
        source: "notifications:delivery",
        appId: "core",
        category: "job",
        kind: "consumer",
        attributes: { "cloud.notification.delivery_id": message.data.deliveryId },
      },
      () => processNotificationDelivery(message.data.deliveryId),
    );
    if (result.activatedIds?.length) await enqueueNotificationDeliveries(result.activatedIds);
    if (result.status === "retry") {
      await message.retry({ delayMs: result.retryAfterMs, reason: result.error ?? "provider_retry" });
      return;
    }
    await message.ack();
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "Notification worker failed";
    log.error("Delivery worker failed", { deliveryId: message.data.deliveryId, error: messageText });
    await message.retry({ delayMs: 5_000, reason: messageText }).catch(() => false);
  }
};

let stopRuntime: (() => Promise<void>) | null = null;

export const startNotificationRuntime = async (input: { concurrency?: number; recoveryIntervalMs?: number } = {}): Promise<void> => {
  if (stopRuntime) return;
  const controller = new AbortController();
  const concurrency = Math.min(Math.max(Math.floor(input.concurrency ?? 4), 1), 16);
  const recoveryIntervalMs = Math.max(input.recoveryIntervalMs ?? 30_000, 5_000);

  const recover = async () => {
    try {
      await enqueueNotificationDeliveries(await recoverNotificationDeliveries());
    } catch (error) {
      log.error("Delivery recovery failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  await recover();
  const timer = setInterval(() => void recover(), recoveryIntervalMs);
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  const readers = Array.from({ length: concurrency }, (_, index) =>
    superviseRuntimeTask({
      name: `Notification delivery reader ${index}`,
      signal: controller.signal,
      run: async (signal) => {
        const reader = await deliveryQueue().reader();
        try {
          for await (const message of reader.stream({ signal })) await handleDelivery(message);
        } finally {
          await reader.close();
        }
      },
      onError: ({ error, failureCount, retryInMs }) =>
        log.error("Delivery reader stopped; restarting", {
          reader: index,
          error: error instanceof Error ? error.message : String(error),
          failureCount,
          retryInMs,
        }),
    }),
  );

  stopRuntime = async () => {
    clearInterval(timer);
    controller.abort();
    await Promise.allSettled(readers);
    stopRuntime = null;
  };
};

export const stopNotificationRuntime = async (): Promise<void> => {
  await stopRuntime?.();
};
