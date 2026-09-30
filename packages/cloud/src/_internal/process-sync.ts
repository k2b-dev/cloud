/**
 * The one @k2b/sync instance of this process.
 *
 * `defineApp().start()` (and the gateway router, which has no `defineApp`)
 * call `startProcessSync()`: connect NATS, create the instance, bind it here,
 * and wait for `ready()`. Everything else reaches it lazily through
 * `app.sync`, `lifecycleContext.sync`, `lazySync()`, or `getProcessSync()`;
 * nothing touches sync during module evaluation.
 */
import { hostname } from "node:os";
import { createSync, type Sync, SyncError } from "@k2b/sync";
import { expBackoff } from "@k2b/sync/retry";
import type { NatsConnection } from "@nats-io/transport-node";
import { env } from "../config/env";
import { logger } from "../services/logging";
import { flushSyncTraceEvents, observeSyncEvent } from "../services/logging/trace";
import { connectNats } from "./nats-connection";
import { withSyncBudgets } from "./sync-budget";

let current: Sync | undefined;
let starting = false;

/** Bind the process instance. `startProcessSync()` does this; tests may bind their own. */
export const bindProcessSync = (sync: Sync): void => {
  if (current) throw new Error("A Sync instance is already bound to this process");
  current = sync;
};

export const unbindProcessSync = (): void => {
  current = undefined;
};

export const getProcessSync = (): Sync => {
  if (!current) {
    throw new Error(
      "Sync is not available before app.start() has connected NATS. Declare primitives with " +
        "lazySync((sync) => sync.job(...)) and use them from lifecycle.start() or request handlers.",
    );
  }
  return current;
};

/**
 * Memoize a sync primitive per process instance so it can be declared at
 * module scope without any I/O at import time:
 *
 *   const emails = lazySync((sync) => sync.job<Email>({ id: "emails" }));
 *   await emails().submit({ key, input });
 *
 * The factory runs on first use with the bound instance; a different bound
 * instance (tests) gets its own handle.
 */
export const lazySync = <T>(create: (sync: Sync) => T): (() => T) => {
  const handles = new WeakMap<Sync, T>();
  return () => {
    const sync = getProcessSync();
    const existing = handles.get(sync);
    if (existing !== undefined) return existing;
    const created = create(sync);
    handles.set(sync, created);
    return created;
  };
};

export type ProcessSync = {
  sync: Sync;
  /** Drains sync work, then the NATS connection, and unbinds the instance. */
  stop: () => Promise<void>;
};

/**
 * How long a starting process waits for NATS and JetStream. After a host or
 * stack restart, NATS nodes come up in any order and JetStream must recover
 * its streams and elect a leader before its API answers; five minutes covers
 * that. A process that still gets no answer exits instead of staying alive
 * without readiness, so Docker or Kubernetes restarts it and the outage shows
 * up as restarts.
 */
const NATS_STARTUP_BUDGET_MS = 5 * 60_000;
// About 1 s, doubling to 20 s, each ±50 % so processes that restarted together spread their retries.
const NATS_STARTUP_BACKOFF = { baseMs: 1_000, maxMs: 20_000, jitter: 0.5 };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run `attempt` until it succeeds, with exponential backoff and jitter. A
 * `SyncError` describes the server or the declarations (unsupported version,
 * JetStream disabled, drift), which waiting does not change, so it fails at
 * once. Every other failure (refused or unresolved address, timeout, JetStream
 * without a leader) is logged and retried until `budgetMs` is spent; then the
 * process exits with status 1.
 */
export const waitForNats = async <T>(
  attempt: () => Promise<T>,
  { application, budgetMs = NATS_STARTUP_BUDGET_MS }: { application: string; budgetMs?: number },
): Promise<T> => {
  const log = logger("sync");
  const deadline = Date.now() + budgetMs;
  for (let attempts = 1; ; attempts++) {
    try {
      const result = await attempt();
      if (attempts > 1) log.info("NATS and JetStream answered", { application, attempts });
      return result;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        log.error("NATS and JetStream did not answer within the startup budget; exiting so the process is restarted", {
          application,
          attempts,
          budgetMs,
          error: errorMessage(error),
        });
        process.exit(1);
      }
      const retryInMs = Math.min(remainingMs, expBackoff(attempts, NATS_STARTUP_BACKOFF));
      log.warn("NATS or JetStream is not ready; retrying", { application, attempt: attempts, retryInMs, error: errorMessage(error) });
      await Bun.sleep(retryInMs);
    }
  }
};

/** One start attempt: connect, bind a new Sync instance, and wait for `ready()`; release both when it fails. */
const connectReadySync = async (application: string): Promise<{ sync: Sync; connection: NatsConnection }> => {
  const connection = await connectNats({ name: `${application}@${hostname()}` });
  let sync: Sync | undefined;
  try {
    sync = withSyncBudgets(
      createSync({
        connection,
        namespace: env.SYNC_NAMESPACE,
        application,
        defaults: { replicas: env.SYNC_REPLICAS },
        observe: (event) => observeSyncEvent(event, application),
      }),
      { connection, namespace: env.SYNC_NAMESPACE },
    );
    bindProcessSync(sync);
    await sync.ready();
    return { sync, connection };
  } catch (error) {
    if (current === sync) unbindProcessSync();
    await flushSyncTraceEvents();
    await connection.close();
    throw error;
  }
};

/**
 * Connect NATS, create and bind the process Sync instance, and wait until it is
 * ready. Existing streams of its jobs, queues, and topics take the byte
 * limits they declare before first use (see `sync-budget.ts`).
 *
 * While NATS or JetStream does not answer, it retries with a fresh connection
 * and instance (see `waitForNats`), and exits the process once
 * `NATS_STARTUP_BUDGET_MS` is spent. Callers are process entry points; nothing
 * serves readiness before this returns.
 */
export const startProcessSync = async ({ application }: { application: string }): Promise<ProcessSync> => {
  if (!env.SYNC_NAMESPACE.trim()) {
    throw new Error(
      `SYNC_NAMESPACE is not set (application "${application}"). Every process of one Cloud installation ` +
        "must share the same @k2b/sync namespace.",
    );
  }
  if (env.NATS_SERVERS.length === 0) {
    throw new Error(
      `NATS_SERVERS is not set (application "${application}"). @k2b/sync needs a comma-separated list of ` +
        "nats://host:port bootstrap servers, e.g. NATS_SERVERS=nats://ipa_nats_1:4222,nats://ipa_nats_2:4222.",
    );
  }
  if (current || starting) throw new Error("A Sync instance is already starting or bound to this process");
  starting = true;
  try {
    const { sync: active, connection } = await waitForNats(() => connectReadySync(application), { application });
    let stopPromise: Promise<void> | undefined;
    return {
      sync: active,
      stop: () =>
        (stopPromise ??= (async () => {
          try {
            await active.drain();
          } finally {
            try {
              await flushSyncTraceEvents();
            } finally {
              if (current === active) unbindProcessSync();
              await connection.drain();
            }
          }
        })()),
    };
  } finally {
    starting = false;
  }
};
