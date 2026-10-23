import { lazySync } from "@k2b/cloud";
import { trace } from "@k2b/cloud/services";
import type { Worker } from "@k2b/sync";
import { sql } from "bun";
import { pulseStoreConfigured } from "../store/service";
import { registerAlertSchedules } from "./alert-runtime";
import { startPulseBaseJobs, stopPulseBaseJobs } from "./base-lifecycle";
import { startBaseMaintenance, stopBaseMaintenance } from "./base-maintenance-runtime";
import { scrapeMetricsSource } from "./index";
import { ingestQuota } from "./ingest-quota";
import { runHourlyRollup } from "./metric-rollups";
import { runRetentionBatch } from "./retention";
import { notificationOutbox } from "./store-health";

export { runRetentionBatch } from "./retention";

type ScrapeInput = {
  baseId: string;
  publicBaseId: string;
  sourceId: string;
  publicSourceId: string;
  slotTs: number;
};

/** The scrape ran and failed for a reason already recorded on `pulse.sources.last_error`. */
class ScrapeOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeOutcomeError";
  }
}

const scrapeJob = lazySync((sync) =>
  sync.job<ScrapeInput>({
    id: "pulse:metrics:scrape",
    delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [30_000, 60_000] },
  }),
);

/** A retention job queued by the previous version has no input; it starts from the first base instead of failing. */
export const retentionCursor = (input: { after: string | null } | undefined): string | null => input?.after ?? null;

