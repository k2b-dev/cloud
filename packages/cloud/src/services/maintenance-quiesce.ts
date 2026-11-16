import type { QuietReport } from "../contracts/maintenance";
import {
  clearQuietReport,
  type ObservedMaintenance,
  publishQuietReport,
  QUIET_REPORT_INTERVAL_MS,
  readMaintenanceState,
  watchMaintenanceState,
} from "./maintenance-state";
import { superviseRuntimeTask } from "./runtime-lifecycle";
import { processQuiesce, type QuiesceController } from "./runtime-quiesce";

/** How often a quiesced instance checks whether its in-flight count changed. */
const QUIET_CHECK_MS = 2_000;

type Dependencies = {
  read: () => Promise<ObservedMaintenance | null>;
  watch: typeof watchMaintenanceState;
  publish: (report: QuietReport) => Promise<void>;
  clear: (instanceId: string) => Promise<void>;
};

const defaults: Dependencies = {
  read: readMaintenanceState,
  watch: watchMaintenanceState,
  publish: publishQuietReport,
  clear: clearQuietReport,
};

/**
 * Follow maintenance stage „Ruhe“ in one app process: quiesce the process's
 * background work while the maintenance record asks for it, resume it when
 * the record no longer does (quiesce off or maintenance ended), and report
 * the work still in flight for `cld admin maintenance status`.
 *
 * Reads the current state before it returns, so workers that start after
 * this already start quiet. When NATS is unreachable the last known state
 * stays. A resume that fails calls `onResumeFailed`; `app.start()` then
 * restarts the process like a failed start.
 */
export const startMaintenanceQuiesce = async ({
  appId,
  instanceId,
  controller = processQuiesce,
  dependencies = defaults,
  onDrainErrors,
  onResumeFailed,
  onReportError,
  reportIntervalMs = QUIET_REPORT_INTERVAL_MS,
  checkIntervalMs = QUIET_CHECK_MS,
}: {
  appId: string;
  instanceId: string;
  controller?: QuiesceController;
  dependencies?: Dependencies;
  onDrainErrors(errors: unknown[]): void;
  onResumeFailed(errors: unknown[]): void;
  onReportError(error: unknown): void;
  reportIntervalMs?: number;
  checkIntervalMs?: number;
}): Promise<{ stop(): Promise<void> }> => {
  const watching = new AbortController();
  let reporter: ReturnType<typeof setInterval> | undefined;
  let lastReport: { inFlight: number; at: number } | undefined;
  let reporting: Promise<void> = Promise.resolve();

  const report = (force = false) => {
    const inFlight = controller.inFlight();
    const now = Date.now();
    if (!force && lastReport && lastReport.inFlight === inFlight && now - lastReport.at < reportIntervalMs) return;
    lastReport = { inFlight, at: now };
    reporting = reporting
      .then(() => dependencies.publish({ appId, instanceId, inFlight }))
      .catch((error: unknown) => {
        lastReport = undefined;
        onReportError(error);
      });
  };

  const stopReporting = () => {
    if (reporter) clearInterval(reporter);
    reporter = undefined;
    lastReport = undefined;
  };

  const apply = (observed: ObservedMaintenance | null) => {
    const wanted = observed?.state.quiesce === true;
    if (wanted === controller.quiesced) return;
    if (wanted) {
      void controller.quiesce().then((errors) => {
        if (errors.length) onDrainErrors(errors);
        if (controller.quiesced) report(true);
      });
      report(true);
      // runtime-timer: status report of a quiesced instance, not background work.
      reporter = setInterval(() => report(), checkIntervalMs);
      if (typeof reporter === "object" && "unref" in reporter) reporter.unref();
      return;
    }
    stopReporting();
    reporting = reporting.then(() => dependencies.clear(instanceId)).catch(onReportError);
    void controller.resume().then((failures) => {
      if (failures.length) onResumeFailed(failures);
    });
  };

  apply(await dependencies.read());
  void superviseRuntimeTask({
    name: "Maintenance quiesce watcher",
    signal: watching.signal,
    run: (signal) => dependencies.watch({ signal, onChange: apply }),
    onError: ({ error }) => onReportError(error),
  });

  return {
    stop: async () => {
      watching.abort();
      const wasQuiet = controller.quiesced;
      stopReporting();
      await reporting;
      if (wasQuiet) await dependencies.clear(instanceId).catch(onReportError);
    },
  };
};
