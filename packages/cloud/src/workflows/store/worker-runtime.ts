import { lazySync } from "../../_internal/process-sync";
import { logger } from "../../services/logging";
import { createRuntimeLifecycle, superviseRuntimeTask } from "../../services/runtime-lifecycle";
import { createWorkflowWorkerPool } from "./worker-pool";

const log = logger("workflows:worker");
const wakeTopic = lazySync((sync) =>
  sync.topic<null>({
    id: "cloud:workflow-wake",
    owner: "cloud",
    retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
    maxPayloadBytes: 2000,
  }),
);
const localWorkers = new Map<string, Set<() => void>>();

/** Call after the application's transaction commits. Postgres remains the work queue. */
export const notifyWorkflowWorker = (appId: string): void => {
  for (const wake of localWorkers.get(appId) ?? []) wake();
  // Hints are best effort. Neither broker latency nor failure delays an accepted request.
  void Promise.resolve()
    .then(() => wakeTopic().publish({ tenantId: appId, data: null }))
    .catch((error) => {
      log.warn("Workflow wake notification failed", { appId, error: String(error) });
    });
};

/** Event-driven claims plus a recovery scan for lost hints, deadlines and expired leases. */
export const createWorkflowWorker = (options: {
  appId: string;
  concurrency: number;
  run(): Promise<boolean>;
  recover(): Promise<unknown>;
}) => {
  const report = (error: unknown) => log.warn("Workflow worker failed", { appId: options.appId, error: String(error) });
  const pool = createWorkflowWorkerPool({ ...options, onError: report });
  let controller: AbortController | undefined;
  let reader: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let recovery: Promise<void> | undefined;
  let requested = 0;
  const wake = () => {
    if (!controller || controller.signal.aborted) return;
    pool.wake();
    requested += 1;
    recovery ??= Promise.resolve().then(async () => {
      try {
        let observed: number;
        do {
          observed = requested;
          await options.recover();
          pool.wake();
        } while (!controller?.signal.aborted && observed !== requested);
      } catch (error) {
        report(error);
      } finally {
        recovery = undefined;
      }
    });
  };
  return createRuntimeLifecycle({
    start: async () => {
      controller = new AbortController();
      const workers = localWorkers.get(options.appId) ?? new Set();
      workers.add(wake);
      localWorkers.set(options.appId, workers);
      pool.start();
      reader = superviseRuntimeTask({
        name: "Workflow wake reader",
        signal: controller.signal,
        onError: ({ error }) => report(error),
        run: async (signal) => {
          for await (const _event of wakeTopic().live({ tenantId: options.appId, signal })) wake();
        },
      });
      // Keep the existing one-second recovery bound; execution does not wait for it.
      timer = setInterval(wake, 1_000);
      wake();
    },
    stop: async () => {
      clearInterval(timer);
      controller?.abort();
      const workers = localWorkers.get(options.appId);
      workers?.delete(wake);
      if (workers?.size === 0) localWorkers.delete(options.appId);
      await Promise.all([pool.stop(), recovery, reader]);
      controller = undefined;
    },
  });
};
