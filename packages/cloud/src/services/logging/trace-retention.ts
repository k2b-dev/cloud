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

/** A PostgreSQL heap tuple needs at least 24 aligned header bytes and a
 * four-byte line pointer. Derive the physical range from the existing 10,000-row
 * scan budget, so even densely packed pages stay within that row ceiling.
 * Explicit ROW constructors keep count/delete sizing consistent across plans.
 */
const tracePayloadBytes = async (options: TraceRetentionOptions): Promise<number> => {
  const source = options.source ?? null;
  const countRelation = async (
    relation: string,
    countPage: (from: string, until: string) => Promise<Array<{ bytes: string }>>,
  ): Promise<number> => {
    options.signal?.throwIfAborted();
    const [storage] = await sql<Array<{ bytes: string; block_size: number }>>`
      SELECT pg_relation_size(${relation}::regclass)::text AS bytes,
        current_setting('block_size')::int AS block_size`;
    if (!storage) throw new Error("Trace relation size unavailable");
    const blocks = Math.ceil(Number(storage.bytes) / storage.block_size);
    const blocksPerPage = Math.max(1, Math.floor((BATCH_SIZE * 28) / storage.block_size));
    let bytes = 0;
    for (let block = 0; block < Math.max(1, blocks); block += blocksPerPage) {
      options.signal?.throwIfAborted();
      const [page] = await countPage(`(${block},0)`, `(${block + blocksPerPage},0)`);
      bytes += Number(page?.bytes ?? 0);
      await options.heartbeat?.();
    }
    return bytes;
  };
  // TID ranges visit adjacent heap blocks, rather than heap-fetching random
  // trace UUIDs through the primary key. Small relations can use a sequential
  // scan; large relations use a bounded TID range scan, without sorting rows.
  const spans = await countRelation(
    "logging.trace_spans",
    (from, until) => sql`
    SELECT COALESCE(SUM(pg_column_size(ROW(s.*))), 0)::text AS bytes
    FROM logging.trace_spans s
    WHERE s.ctid >= ${from}::tid AND s.ctid < ${until}::tid
      AND (${source}::text IS NULL OR source = ${source})`,
  );
  const events = await countRelation(
    "logging.trace_events",
    (from, until) => sql`
    SELECT COALESCE(SUM(pg_column_size(ROW(e.*))), 0)::text AS bytes
    FROM logging.trace_events e
    WHERE e.ctid >= ${from}::tid AND e.ctid < ${until}::tid
      AND (${source}::text IS NULL OR EXISTS (
        SELECT 1 FROM logging.trace_spans s WHERE s.trace_id = e.trace_id AND s.span_id = e.span_id AND s.source = ${source}
      ))`,
  );
  const minutes = await countRelation(
    "logging.run_minutes",
    (from, until) => sql`
    SELECT COALESCE(SUM(pg_column_size(ROW(r.*))), 0)::text AS bytes
    FROM logging.run_minutes r
    WHERE r.ctid >= ${from}::tid AND r.ctid < ${until}::tid
      AND (${source}::text IS NULL OR source = ${source})`,
  );
  return spans + events + minutes;
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
