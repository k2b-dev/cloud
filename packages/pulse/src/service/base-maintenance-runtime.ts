import { lazySync } from "@k2b/cloud";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { BaseOperationSuperseded } from "../store/base-store";
import { measureBaseUsage, measureInstanceDisk, verifyBaseCheckpoint, writeBaseCheckpoint } from "../store/maintenance";
import { pulseStoreConfigured } from "../store/service";
import { resumePulseBaseJobs } from "./base-lifecycle";

type ScanInput = { slot: number; after: string | null; checkpointId: string | null; verifyOnly: boolean };
const usageJob = lazySync((sync) =>
  sync.job<ScanInput>({ id: "pulse:base-usage", delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [10_000, 30_000] } }),
);
const checkpointJob = lazySync((sync) =>
  sync.job<ScanInput>({ id: "pulse:base-checkpoint", delivery: { ackWaitMs: 120_000, maxAttempts: 3, backoffMs: [10_000, 30_000] } }),
);
const scheduler = lazySync((sync) => sync.scheduler({ id: "pulse:stores", delivery: { maxAttempts: 3, backoffMs: [10_000, 30_000] } }));
let workers: Worker[] = [];
export const startBaseMaintenance = async () => {
  workers.push(
    await usageJob().process({}, async (context) => {
      if (!(await pulseStoreConfigured())) return;
      const { slot } = context.input;
      const [base] = await sql<
        { base_id: string }[]
      >`SELECT base_id FROM pulse.base_stores WHERE state='active' AND (usage_measured_at IS NULL OR usage_measured_at<${new Date(slot)}) ORDER BY usage_measured_at ASC NULLS FIRST,base_id LIMIT 1`;
      if (!base) return;
      try {
        await measureBaseUsage(base.base_id);
      } catch (error) {
        if (!(error instanceof BaseOperationSuperseded)) throw error;
      }
      context.resubmit();
    }),
  );
  workers.push(
    await checkpointJob().process({}, async (context) => {
      if (!(await pulseStoreConfigured())) return;
      const input = context.input;
      const [base] = await sql<
        { base_id: string }[]
      >`SELECT base_id FROM pulse.base_stores WHERE state='active' AND (${input.after}::uuid IS NULL OR base_id>${input.after}::uuid) ORDER BY base_id LIMIT 1`;
      if (!base) return;
      try {
        if (input.verifyOnly) await verifyBaseCheckpoint(base.base_id);
        else if (input.checkpointId) await writeBaseCheckpoint(base.base_id, input.checkpointId);
      } catch (error) {
        if (!(error instanceof BaseOperationSuperseded)) throw error;
      }
      context.resubmit({ input: { ...input, after: base.base_id } });
    }),
  );
  await scheduler().create({
    id: "pulse:base-lifecycle:sweep",
    cron: "* * * * *",
    misfire: "latest",
    process: async () => {
      await resumePulseBaseJobs();
    },
  });
  await scheduler().create({
    id: "pulse:base-usage:slot",
    cron: "*/5 * * * *",
    misfire: "latest",
    process: async (context) => {
      if (!(await pulseStoreConfigured())) return;
      await measureInstanceDisk();
      await usageJob().submit({
        key: "usage",
        coalesce: true,
        input: { slot: context.slot.getTime(), after: null, checkpointId: null, verifyOnly: false },
      });
    },
  });
  await scheduler().create({
    id: "pulse:base-checkpoint:slot",
    cron: "0 * * * *",
    misfire: "latest",
    process: async (context) => {
      if (!(await pulseStoreConfigured())) return;
      // The slot determines one shared id, including scheduler redeliveries.
      const hex = context.slot.getTime().toString(16).padStart(32, "0");
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
      await checkpointJob().submit({
        key: `slot:${context.slot.getTime()}`,
        coalesce: true,
        input: { slot: context.slot.getTime(), after: null, checkpointId: id, verifyOnly: false },
      });
    },
  });
  workers.push(await scheduler().process());
  await resumePulseBaseJobs();
  if (await pulseStoreConfigured())
    await checkpointJob().submit({
      key: "verify-start",
      coalesce: true,
      input: { slot: Date.now(), after: null, checkpointId: null, verifyOnly: true },
    });
};
export const stopBaseMaintenance = async () => {
  await Promise.all(workers.map((w) => w.drain()));
  workers = [];
};
