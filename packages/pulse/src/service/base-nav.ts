import { sql } from "@k2b/cloud";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { NAV_BASES, type PulseBaseNav, type PulseNav } from "../contracts";
import { type AccessScope, readableScopeFilter } from "./access-control";

type Row = { id: string; name: string; icon: string; color: string; store_failed: boolean; current: boolean; rank: number };

const entry = (row: Row): PulseBaseNav => ({
  id: row.id,
  name: row.name,
  icon: row.icon,
  color: row.color,
  state: row.store_failed ? "failed" : "ok",
});

/**
 * The bases a person reaches from the sidebar, in one statement: the first `NAV_BASES` they can read (newest change
 * first) and the one they name as current even beyond that. It reads the same grants, binding and scope as every
 * other read (`readableScopeFilter`); a base whose deletion started is not a place any more.
 */
export const baseNav = async (scope: AccessScope, params: { currentId?: string | null } = {}): Promise<PulseNav> => {
  const visibility = readableScopeFilter(scope);
  if (!visibility) return { bases: [], more: false };
  const principalMatch = buildAccessPrincipalCondition({
    subject: visibility.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const rows = await sql<Row[]>`
    WITH visible AS (
      SELECT DISTINCT ba.base_id
      FROM pulse.base_access ba
      JOIN auth.access a ON a.id = ba.access_id
      JOIN pulse.bases b ON b.id = ba.base_id
      WHERE ${principalMatch}
        AND a.permission <> 'none'
        AND (${visibility.boundBaseShortId}::text IS NULL OR b.short_id = ${visibility.boundBaseShortId})
    ), ranked AS (
      SELECT b.short_id AS id, b.name, b.icon, b.color,
        coalesce(s.state, 'failed') = 'failed' AS store_failed,
        b.short_id = ${params.currentId ?? null}::text AS current,
        row_number() OVER (ORDER BY b.updated_at DESC, b.name ASC, b.id ASC)::int AS rank
      FROM visible v
      JOIN pulse.bases b ON b.id = v.base_id
      LEFT JOIN pulse.base_stores s ON s.base_id = b.id
      WHERE b.deletion_started_at IS NULL
    )
    SELECT * FROM ranked
    WHERE rank <= ${NAV_BASES + 1} OR current
    ORDER BY rank
  `;
  // the first NAV_BASES and the current one show; one more row beyond them says there are more
  const shown = rows.filter((row) => row.rank <= NAV_BASES || row.current);
  return { bases: shown.map(entry), more: rows.length > shown.length };
};
