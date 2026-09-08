import { SQL, sql } from "bun";
import type { SqlClient } from "./audit";

const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

export const boundedQueryPoolSize = positiveInteger("GRIDS_QUERY_POOL_SIZE", 12);

let queryPool: SQL | undefined;

const getQueryPool = (): SQL => {
  const url = process.env.DATABASE_URL;
  queryPool ??= url ? new SQL({ url, max: boundedQueryPoolSize }) : new SQL({ max: boundedQueryPoolSize });
  return queryPool;
};

export class BoundedQueryTimeoutError extends Error {
  override readonly name = "BoundedQueryTimeoutError";

  constructor(
    readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`statement timeout after ${timeoutMs}ms`, options);
  }
}

class BoundedQueryAbortedError extends Error {
  override readonly name = "BoundedQueryAbortedError";

  constructor(options?: ErrorOptions) {
    super("query aborted", options);
  }
}

export const isBoundedQueryTimeoutError = (error: unknown): error is BoundedQueryTimeoutError => error instanceof BoundedQueryTimeoutError;

const validateTimeout = (timeoutMs: number): void => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError("query timeout must be an integer between 1 and 60000 milliseconds");
  }
};

const isStatementTimeout = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; errno?: string };
  return candidate.code === "57014" || candidate.errno === "57014";
};

const runBoundedQueryDirect = async <T>(query: unknown, timeoutMs: number, signal?: AbortSignal, client?: SqlClient): Promise<T[]> => {
  validateTimeout(timeoutMs);
  if (signal?.aborted) throw new BoundedQueryAbortedError();

  const reserved = client ? undefined : await getQueryPool().reserve();
  const connection = client ?? reserved!;
  let previousTimeout: string | undefined;
  let succeeded = false;
  try {
    if (client) {
      const [settings] = await client<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
      previousTimeout = settings?.timeout;
    }
    const [backend] = await connection<Array<{ pid: number }>>`
      SELECT
        pg_backend_pid()::int AS pid,
        set_config('statement_timeout', ${`${timeoutMs}ms`}, ${Boolean(client)}) AS statement_timeout
    `;
    if (!backend) throw new Error("reserved query connection has no PostgreSQL backend");
    let abort: (() => void) | undefined;
    let cancelRequest: Promise<unknown> | undefined;
    let queryActive = false;
    try {
      // Bun SQL is lazy. Execute explicitly so cancel() always targets the
      // active statement instead of a query that has not started yet.
      const pending = connection<T[]>`${query}`.execute();
      queryActive = true;
      abort = () => {
        if (!queryActive || cancelRequest) return;
        pending.cancel();
        // Bun's local cancel flag does not reliably interrupt a statement on
        // a reserved connection. PostgreSQL cancellation targets exactly this
        // backend while preserving the connection for a safe reset.
        cancelRequest = sql`SELECT pg_cancel_backend(${backend.pid})`.execute().catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const rows = await pending;
      queryActive = false;
      succeeded = true;
      return [...rows];
    } catch (error) {
      queryActive = false;
      if (signal?.aborted) throw new BoundedQueryAbortedError({ cause: error });
      if (isStatementTimeout(error)) throw new BoundedQueryTimeoutError(timeoutMs, { cause: error });
      throw error;
    } finally {
      queryActive = false;
      if (signal && abort) signal.removeEventListener("abort", abort);
      await cancelRequest;
    }
  } finally {
    // The pool is private to bounded reads, and every reservation overwrites
    // statement_timeout before executing user-controlled SQL.
    // A failed statement aborts the caller's transaction; preserve its original
    // error and let the owner roll back instead of attempting another statement.
    if (client && succeeded && previousTimeout !== undefined) {
      await client`SELECT set_config('statement_timeout', ${previousTimeout}, TRUE)`;
    }
    reserved?.release();
  }
};

type SharedQueryFlight = {
  controller: AbortController;
  promise: Promise<unknown[]>;
  settled: boolean;
  waiters: number;
};

const sharedQueryFlights = new Map<string, SharedQueryFlight>();

const waitForSharedQuery = <T>(flight: SharedQueryFlight, signal?: AbortSignal): Promise<T[]> =>
  new Promise((resolve, reject) => {
    let finished = false;
    flight.waiters += 1;

    const finish = (settle: () => void): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      flight.waiters -= 1;
      settle();
      if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
    };
    const onAbort = () => finish(() => reject(new BoundedQueryAbortedError()));

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    flight.promise.then(
      (rows) => finish(() => resolve(rows as T[])),
      (error) => finish(() => reject(error)),
    );
  });

const sharedQueryFlight = <T>(key: string, query: unknown, timeoutMs: number): SharedQueryFlight => {
  const existing = sharedQueryFlights.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  const flight: SharedQueryFlight = {
    controller,
    promise: Promise.resolve([]),
    settled: false,
    waiters: 0,
  };
  flight.promise = runBoundedQueryDirect<T>(query, timeoutMs, controller.signal)
    .then(
      (rows) => {
        flight.settled = true;
        return rows;
      },
      (error) => {
        flight.settled = true;
        throw error;
      },
    )
    .finally(() => {
      if (sharedQueryFlights.get(key) === flight) sharedQueryFlights.delete(key);
    });
  sharedQueryFlights.set(key, flight);
  return flight;
};

/**
 * Runs one read query on a reserved connection with a server-side timeout.
 * Reserving first avoids cancelling a query that is still queued in Bun's
 * connection pool, which can leave its promise pending indefinitely.
 *
 * A dedupe key shares only an overlapping execution; completed results are
 * never cached. Each caller keeps independent cancellation semantics.
 */
export const runBoundedQuery = async <T>(
  query: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  dedupeKey?: string,
  client?: SqlClient,
): Promise<T[]> => {
  validateTimeout(timeoutMs);
  if (signal?.aborted) throw new BoundedQueryAbortedError();
  // Transaction snapshots must never share an execution with another caller.
  if (client && client !== sql) return runBoundedQueryDirect<T>(query, timeoutMs, signal, client);
  if (!dedupeKey) return runBoundedQueryDirect<T>(query, timeoutMs, signal);
  return waitForSharedQuery<T>(sharedQueryFlight<T>(`${timeoutMs}:${dedupeKey}`, query, timeoutMs), signal);
};

export const stopBoundedQueryPool = async (): Promise<void> => {
  const flights = [...sharedQueryFlights.values()];
  for (const flight of flights) flight.controller.abort();
  await Promise.allSettled(flights.map((flight) => flight.promise));
  sharedQueryFlights.clear();

  const pool = queryPool;
  queryPool = undefined;
  await pool?.close({ timeout: 5 });
};
