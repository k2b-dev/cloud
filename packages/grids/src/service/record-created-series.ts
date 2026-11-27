import { sql } from "@k2b/cloud";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { parseJsonbRow } from "./jsonb";

/** How many days a series covers by default, and at most: the longest window a table's head shows. */
export const RECORD_SERIES_DAYS = { default: 30, max: 90 } as const;

/** The live records of a table, and how many of them were created on each of the last days. */
export type RecordCreatedSeries = {
  /** Every live record of the table, now. */
  total: number;
  /** One point per calendar day of the viewer, oldest first, today last; a day without a new record counts 0. */
  points: Array<{ day: string; created: number }>;
};

/** The SQLSTATE of a Postgres error: Bun's driver carries it in `errno`. */
const sqlState = (error: unknown): unknown => (typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined);

/**
 * The record count of a stored table with its new records per day, in one statement. Days follow the viewer's
 * calendar (`timeZone`), so a day across a daylight-saving switch has 23 or 25 hours. A record that is in the bin
 * counts nowhere. The caller has checked that the viewer may read the table.
 */
export const getRecordCreatedSeries = async (
  tableId: string,
  options: {
    days?: number;
    timeZone?: string | null;
    /** The moment the series ends; the database's clock by default. A test pins it to a known day. */
    now?: Date;
  } = {},
): Promise<RecordCreatedSeries> => {
  const days = Math.min(Math.max(Math.trunc(options.days ?? RECORD_SERIES_DAYS.default), 1), RECORD_SERIES_DAYS.max);
  const read = async (timeZone: string) => {
    const now = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`now()`;
    const [row] = await sql<Array<{ total: number; points: unknown }>>`
      WITH bounds AS (
        SELECT (${now} AT TIME ZONE ${timeZone})::date - ${days - 1}::int AS first_day,
               (${now} AT TIME ZONE ${timeZone})::date AS last_day
      ),
      created AS (
        SELECT (r.created_at AT TIME ZONE ${timeZone})::date AS day, count(*)::int AS created
        FROM grids.records r, bounds
        WHERE r.table_id = ${tableId}::uuid
          AND r.deleted_at IS NULL
          AND r.created_at >= (bounds.first_day::timestamp AT TIME ZONE ${timeZone})
          AND r.created_at <= ${now}
        GROUP BY 1
      )
      SELECT (SELECT count(*)::int FROM grids.records WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL) AS total,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('day', to_char(g.at, 'YYYY-MM-DD'), 'created', COALESCE(c.created, 0))
                                        ORDER BY g.at)
                       FROM bounds
                       CROSS JOIN generate_series(bounds.first_day::timestamp, bounds.last_day::timestamp, interval '1 day') AS g(at)
                       LEFT JOIN created c ON c.day = g.at::date), '[]'::jsonb) AS points
    `;
    return row;
  };
  const timeZone = normalizeTimeZone(options.timeZone, "UTC");
  // Intl knows zones that Postgres does not (old links, zones newer than the server's tz data): rather than fail the
  // page, the series counts UTC days. Only this error spends a second statement.
  const row = await read(timeZone).catch((error: unknown) => {
    if (timeZone === "UTC" || sqlState(error) !== "22023") throw error;
    return read("UTC");
  });
  return { total: row?.total ?? 0, points: parseJsonbRow<RecordCreatedSeries["points"]>(row?.points, []) };
};
