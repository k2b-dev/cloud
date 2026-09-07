/**
 * Isolated two-process recovery acceptance for the local NATS cluster.
 *
 * SYNC_RECOVERY_NAMESPACE=cloud-recovery-smoke-<unique> bun packages/cloud/scripts/sync-recovery-smoke.ts prepare
 * Stop the application fleet across the printed nextTick boundary, keeping NATS up.
 * Restart the fleet, then run the same command with `recover`.
 * No provider or application-domain effects; successful recovery deletes only
 * the exact test streams after checking their broker identity metadata.
 */
import { createSync, type SyncResourceSummary, type Worker } from "@k2b/sync";
import { connect, type NatsConnection } from "@nats-io/transport-node";

const APPLICATION = "cloud-recovery-smoke";
const JOB_ID = "restart-job";
const SCHEDULER_ID = "restart-scheduler";
const SCHEDULE_ID = "minute";
const WAIT_MS = 20_000;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a broker object response");
  return Object.fromEntries(Object.entries(value));
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const removeTestStreams = async (connection: NatsConnection, namespace: string, resources: SyncResourceSummary[]) => {
  let deleted = 0;
  for (const resource of resources) {
    check(resource.namespace === namespace && resource.owner === APPLICATION, "Refusing to remove a foreign resource");
    check(resource.id === JOB_ID || resource.id === SCHEDULER_ID, "Refusing to remove an unexpected resource");
    for (const name of resource.natsNames) {
      check(/^[A-Za-z0-9_-]+$/.test(name), "Invalid broker stream name");
      const info = object((await connection.request(`$JS.API.STREAM.INFO.${name}`, new Uint8Array())).json<unknown>());
      const metadata = object(object(info.config).metadata);
      check(
        metadata["sync.managed"] === "true" &&
          metadata["sync.namespace"] === namespace &&
          metadata["sync.owner"] === APPLICATION &&
          metadata["sync.id"] === resource.id,
        "Broker identity does not match the isolated recovery resource",
      );
      const removed = object((await connection.request(`$JS.API.STREAM.DELETE.${name}`, new Uint8Array())).json<unknown>());
      check(removed.success === true, "Broker refused recovery stream cleanup");
      deleted++;
    }
  }
  return deleted;
};

