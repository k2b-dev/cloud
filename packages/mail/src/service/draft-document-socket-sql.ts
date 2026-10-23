import { type SQL, sql } from "bun";

// Each SQL statement uses the socket's existing access-refresh budget.
export const DRAFT_DOCUMENT_ACCESS_REFRESH_MS = 10_000;

/** Cancel the actual query, then await its settlement so the transaction can roll back. */
export const awaitDraftDocumentQuery = async <T>(
  query: Pick<SQL.Query<T>, "then"> & { cancel(): unknown },
  signal?: AbortSignal,
): Promise<T> => {
  const abort = () => query.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
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
 * extending a shorter operator timeout. Await rollback before releasing the
 * reservation; a close never leaves a transaction behind a contested row.
 */
export const withDraftDocumentTransaction = async <T>(
  signal: AbortSignal | undefined,
  operation: (db: typeof sql) => Promise<T>,
): Promise<T> => {
  if (!signal) return sql.begin(operation);
  signal.throwIfAborted();
  const reserved = await sql.reserve({ signal });
  try {
    signal.throwIfAborted();
    return await reserved.begin(async (db) => {
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
    });
  } finally {
    reserved.release();
  }
};
