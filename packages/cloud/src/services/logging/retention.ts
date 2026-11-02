import type { TransactionSQL } from "bun";
import { sql } from "../../runtime/clients";

// Match the existing telemetry batch size. A pass yields within 30s so the
// scheduler can service other work; the five-minute schedule resumes a backlog.
export const RETENTION_BATCH_SIZE = 10_000;
const PASS_BUDGET_MS = 30_000;

export type RetentionProgress = { entries?: number; events?: number; spans?: number; complete: boolean };
export type RetentionOptions = {
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
  onProgress?: (progress: RetentionProgress) => Promise<void>;
};

export const drainRetention = async (
  batch: (tx: TransactionSQL) => Promise<RetentionProgress>,
  options: RetentionOptions,
): Promise<RetentionProgress> => {
  const deadline = performance.now() + PASS_BUDGET_MS;
  const progress: RetentionProgress = { complete: false };
  do {
    options.signal?.throwIfAborted();
    const result = await sql.begin(async (tx) => {
      // Bound lock contention and server work even if the worker disappears.
      await tx`SET LOCAL lock_timeout = '1s'`;
      await tx`SET LOCAL statement_timeout = '10s'`;
      return batch(tx);
    });
    for (const key of ["entries", "events", "spans"] as const) {
      if (result[key] !== undefined) progress[key] = (progress[key] ?? 0) + result[key];
    }
    progress.complete = result.complete;
    await options.heartbeat?.();
    await options.onProgress?.({ ...progress });
    if (progress.complete) break;
  } while (performance.now() < deadline);
  return progress;
};
