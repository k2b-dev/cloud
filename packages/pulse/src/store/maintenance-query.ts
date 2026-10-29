import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { lazySync } from "@k2b/cloud";
import type { Mutex } from "@k2b/sync";
import { clickhouseQuery, type QueryOptions, StoreQueryError } from "./client";

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
    const admissionDeadline = Date.now() + 5_000;
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
        signal: admission,
        queryId: undefined,
        timeoutMs: Math.max(1, Math.min(KILL_MS, admissionDeadline - Date.now())),
        settings: undefined,
        params: { user: options.user },
        query: "KILL QUERY WHERE startsWith(query_id, 'pulse_maintenance_') AND user={user:String} SYNC",
        format: "JSON",
      });
      if (!cancellationFinished(cancelled)) throw new MaintenanceBusy();
    } catch (error) {
      await lane.release(lock).catch(() => false);
      throw admission.aborted ? new MaintenanceBusy() : error;
    }
    const queryId = `pulse_maintenance_${randomUUID()}`;
    let release = true;
    try {
      for (;;) {
        // Recompute after each refused admission: neither a delayed acquisition
        // nor a retry may receive a fresh execution window beyond the lease.
        const remaining = lock.expiresAt.getTime() - Date.now() - KILL_MS - 1_000;
        if (remaining <= 2_000 || Date.now() >= admissionDeadline || admission.aborted || options.signal?.aborted)
          throw new MaintenanceBusy();
        const timeoutMs = Math.min(options.timeoutMs, HTTP_MS, remaining);
        release = false;
        try {
          const result = await query({
            ...options,
            queryId,
            timeoutMs,
            settings: {
              ...options.settings,
              // Server admission also fences a delayed request from a dead replica.
              // Same-user ingest can defer maintenance, but keeps its own settings.
              max_concurrent_queries_for_user: 1,
              max_execution_time: Math.max(1, Math.floor((timeoutMs - 2_000) / 1_000)),
              timeout_before_checking_execution_speed: 0,
            },
          });
          release = true;
          return result;
        } catch (error) {
          if (error instanceof StoreQueryError && error.kind === "clickhouse" && error.code === 202) {
            // KILL SYNC confirms its target is gone, but its own HTTP response
            // can arrive before its same-user process entry is removed.
            // Pulse maintenance uses local tables, without shard fan-out.
            // Here 202 proves this statement never started: retry admission only,
            // under the original five-second budget and while holding the lease.
            release = true;
            const waitMs = Math.min(200, admissionDeadline - Date.now());
            if (waitMs <= 0 || admission.aborted) throw new MaintenanceBusy();
            try {
              await delay(waitMs, undefined, { signal: admission });
            } catch {
              throw new MaintenanceBusy();
            }
            continue;
          }
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
        }
      }
    } finally {
      if (release) await lane.release(lock).catch(() => false);
    }
  };
export const maintenanceQuery = createMaintenanceQuery();
