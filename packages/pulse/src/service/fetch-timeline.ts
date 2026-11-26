import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { FETCH_BUCKET_MINUTES, FETCH_TICKS, type FetchesToday, type FetchMinute, type FetchSlot, SOURCE_HOUR_MINUTES } from "../contracts";
import { type AccessScope, requireBaseAccess } from "./access-control";
import { sqlAdmission } from "./sql-admission";

/**
 * The last `minutes` minutes of each given source's fetches, one slot per minute, oldest first: "ok" when every fetch
 * of that minute succeeded, "bad" when one failed, "none" when there was none, with the values those fetches brought.
 * One read for all given sources through the (source_id, started_at) index; the caller has required read access to
 * their base. Push sources record no fetches and get only empty minutes.
 */
export const fetchMinutes = async (sourceIds: readonly string[], now: Date, minutes: number): Promise<Map<string, FetchMinute[]>> => {
  if (sourceIds.length === 0) return new Map();
  const rows = await sql<{ source_id: string; ago: number; ok: boolean; values: number }[]>`
    SELECT source_id::text AS source_id,
      floor(extract(epoch FROM (${now}::timestamptz - started_at)) / 60)::int AS ago,
      bool_and(success) AS ok,
      sum(metrics_count + events_count + states_count)::int AS values
    FROM pulse.source_scrapes
    WHERE source_id = ANY(${sql.array([...sourceIds], "UUID")})
      AND started_at > ${now}::timestamptz - make_interval(mins => ${minutes})
      AND started_at <= ${now}::timestamptz
    GROUP BY 1, 2
  `;
  const result = new Map<string, FetchMinute[]>();
  for (const row of rows) {
    if (row.ago < 0 || row.ago >= minutes) continue;
    const slots = result.get(row.source_id) ?? Array.from({ length: minutes }, (): FetchMinute => ({ slot: "none", values: 0 }));
    slots[minutes - 1 - row.ago] = { slot: row.ok ? "ok" : "bad", values: row.values };
    result.set(row.source_id, slots);
  }
  return result;
};

/** The last FETCH_TICKS minutes of each metrics source's fetches, as the list shows them. */
export const fetchTicks = async (sourceIds: readonly string[], now: Date): Promise<Map<string, FetchSlot[]>> =>
  new Map([...(await fetchMinutes(sourceIds, now, FETCH_TICKS))].map(([id, minutes]) => [id, minutes.map((minute) => minute.slot)]));

/** One source's last SOURCE_HOUR_MINUTES minutes: values per minute and whether its fetches worked, for its detail. */
export const sourceHour = async (params: {
  baseId: string;
  sourceId: string;
  user: AccessScope;
  now?: Date;
}): Promise<Result<FetchMinute[]>> => {
  const access = await requireBaseAccess(params.baseId, params.user, "read");
  if (!access.ok) return fail(access.error);
  // the source must belong to the base the access was checked for
  const [source] = await sql<{ id: string }[]>`
    SELECT id FROM pulse.sources WHERE id = ${params.sourceId}::uuid AND base_id = ${params.baseId}::uuid AND NOT deleted`;
  if (!source) return fail(err.notFound("Source"));
  const minutes = await fetchMinutes([params.sourceId], params.now ?? new Date(), SOURCE_HOUR_MINUTES);
  return ok(minutes.get(params.sourceId) ?? Array.from({ length: SOURCE_HOUR_MINUTES }, (): FetchMinute => ({ slot: "none", values: 0 })));
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
