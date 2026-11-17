import { createRuntimeTaskTracker } from "../runtime-lifecycle";
import { backgroundWork } from "../runtime-quiesce";

/** Core delivery passes coalesce hints, including hints received during a pass. */
export const startEventDispatcher = (
  broker: {
    work(options: { reconcile: false }): Promise<number>;
    checkGap(): Promise<unknown>;
    retain(): Promise<unknown>;
  },
  report: (error: unknown) => void,
) => {
  let stopping = false;
  let requested = false;
  let active: Promise<void> | undefined;
  let maintenanceAt = Date.now() + 60_000;
  // Passes go through a tracker, so maintenance quiesce stops them; the first tick after resume catches up.
  const tasks = createRuntimeTaskTracker();
  tasks.open();
  const wake = () => {
    if (stopping) return;
    requested = true;
    active ??=
      tasks.run(async () => {
        try {
          do {
            requested = false;
            const processed = await broker.work({ reconcile: false });
            requested ||= processed > 0;
            if (Date.now() >= maintenanceAt) {
              maintenanceAt = Date.now() + 60_000;
              await broker.checkGap();
              await broker.retain();
            }
            // A pass in flight finishes its batch; quiesce stops the loop before the next one.
          } while (!stopping && requested && !backgroundWork.paused());
        } catch (error) {
          report(error);
        } finally {
          active = undefined;
        }
      }) ?? undefined;
  };
  // runtime-timer: wake() runs passes through the task tracker, which quiesce gates.
  const timer = setInterval(wake, 5_000);
  timer.unref();
  wake();
  return {
    wake,
    stop: async () => {
      stopping = true;
      tasks.close();
      clearInterval(timer);
      await active;
    },
  };
};
