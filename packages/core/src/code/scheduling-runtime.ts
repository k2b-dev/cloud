import { lazySync, sql } from "@k2b/cloud";
import type { signCodeRunToken } from "@k2b/cloud/code/run-token";
import { RunnerConfigSchema, type RunnerFetchRequest, type RunnerFetchResponse } from "@k2b/cloud/code/runner";
import { CAPABILITY_MAX_REQUEST_BYTES, CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { coreSettings, logger } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { Queue, Scheduler, Worker } from "@k2b/sync";
import { claimCodeWork } from "./dispatch";
import { reconcileCodeJobs } from "./runner-jobs";
import { codeRunnerLease, processCurrentCodeScheduleTick, readCodeRunLimits, reconcileCodeRuns, recordCodeRunner } from "./scheduling";
import { CODE_SCHEDULE_TICK_RETENTION_MS } from "./scheduling-contracts";
import { codeSettings } from "./settings";

/** One installation-wide queue. A delivery is a dispatch wakeup, not an execution instruction or replay step. */
export type CodeRunWakeup = { runId: string };
export const codeRunQueue = lazySync((sync) => sync.queue<CodeRunWakeup>({ id: "core-code-runs" }));
export const codeRunScheduler = lazySync((sync) =>
  sync.scheduler({ id: "core-code-schedules", retention: { maxAgeMs: CODE_SCHEDULE_TICK_RETENTION_MS } }),
);
/** Postgres commit precedes publication; a crashed publisher can repeat delivery safely. */
export const createCodeRunOutbox = (queue: () => Queue<CodeRunWakeup>) =>
  createPgOutbox<OutboxRow & { run_id: string }>({
    table: "code.run_outbox",
    name: "core:code-runs",
    orderBy: "run_id",
    sequence: "sequence",
    batchSize: 100,
    reconcileIntervalMs: 1_000,
    publish: async (row) => {
      await queue().send({ data: { runId: row.run_id }, idempotencyKey: row.id });
      await sql`UPDATE code.runs SET wake_at=clock_timestamp() WHERE id=${row.run_id}::uuid`;
    },
  });
export const codeRunOutbox = createCodeRunOutbox(codeRunQueue);
/** Job tickets use the same queue/consumer and therefore the same runner slot advertisement. */
export const createCodeJobOutbox = (queue: () => Queue<CodeRunWakeup>) =>
  createPgOutbox<OutboxRow & { job_id: string }>({
    table: "code.job_outbox",
    name: "core:code-jobs",
    orderBy: "job_id",
    sequence: "sequence",
    batchSize: 100,
    reconcileIntervalMs: 1000,
    publish: async (row) => {
      await queue().send({ data: { runId: row.job_id }, idempotencyKey: row.id });
    },
  });
export const codeJobOutbox = createCodeJobOutbox(codeRunQueue);
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
      const { runs, jobs } = await claimCodeWork(free, request.instanceId, await readCodeRunLimits());
      await ticket.ack();
      if (runs.length || jobs.length) {
        const leases = [];
        for (const run of runs) leases.push(await codeRunnerLease(run, dependencies.sign));
        // Even a lost response consumed these slots until the next signed advertisement.
        await recordCodeRunner(request.instanceId, free - runs.length - jobs.length);
        return { runs: leases, jobs };
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

const scheduleId = (codeId: string, entrypoint: string) =>
  `code:${new Bun.CryptoHasher("sha256").update(`${codeId}:${entrypoint}`).digest("hex")}`;
/** Every replica registers all handlers, in bounded database pages. Definition changes and deletion
 * recheck the current Code under its row lock, so another replica's newer snapshot cannot be undone.
 * Stable entrypoint IDs keep retained ticks across version activation; callbacks bind the current version.
 */
export function createCodeScheduleReconciler(scheduler: Scheduler) {
  return async () => {
    const registered = await scheduler.list();
    const timezone = (await coreSettings.get<string>("app.timezone")) || "UTC";
    let cursor = "";
    while (true) {
      const codes = await sql<{ id: string }[]>`SELECT id FROM code.codes WHERE id>${cursor} ORDER BY id LIMIT 50`;
      for (const code of codes) {
        try {
          await sql.begin(async (db) => {
            await db`SELECT id FROM code.codes WHERE id=${code.id} FOR UPDATE`;
            const [current] = await db<{ state: string; manifest: unknown }[]>`SELECT c.state,v.manifest FROM code.codes c
            LEFT JOIN code.versions v ON v.id=c.active_version_id WHERE c.id=${code.id}`;
            const manifest = CodeCheckedVersionManifestSchema.safeParse(current?.manifest);
            const desired = new Set<string>();
            if (current?.state === "active" && manifest.success)
              for (const entry of manifest.data.entrypoints) {
                if (entry.kind !== "schedule" || !entry.cron) continue;
                const cron = entry.cron;
                const id = scheduleId(code.id, entry.entrypoint);
                desired.add(id);
                await scheduler.create({
                  id,
                  cron,
                  timezone,
                  misfire: "latest",
                  meta: { family: "code", codeId: code.id },
                  process: async (ctx) => {
                    await processCurrentCodeScheduleTick({
                      codeId: code.id,
                      entrypoint: entry.entrypoint,
                      cron,
                      slot: ctx.slot,
                    });
                  },
                });
              }
            for (const schedule of registered) {
              if (schedule.id.startsWith("code:") && schedule.meta?.codeId === code.id && !desired.has(schedule.id))
                await scheduler.delete({ id: schedule.id });
            }
          });
        } catch (error) {
          logger("core:code-scheduling").error("code_schedule_sync_failed", {
            codeId: code.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (codes.length < 50) break;
      cursor = codes.at(-1)!.id;
    }
    // Deleted Codes cannot acquire new active versions. Check absence freshly, never against a replica-local desired set.
    for (const schedule of registered) {
      if (!schedule.id.startsWith("code:") || typeof schedule.meta?.codeId !== "string") continue;
      const [exists] = await sql`SELECT id FROM code.codes WHERE id=${schedule.meta.codeId}`;
      if (!exists)
        try {
          await scheduler.delete({ id: schedule.id });
        } catch (error) {
          logger("core:code-scheduling").error("code_schedule_delete_failed", {
            scheduleId: schedule.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
    await reconcileCodeJobs();
    await reconcileSchedules();
    await codeRunOutbox.notify();
    await codeJobOutbox.notify();
  };
  try {
    worker = await codeRunScheduler().process();
    codeRunOutbox.start();
    codeJobOutbox.start();
  } catch (error) {
    worker?.stop();
    await worker?.drain();
    await codeRunOutbox.stop();
    await codeJobOutbox.stop();
    throw error;
  }
  const startRecovery = () => {
    if (pending) return;
    pending = recover()
      .catch((error) => {
        logger("core:code-scheduling").error("code_scheduling_recovery_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        pending = undefined;
      });
  };
  startRecovery();
  const timer = setInterval(startRecovery, 5_000);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await pending;
    worker?.stop();
    await worker?.drain();
    await codeRunOutbox.stop();
    await codeJobOutbox.stop();
  };
}
