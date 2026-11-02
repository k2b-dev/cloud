import { sql } from "../../runtime/clients";

// Match the existing observability delete-batch budget (telemetry retention).
const BATCH_SIZE = 10_000;
export type TraceRetentionOptions = {
  days: number;
  source?: string;
  maxBytes?: number;
  heartbeat?: () => Promise<void>;
  signal?: AbortSignal;
};

/** Core owns scheduled retention. Size is live row payload, including events,
 * not relation files: DELETE leaves reusable pages and cannot shrink those.
 * Open spans are preserved regardless of age/size; age is not a worker lease.
 */
export const cleanupTraceStorage = async (options: TraceRetentionOptions): Promise<number> => {
  const days = Number.isFinite(options.days) ? Math.max(1, Math.trunc(options.days)) : 30;
  const source = options.source ?? null;
  const budget = options.maxBytes;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1))
    throw new Error("Trace byte budget must be a positive integer");
  let total = 0;
  const drain = async (remove: () => Promise<number>): Promise<void> => {
    for (;;) {
      options.signal?.throwIfAborted();
      const deleted = await remove();
      total += deleted;
      await options.heartbeat?.();
      if (deleted < BATCH_SIZE) return;
    }
  };
  await drain(async () => {
    const rows = await sql`WITH expired AS (
        SELECT trace_id, span_id FROM logging.trace_spans
        WHERE ended_at < now() - (${days}::int * INTERVAL '1 day') AND (${source}::text IS NULL OR source = ${source})
        ORDER BY ended_at, trace_id, span_id LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM logging.trace_spans s USING expired e WHERE s.trace_id = e.trace_id AND s.span_id = e.span_id AND s.ended_at < now() - (${days}::int * INTERVAL '1 day')`;
    return rows.count;
  });
  await drain(async () => {
    const rows = await sql`WITH expired AS (
        SELECT ctid FROM logging.run_minutes WHERE bucket < now() - (${days}::int * INTERVAL '1 day')
          AND (${source}::text IS NULL OR source = ${source}) ORDER BY bucket LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ) DELETE FROM logging.run_minutes r USING expired e WHERE r.ctid = e.ctid`;
    return rows.count;
  });
  if (budget === undefined) return total;
  options.signal?.throwIfAborted();
  // One accounting scan, then subtract each deleted batch. Never repeatedly
  // scan a large table while draining. Concurrent inserts wait for next sweep.
  const [size] = await sql<Array<{ bytes: string }>>`SELECT (
      COALESCE((SELECT SUM(pg_column_size(s)) FROM logging.trace_spans s WHERE (${source}::text IS NULL OR source = ${source})), 0)
      + COALESCE((SELECT SUM(pg_column_size(e)) FROM logging.trace_events e JOIN logging.trace_spans s USING (trace_id, span_id)
          WHERE (${source}::text IS NULL OR s.source = ${source})), 0)
      + COALESCE((SELECT SUM(pg_column_size(r)) FROM logging.run_minutes r WHERE (${source}::text IS NULL OR source = ${source})), 0)
    )::text AS bytes`;
  let excess = Number(size?.bytes ?? 0) - budget;
  while (excess > 0) {
    options.signal?.throwIfAborted();
    const [batch] = await sql<Array<{ deleted: number; bytes: string }>>`WITH oldest_spans AS MATERIALIZED (
        SELECT ctid FROM logging.trace_spans WHERE ended_at IS NOT NULL AND (${source}::text IS NULL OR source = ${source})
        ORDER BY ended_at LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ), oldest_minutes AS MATERIALIZED (
        SELECT ctid FROM logging.run_minutes WHERE (${source}::text IS NULL OR source = ${source}) ORDER BY bucket LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ), candidates AS MATERIALIZED (
        SELECT 'span' AS kind, s.ctid::text AS tid, s.ended_at AS at,
          pg_column_size(s)::bigint + COALESCE((SELECT SUM(pg_column_size(e)) FROM logging.trace_events e
            WHERE e.trace_id = s.trace_id AND e.span_id = s.span_id), 0) AS bytes
        FROM logging.trace_spans s JOIN oldest_spans oldest ON s.ctid = oldest.ctid
        UNION ALL
        SELECT 'minute', r.ctid::text, r.bucket, pg_column_size(r)::bigint FROM logging.run_minutes r JOIN oldest_minutes oldest ON r.ctid = oldest.ctid
        ORDER BY at, kind, tid LIMIT ${BATCH_SIZE}
      ), selected AS MATERIALIZED (
        SELECT * FROM (SELECT *, SUM(bytes) OVER (ORDER BY at, kind, tid ROWS UNBOUNDED PRECEDING) - bytes AS before_bytes FROM candidates) ranked
        WHERE before_bytes < ${excess}
      ), spans AS (
        DELETE FROM logging.trace_spans s USING selected d WHERE d.kind = 'span' AND s.ctid = d.tid::tid AND s.ended_at IS NOT NULL RETURNING 1
      ), minutes AS (
        DELETE FROM logging.run_minutes r USING selected d WHERE d.kind = 'minute' AND r.ctid = d.tid::tid RETURNING 1
      ) SELECT ((SELECT COUNT(*) FROM spans) + (SELECT COUNT(*) FROM minutes))::int AS deleted,
        COALESCE((SELECT SUM(bytes) FROM selected), 0)::text AS bytes`;
    const deleted = batch?.deleted ?? 0;
    total += deleted;
    if (!deleted) {
      console.warn("[logging:trace] byte budget exceeded by open spans; preserving active work");
      break;
    }
    excess -= Number(batch?.bytes ?? 0);
    await options.heartbeat?.();
  }
  return total;
};
