import { sql } from "@k2b/cloud";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { FETCH_TICKS, FETCHES_TODAY_SLOTS, type FetchesToday, type FetchMinute, type FetchSlot, SOURCE_HOUR_MINUTES } from "../contracts";
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
 * Today's fetches of a base's sources in FETCHES_TODAY_SLOTS half-hour slots of the day in its zone, with how many
 * succeeded and failed. One statement; the slot is the local hour and half hour, so a day with a clock change still
 * has 48 slots. It reads by the sources' ids, so the (source_id, started_at) index carries it. The answer is
 * kept five minutes (like the values per source), so a base with many sources reads its day once per five minutes,
 * not on every refresh. The caller has required read access to the base.
 */
export const fetchesToday = async (baseId: string, sourceIds: readonly string[], timezone: string, now: Date): Promise<FetchesToday> => {
  const key = `fetches-today:${baseId}:${Math.floor(now.getTime() / 300_000)}`;
  const cached = await sqlAdmission.cached(key).catch(() => null);
  if (cached) {
    const value: unknown = JSON.parse(cached);
    if (isFetchesToday(value)) return value;
  }
  // the tag names the statement for the SQL meter: one per page load, none while the answer is kept
  const rows = await sql<{ slot: number; ok: number; failed: number }[]>`
    /* pulse:fetches-today */
    WITH day AS (
      SELECT (date_trunc('day', ${now}::timestamptz AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS start
    )
    SELECT (extract(hour FROM s.started_at AT TIME ZONE ${timezone}) * 2
        + floor(extract(minute FROM s.started_at AT TIME ZONE ${timezone}) / 30))::int AS slot,
      count(*) FILTER (WHERE s.success)::int AS ok,
      count(*) FILTER (WHERE NOT s.success)::int AS failed
    FROM day
    JOIN pulse.source_scrapes s
      ON s.source_id = ANY(${sql.array([...sourceIds], "UUID")})
      AND s.started_at >= day.start AND s.started_at <= ${now}::timestamptz
    GROUP BY 1
  `;
  const slots = Array.from({ length: FETCHES_TODAY_SLOTS }, (): FetchSlot => "none");
  for (const row of rows)
    if (row.slot >= 0 && row.slot < FETCHES_TODAY_SLOTS) slots[row.slot] = row.failed > 0 ? "bad" : row.ok > 0 ? "ok" : "none";
  const today: FetchesToday = {
    ok: rows.reduce((sum, row) => sum + row.ok, 0),
    failed: rows.reduce((sum, row) => sum + row.failed, 0),
    slots,
  };
  await sqlAdmission.cache(key, JSON.stringify(today)).catch(() => {});
  return today;
};

const isFetchesToday = (value: unknown): value is FetchesToday =>
  typeof value === "object" &&
  value !== null &&
  "slots" in value &&
  Array.isArray(value.slots) &&
  value.slots.length === FETCHES_TODAY_SLOTS &&
  "ok" in value &&
  typeof value.ok === "number" &&
  "failed" in value &&
  typeof value.failed === "number";
