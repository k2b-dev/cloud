import { sql } from "@k2b/cloud";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { NAV_BASES, NAV_DELETING_BASES, type PulseBaseNav, type PulseNav } from "../contracts";
import { type AccessScope, canRequestPermission, readableScopeFilter } from "./access-control";

type Row = { id: string; name: string; icon: string; color: string; store_failed: boolean; deleting: boolean; current: boolean };

const entry = (row: Row): PulseBaseNav => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  color: row.color,
  // a deletion that stopped waits for its retry, which a failed store allows
  state: row.deleting ? (row.store_failed ? "deletion-failed" : "deleting") : row.store_failed ? "failed" : "ok",
});

/**
 * The bases a person reaches from the sidebar, in one statement: the first `NAV_BASES` they can read (newest change
 * first), the one they name as current even beyond that, and the first `NAV_DELETING_BASES` they administer whose
 * deletion still runs or failed, so they can follow or resume it there. A base whose deletion started is no place for
 * anyone else. `query` narrows both by name, for the sidebar's search. It reads the same grants, binding and scope as
 * every other read (`readableScopeFilter`); the deleting ones also need a scope that may administer.
 */
export const baseNav = async (scope: AccessScope, params: { currentId?: string | null; query?: string | null } = {}): Promise<PulseNav> => {
  const visibility = readableScopeFilter(scope);
  if (!visibility) return { bases: [], deleting: [] };
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
        b.short_id = ${params.currentId ?? null}::text AS current,
        row_number() OVER (
          PARTITION BY b.deletion_started_at IS NOT NULL ORDER BY b.updated_at DESC, b.name ASC, b.id ASC
        )::int AS rank
      FROM visible v
      JOIN pulse.bases b ON b.id = v.base_id
      LEFT JOIN pulse.base_stores s ON s.base_id = b.id
      WHERE (b.deletion_started_at IS NULL OR (${canRequestPermission(scope, "admin")}::boolean AND v.admin))
        AND (${pattern}::text IS NULL OR b.name ILIKE ${pattern} ESCAPE '\\')
    )
    SELECT id, name, icon, color, store_failed, deleting, current FROM ranked
    WHERE rank <= CASE WHEN deleting THEN ${NAV_DELETING_BASES}::int ELSE ${NAV_BASES}::int END OR current
    ORDER BY deleting, rank
  `;
  return { bases: rows.filter((row) => !row.deleting).map(entry), deleting: rows.filter((row) => row.deleting).map(entry) };
};
