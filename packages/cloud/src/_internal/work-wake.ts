import { createHash } from "node:crypto";
import { connections } from "../runtime/connections";
import { logger } from "../services/logging";
import { getProcessNats } from "./process-sync";

const log = logger("work-wake");
export const workWakeOrigin = crypto.randomUUID();
const originBytes = new TextEncoder().encode(workWakeOrigin);

/** Non-retained hints on the existing transport; committed Postgres rows own the work. */
export const workWakeSubject = (namespace: string, key: string): string =>
  `cloud.wake.${createHash("sha256").update(namespace).digest("hex")}.${createHash("sha256").update(key).digest("hex")}.v1`;

/** Call only after committing. Missing hints are repaired by the worker's safety scan. */
export const notifyWork = (key: string): void => {
  try {
    getProcessNats().publish(workWakeSubject(connections().nats.namespace, key), originBytes);
  } catch (error) {
    log.warn("Work wake notification failed; safety scan will recover", { key, error: String(error) });
  }
};

export const subscribeWorkWake = (key: string, wake: () => void): (() => void) => {
  const subscription = getProcessNats().subscribe(workWakeSubject(connections().nats.namespace, key), {
    callback: (error, message) => {
      if (error) log.warn("Work wake subscription failed; safety scan will recover", { key, error: String(error) });
      else if (message.string() !== workWakeOrigin) wake();
    },
  });
  return () => subscription.unsubscribe();
};

/** Same canonical identity as the outbox claim lock, independent of filter order. */
export const pgOutboxKey = (table: string, where: Readonly<Record<string, string>> = {}) =>
  `${table}:${JSON.stringify(Object.fromEntries(Object.entries(where).sort(([a], [b]) => (a < b ? 1 : -1))))}`;

/** A writer need not run a dispatcher itself. Call after commit. */
export const notifyPgOutbox = (table: string, where?: Readonly<Record<string, string>>): void => notifyWork(pgOutboxKey(table, where));
