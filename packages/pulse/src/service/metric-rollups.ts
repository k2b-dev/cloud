import { err } from "@k2b/cloud/server";
import { sql } from "bun";
import { requireBaseActive } from "./access-control";

const HOUR_MS = 3_600_000;

/** The hour row is the shared writer/rollup/retention lock and durable completion record. */
export const markMetricHoursDirty = async (baseId: string, timestamps: readonly string[], db: typeof sql): Promise<void> => {
  if (!timestamps.length) return;
  const hours = [...new Set(timestamps.map((ts) => new Date(Math.floor(Date.parse(ts) / HOUR_MS) * HOUR_MS).toISOString()))].sort();
  const [policy] = await db<
    { earliest: Date }[]
  >`SELECT date_bin('1 hour',now()-(retention_days*interval '1 day'),'1970-01-01'::timestamptz) AS earliest FROM pulse.bases WHERE id=${baseId}::uuid`;
  if (!policy) throw err.notFound("Pulse base");
  if (hours.some((hour) => Date.parse(hour) < policy.earliest.getTime()))
    throw err.badInput("Metric timestamps must be within the raw retention window");
  // Acquire each hour in the same order for both the shared and transition paths.
  // Dirty hours need exclusion against rollup/sealing, not against other writers.
  for (const hour of hours) {
    const [dirty] = await db`SELECT hour FROM pulse.metric_hours
      WHERE base_id=${baseId}::uuid AND hour=${hour}::timestamptz AND state='dirty' FOR SHARE`;
    if (dirty) continue;
    // Do not share-lock clean rows: upgrading two concurrent readers would deadlock.
    const marked = await db`INSERT INTO pulse.metric_hours(base_id,hour,state)
      VALUES (${baseId}::uuid,${hour}::timestamptz,'dirty')
      ON CONFLICT(base_id,hour) DO UPDATE SET state='dirty',updated_at=now()
      WHERE pulse.metric_hours.state<>'sealed' RETURNING hour`;
    if (marked.length !== 1) throw err.badInput("Metric hour is sealed after raw retention");
  }
};

export const runHourlyRollup = async (baseId?: string): Promise<{ buckets: number; done: boolean }> =>
  sql.begin(async (tx) => {
    const [candidate] = await tx<{ base_id: string; hour: Date }[]>`
   SELECT h.base_id,h.hour FROM pulse.metric_hours h JOIN pulse.bases b ON b.id=h.base_id
   WHERE h.state='dirty' AND h.hour<date_bin('1 hour',now(),'1970-01-01'::timestamptz)
     AND (${baseId ?? null}::uuid IS NULL OR h.base_id=${baseId ?? null}::uuid)
     AND b.deletion_started_at IS NULL AND (b.data_clear_started_at IS NULL OR b.data_clear_completed_at IS NOT NULL)
   ORDER BY h.hour,h.base_id LIMIT 1
 `;
    if (!candidate) return { buckets: 0, done: true };
    const active = await requireBaseActive(candidate.base_id, tx);
    if (!active.ok) return { buckets: 0, done: false };
    const [claimed] =
      await tx`SELECT hour FROM pulse.metric_hours WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour} AND state='dirty' FOR UPDATE`;
    if (!claimed) return { buckets: 0, done: false };
    const end = new Date(candidate.hour.getTime() + HOUR_MS);
    const result = await tx`
   INSERT INTO pulse.metric_rollups_hourly(base_id,series_id,bucket,sample_count,value_sum,value_min,value_max,last_value,last_ts,updated_at)
   SELECT base_id,series_id,${candidate.hour},count(*)::bigint,sum(value),min(value),max(value),
     (array_agg(value ORDER BY ts DESC))[1],max(ts),now()
   FROM pulse.metric_samples
   WHERE base_id=${candidate.base_id}::uuid AND ts>=${candidate.hour} AND ts<${end}
   GROUP BY base_id,series_id
   ON CONFLICT(series_id,bucket) DO UPDATE SET sample_count=EXCLUDED.sample_count,value_sum=EXCLUDED.value_sum,
     value_min=EXCLUDED.value_min,value_max=EXCLUDED.value_max,last_value=EXCLUDED.last_value,last_ts=EXCLUDED.last_ts,updated_at=now()
 `;
    await tx`UPDATE pulse.metric_hours SET state='clean',updated_at=now() WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour}`;
    return { buckets: result.count ?? 0, done: false };
  });

export const sealExpiredMetricHour = async (baseId?: string): Promise<number> =>
  sql.begin(async (tx) => {
    const [candidate] = await tx<{ base_id: string; hour: Date }[]>`
   SELECT h.base_id,h.hour FROM pulse.metric_hours h JOIN pulse.bases b ON b.id=h.base_id
   WHERE h.state='clean' AND h.hour<date_bin('1 hour',now()-(b.retention_days*interval '1 day'),'1970-01-01'::timestamptz)
     AND (${baseId ?? null}::uuid IS NULL OR h.base_id=${baseId ?? null}::uuid)
     AND b.deletion_started_at IS NULL AND (b.data_clear_started_at IS NULL OR b.data_clear_completed_at IS NOT NULL)
   ORDER BY h.hour,h.base_id LIMIT 1
 `;
    if (!candidate) return 0;
    const active = await requireBaseActive(candidate.base_id, tx);
    if (!active.ok) return 0;
    const [claimed] =
      await tx`SELECT hour FROM pulse.metric_hours WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour} AND state='clean' AND hour<(SELECT date_bin('1 hour',now()-retention_days*interval '1 day','1970-01-01'::timestamptz) FROM pulse.bases WHERE id=${candidate.base_id}::uuid) FOR UPDATE`;
    if (!claimed) return 0;
    const result =
      await tx`UPDATE pulse.metric_hours SET state='sealed',updated_at=now() WHERE base_id=${candidate.base_id}::uuid AND hour=${candidate.hour}`;
    return result.count ?? 0;
  });
