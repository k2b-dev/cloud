import { sql } from "@k2b/cloud";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { NAV_BASES, NAV_DELETING_BASES, type PulseBaseNav, type PulseNav } from "../contracts";
import { type AccessScope, readableScopeFilter } from "./access-control";

type Row = {
  id: string;
  name: string;
  icon: string;
  color: string;
  store_failed: boolean;
  deleting: boolean;
  deletion_failed: boolean;
  current: boolean;
  rank: number;
};

const entry = (row: Row): PulseBaseNav => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  color: row.color,
  state: row.deleting ? (row.deletion_failed ? "deletion-failed" : "deleting") : row.store_failed ? "failed" : "ok",
});

/**
 * The bases a person reaches from the sidebar, in one statement: the first `NAV_BASES` they can read (newest change
 * first), the one they name as current even beyond that, and the bases they administer whose deletion still runs or
 * failed, so they can follow or resume it. `query` narrows by name, for the sidebar's search.
 */
export const baseNav = async (scope: AccessScope, params: { currentId?: string | null; query?: string | null } = {}): Promise<PulseNav> => {
  const visibility = readableScopeFilter(scope);
  if (!visibility) return { bases: [], more: false, deleting: [] };
  const principalMatch = buildAccessPrincipalCondition({
    subject: visibility.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const query = params.query?.trim() || null;
  const pattern = query ? `%${query.replace(/([\\%_])/g, "\\$1")}%` : null;
  const rows = await sql<Row[]>`
    WITH visible AS (
      SELECT ba.base_id, bool_or(a.permission = 'admin') AS admin
      FROM pulse.base_access ba
      JOIN auth.access a ON a.id = ba.access_id
      JOIN pulse.bases b ON b.id = ba.base_id
      WHERE ${principalMatch}
        AND a.permission <> 'none'
        AND (${visibility.boundBaseShortId}::text IS NULL OR b.short_id = ${visibility.boundBaseShortId})
      GROUP BY ba.base_id
    ), ranked AS (
      SELECT b.short_id AS id, b.name, b.icon, b.color,
        coalesce(s.state, 'failed') = 'failed' AS store_failed,
        b.deletion_started_at IS NOT NULL AS deleting,
        b.deletion_failed_at IS NOT NULL AS deletion_failed,
        b.short_id = ${params.currentId ?? null}::text AS current,
        row_number() OVER (
          PARTITION BY b.deletion_started_at IS NOT NULL ORDER BY b.updated_at DESC, b.name ASC, b.id ASC
        )::int AS rank
      FROM visible v
      JOIN pulse.bases b ON b.id = v.base_id
      LEFT JOIN pulse.base_stores s ON s.base_id = b.id
      WHERE (b.deletion_started_at IS NULL OR v.admin)
        AND (${pattern}::text IS NULL OR b.name ILIKE ${pattern} ESCAPE '\\')
    )
    SELECT * FROM ranked
    WHERE (NOT deleting AND (rank <= ${NAV_BASES + 2} OR current)) OR (deleting AND rank <= ${NAV_DELETING_BASES})
    ORDER BY deleting, rank
  `;
  // the first NAV_BASES and the current one show; one more row beyond them says the search reaches further
  const active = rows.filter((row) => !row.deleting);
  const shown = active.filter((row) => row.rank <= NAV_BASES || row.current);
  return {
    bases: shown.map(entry),
    more: active.length > shown.length,
    deleting: rows.filter((row) => row.deleting).map(entry),
  };
};
