import { lazySync, sql } from "@k2b/cloud";
import type { signCodeRunToken } from "@k2b/cloud/code/run-token";
import { RunnerConfigSchema, type RunnerFetchRequest, type RunnerFetchResponse } from "@k2b/cloud/code/runner";
import { CAPABILITY_MAX_REQUEST_BYTES, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { coreSettings, logger } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { Queue, Scheduler, Worker } from "@k2b/sync";
import {
  claimCodeRuns,
  codeRunnerLease,
  processCodeScheduleTick,
  readCodeRunLimits,
  reconcileCodeRuns,
  recordCodeRunner,
} from "./scheduling";
import { codeSettings } from "./settings";

/** One installation-wide queue. A delivery is a dispatch wakeup, not an execution instruction or replay step. */
export type CodeRunWakeup = { runId: string };
export const codeRunQueue = lazySync((sync) => sync.queue<CodeRunWakeup>({ id: "core-code-runs" }));
export const codeRunScheduler = lazySync((sync) => sync.scheduler({ id: "core-code-schedules" }));
/** Postgres commit precedes publication; a crashed publisher can repeat delivery safely. */
export const codeRunOutbox = createPgOutbox<OutboxRow & { run_id: string }>({
  table: "code.run_outbox",
  name: "core:code-runs",
  orderBy: "run_id",
  sequence: "sequence",
  batchSize: 100,
  reconcileIntervalMs: 1_000,
  publish: async (row) => {
    await codeRunQueue().send({ data: { runId: row.run_id }, idempotencyKey: row.id });
    await sql`UPDATE code.runs SET wake_at=clock_timestamp() WHERE id=${row.run_id}::uuid`;
  },
});
/** Configuration is read at runner startup. No runner environment variables control budgets. */
export async function readCodeRunnerConfig() {
  return RunnerConfigSchema.parse({
    slots: await codeSettings.get("core.code.runner_slots"),
    pollMs: await codeSettings.get("core.code.runner_poll_ms"),
    retryMs: await codeSettings.get("core.code.runner_retry_ms"),
    transportMs: await codeSettings.get("core.code.runner_transport_ms"),
    bundleBytes: await codeSettings.get("core.code.bundle_bytes"),
    cacheBytes: await codeSettings.get("core.code.runner_cache_bytes"),
    bridgeBytes: CAPABILITY_MAX_REQUEST_BYTES,
    bridgeConcurrency: await codeSettings.get("core.code.runner_bridge_concurrency"),
    processMemoryBytes: await codeSettings.get("core.code.runner_process_memory_bytes"),
  });
}
/** Same stateless fetch implementation is used by HTTP and in-process multi-runner integration tests. */
export async function fetchCodeRuns(
  request: RunnerFetchRequest,
  signal: AbortSignal,
  dependencies: { queue?: Queue<CodeRunWakeup>; sign?: typeof signCodeRunToken } = {},
): Promise<RunnerFetchResponse> {
  const config = await readCodeRunnerConfig();
  const free = Math.min(request.freeSlots, config.slots);
  await recordCodeRunner(request.instanceId, free);
  const abort = AbortSignal.any([signal, AbortSignal.timeout(config.pollMs)]);
  const reader = await (dependencies.queue ?? codeRunQueue()).reader({ signal: abort });
  try {
    while (!abort.aborted) {
      const ticket = await reader.receive({ waitMs: 1000, signal: abort });
      if (!ticket) continue;
      // Selection skips Codes at their limit rather than making this runner wait behind their tickets.
      const runs = await claimCodeRuns(free, await readCodeRunLimits());
      await ticket.ack();
      if (runs.length) {
        const leases = [];
        for (const run of runs) leases.push(await codeRunnerLease(run, dependencies.sign));
        // Even a lost response consumed these slots until the next signed advertisement.
        await recordCodeRunner(request.instanceId, free - runs.length);
        return { runs: leases };
      }
    }
    return { runs: [] };
  } catch (error) {
    if (abort.aborted && !signal.aborted) return { runs: [] };
    throw error;
  } finally {
    await reader.close();
  }
}

const scheduleId = (versionId: string, entrypoint: string) =>
  `code:${new Bun.CryptoHasher("sha256").update(`${versionId}:${entrypoint}`).digest("hex")}`;
/** Reconciles at most 50 Codes per pass. Stale version callbacks recheck the active version before admitting a tick. */
export function createCodeScheduleReconciler(scheduler: Scheduler) {
  let cursor = "";
  let desired = new Set<string>();
  return async () => {
    const versions = await sql<{ id: string; version_id: string; manifest: unknown }[]>`SELECT c.id,v.id AS version_id,v.manifest
      FROM code.codes c JOIN code.versions v ON v.id=c.active_version_id WHERE c.state='active' AND c.id>${cursor}
      ORDER BY c.id LIMIT 50`;
    const timezone = (await coreSettings.get<string>("app.timezone")) || "UTC";
    for (const version of versions) {
      const manifest = CodeCheckedVersionManifestSchema.safeParse(version.manifest);
      if (!manifest.success) continue;
      for (const entry of manifest.data.entrypoints) {
        if (entry.kind !== "schedule" || !entry.cron) continue;
        const id = scheduleId(version.version_id, entry.entrypoint);
        desired.add(id);
        await scheduler.create({
          id,
          cron: entry.cron,
          timezone,
          misfire: "latest",
          meta: { family: "code", codeId: version.id },
          process: async (ctx) => {
            await processCodeScheduleTick({
              codeId: version.id,
              versionId: version.version_id,
              entrypoint: entry.entrypoint,
              slot: ctx.slot,
            });
          },
        });
      }
    }
    if (versions.length === 50) cursor = versions.at(-1)!.id;
    else {
      for (const schedule of await scheduler.list())
        if (schedule.id.startsWith("code:") && !desired.has(schedule.id)) await scheduler.delete({ id: schedule.id });
      cursor = "";
      desired = new Set();
    }
  };
}

/** Core lifecycle owns the queue publisher, scheduler worker and bounded lease/outbox repair. Stop drains every owned task. */
export async function startCodeScheduling(): Promise<() => Promise<void>> {
  let worker: Worker | undefined;
  let pending: Promise<void> | undefined;
  const reconcileSchedules = createCodeScheduleReconciler(codeRunScheduler());
  const recover = async () => {
    await reconcileCodeRuns();
    await reconcileSchedules();
    await codeRunOutbox.notify();
  };
  try {
    await recover();
    worker = await codeRunScheduler().process();
    codeRunOutbox.start();
  } catch (error) {
    worker?.stop();
    await worker?.drain();
    await codeRunOutbox.stop();
    throw error;
  }
  const timer = setInterval(() => {
    if (pending) return;
    pending = recover()
      .catch(() => {
        logger("core:code-scheduling").error("code_scheduling_recovery_failed");
      })
      .finally(() => {
        pending = undefined;
      });
  }, 5_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await pending;
    worker?.stop();
    await worker?.drain();
    await codeRunOutbox.stop();
  };
}
