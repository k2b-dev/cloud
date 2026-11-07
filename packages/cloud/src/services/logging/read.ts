import { AsyncLocalStorage } from "node:async_hooks";
import type { TransactionSQL } from "bun";
import { createSql, sql } from "../../runtime/clients";

// Stay below the gateway's ten-second response budget. The same deadline covers
// pool acquisition and every sequential read in one HTTP request.
const READ_BUDGET_MS = 5_000;
const requestSignal = new AsyncLocalStorage<AbortSignal>();

/** Platform-owned scope for operator reads, including sibling SSR and API routes. */
export const withObservabilityRead = async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Observability read timed out")), READ_BUDGET_MS);
  try {
    return await requestSignal.run(AbortSignal.any([signal, deadline.signal]), work);
  } finally {
    clearTimeout(timer);
  }
};

export const readQuery = async <T>(query: (db: TransactionSQL) => PromiseLike<T>): Promise<T> => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("Observability read timed out")), READ_BUDGET_MS);
  const inherited = requestSignal.getStore();
  const signal = AbortSignal.any([timeout.signal, ...(inherited ? [inherited] : [])]);
  let cancel: Promise<void> | undefined;
  let backend: { pid: number; started: string } | undefined;
  const connection = await sql.reserve({ signal }).catch((error: unknown) => {
    clearTimeout(timer);
    throw error;
  });
  const abort = () => {
    if (!backend || cancel) return;
    const identity = backend;
    cancel = (async () => {
      // Bun Query.cancel() does not cancel running PostgreSQL work. Use an
      // independent connection so cancellation cannot queue behind this pool.
      const control = createSql({ max: 1, connectionTimeout: 1, connection: { statement_timeout: 1000 } });
      try {
        await control`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
          WHERE pid=${identity.pid} AND extract(epoch FROM backend_start)::text=${identity.started}
            AND datname=current_database() AND usename=session_user`;
      } finally {
        await control.close({ timeout: 1 });
      }
    })().catch(() => {
      // statement_timeout still bounds server work if the control path fails.
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await connection.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '5s'`;
      await tx`SET LOCAL lock_timeout = '1s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const [identity] = await tx<{ pid: number; started: string }[]>`
        SELECT pid, extract(epoch FROM backend_start)::text AS started
        FROM pg_stat_activity WHERE pid=pg_backend_pid()
      `;
      backend = identity;
      signal.throwIfAborted();
      const result = await query(tx);
      signal.throwIfAborted();
      return result;
    });
  } finally {
    await cancel;
    signal.removeEventListener("abort", abort);
    clearTimeout(timer);
    connection.release();
  }
};
