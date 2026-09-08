import type { DeliveryConfig, JobContext, Worker } from "@k2b/sync";
import { lazySync } from "../../_internal/process-sync";
import { logger, trace } from "../logging";
import { createRuntimeLifecycle, createRuntimeTaskTracker, stopRuntimeJobs } from "../runtime-lifecycle";

import { processNotificationDelivery, recoverNotificationDeliveries } from "./dispatcher";

type DeliveryMessage = { deliveryId: string };

const log = logger("notifications:delivery");
const ENQUEUE_DEDUPLICATION_WINDOW_MS = 60_000;
// Postgres owns delivery retries: provider failures are persisted by the
// dispatcher, and the recovery scan re-enqueues pending rows. A handler throw
// therefore means the database itself was unreachable; a few spaced attempts
// cover a blip, and a longer outage dead-letters once while recovery restores
// the row after the outage anyway.
const HANDLER_RETRY = { maxAttempts: 3, backoffMs: [5_000, 30_000] } satisfies Partial<DeliveryConfig>;
const deliveryJob = lazySync((sync) => {
  const handle = sync.job<DeliveryMessage>({
    id: "cloud-notification-deliveries",
    owner: "core",
    delivery: { ackWaitMs: 60_000, ...HANDLER_RETRY },
    dedupeWindowMs: ENQUEUE_DEDUPLICATION_WINDOW_MS * 2,
  });

  return handle;
});

export const enqueueNotificationDelivery = async (deliveryId: string, delayMs?: number): Promise<void> => {
  const bucket = Math.floor(Date.now() / ENQUEUE_DEDUPLICATION_WINDOW_MS);
  await deliveryJob().submit({
    input: { deliveryId },
    ...(delayMs ? { delayMs } : {}),
    // Recovery scans are intentionally repetitive. A time bucket suppresses
    // duplicate wakeups without permanently blocking a later recovery attempt.
    key: `delivery:${deliveryId}:${bucket}`,
  });
};

export const enqueueNotificationDeliveries = async (deliveryIds: readonly string[]): Promise<void> => {
  const bucket = Math.floor(Date.now() / ENQUEUE_DEDUPLICATION_WINDOW_MS);
  await deliveryJob().submitMany(
    deliveryIds.map((deliveryId) => ({
      key: `delivery:${deliveryId}:${bucket}`,
      input: { deliveryId },
    })),
  );
};

const handleDelivery = async (context: JobContext<DeliveryMessage>): Promise<void> => {
  const result = await trace.withSpan(
    {
      name: "Notification delivery",
      source: "notifications:delivery",
      appId: "core",
      category: "job",
      kind: "consumer",
      spanKey: trace.syncSpanKey("job", "cloud-notification-deliveries", context.jobId),
      attributes: { "cloud.notification.delivery_id": context.input.deliveryId },
    },
    () => processNotificationDelivery(context.input.deliveryId),
  );
  if (result.activatedIds?.length) await enqueueNotificationDeliveries(result.activatedIds);
  if (result.status === "retry") context.resubmit({ delayMs: result.retryAfterMs });
};

type RuntimeOptions = { concurrency?: number; recoveryIntervalMs?: number };
let runtimeOptions: RuntimeOptions = {};
let worker: Worker | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let recovery: Promise<void> | undefined;
const recoveryTasks = createRuntimeTaskTracker();

const recover = (): Promise<void> => {
  recovery ??= (
    recoveryTasks.run(async () => {
      try {
        await enqueueNotificationDeliveries(await recoverNotificationDeliveries());
      } catch (error) {
        log.error("Delivery recovery failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }) ?? Promise.resolve()
  ).finally(() => {
    recovery = undefined;
  });
  return recovery;
};

const lifecycle = createRuntimeLifecycle({
  start: async () => {
    recoveryTasks.open();
    const concurrency = Math.min(Math.max(Math.floor(runtimeOptions.concurrency ?? 4), 1), 16);
    const recoveryIntervalMs = Math.max(runtimeOptions.recoveryIntervalMs ?? 30_000, 5_000);
    worker = await deliveryJob().process(
      {
        concurrency,
        onError: ({ context, error }) => {
          log.error("Delivery worker failed", { deliveryId: context.input.deliveryId, attempt: context.attempt, error: error.message });
          return { action: "retry" };
        },
      },
      handleDelivery,
    );
    await recover();
    timer = setInterval(() => void recover(), recoveryIntervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  },
  stop: async () => {
    clearInterval(timer);
    timer = undefined;
    await stopRuntimeJobs(recoveryTasks, worker ? [worker] : []);
    worker = undefined;
  },
});

export const startNotificationRuntime = async (input: RuntimeOptions = {}): Promise<void> => {
  runtimeOptions = input;
  await lifecycle.start();
};
export const stopNotificationRuntime = lifecycle.stop;
