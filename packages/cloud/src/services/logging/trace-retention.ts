import { sql } from "../../runtime/clients";
import { SYNC_SLOW_AFTER_MS } from "./background-loop-policy";

// Match the existing observability delete-batch budget (telemetry retention).
const BATCH_SIZE = 10_000;
export type TraceRetentionOptions = {
  days: number;
  source?: string;
  maxBytes?: number;
  heartbeat?: () => Promise<void>;
  signal?: AbortSignal;
};

/** Page by the existing primary keys; a large history must renew the job's
 * lease while counting, not only once it starts deleting. No OFFSET scans.
 * Explicit ROW constructors keep count/delete sizing consistent across query
 * plans (whole-row references can use different varlena representations).
 */
const tracePayloadBytes = async (options: TraceRetentionOptions): Promise<number> => {
  const source = options.source ?? null;
  let bytes = 0;
  let span: { trace_id: string; span_id: string } | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const after = span ? sql`(trace_id, span_id) > (${span.trace_id}, ${span.span_id})` : sql`TRUE`;
    const rows = await sql<Array<{ trace_id: string; span_id: string; bytes: number }>>`
      WITH page AS MATERIALIZED (
        SELECT trace_id, span_id, pg_column_size(ROW(s.*)) AS bytes FROM logging.trace_spans s WHERE ${after}
          AND (${source}::text IS NULL OR source = ${source})
        ORDER BY trace_id, span_id LIMIT ${BATCH_SIZE}
      ) SELECT * FROM page ORDER BY trace_id, span_id`;
    bytes += rows.reduce((sum, row) => sum + row.bytes, 0);
    await options.heartbeat?.();
    if (rows.length < BATCH_SIZE) break;
    span = rows.at(-1);
  }
  let eventId = "0";
  for (;;) {
    options.signal?.throwIfAborted();
    const rows = await sql<Array<{ id: string; bytes: number }>>`
      WITH page AS MATERIALIZED (
        SELECT id, trace_id, span_id, pg_column_size(ROW(e.*)) AS bytes FROM logging.trace_events e
        WHERE id > ${eventId}::bigint ORDER BY id LIMIT ${BATCH_SIZE}
      ) SELECT id::text, CASE WHEN ${source}::text IS NULL OR EXISTS (
          SELECT 1 FROM logging.trace_spans s WHERE s.trace_id = page.trace_id AND s.span_id = page.span_id AND s.source = ${source}
        ) THEN bytes ELSE 0 END AS bytes FROM page ORDER BY page.id`;
    bytes += rows.reduce((sum, row) => sum + row.bytes, 0);
    await options.heartbeat?.();
    if (rows.length < BATCH_SIZE) break;
    eventId = rows.at(-1)!.id;
  }
  let minute: { bucket: Date; source: string; app_id: string; category: string; name: string } | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const after = minute
      ? sql`(bucket, source, app_id, category, name) > (${minute.bucket}, ${minute.source}, ${minute.app_id}, ${minute.category}, ${minute.name})`
      : sql`TRUE`;
    const rows = await sql<Array<{ bucket: Date; source: string; app_id: string; category: string; name: string; bytes: number }>>`
      WITH page AS MATERIALIZED (
        SELECT bucket, source, app_id, category, name, pg_column_size(ROW(r.*)) AS bytes FROM logging.run_minutes r
        WHERE ${after} AND (${source}::text IS NULL OR source = ${source})
        ORDER BY bucket, source, app_id, category, name LIMIT ${BATCH_SIZE}
      ) SELECT * FROM page
        ORDER BY bucket, source, app_id, category, name`;
    bytes += rows.reduce((sum, row) => sum + row.bytes, 0);
    await options.heartbeat?.();
    if (rows.length < BATCH_SIZE) break;
    minute = rows.at(-1);
  }
  return bytes;
};

/** Core owns scheduled retention. Size is live row payload, including events,
 * not relation files: DELETE leaves reusable pages and cannot shrink those.
 * Open spans are preserved regardless of age/size; age is not a worker lease.
 */
export const cleanupTraceStorage = async (options: TraceRetentionOptions): Promise<number> => {
  const days = Number.isFinite(options.days) ? Math.max(1, Math.trunc(options.days)) : 30;
  const source = options.source ?? null;
  let budget = options.maxBytes;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 1)) {
    console.warn("[logging:trace] invalid byte budget; continuing age-based retention only");
    budget = undefined;
  }
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
  // One paged accounting pass, then subtract each deleted batch. Concurrent
  // writes are approximate until the next sweep, as with day-based retention.
  let excess = (await tracePayloadBytes(options)) - budget;
  let routineOnly = true;
  while (excess > 0) {
    options.signal?.throwIfAborted();
    const [batch] = await sql<Array<{ deleted: number; bytes: string }>>`WITH oldest_spans AS MATERIALIZED (
        SELECT s.ctid FROM logging.trace_spans s WHERE ended_at IS NOT NULL AND (${source}::text IS NULL OR source = ${source})
          AND (${!routineOnly} OR (status = 'ok' AND duration_ms < ${SYNC_SLOW_AFTER_MS}
            AND COALESCE(attributes->>'sync.attempt', '1') = '1'
            AND NOT EXISTS (SELECT 1 FROM logging.trace_events e WHERE e.trace_id = s.trace_id AND e.span_id = s.span_id)))
        ORDER BY ended_at LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ), oldest_minutes AS MATERIALIZED (
        SELECT ctid FROM logging.run_minutes WHERE ${!routineOnly} AND (${source}::text IS NULL OR source = ${source}) ORDER BY bucket LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      ), candidates AS MATERIALIZED (
        SELECT 'span' AS kind, s.ctid::text AS tid, s.ended_at AS at,
          pg_column_size(ROW(s.*))::bigint + COALESCE((SELECT SUM(pg_column_size(ROW(e.*))) FROM logging.trace_events e
            WHERE e.trace_id = s.trace_id AND e.span_id = s.span_id), 0) AS bytes
        FROM logging.trace_spans s JOIN oldest_spans oldest ON s.ctid = oldest.ctid
        UNION ALL
        SELECT 'minute', r.ctid::text, r.bucket, pg_column_size(ROW(r.*))::bigint FROM logging.run_minutes r JOIN oldest_minutes oldest ON r.ctid = oldest.ctid
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
      if (routineOnly) {
        routineOnly = false;
        await options.heartbeat?.();
        continue;
      }
      console.warn("[logging:trace] byte budget exceeded by open spans; preserving active work");
      break;
    }
    excess -= Number(batch?.bytes ?? 0);
    await options.heartbeat?.();
  }
  return total;
};
