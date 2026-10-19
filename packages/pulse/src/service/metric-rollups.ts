import { err } from "@k2b/cloud/server";
import { sql } from "bun";
import { assertStoreName } from "../store/base-schema";
import { baseStore } from "../store/base-store";
import { requireBaseWritable } from "./access-control";
import type { IngestStore } from "./ingest-bulk";

export const HOUR_MS = 3_600_000;
export const markMetricHoursDirty = async (baseId: string, timestamps: readonly string[], db: typeof sql, now: Date): Promise<void> => {
  const hours = [...new Set(timestamps.map((ts) => new Date(Math.floor(Date.parse(ts) / HOUR_MS) * HOUR_MS).toISOString()))].sort();
  if (!hours.length) return;
  const [base] = await db<{ sealed_before: Date | null }[]>`SELECT sealed_before FROM pulse.base_stores WHERE base_id=${baseId}::uuid`;
  const sealedBefore = base?.sealed_before?.getTime();
  if (sealedBefore !== undefined && hours.some((hour) => Date.parse(hour) < sealedBefore))
    throw err.badInput("Metric hour is sealed after raw retention");
  const rows = await db`INSERT INTO pulse.metric_hours(base_id,hour,state,revision,lease_until,updated_at)
    SELECT ${baseId}::uuid,hour::timestamptz,'dirty',1,${new Date(now.getTime() + 10 * 60_000)}::timestamptz,${now}::timestamptz
    FROM unnest(${sql.array(hours, "TEXT")}) hour ORDER BY hour
    ON CONFLICT(base_id,hour) DO UPDATE SET state='dirty',revision=pulse.metric_hours.revision+1,
      lease_until=greatest(pulse.metric_hours.lease_until,EXCLUDED.lease_until),updated_at=EXCLUDED.updated_at
    WHERE pulse.metric_hours.state<>'sealed' RETURNING hour`;
  if (rows.length !== hours.length) throw err.badInput("Metric hour is sealed after raw retention");
};

