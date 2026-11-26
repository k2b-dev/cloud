import { sql } from "@k2b/cloud";
import { FETCH_BUCKET_MINUTES, FETCH_TICKS, type FetchesToday, type FetchSlot } from "../contracts";
import { sqlAdmission } from "./sql-admission";

/**
 * The last FETCH_TICKS minutes of each metrics source's fetches, one slot per minute, oldest first: "ok" when every
 * fetch of that minute succeeded, "bad" when one failed, "none" when there was none. One read for all given sources;
 * the caller has required read access to their base. Push sources record no fetches and get none.
 */
export const fetchTicks = async (sourceIds: readonly string[], now: Date): Promise<Map<string, FetchSlot[]>> => {
  if (sourceIds.length === 0) return new Map();
  const rows = await sql<{ source_id: string; ago: number; ok: boolean }[]>`
    SELECT source_id::text AS source_id,
      floor(extract(epoch FROM (${now}::timestamptz - started_at)) / 60)::int AS ago,
      bool_and(success) AS ok
    FROM pulse.source_scrapes
    WHERE source_id = ANY(${sql.array([...sourceIds], "UUID")})
      AND started_at > ${now}::timestamptz - make_interval(mins => ${FETCH_TICKS})
      AND started_at <= ${now}::timestamptz
    GROUP BY 1, 2
  `;
  const ticks = new Map<string, FetchSlot[]>();
  for (const row of rows) {
    if (row.ago < 0 || row.ago >= FETCH_TICKS) continue;
    const slots = ticks.get(row.source_id) ?? Array.from({ length: FETCH_TICKS }, (): FetchSlot => "none");
    slots[FETCH_TICKS - 1 - row.ago] = row.ok ? "ok" : "bad";
    ticks.set(row.source_id, slots);
  }
  return ticks;
};

/**
 * Today's fetches of a base's sources since midnight in its zone, in FETCH_BUCKET_MINUTES buckets, with how many
 * succeeded and failed. It reads by the sources' ids, so the (source_id, started_at) index carries it. The answer is
 * kept five minutes (like the values per source), so a base with many sources reads its day once per five minutes,
 * not on every refresh. The caller has required read access to the base.
 */
export const fetchesToday = async (baseId: string, sourceIds: readonly string[], timezone: string, now: Date): Promise<FetchesToday> => {
  const key = `fetches:${baseId}:${Math.floor(now.getTime() / 300_000)}`;
  const cached = await sqlAdmission.cached(key).catch(() => null);
  if (cached) {
    const value: unknown = JSON.parse(cached);
    if (isFetchesToday(value)) return value;
  }
  // the day's start joins every fetch, so a day without one still says how many buckets have passed
  const rows = await sql<{ bucket: number | null; ok: number; failed: number; buckets: number }[]>`
    WITH day AS (
      SELECT (date_trunc('day', ${now}::timestamptz AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS start
    )
    SELECT floor(extract(epoch FROM (s.started_at - day.start)) / ${FETCH_BUCKET_MINUTES * 60})::int AS bucket,
      count(*) FILTER (WHERE s.success)::int AS ok,
      count(*) FILTER (WHERE NOT s.success)::int AS failed,
      ceil(extract(epoch FROM (${now}::timestamptz - day.start)) / ${FETCH_BUCKET_MINUTES * 60})::int AS buckets
    FROM day
    LEFT JOIN pulse.source_scrapes s
      ON s.source_id = ANY(${sql.array([...sourceIds], "UUID")})
      AND s.started_at >= day.start AND s.started_at <= ${now}::timestamptz
    GROUP BY 1, day.start
  `;
  const length = Math.max(1, rows[0]?.buckets ?? 1);
  const buckets = Array.from({ length }, () => ({ ok: 0, failed: 0 }));
  for (const row of rows)
    if (row.bucket !== null && row.bucket >= 0 && row.bucket < length) buckets[row.bucket] = { ok: row.ok, failed: row.failed };
  const today: FetchesToday = {
    ok: buckets.reduce((sum, bucket) => sum + bucket.ok, 0),
    failed: buckets.reduce((sum, bucket) => sum + bucket.failed, 0),
    buckets,
  };
  await sqlAdmission.cache(key, JSON.stringify(today)).catch(() => {});
  return today;
};

const isFetchesToday = (value: unknown): value is FetchesToday =>
  typeof value === "object" &&
  value !== null &&
  "buckets" in value &&
  Array.isArray(value.buckets) &&
  "ok" in value &&
  typeof value.ok === "number" &&
  "failed" in value &&
  typeof value.failed === "number";
