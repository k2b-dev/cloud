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
  const wake = () => {
    if (stopping) return;
    requested = true;
    active ??= Promise.resolve().then(async () => {
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
        } while (!stopping && requested);
      } catch (error) {
        report(error);
      } finally {
        active = undefined;
      }
    });
  };
  const timer = setInterval(wake, 5_000);
  timer.unref();
  wake();
  return {
    wake,
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await active;
    },
  };
};
