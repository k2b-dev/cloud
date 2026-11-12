import { createSql, sql } from "@k2b/cloud";
import type { SQL } from "bun";
import { afterDraftDocumentCommit } from "./draft-document-log";

// Each SQL statement uses the socket's existing access-refresh budget.
export const DRAFT_DOCUMENT_ACCESS_REFRESH_MS = 10_000;

// Cancellation must not queue behind the reservations it needs to cancel.
// One extra connection serves the whole process (not one per socket). Close
// the owned pool after its last cancellation settles, including failed batches.
let cancellationPool: ReturnType<typeof createSql> | undefined;
let cancellationUsers = 0;
const cancelBackend = async (pid: number): Promise<void> => {
  cancellationPool ??= createSql({ max: 1, connectionTimeout: DRAFT_DOCUMENT_ACCESS_REFRESH_MS / 1000 });
  const pool = cancellationPool;
  cancellationUsers++;
  try {
    await pool`SELECT pg_cancel_backend(${pid})`;
  } finally {
    if (--cancellationUsers === 0) {
      cancellationPool = undefined;
      await pool.close();
    }
  }
};

/** Start only a live socket's lazy query; cancel running work and await rollback readiness. */
export const awaitDraftDocumentQuery = async <T>(
  query: Pick<SQL.Query<T>, "then"> & { cancel(): unknown },
  signal?: AbortSignal,
): Promise<T> => {
  // Bun can leave a lazy SQL query unsettled forever if cancel() precedes its
  // first await. All callers pass lazy queries: reject before starting one when
  // the socket already stopped, so BEGIN can roll back without awaiting it.
  signal?.throwIfAborted();
  // A cancel after the reservation closed settles with "Connection closed"; the awaited query reports the outcome.
  const abort = () => void Promise.resolve(query.cancel()).catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await query;
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};

/**
 * Socket callers can cancel pool acquisition and row-lock reads. Bound every
 * other statement too, including downstream projection queries, without
 * extending a shorter operator timeout. The transaction always ends with its
 * own COMMIT or ROLLBACK before the reservation is released, so a stopped
 * socket never leaves a transaction behind a contested row.
 */
export const withDraftDocumentTransaction = async <T>(
  signal: AbortSignal | undefined,
  operation: (db: typeof sql) => Promise<T>,
): Promise<T> => {
  if (!signal)
    return afterDraftDocumentCommit((observe) =>
      sql.begin((db) => {
        observe(db);
        return operation(db);
      }),
    );
  signal.throwIfAborted();
  const reserved = await sql.reserve({ signal });
  // A closed client socket does not wake a backend waiting on a row lock: it
  // notices only when it next writes. Cancel that backend's statement through
  // a separate, single-connection cancellation pool. The cancelled statement
  // fails the transaction; explicit ROLLBACK ends it before pool release. Never close
  // the reservation while the transaction runs: a close racing the driver's
  // rollback left the backend open in an aborted transaction (#3039).
  let pid: number | undefined;
  let cancelling: Promise<void> | undefined;
  const abort = () => {
    if (pid === undefined) return;
    cancelling ??= cancelBackend(pid).then(
      () => undefined,
      () => undefined,
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const [backend] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pid = backend?.pid;
    if (signal.aborted) abort();
    signal.throwIfAborted();
    return await afterDraftDocumentCommit((observe) =>
      reserved.begin(async (db) => {
        observe(db);
        await awaitDraftDocumentQuery(
          db`
        SELECT set_config('statement_timeout', (
          CASE WHEN current_setting('statement_timeout')::interval = interval '0'
            THEN ${DRAFT_DOCUMENT_ACCESS_REFRESH_MS}
            ELSE LEAST(
              (extract(epoch FROM current_setting('statement_timeout')::interval) * 1000)::bigint,
              ${DRAFT_DOCUMENT_ACCESS_REFRESH_MS}
            )
          END
        )::text, true)
      `,
          signal,
        );
        const result = await operation(db);
        signal.throwIfAborted();
        return result;
      }),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    // A cancel still on its way could otherwise hit the next user of this connection.
    await cancelling;
    // After an abort the driver does not reliably end the failed transaction
    // itself. End it here, so the pool never gets back a connection inside an
    // open or aborted transaction; one that cannot even roll back is closed.
    if (signal.aborted) await reserved`ROLLBACK`.catch(() => reserved.close({ timeout: 0 }).catch(() => undefined));
    reserved.release();
  }
};
