import { randomUUID } from "node:crypto";
import { lazySync } from "@k2b/cloud";
import type { Mutex } from "@k2b/sync";
import { clickhouseQuery, type QueryOptions } from "./client";

const cancellationFinished = (rows: Record<string, unknown>[]) => rows.every((row) => row.kill_status === "finished");

// One maintenance query at 1 GB beside the three reader slots. The existing
// service profile owns the memory limit. 30 s execution + 2 s HTTP delivery +
// 5 s KILL + broker reserve fits a 40 s lease, also after a replica dies.
export const MAINTENANCE_LEASE_MS = 40_000;
const HTTP_MS = 32_000;
const KILL_MS = 5_000;
const maintenanceMutex = lazySync((sync) =>
  sync.mutex({ id: "pulse:store-maintenance", ttlMs: MAINTENANCE_LEASE_MS, retry: { maxAttempts: 1, delayMs: 200 } }),
);
export class MaintenanceBusy extends Error {
  constructor() {
    super("MAINTENANCE_BUSY");
  }
}
export const createMaintenanceQuery =
  ({
    mutex = maintenanceMutex,
    query = clickhouseQuery,
  }: {
    mutex?: () => Pick<Mutex, "acquire" | "release">;
    query?: typeof clickhouseQuery;
  } = {}) =>
  async (options: QueryOptions, workload: "maintenance" | "ingest" = "maintenance") => {
    // Ingest is bounded before T1 (500/collection, 1,500 total and 5 MiB).
    // It must not queue behind scans or share their query execution slot.
    if (workload === "ingest") return query(options);
    const admission = AbortSignal.any([AbortSignal.timeout(5_000), ...(options.signal ? [options.signal] : [])]);
    const lane = mutex();
    let lock: Awaited<ReturnType<Mutex["acquire"]>> = null;
    try {
      while (!lock) {
        admission.throwIfAborted();
        // Broker requests can finish after cancellation. Bound the caller and
        // release a late successful acquisition without ever submitting SQL.
        let abort: (() => void) | undefined;
        try {
          const pending = lane
            .acquire({ resource: "clickhouse", ttlMs: MAINTENANCE_LEASE_MS, signal: admission })
            .then(async (acquired) => {
              if (acquired && admission.aborted) {
                await lane.release(acquired).catch(() => false);
                return null;
              }
              return acquired;
            });
          lock = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              abort = () => reject(admission.reason);
              admission.addEventListener("abort", abort, { once: true });
              if (admission.aborted) abort();
            }),
          ]);
        } finally {
          if (abort) admission.removeEventListener("abort", abort);
        }
        if (!lock)
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(admission.reason);
            };
            const timer = setTimeout(() => {
              admission.removeEventListener("abort", abort);
              resolve();
            }, 200);
            admission.addEventListener("abort", abort, { once: true });
            if (admission.aborted) abort();
          });
      }
    } catch {
      throw new MaintenanceBusy();
    }
    if (admission.aborted) {
      await lane.release(lock);
      throw new MaintenanceBusy();
    }
    // The previous replica may have died while ClickHouse was still executing.
    // A lease timeout alone is never proof of termination: observe cancellation
    // of all previous queries in this private lane before admitting another.
    try {
      const cancelled = await query({
        ...options,
        signal: undefined,
        queryId: undefined,
        timeoutMs: KILL_MS,
        settings: undefined,
        params: { user: options.user },
        query: "KILL QUERY WHERE startsWith(query_id, 'pulse_maintenance_') AND user={user:String} SYNC",
        format: "JSON",
      });
      if (!cancellationFinished(cancelled)) throw new MaintenanceBusy();
    } catch (error) {
      await lane.release(lock).catch(() => false);
      throw error;
    }
    // Derive an absolute deadline from the broker lease, so delayed acquisition
    // never receives a fresh full query window. Refuse before submitting SQL.
    const remaining = lock.expiresAt.getTime() - Date.now() - KILL_MS - 1_000;
    if (remaining <= 2_000 || options.signal?.aborted) {
      await lane.release(lock);
      throw new MaintenanceBusy();
    }
    const timeoutMs = Math.min(options.timeoutMs, HTTP_MS, remaining);
    const queryId = `pulse_maintenance_${randomUUID()}`;
    let release = false;
    try {
      const result = await query({
        ...options,
        queryId,
        timeoutMs,
        settings: {
          ...options.settings,
          max_execution_time: Math.max(1, Math.floor((timeoutMs - 2_000) / 1_000)),
          timeout_before_checking_execution_speed: 0,
        },
      });
      release = true;
      return result;
    } catch (error) {
      // A missing HTTP answer is not proof the query stopped. Kill by both the
      // generated ID and exact service user before giving another replica room.
      try {
        const cancelled = await query({
          ...options,
          signal: undefined,
          queryId: undefined,
          timeoutMs: KILL_MS,
          settings: undefined,
          params: { id: queryId, user: options.user },
          query: "KILL QUERY WHERE query_id={id:String} AND user={user:String} SYNC",
          format: "JSON",
        });
        release = cancellationFinished(cancelled);
      } catch {
        /* Keep the lease until expiry when cancellation cannot be observed. */
      }
      throw error;
    } finally {
      if (release) await lane.release(lock).catch(() => false);
    }
  };
export const maintenanceQuery = createMaintenanceQuery();