/** The predecessor crosses empty hours and, when raw data has gone, comes from a previous rollup. */
export const hourlyRollupSql = (database: string, prefix: string) => {
  const db = assertStoreName(database, prefix);
  return `INSERT INTO ${db}._rollups
    WITH
    in_hour AS (SELECT series_id,ts,value FROM ${db}.samples WHERE ts>=fromUnixTimestamp64Milli({start:Int64}) AND ts<fromUnixTimestamp64Milli({end:Int64})),
    ids AS (SELECT DISTINCT series_id FROM in_hour),
    raw_base AS (SELECT src.series_id,argMax(src.value,src.ts) AS value,max(src.ts) AS ts FROM ${db}.samples src
      WHERE src.series_id IN ids AND src.ts<fromUnixTimestamp64Milli({start:Int64}) AND src.ts>=fromUnixTimestamp64Milli({cutoff:Int64}) GROUP BY src.series_id),
    historical_base AS (SELECT series_id,argMax(last_value,bucket) AS value,argMax(last_ts,bucket) AS ts FROM ${db}.rollups
      WHERE series_id IN ids AND series_id NOT IN (SELECT series_id FROM raw_base) AND bucket<fromUnixTimestamp64Milli({start:Int64}) GROUP BY series_id),
    points AS (SELECT series_id,ts,value,1 AS inside FROM in_hour UNION ALL SELECT series_id,ts,value,0 AS inside FROM raw_base UNION ALL SELECT series_id,ts,value,0 AS inside FROM historical_base),
    pairs AS (SELECT *,lagInFrame(toNullable(value),1,NULL) OVER w AS previous_value,lagInFrame(toNullable(ts),1,NULL) OVER w AS previous_ts
      FROM points WINDOW w AS (PARTITION BY series_id ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))
    SELECT p.series_id,toDateTime(fromUnixTimestamp64Milli({start:Int64})),countIf(inside=1),sumIf(value,inside=1),minIf(value,inside=1),maxIf(value,inside=1),
      argMaxIf(value,ts,inside=1),maxIf(ts,inside=1),
      coalesce(sumIf(if(value>=previous_value,value-previous_value,value),inside=1 AND s.type='counter' AND previous_value IS NOT NULL),0),
      coalesce(sumIf(dateDiff('millisecond',previous_ts,ts)/1000.0,inside=1 AND s.type='counter' AND previous_ts IS NOT NULL),0),{revision:UInt64}
    FROM pairs p INNER JOIN ${db}.series s ON s.series_id=p.series_id GROUP BY p.series_id`;
};
export const createHourlyRollup =
  ({ store = baseStore, database = sql, clock = store.clock }: { store?: IngestStore; database?: typeof sql; clock?: () => Date } = {}) =>
  async (baseId?: string): Promise<{ buckets: number; done: boolean }> => {
    const connectedStore = { ...store, query: await store.prepare() };
    return database.begin(async (tx) => {
      const now = clock();
      await tx`SET LOCAL statement_timeout='30s'`.simple();
      await tx`SET LOCAL lock_timeout='30s'`.simple();
      const [candidate] = await tx<{ base_id: string; hour: Date }[]>`SELECT h.base_id,h.hour FROM pulse.metric_hours h
      JOIN pulse.base_stores s ON s.base_id=h.base_id
      WHERE h.state='dirty' AND (h.lease_until IS NULL OR h.lease_until<=${now}::timestamptz) AND h.hour<${new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)}
        AND (${baseId ?? null}::uuid IS NULL OR h.base_id=${baseId ?? null}::uuid) AND s.state='active' AND s.write_block_reason IS NULL
      ORDER BY h.hour,h.base_id LIMIT 1`;
      if (!candidate) return { buckets: 0, done: true };
      const active = await requireBaseWritable(candidate.base_id, tx);
      if (!active.ok) return { buckets: 0, done: false };
      const [lock] =
        await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${`pulse.rollup:${candidate.base_id}:${candidate.hour.toISOString()}`},0)) AS claimed`;
      if (!lock?.claimed) return { buckets: 0, done: false };
      const [hour] = await tx<
        { revision: string }[]
      >`SELECT revision::text FROM pulse.metric_hours WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour}
      AND state='dirty' AND (lease_until IS NULL OR lease_until<=${now}::timestamptz)`;
      if (!hour) return { buckets: 0, done: false };
      const [base] = await tx<
        { database_name: string; retention_days: number }[]
      >`SELECT s.database_name,b.retention_days FROM pulse.base_stores s JOIN pulse.bases b ON b.id=s.base_id WHERE b.id=${candidate.base_id}::uuid`;
      if (!base) return { buckets: 0, done: false };
      await connectedStore.query(hourlyRollupSql(base.database_name, store.prefix), {
        start: candidate.hour.getTime(),
        end: candidate.hour.getTime() + HOUR_MS,
        cutoff: now.getTime() - base.retention_days * 86_400_000,
        revision: hour.revision,
      });
      // No hour lock during the insert: a concurrent T1 can bump the revision; this CAS then leaves it dirty.
      await tx`UPDATE pulse.metric_hours SET state='clean',updated_at=${now}::timestamptz WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour} AND state='dirty' AND revision=${hour.revision}::bigint`;
      return { buckets: 1, done: false };
    });
  };
export const runHourlyRollup = createHourlyRollup();

export const sealExpiredMetricHour = async (baseId?: string, now = new Date()): Promise<number> =>
  sql.begin(async (tx) => {
    const [candidate] = await tx<{ base_id: string; hour: Date }[]>`SELECT h.base_id,h.hour FROM pulse.metric_hours h
    JOIN pulse.bases b ON b.id=h.base_id JOIN pulse.base_stores s ON s.base_id=b.id
    WHERE h.state='clean' AND h.hour+interval '1 hour'<=${now}::timestamptz-b.retention_days*interval '1 day' AND (h.lease_until IS NULL OR h.lease_until<=${now}::timestamptz)
      AND (${baseId ?? null}::uuid IS NULL OR h.base_id=${baseId ?? null}::uuid) AND s.state='active' AND s.write_block_reason IS NULL ORDER BY h.hour,h.base_id LIMIT 1`;
    if (!candidate) return 0;
    const active = await requireBaseWritable(candidate.base_id, tx);
    if (!active.ok) return 0;
    const rows = await tx`UPDATE pulse.metric_hours SET state='sealed',updated_at=${now}::timestamptz
    WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour} AND state='clean' AND (lease_until IS NULL OR lease_until<=${now}::timestamptz)`;
    return rows.count;
  });
