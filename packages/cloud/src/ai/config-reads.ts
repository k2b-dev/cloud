import { AsyncLocalStorage } from "node:async_hooks";
import { createMiddleware } from "hono/factory";

type Reads = { entries: Map<string, Promise<unknown>>; open: boolean };

const scope = new AsyncLocalStorage<Reads>();

/**
 * One request's reads of the AI configuration (providers, models, variants, assignments, which providers hold a key,
 * the quota rules): a GET request reads each of them once while it builds its response, however many functions ask.
 * Every request starts empty, so nothing is shared between requests or kept in the process. A request that writes
 * (any other method) and work outside a request read every time; once the response is built, the scope closes, so a
 * streamed body that runs on reads fresh configuration too.
 */
export const aiConfigRequestScope = createMiddleware(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const reads: Reads = { entries: new Map(), open: true };
  try {
    await scope.run(reads, next);
  } finally {
    reads.open = false;
    reads.entries.clear();
  }
});

/**
 * Reads `key` once in the current request scope and hands the same answer to every later caller; outside a scope it
 * simply reads. Only reads through the shared client belong here, never one inside a transaction or with a lock. A
 * failed read is not kept, so the next caller tries again.
 */
export const readAiConfigOnce = <T>(key: string, read: () => Promise<T>): Promise<T> => {
  const reads = scope.getStore();
  if (!reads?.open) return read();
  const known = reads.entries.get(key);
  if (known) return known as Promise<T>;
  const pending = read();
  reads.entries.set(key, pending);
  pending.catch(() => {
    if (reads.entries.get(key) === pending) reads.entries.delete(key);
  });
  return pending;
};
