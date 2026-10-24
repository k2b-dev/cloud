import type { ReservedSQL, SQL, TransactionSQL } from "bun";
import * as bun from "bun";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { boundTransaction } from "./authority";
import { AppPwaError } from "./contracts";

const requestBudget = REQUEST_IDLE_TIMEOUT_SECONDS * 1000;

/** Bun exposes normalized options: timeout values are milliseconds and PostgreSQL
 * startup parameters are NUL-separated in `query`. Reconstitute constructor input
 * without losing role, routing or TLS settings. Never log these credential-bearing options.
 */
const cancellationPool = (db: SQL) => {
  const options = db.options;
  const query: unknown = Reflect.get(options, "query");
  const sslMode: unknown = Reflect.get(options, "sslMode");
  const modes = ["disable", "prefer", "require", "verify-ca", "verify-full"];
  if (options.adapter !== "postgres" || typeof query !== "string" || typeof sslMode !== "number" || !modes[sslMode])
    throw new AppPwaError("UNAVAILABLE", 503);
  const parts = query.split("\0");
  const connection: Record<string, string | number> = {};
  for (let index = 0; index + 1 < parts.length; index += 2) connection[parts[index]!] = parts[index + 1]!;
  connection.statement_timeout = requestBudget;
  return new bun.SQL(`postgres://localhost?sslmode=${modes[sslMode]}`, {
    ...options,
    // Bun adds SNI to normalized prefer options. Passing that generated object
    // back as explicit TLS upgrades prefer to require. Recreate its default SNI
    // from hostname instead; explicit verification options remain unchanged.
    tls: sslMode === 1 ? undefined : options.tls,
    connection,
    max: 1,
    connectionTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
    idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
    maxLifetime: REQUEST_IDLE_TIMEOUT_SECONDS,
    onconnect: undefined,
    onclose: undefined,
  });
};

/** Close application SQL independently of the platform's transaction lifecycle.
 * Queries are lazy in Bun: guard execution as well as query construction, and
 * settle started queries before the connection can be committed or reused.
 */
