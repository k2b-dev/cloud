import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";

/**
 * Connections are refresh token families: one per person and application that signed in with "stay connected"
 * (`offline_access`). Active means not revoked and not expired. Revoked families are removed a day after revocation
 * (`refresh-tokens.ts` cleanup), so a series of new connections per day counts the connections that still exist.
 */

/** Days a series covers, oldest first, ending today (in the database's day). */
export const CONNECTION_DAYS = 30;
/** A client counts as unused when nothing signed in or refreshed with it for this many days. */
export const UNUSED_AFTER_DAYS = 30;
/** People a client row shows as faces; the rest it counts. */
const FACES = 3;

export type ConnectionFigures = {
  /** Active connections across all clients. */
  active: number;
  /** Distinct people with an active connection. */
  people: number;
  /** Connections made in the last 7 days. */
  newLast7: number;
  /** New connections per day, oldest first, the last entry today. */
  perDay: number[];
  /** Clients that can keep connections but were not used for `UNUSED_AFTER_DAYS` days, by name. */
  unused: { count: number; names: string[] };
};

export type ClientConnections = {
  active: number;
  /** Distinct people with an active connection. */
  peopleCount: number;
  /** The people who used it last, at most three. */
  people: { name: string }[];
  /** New connections per day, oldest first. */
  perDay: number[];
  /** The last sign-in or refresh, ISO; null when it was never used. */
  lastUsedAt: string | null;
};

type FigureRow = { active: number; people: number; new_last_7: number; per_day: number[] };
type UnusedRow = { name: string; total: number };

/** The figures of all connections: one statement for the counts and the days, one for the unused clients. */
export const figures = async (): Promise<ConnectionFigures> => {
  const [[row], unused] = await Promise.all([
    sql<FigureRow[]>`
      WITH live AS (
        SELECT user_id FROM oauth.refresh_token_families WHERE status = 'active' AND expires_at > now()
      ), made AS (
        SELECT (current_date - created_at::date) AS age
        FROM oauth.refresh_token_families
        WHERE status <> 'reserved' AND created_at >= current_date - ${CONNECTION_DAYS - 1}::int
      )
      SELECT
        (SELECT count(*) FROM live)::int AS active,
        (SELECT count(DISTINCT user_id) FROM live)::int AS people,
        (SELECT count(*) FROM made WHERE age < 7)::int AS new_last_7,
        ARRAY(
          SELECT (SELECT count(*) FROM made WHERE made.age = day.age)::int
          FROM generate_series(${CONNECTION_DAYS - 1}::int, 0, -1) AS day(age)
        ) AS per_day
    `,
    // only clients that can keep a connection (they may ask for offline_access and act for people) can fall unused
    sql<UnusedRow[]>`
      SELECT c.name, count(*) OVER ()::int AS total
      FROM oauth.clients c
      LEFT JOIN LATERAL (
        SELECT max(COALESCE(f.last_used_at, f.created_at)) AS last
        FROM oauth.refresh_token_families f
        WHERE f.client_id = c.client_id AND f.status <> 'reserved'
      ) used ON true
      WHERE 'offline_access' = ANY(c.scopes)
        AND c.service_account_id IS NULL
        AND COALESCE(used.last, c.created_at) < now() - make_interval(days => ${UNUSED_AFTER_DAYS}::int)
      ORDER BY COALESCE(used.last, c.created_at)
      LIMIT 3
    `,
  ]);
  return {
    active: row?.active ?? 0,
    people: row?.people ?? 0,
    newLast7: row?.new_last_7 ?? 0,
    perDay: row?.per_day ?? Array.from({ length: CONNECTION_DAYS }, () => 0),
    unused: { count: unused[0]?.total ?? 0, names: unused.map((client) => client.name) },
  };
};

type ClientRow = {
  client_id: string;
  active: number;
  people_count: number;
  last_used_at: Date | null;
  people: string[] | null;
  per_day: number[];
};

/** The connections of a page of clients, by `client_id`, in one statement. */
export const forClients = async (clientIds: readonly string[]): Promise<Record<string, ClientConnections>> => {
  if (clientIds.length === 0) return {};
  const rows = await sql<ClientRow[]>`
    SELECT
      c.client_id,
      (SELECT count(*) FROM oauth.refresh_token_families f
        WHERE f.client_id = c.client_id AND f.status = 'active' AND f.expires_at > now())::int AS active,
      (SELECT count(DISTINCT f.user_id) FROM oauth.refresh_token_families f
        WHERE f.client_id = c.client_id AND f.status = 'active' AND f.expires_at > now())::int AS people_count,
      (SELECT max(COALESCE(f.last_used_at, f.created_at)) FROM oauth.refresh_token_families f
        WHERE f.client_id = c.client_id AND f.status <> 'reserved') AS last_used_at,
      ARRAY(
        SELECT COALESCE(NULLIF(u.display_name, ''), u.uid)
        FROM (
          SELECT f.user_id, max(COALESCE(f.last_used_at, f.created_at)) AS last
          FROM oauth.refresh_token_families f
          WHERE f.client_id = c.client_id AND f.status = 'active' AND f.expires_at > now()
          GROUP BY f.user_id
          ORDER BY last DESC
          LIMIT ${FACES}
        ) recent
        JOIN auth.users u ON u.id = recent.user_id
        ORDER BY recent.last DESC
      ) AS people,
      ARRAY(
        SELECT (
          SELECT count(*) FROM oauth.refresh_token_families f
          WHERE f.client_id = c.client_id AND f.status <> 'reserved' AND f.created_at::date = current_date - day.age
        )::int
        FROM generate_series(${CONNECTION_DAYS - 1}::int, 0, -1) AS day(age)
      ) AS per_day
    FROM unnest(${toPgTextArray([...clientIds])}::text[]) AS c(client_id)
  `;
  return Object.fromEntries(
    rows.map((row) => [
      row.client_id,
      {
        active: row.active,
        peopleCount: row.people_count,
        people: (row.people ?? []).map((name) => ({ name })),
        perDay: row.per_day,
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      },
    ]),
  );
};