const retentionJob = lazySync((sync) =>
  // Jobs queued by the previous version carry no input; they start from the first base.
  sync.job<{ after: string | null } | undefined>({
    id: "pulse:retention",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
const hourlyRollupJob = lazySync((sync) =>
  sync.job<void>({
    id: "pulse:rollup:hourly",
    delivery: { ackWaitMs: 5 * 60_000, maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
const pulseScheduler = lazySync((sync) =>
  sync.scheduler({
    id: "pulse",
    delivery: { maxAttempts: 3, backoffMs: [60_000, 120_000] },
  }),
);
let workers: Worker[] = [];
let started = false;
let alertStop = new AbortController();

export const dueMetricsSources = async (slotTs: number) => sql<{ id: string; short_id: string; base_id: string; base_short_id: string }[]>`
    SELECT s.id, s.short_id, s.base_id, b.short_id AS base_short_id
    FROM pulse.sources s
    JOIN pulse.bases b ON b.id = s.base_id
    WHERE s.kind = 'metrics'::pulse.source_kind
      AND s.enabled = TRUE AND NOT s.deleted
      AND s.endpoint_url IS NOT NULL
      AND s.scrape_interval_seconds IS NOT NULL
      AND EXISTS(SELECT 1 FROM pulse.base_stores store WHERE store.base_id=b.id AND store.state='active' AND store.write_block_reason IS NULL)
      AND b.deletion_started_at IS NULL
      AND (
        b.data_clear_started_at IS NULL
        OR b.data_clear_completed_at IS NOT NULL
      )
      AND (s.last_scrape_slot_at IS NULL OR s.last_scrape_slot_at <= ${new Date(slotTs)}::timestamptz - (s.scrape_interval_seconds * interval '1 second'))
    ORDER BY s.last_scrape_slot_at ASC NULLS FIRST,
      s.created_at ASC
    LIMIT 200
  `;

const submitDueScrapes = async (slotTs: number): Promise<{ submitted: number }> => {
  if (!(await pulseStoreConfigured())) return { submitted: 0 };
  const rows = await dueMetricsSources(slotTs);
  for (const row of rows) {
    await scrapeJob().submit({
      key: `source:${row.id}:slot:${slotTs}`,
      input: {
        baseId: row.base_id,
        publicBaseId: row.base_short_id,
        sourceId: row.id,
        publicSourceId: row.short_id,
        slotTs,
      },
    });
  }

  return { submitted: rows.length };
};

export const pulseRuntime = {
  start: async (): Promise<void> => {
    if (started) return;
    alertStop = new AbortController();
    workers.push(
      await scrapeJob().process({}, async (context) => {
        await trace
          .withSpan(
            {
              spanKey: trace.syncSpanKey("job", "pulse:metrics:scrape", context.jobId),
              name: "Pulse metrics scrape",
              source: "pulse:metrics:scrape",
              appId: "pulse",
              category: "job",
              attributes: { "cloud.pulse.base_id": context.input.publicBaseId, "cloud.pulse.source_id": context.input.publicSourceId },
            },
            async () => {
              const result = await scrapeMetricsSource(context.input);
              if (!result.ok) throw new ScrapeOutcomeError(result.error.message);
              return result.data;
            },
            { summarize: (result) => result },
          )
          .catch((error: unknown) => {
            // Returned scrape failures, including rejected ingest input, are recorded on the
            // source and retried by its next due slot. Only errors thrown out of the
            // scraper or tracing reach the job's retry and dead-letter policy.
            if (!(error instanceof ScrapeOutcomeError)) throw error;
          });
      }),
    );
    workers.push(
      await retentionJob().process({}, async (context) => {
        const result = await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("job", "pulse:retention", context.jobId),
            name: "Pulse retention cleanup",
            source: "pulse:retention",
            appId: "pulse",
            category: "job",
          },
          async () => {
            const result = await runRetentionBatch(undefined, retentionCursor(context.input));
            return result;
          },
          { summarize: (result) => result },
        );
        if (!result.done) context.resubmit({ input: { after: result.nextAfter } });
      }),
    );
    workers.push(
      await hourlyRollupJob().process({}, async (context) => {
        const result = await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("job", "pulse:rollup:hourly", context.jobId),
            name: "Pulse hourly rollup",
            source: "pulse:rollup:hourly",
            appId: "pulse",
            category: "job",
          },
          () => runHourlyRollup(),
          { summarize: (result) => result },
        );
        if (!result.done) context.resubmit({ delayMs: result.retryAfterMs ?? 0 });
      }),
    );
    await pulseScheduler().create({
      id: "pulse:metrics:scrape-due",
      cron: "* * * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:metrics", label: "Pulse due metrics scrape", source: "pulse:metrics:scrape-due" },
      process: async (context) => {
        await trace.withSpan(
          {
            spanKey: trace.syncSpanKey("scheduler", "pulse", context.runId),
            name: "Pulse due metrics scrape schedule",
            source: "pulse",
            appId: "pulse",
            category: "schedule",
          },
          () => submitDueScrapes(context.slot.getTime()),
          { summarize: (result) => result },
        );
      },
    });
    await pulseScheduler().create({
      id: "pulse:rollup:hourly",
      cron: "23 * * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:rollups", label: "Pulse hourly rollup", source: "pulse:rollup:hourly" },
      process: async (context) => {
        if (!(await pulseStoreConfigured())) return;
        await hourlyRollupJob().submit({ key: `slot:${context.slot.getTime()}`, input: undefined });
      },
    });
    await pulseScheduler().create({
      id: "pulse:retention",
      cron: "17 3 * * *",
      misfire: "latest",
      meta: { appId: "pulse", family: "pulse:retention", label: "Pulse retention", source: "pulse:retention" },
      process: async (context) => {
        if (!(await pulseStoreConfigured())) return;
        await retentionJob().submit({ key: `slot:${context.slot.getTime()}`, input: { after: null } });
      },
    });
    await registerAlertSchedules(pulseScheduler(), alertStop.signal);
    // The three bounded alert scans must not hold up each other or the existing
    // scrape/maintenance dispatch lane. Each schedule remains serial fleet-wide.
    workers.push(await pulseScheduler().process({ concurrency: 4 }));
    await startPulseBaseJobs();
    await startBaseMaintenance();
    notificationOutbox.start();
    started = true;
  },
  stop: async (): Promise<void> => {
    alertStop.abort();
    await Promise.all(workers.map((worker) => worker.drain()));
    workers = [];
    await stopPulseBaseJobs();
    await stopBaseMaintenance();
    await notificationOutbox.stop();
    ingestQuota.close();
    started = false;
  },
};
