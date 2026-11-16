import { expect, test } from "bun:test";
import type { MaintenanceState, QuietReport } from "../contracts/maintenance";
import { startMaintenanceQuiesce } from "./maintenance-quiesce";
import type { ObservedMaintenance } from "./maintenance-state";
import { createRuntimeLifecycle } from "./runtime-lifecycle";
import { createQuiesceController, quiesceWorker } from "./runtime-quiesce";

const state = (quiesce: boolean, quiesceEpoch?: number): ObservedMaintenance => ({
  updatedAt: Date.UTC(2026, 10, 16, 13, 0),
  state: {
    id: "maintenance-1",
    startedAt: Date.UTC(2026, 10, 16, 13, 0),
    startedBy: { id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51", label: "Lea Muster" },
    quiesce,
    ...(quiesceEpoch ? { quiesceEpoch } : {}),
    bypassKey: "a".repeat(43),
  } satisfies MaintenanceState,
});

/**
 * A maintenance record the test changes by hand, and what the instance reported. Like the real watch, the watch
 * loop itself delivers each change, so `onChange` runs in the watcher's own context (inside `superviseRuntimeTask`).
 */
const harness = (initial: ObservedMaintenance | null) => {
  const changes: Array<ObservedMaintenance | null> = [];
  let wake = () => {};
  const reports: QuietReport[] = [];
  const cleared: string[] = [];
  return {
    reports,
    cleared,
    change: (observed: ObservedMaintenance | null) => {
      changes.push(observed);
      wake();
    },
    dependencies: {
      read: async () => initial,
      watch: async ({ signal, onChange }: { signal: AbortSignal; onChange: (observed: ObservedMaintenance | null) => void }) => {
        while (!signal.aborted) {
          if (changes.length > 0) {
            onChange(changes.shift() ?? null);
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
      publish: async (report: QuietReport) => void reports.push(report),
      clear: async (instanceId: string) => void cleared.push(instanceId),
    },
  };
};

/** Lets every promise chain of one transition settle: a zero timeout runs after all pending microtasks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const start = (controller: ReturnType<typeof createQuiesceController>, dependencies: ReturnType<typeof harness>["dependencies"]) => {
  const resumeFailures: unknown[][] = [];
  const resumeRetries: number[] = [];
  return {
    resumeFailures,
    resumeRetries,
    started: startMaintenanceQuiesce({
      appId: "mail",
      instanceId: "instance-a",
      controller,
      dependencies,
      onDrainErrors: () => {},
      onResumeFailed: (errors) => resumeFailures.push(errors),
      onResumeRetry: ({ attempt }) => resumeRetries.push(attempt),
      onReportError: () => {},
      // An hour: periodic reports never fire during the test.
      checkIntervalMs: 3_600_000,
    }),
  };
};

test("an instance that starts during stage Ruhe is quiet before its workers start and reports it", async () => {
  const controller = createQuiesceController();
  const maintenance = harness(state(true, 1));
  const { started } = start(controller, maintenance.dependencies);
  const quiesce = await started;
  expect(controller.quiesced).toBe(true);
  await settle();
  expect(maintenance.reports.at(-1)).toEqual({ appId: "mail", instanceId: "instance-a", generation: "maintenance-1:1", inFlight: 0 });
  await quiesce.stop();
  expect(maintenance.cleared).toEqual(["instance-a"]);
  // Nothing stays quiet behind a watcher that stopped.
  expect(controller.quiesced).toBe(false);
});

test("a stage Ruhe switched off and on again that the instance saw only as on is answered under the new generation", async () => {
  const controller = createQuiesceController();
  const maintenance = harness(state(true, 1));
  const { started } = start(controller, maintenance.dependencies);
  const quiesce = await started;
  await settle();
  maintenance.change(state(true, 2));
  await settle();
  expect(maintenance.reports.at(-1)?.generation).toBe("maintenance-1:2");
  expect(controller.quiesced).toBe(true);
  await quiesce.stop();
});

test("quiesce on, off and maintenance end follow the record; off clears the report", async () => {
  const controller = createQuiesceController();
  const events: string[] = [];
  const runtime = createRuntimeLifecycle(
    { start: async () => void events.push("start"), stop: async () => void events.push("stop") },
    { controller },
  );
  const maintenance = harness(state(false));
  const { started } = start(controller, maintenance.dependencies);
  const quiesce = await started;
  await runtime.start();
  await settle();

  maintenance.change(state(true));
  await settle();
  expect(controller.quiesced).toBe(true);
  expect(events).toEqual(["start", "stop"]);
  expect(maintenance.reports.length).toBeGreaterThan(0);

  maintenance.change(state(true));
  maintenance.change(null);
  await settle();
  expect(controller.quiesced).toBe(false);
  expect(events).toEqual(["start", "stop", "start"]);
  expect(maintenance.cleared).toEqual(["instance-a"]);
  await quiesce.stop();
  await runtime.stop();
});

test("a resume that still fails after its retries is handed to the app, which restarts the process", async () => {
  const controller = createQuiesceController({ retryMs: 1 });
  let starts = 0;
  const runtime = createRuntimeLifecycle(
    {
      start: async () => {
        starts += 1;
        if (starts > 1) throw new Error("database unavailable");
      },
      stop: async () => {},
    },
    { controller },
  );
  const maintenance = harness(state(false));
  const { started, resumeFailures, resumeRetries } = start(controller, maintenance.dependencies);
  const quiesce = await started;
  await runtime.start();
  await settle();
  maintenance.change(state(true));
  await settle();
  maintenance.change(state(false));
  while (resumeFailures.length === 0) await Bun.sleep(1);
  expect(resumeRetries).toEqual([1, 2, 3, 4]);
  expect(resumeFailures.flat().map((error) => (error instanceof Error ? error.message : String(error)))).toEqual(["database unavailable"]);
  await quiesce.stop();
});

test("a worker that a runtime creates during a resume of the watcher is not supervised: its failure restarts the process", async () => {
  const controller = createQuiesceController({ retryMs: 1 });
  let failing = false;
  let worker: Promise<unknown> | undefined;
  const runtime = createRuntimeLifecycle(
    {
      start: async () => {
        worker ??= quiesceWorker(
          async () => {
            if (failing) throw new Error("consumer unavailable");
            return { active: 0, capacity: 1, stop: () => {}, drain: async () => {}, [Symbol.asyncDispose]: async () => {} };
          },
          { controller },
        );
        await worker;
      },
      stop: async () => {},
    },
    { controller },
  );
  // The instance starts during stage Ruhe: the runtime and its worker start with the resume the watcher triggers.
  const maintenance = harness(state(true));
  const { started, resumeFailures } = start(controller, maintenance.dependencies);
  const quiesce = await started;
  await runtime.start();
  maintenance.change(state(false));
  while (!worker) await Bun.sleep(1);
  await worker;
  await settle();

  maintenance.change(state(true));
  await settle();
  failing = true;
  maintenance.change(state(false));
  while (resumeFailures.length === 0) await Bun.sleep(1);
  expect(resumeFailures.flat().map((error) => (error instanceof Error ? error.message : String(error)))).toEqual(["consumer unavailable"]);
  await quiesce.stop();
  await runtime.stop();
});