export const main = async (): Promise<void> => {
  const phase = Bun.argv[2];
  check(phase === "prepare" || phase === "recover", "Pass prepare or recover");
  const namespace = process.env.SYNC_RECOVERY_NAMESPACE?.trim() ?? "";
  check(/^cloud-recovery-smoke-[A-Za-z0-9_-]{6,60}$/.test(namespace), "Set a unique SYNC_RECOVERY_NAMESPACE=cloud-recovery-smoke-<suffix>");
  const servers = (process.env.NATS_SERVERS ?? "nats://127.0.0.1:4222")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const connection = await connect({ servers, name: `${APPLICATION}-${phase}`, ignoreClusterUpdates: true });
  const sync = createSync({ connection, namespace, application: APPLICATION, defaults: { replicas: 3 } });
  const job = sync.job<{ preparedAt: string }>({
    id: JOB_ID,
    delivery: { ackWaitMs: 30_000, maxAttempts: 3, backoffMs: [1_000, 2_000] },
  });
  const scheduler = sync.scheduler({ id: SCHEDULER_ID, delivery: { maxAttempts: 3, backoffMs: [1_000, 2_000] } });
  const workers: Worker[] = [];
  let drained = false;
  try {
    await sync.ready();
    if (phase === "prepare") {
      check((await scheduler.get({ id: SCHEDULE_ID })) === null, "Namespace already prepared; use a new unique namespace");
      const preparedAt = new Date().toISOString();
      await scheduler.create({
        id: SCHEDULE_ID,
        cron: "* * * * *",
        timezone: "UTC",
        misfire: "latest",
        meta: { preparedAt },
        process: async () => {
          throw new Error("Prepare phase must not start schedule workers");
        },
      });
      const receipt = await job.submit({ key: "pending-before-stop", input: { preparedAt }, coalesce: true });
      const schedule = await scheduler.get({ id: SCHEDULE_ID });
      check(schedule?.nextRunAt, "Broker did not persist the recovery schedule");
      console.log(
        JSON.stringify({
          phase,
          namespace,
          preparedAt,
          nextTick: schedule.nextRunAt.toISOString(),
          jobId: receipt.jobId,
          workersStarted: 0,
        }),
      );
      return;
    }

    const recoveredAt = Date.now();
    const existing = await scheduler.get({ id: SCHEDULE_ID });
    check(existing, "Prepared schedule missing; recovery cannot prove persistence");
    const preparedAt = existing.meta?.preparedAt;
    check(typeof preparedAt === "string" && Number.isFinite(Date.parse(preparedAt)), "Prepared schedule metadata missing");
    check(existing.runNumber === 0, "Prepared schedule was already processed");
    const firstTick = Math.floor(Date.parse(preparedAt) / 60_000) * 60_000 + 60_000;
    check(recoveredAt > firstTick, "No missed minute boundary yet; leave NATS running until after nextTick");
    const jobDone = Promise.withResolvers<void>();
    const tickDone = Promise.withResolvers<void>();
    let jobs = 0;
    let ticks = 0;
    let recoveredSlot: string | undefined;
    const registration = await scheduler.create({
      id: SCHEDULE_ID,
      cron: "* * * * *",
      timezone: "UTC",
      misfire: "latest",
      meta: { preparedAt },
      process: async (context) => {
        check(context.trigger === "schedule", "Expected a broker cron tick, not a manual run");
        check(
          context.slot.getTime() >= firstTick && context.slot.getTime() < recoveredAt,
          "Cron tick was not retained from the offline interval",
        );
        recoveredSlot = context.slot.toISOString();
        ticks++;
        tickDone.resolve();
      },
    });
    check(!registration.created && !registration.updated, "Re-registration unexpectedly changed the persisted schedule");
    workers.push(
      await job.process({ concurrency: 1 }, async (context) => {
        check(context.input.preparedAt === preparedAt && context.key === "pending-before-stop", "Unexpected recovery job payload");
        jobs++;
        jobDone.resolve();
      }),
    );
    workers.push(await scheduler.process({ concurrency: 1 }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([jobDone.promise, tickDone.promise]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Retained job or cron tick was not recovered within 20 seconds")), WAIT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    for (const worker of workers) worker.stop();
    await Promise.all(workers.map((worker) => worker.drain()));
    check(jobs === 1 && ticks === 1, "Unexpected duplicate work during isolated recovery");
    const finalSchedule = await scheduler.get({ id: SCHEDULE_ID });
    check(finalSchedule?.lastCompletedAt, "Recovered cron tick did not settle successfully");
    const resources = await sync.resources();
    check(
      resources.every((resource) => resource.state === "ready"),
      "Recovery resources are not ready",
    );
    check(
      resources.every((resource) => !resource.detail?.deadLetters),
      "Recovery created dead letters",
    );
    const recoveredJob = resources.find((resource) => resource.kind === "job" && resource.id === JOB_ID);
    check(recoveredJob?.detail?.messages === 0, "Recovery job remains in the broker stream after drain");
    const consumers = object(recoveredJob.detail.consumers);
    check(Object.keys(consumers).length > 0, "Recovery job consumer diagnostics are missing");
    for (const state of Object.values(consumers)) {
      const consumer = object(state);
      check(consumer.pending === 0 && consumer.ackPending === 0, "Recovery job has pending or unacknowledged broker deliveries");
    }
    await scheduler.delete({ id: SCHEDULE_ID });
    await sync.drain();
    drained = true;
    const deletedStreams = await removeTestStreams(connection, namespace, resources);
    console.log(
      JSON.stringify({
        phase,
        namespace,
        preparedAt,
        recoveredAt: new Date(recoveredAt).toISOString(),
        recoveredSlot,
        jobs,
        ticks,
        pendingJobMessages: recoveredJob.detail.messages,
        unacknowledgedJobMessages: 0,
        deletedStreams,
        outcome: "passed",
      }),
    );
  } finally {
    for (const worker of workers) worker.stop();
    try {
      if (!drained) await sync.drain();
    } finally {
      await connection.drain();
    }
  }
};

if (import.meta.main) await main();
