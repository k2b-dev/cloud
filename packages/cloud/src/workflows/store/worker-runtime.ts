import { localWorkflowWorkers, workflowWakeTopic } from "../../_internal/workflow-signals";

export { notifyWorkflowWorker } from "../../_internal/workflow-signals";

import { workWakeOrigin } from "../../_internal/work-wake";
import { logger } from "../../services/logging";
import { createRuntimeLifecycle, superviseRuntimeTask } from "../../services/runtime-lifecycle";
import { createWorkflowWorkerPool } from "./worker-pool";

const log = logger("workflows:worker");
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
      const workers = localWorkflowWorkers.get(options.appId) ?? new Set();
      workers.add(wake);
      localWorkflowWorkers.set(options.appId, workers);
      pool.start();
      reader = superviseRuntimeTask({
        name: "Workflow wake reader",
        signal: controller.signal,
        onError: ({ error }) => report(error),
        run: async (signal) => {
          for await (const event of workflowWakeTopic().live({ tenantId: options.appId, signal }))
            if (event.data?.origin !== workWakeOrigin) wake();
        },
      });
      // Repair missed hints, due deadlines and expired leases; execution wakes immediately.
      timer = setInterval(wake, 30_000);
      wake();
    },
    stop: async () => {
      clearInterval(timer);
      controller?.abort();
      const workers = localWorkflowWorkers.get(options.appId);
      workers?.delete(wake);
      if (workers?.size === 0) localWorkflowWorkers.delete(options.appId);
      await Promise.all([pool.stop(), recovery, reader]);
      controller = undefined;
    },
  });
};
