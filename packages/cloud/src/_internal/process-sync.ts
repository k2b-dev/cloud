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
import { createSync, type Sync } from "@k2b/sync";
import { env } from "../config/env";
import { observeSyncEvent } from "../services/logging/trace";
import { connectNats } from "./nats-connection";

let current: Sync | undefined;

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

/** Connect NATS, create and bind the process Sync instance, and wait until it is ready. */
export const startProcessSync = async ({ application }: { application: string }): Promise<ProcessSync> => {
  if (!env.SYNC_NAMESPACE.trim()) {
    throw new Error(
      `SYNC_NAMESPACE is not set (application "${application}"). Every process of one Cloud installation ` +
        "must share the same @k2b/sync namespace.",
    );
  }
  const connection = await connectNats({ name: `${application}@${hostname()}` });
  const sync = createSync({ connection, namespace: env.SYNC_NAMESPACE, application, observe: observeSyncEvent });
  bindProcessSync(sync);
  try {
    await sync.ready();
  } catch (error) {
    unbindProcessSync();
    await connection.close();
    throw error;
  }
  return {
    sync,
    stop: async () => {
      try {
        await sync.drain();
      } finally {
        unbindProcessSync();
        await connection.drain();
      }
    },
  };
};