export const withAppPwaTransactionLease = async <T>(
  connection: SQL,
  signal: AbortSignal,
  work: (tx: TransactionSQL) => Promise<T>,
  beforeQuery: () => Promise<void> = async () => {},
): Promise<T> => {
  let open = true;
  let sequence = 0;
  let queue = Promise.resolve();
  const queries = new Set<{ cancel(): void; pending?: Promise<unknown> }>();
  const guardedQueries = new WeakMap<object, object>();
  const check = () => {
    if (!open || signal.aborted) throw new AppPwaError("UNAVAILABLE", 503);
  };
  const guardResult = (result: unknown, recovery = false): unknown => {
    if (typeof result !== "object" || result === null || !("cancel" in result) || typeof result.cancel !== "function") return result;
    const existing = guardedQueries.get(result);
    if (existing) return existing;
    const cancel = result.cancel;
    const query: { cancel(): void; pending?: Promise<unknown> } = { cancel: () => Reflect.apply(cancel, result, []) };
    queries.add(query);
    const start = (): Promise<unknown> => {
      check();
      if (!query.pending) {
        query.pending = queue.then(async () => {
          check();
          // An aborted savepoint rejects ordinary SQL (including set_config).
          // ROLLBACK TO must reach PostgreSQL before configuration can resume.
          if (!recovery) await beforeQuery();
          check();
          // Assimilate the original Bun query only after setting its remaining budget.
          return await result;
        });
        queue = query.pending.then(
          () => {},
          () => {},
        );
        void query.pending.then(
          () => queries.delete(query),
          () => queries.delete(query),
        );
      }
      return query.pending;
    };
    const guarded = new Proxy(result, {
      get(target, property) {
        check();
        if (property === "then") return (yes: (value: unknown) => unknown, no: (error: unknown) => unknown) => start().then(yes, no);
        if (property === "catch") return (no: (error: unknown) => unknown) => start().catch(no);
        if (property === "finally") return (done: () => void) => start().finally(done);
        if (property === "execute")
          return () => {
            void start();
            return guarded;
          };
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          check();
          return guardResult(Reflect.apply(value, target, args));
        };
      },
    });
    guardedQueries.set(result, guarded);
    return guarded;
  };
  async function savepoint<T>(
    nameOrWork: string | SQL.SavepointContextCallback<T>,
    callback?: SQL.SavepointContextCallback<T>,
  ): Promise<T> {
    check();
    const callbackWork = typeof nameOrWork === "function" ? nameOrWork : callback;
    if (!callbackWork) throw new TypeError("A savepoint needs a callback");
    // Only generated identifiers enter SQL; the optional name is diagnostic in Bun.
    const name = `app_pwa_${sequence++}`;
    await tx.unsafe(`SAVEPOINT ${name}`);
    try {
      const result = await callbackWork(tx);
      await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      // A late callback must never roll back a later user's transaction.
      check();
      await guardResult(connection.unsafe(`ROLLBACK TO SAVEPOINT ${name}`), true);
      await tx.unsafe(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  const tx: TransactionSQL = new Proxy(Object.assign(connection, { savepoint }), {
    apply(target, receiver, args) {
      check();
      return guardResult(Reflect.apply(target, receiver, args));
    },
    get(target, property) {
      check();
      if (property === "file")
        return async (path: string, args?: unknown[]) => {
          const text = await Bun.file(path).text();
          check();
          return await tx.unsafe(text, args);
        };
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!["unsafe", "array", "savepoint"].includes(String(property)))
        return () => {
          throw new AppPwaError("FORBIDDEN", 403);
        };
      return (...args: unknown[]) => {
        check();
        return guardResult(Reflect.apply(value, target, args));
      };
    },
  });
  const close = () => {
    if (!open) return;
    open = false;
    for (const query of queries) {
      try {
        query.cancel();
      } catch {
        /* Transaction recovery owns a failed cancellation. */
      }
    }
  };
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      close();
      reject(new AppPwaError("UNAVAILABLE", 503));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    check();
    return await Promise.race([work(tx), cancelled]);
  } finally {
    close();
    await Promise.allSettled([...queries].flatMap((query) => (query.pending ? [query.pending] : [])));
    signal.removeEventListener("abort", abort);
  }
};

/** Own BEGIN through COMMIT/rollback, including server-side cancellation.
 * Reservation cancellation alone stops having an effect once reserve resolves.
 */
