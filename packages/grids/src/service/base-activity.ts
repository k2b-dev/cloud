import { sql } from "@k2b/cloud";
import { toPgUuidArray } from "@k2b/cloud/services";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { parseJsonbRow } from "./jsonb";

/** The days a base home charts: two weeks, today last. */
export const BASE_ACTIVITY_DAYS = 14;
/** The last changed records a base home names. */
export const BASE_RECENT_CHANGES = 6;
/** The tables that carry their own series; beyond them a table shows its count only, so the page stays bounded. */
export const BASE_TABLE_SERIES_LIMIT = 200;

/** A record that changed last, with who changed it. */
export type BaseRecentChange = {
  tableId: string;
  recordShortId: string;
  /** The value of the table's first presentable text field, when it has one. */
  title: string | null;
  updatedAt: string;
  user: { id: string; name: string | null; avatarHash: string | null } | null;
};

/** What happens in a base: its records, new ones per day, the exceptions, and who changed what last. */
export type BaseActivity = {
  /** Live records of the readable tables. */
  total: number;
  /** New records per calendar day of the viewer, oldest first, today last. */
  points: number[];
  /** Per readable table (internal id): its live records and, for the first tables, new ones per day. */
  tables: Record<string, { total: number; points: number[] | null }>;
  /** Finalizations that wait for a decision in the readable tables. */
  pendingFinalizations: number;
  /** Runs of the readable workflows that failed or need attention in the last 24 hours. */
  failedRuns24h: number;
  recent: BaseRecentChange[];
};

/** The SQLSTATE of a Postgres error: Bun's driver carries it in `errno`. */
const sqlState = (error: unknown): unknown => (typeof error === "object" && error !== null && "errno" in error ? error.errno : undefined);

type CountsRow = { tables: unknown; points: unknown; pending: number; failed: number };
type RecentRow = {
  table_id: string;
  short_id: string;
  title: string | null;
  updated_at: Date;
  user_id: string | null;
  user_name: string | null;
  user_avatar_hash: string | null;
};

/**
 * The activity of a base for its home, in two statements: counts, series and exceptions in one, the last changed
 * records in the other. The caller passes only the stored tables and the workflows the viewer may read; days follow the
 * viewer's calendar, as the records-per-day series of a table does.
 */
