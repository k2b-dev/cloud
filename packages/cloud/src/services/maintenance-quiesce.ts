import { type QuietReport, quietGeneration } from "../contracts/maintenance";
import {
  clearQuietReport,
  type ObservedMaintenance,
  publishQuietReport,
  QUIET_REPORT_INTERVAL_MS,
  readMaintenanceState,
  watchMaintenanceState,
} from "./maintenance-state";
import { superviseRuntimeTask } from "./runtime-lifecycle";
import { processQuiesce, type QuiesceController, type ResumeRetry } from "./runtime-quiesce";

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
 * stays; at start, an unreadable state counts as off until the watch reads it.
 * Resume retries what fails to start or runs past its step budget
 * (`onResumeRetry` hears each retry, also while a worker waits for old
 * handlers); what still fails goes to `onResumeFailed`, and `app.start()` then
 * restarts the process like a failed start. The controller runs each
 * transition outside the supervised context of this watcher. Each report names the stage „Ruhe“ it answers
 * (`quietGeneration`), so Core never counts a report of an earlier one.
 * `stop()` leaves the controller not quiet: nothing stays quiet behind a
 * watcher that no longer follows the record.
 */
export const startMaintenanceQuiesce = async ({
  appId,
  instanceId,
  controller = processQuiesce,
  dependencies = defaults,
  onDrainErrors,
  onResumeFailed,
  onResumeRetry,
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
  onResumeRetry?(retry: ResumeRetry): void;
  onReportError(error: unknown): void;
  reportIntervalMs?: number;
  checkIntervalMs?: number;
}): Promise<{ stop(): Promise<void> }> => {
  const watching = new AbortController();
  let reporter: ReturnType<typeof setInterval> | undefined;
  let lastReport: { inFlight: number; at: number } | undefined;
  let reporting: Promise<void> = Promise.resolve();
  /** The stage „Ruhe“ this instance follows, while it does. */
  let generation: string | undefined;

  const report = (force = false) => {
    if (!generation) return;
    const inFlight = controller.inFlight();
    const now = Date.now();
    if (!force && lastReport && lastReport.inFlight === inFlight && now - lastReport.at < reportIntervalMs) return;
    lastReport = { inFlight, at: now };
    const current = { appId, instanceId, generation, inFlight };
    reporting = reporting
      .then(() => dependencies.publish(current))
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
    if (watching.signal.aborted) return;
    const wanted = observed?.state.quiesce === true;
    if (wanted && observed && controller.quiesced) {
      // Still quiet, but switched off and on again meanwhile: answer the new stage at once.
      const next = quietGeneration(observed.state);
      if (next !== generation) {
        generation = next;
        report(true);
      }
      return;
    }
    if (wanted === controller.quiesced) return;
    if (wanted && observed) {
      generation = quietGeneration(observed.state);
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
    generation = undefined;
    reporting = reporting.then(() => dependencies.clear(instanceId)).catch(onReportError);
    // A supervised worker whose old handlers never end fails after the resume resolved; it restarts the process too.
    void controller.resume({ onRetry: onResumeRetry, onLateFailure: (failure) => onResumeFailed([failure]) }).then((failures) => {
      if (failures.length) onResumeFailed(failures);
    });
  };

  // An unreadable state does not block the start; the watcher below applies it once NATS answers.
  apply(
    await dependencies.read().catch((error: unknown) => {
      onReportError(error);
      return null;
    }),
  );
  // runtime-timer: the maintenance watcher that switches quiesce itself.
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
      generation = undefined;
      controller.release();
      await reporting;
      if (wasQuiet) await dependencies.clear(instanceId).catch(onReportError);
    },
  };
};