export const withAppPwaTransaction = async <T>(
  db: SQL,
  signal: AbortSignal | undefined,
  work: (tx: TransactionSQL, signal: AbortSignal) => Promise<T>,
  authorityDeadline: (time: Date) => Date | undefined = () => undefined,
): Promise<T> => {
  const requestEnd = performance.now() + requestBudget;
  const expiry = new AbortController();
  const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(requestBudget), expiry.signal]);
  const connection = await db.reserve({ signal: requestSignal });
  let authorityEnd = Infinity;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let recovering = false;
  let backend: { pid: number; started: string } | undefined;
  let cancellation: Promise<void> | undefined;
  let control: ReservedSQL | undefined;
  const failure = () =>
    expiry.signal.aborted || (authorityEnd <= requestEnd && performance.now() >= authorityEnd)
      ? new AppPwaError("EXPIRED", 410)
      : new AppPwaError("UNAVAILABLE", 503);
  const check = () => {
    if (requestSignal.aborted || performance.now() >= Math.min(requestEnd, authorityEnd)) throw failure();
  };
  const closeConnection = () => {
    closing ??= connection.close({ timeout: 0 });
  };
  const startRecoveryTimer = () => {
    recoveryTimer ??= setTimeout(() => {
      closeConnection();
      void control?.close({ timeout: 0 });
    }, requestBudget);
  };
  const cancelBackend = async () => {
    let pool: SQL | undefined;
    try {
      if (!backend) return closeConnection();
      pool = cancellationPool(db);
      // A separate max:1 pool cannot deadlock behind the reserved application pool.
      control = await pool.reserve({ signal: AbortSignal.timeout(requestBudget) });
      if (closing) return;
      // pg_cancel_backend permits the authenticated owner's role. A startup SET
      // ROLE may have narrowed current_user, so restore this connection's login.
      await control`RESET ROLE`;
      if (closing) return;
      const [row] = await control<{ cancelled: boolean }[]>`SELECT pg_cancel_backend(pid) AS cancelled
        FROM pg_stat_activity WHERE pid=${backend.pid} AND extract(epoch FROM backend_start)::text=${backend.started}
          AND datname=current_database() AND usename=session_user`;
      if (!row?.cancelled) closeConnection();
    } catch {
      // Unreachable control connection or denied cancellation: discard, never reuse.
      closeConnection();
    } finally {
      await control?.close({ timeout: 0 });
      // Pool close(timeout:0) is graceful in this Bun; a positive bound is required.
      await pool?.close({ timeout: REQUEST_IDLE_TIMEOUT_SECONDS });
    }
  };
  const abort = () => {
    startRecoveryTimer();
    // Query.cancel() does not send PostgreSQL cancellation on Bun 744846f84.
    // Keep this reservation until the independent cancellation has settled.
    if (!recovering) cancellation ??= cancelBackend().catch(closeConnection);
  };
  requestSignal.addEventListener("abort", abort, { once: true });
  const run = async <R>(query: SQL.Query<R>): Promise<R> => {
    if (!recovering) check();
    return await query;
  };
  const configure = async () => {
    check();
    // PostgreSQL interprets zero as unlimited. Never round a remaining budget up.
    const remaining = Math.floor(Math.min(requestEnd, authorityEnd) - performance.now());
    if (remaining < 1) throw failure();
    await run(boundTransaction(connection, remaining));
    check();
  };
  const checkAuthority = async () => {
    await configure();
    const started = performance.now();
    const [row] = await run(connection<{ time: Date }[]>`SELECT clock_timestamp() AS time`);
    if (!row) throw new AppPwaError("UNAVAILABLE", 503);
    const time = row.time;
    const deadline = authorityDeadline(time);
    if (deadline) {
      // Bun Date values truncate PostgreSQL's submillisecond clock precision.
      // Discount that precision as well as the clock query's round trip.
      authorityEnd = Math.min(authorityEnd, started + deadline.getTime() - time.getTime() - 1);
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => expiry.abort(), Math.max(0, authorityEnd - performance.now()));
    }
    check();
  };
  try {
    check();
    [backend] = await run(connection<{ pid: number; started: string }[]>`SELECT pg_backend_pid() AS pid,
      extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()`);
    if (!backend || !Number.isSafeInteger(backend.pid) || backend.pid <= 0 || !backend.started) throw failure();
    await run(connection`BEGIN`);
    const result = await withAppPwaTransactionLease(connection, requestSignal, (tx) => work(tx, requestSignal), configure);
    await checkAuthority();
    await configure();
    await run(connection`SET CONSTRAINTS ALL IMMEDIATE`);
    // All application callbacks and deferred constraint work precede this fresh clock.
    await checkAuthority();
    await configure();
    await run(connection`COMMIT`);
    // COMMIT may already be durable when an abort arrives. A known success stays
    // successful; a lost acknowledgement is reconciled through the stored attempt.
    return result;
  } catch (error) {
    recovering = true;
    startRecoveryTimer();
    // A late cancel must not interrupt rollback or a later transaction.
    await cancellation;
    try {
      await run(connection`ROLLBACK`);
    } catch {
      closeConnection();
    }
    if (requestSignal.aborted || performance.now() >= Math.min(requestEnd, authorityEnd)) throw failure();
    throw error;
  } finally {
    // Never return a connection while COMMIT, cancellation or recovery is pending.
    // SQL has settled. Stop accepting new cancellation before snapshotting its
    // promise: an abort during `await undefined` must not escape cleanup.
    requestSignal.removeEventListener("abort", abort);
    clearTimeout(expiryTimer);
    try {
      await cancellation;
      if (requestSignal.aborted) closeConnection();
      if (closing) await closing;
    } finally {
      clearTimeout(recoveryTimer);
      // ReservedSQL.close resolves before its socket-close callback. That
      // callback releases the reservation after marking the pool slot closed;
      // explicitly releasing earlier could hand out a closing connection.
      if (!closing) connection.release();
    }
  }
};