export const getBaseActivity = async (
  baseId: string,
  tableIds: readonly string[],
  workflowIds: readonly string[],
  options: { timeZone?: string | null; now?: Date } = {},
): Promise<BaseActivity> => {
  const empty: BaseActivity = {
    total: 0,
    points: Array.from({ length: BASE_ACTIVITY_DAYS }, () => 0),
    tables: {},
    pendingFinalizations: 0,
    failedRuns24h: 0,
    recent: [],
  };
  if (tableIds.length === 0 && workflowIds.length === 0) return empty;
  const tables = toPgUuidArray([...tableIds]);
  const series = toPgUuidArray(tableIds.slice(0, BASE_TABLE_SERIES_LIMIT));
  const workflows = toPgUuidArray([...workflowIds]);
  const now = options.now ? sql`${options.now.toISOString()}::timestamptz` : sql`now()`;
  const counts = (timeZone: string) => sql<CountsRow[]>`
    WITH bounds AS (
      SELECT (${now} AT TIME ZONE ${timeZone})::date - ${BASE_ACTIVITY_DAYS - 1}::int AS first_day,
             (${now} AT TIME ZONE ${timeZone})::date AS last_day
    ),
    days AS (
      SELECT g.at::date AS day
      FROM bounds CROSS JOIN generate_series(bounds.first_day::timestamp, bounds.last_day::timestamp, interval '1 day') AS g(at)
    ),
    totals AS (
      SELECT r.table_id, count(*)::int AS n
      FROM grids.records r
      WHERE r.table_id = ANY(${tables}::uuid[]) AND r.deleted_at IS NULL
      GROUP BY r.table_id
    ),
    created AS (
      SELECT r.table_id, (r.created_at AT TIME ZONE ${timeZone})::date AS day, count(*)::int AS n
      FROM grids.records r, bounds
      WHERE r.table_id = ANY(${series}::uuid[])
        AND r.deleted_at IS NULL
        AND r.created_at >= (bounds.first_day::timestamp AT TIME ZONE ${timeZone})
        AND r.created_at <= ${now}
      GROUP BY 1, 2
    ),
    created_all AS (
      SELECT (r.created_at AT TIME ZONE ${timeZone})::date AS day, count(*)::int AS n
      FROM grids.records r, bounds
      WHERE r.table_id = ANY(${tables}::uuid[])
        AND r.deleted_at IS NULL
        AND r.created_at >= (bounds.first_day::timestamp AT TIME ZONE ${timeZone})
        AND r.created_at <= ${now}
      GROUP BY 1
    )
    SELECT
      COALESCE((SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY d.day) FROM days d LEFT JOIN created_all c ON c.day = d.day),
               '[]'::jsonb) AS points,
      COALESCE((
        SELECT jsonb_object_agg(s.table_id::text, jsonb_build_object(
                 'total', COALESCE(t.n, 0),
                 'points', CASE WHEN s.table_id = ANY(${series}::uuid[])
                   THEN (SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY d.day) FROM days d
                         LEFT JOIN created c ON c.table_id = s.table_id AND c.day = d.day)
                   ELSE NULL END))
        FROM unnest(${tables}::uuid[]) AS s(table_id)
        LEFT JOIN totals t ON t.table_id = s.table_id
      ), '{}'::jsonb) AS tables,
      (SELECT count(*)::int FROM grids.record_finalization_requests q
        WHERE q.table_id = ANY(${tables}::uuid[]) AND q.status = 'pending') AS pending,
      (SELECT count(*)::int FROM workflows.run w
        WHERE w.app_id = 'grids' AND w.scope_id = ${baseId} AND w.workflow_id = ANY(${workflows}::uuid[])
          AND w.mode = 'execute' AND w.state IN ('failed', 'needs_attention')
          AND w.created_at >= ${now} - interval '24 hours' AND w.created_at <= ${now}) AS failed
  `;
  const timeZone = normalizeTimeZone(options.timeZone, "UTC");
  // As for a table's series: a zone Intl knows but Postgres does not counts UTC days, with a second statement.
  const [row] = await counts(timeZone).catch((error: unknown) => {
    if (timeZone === "UTC" || sqlState(error) !== "22023") throw error;
    return counts("UTC");
  });
  const recent =
    tableIds.length === 0
      ? []
      : await sql<RecentRow[]>`
          SELECT r.table_id::text AS table_id, r.short_id, r.updated_at, r.updated_by::text AS user_id,
                 u.display_name AS user_name, u.avatar_hash AS user_avatar_hash,
                 CASE WHEN pf.id IS NULL THEN NULL ELSE left(r.data->>(pf.id::text), 200) END AS title
          FROM unnest(${tables}::uuid[]) AS s(table_id)
          CROSS JOIN LATERAL (
            SELECT id, table_id, short_id, updated_at, updated_by, data FROM grids.records
            WHERE table_id = s.table_id AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ${BASE_RECENT_CHANGES}
          ) r
          LEFT JOIN auth.users u ON u.id = r.updated_by
          LEFT JOIN LATERAL (
            SELECT f.id FROM grids.fields f
            WHERE f.table_id = r.table_id AND f.presentable AND f.deleted_at IS NULL AND f.type IN ('text', 'id')
            ORDER BY f.position
            LIMIT 1
          ) pf ON TRUE
          ORDER BY r.updated_at DESC
          LIMIT ${BASE_RECENT_CHANGES}
        `;
  const perTable = parseJsonbRow<BaseActivity["tables"]>(row?.tables, {});
  const points = parseJsonbRow<number[]>(row?.points, empty.points);
  return {
    total: Object.values(perTable).reduce((sum, table) => sum + table.total, 0),
    points,
    tables: perTable,
    pendingFinalizations: row?.pending ?? 0,
    failedRuns24h: row?.failed ?? 0,
    recent: recent.map((each) => ({
      tableId: each.table_id,
      recordShortId: each.short_id,
      title: each.title,
      updatedAt: each.updated_at.toISOString(),
      user: each.user_id ? { id: each.user_id, name: each.user_name, avatarHash: each.user_avatar_hash } : null,
    })),
  };
};
