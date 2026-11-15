import { sql } from "@k2b/cloud";
import { buildAccessPrincipalCondition, listAccessRecipientUserIds } from "@k2b/cloud/server";
import { type Grant, resolveEffectivePermission } from "./permission-resolver";

/** Candidate expansion uses the shared group policy; Grids' tier/deny rules decide the final permission. */
export async function listBaseManagers(input: { id: string; afterId?: string; userId?: string; limit: number }, signal: AbortSignal) {
  const [base] = await sql<{ id: string }[]>`SELECT id FROM grids.bases WHERE short_id=${input.id} AND deleted_at IS NULL`;
  if (!base) return [];
  const access = await sql<{ access_id: string }[]>`SELECT access_id FROM grids.base_access WHERE base_id=${base.id}::uuid`;
  const result: string[] = [];
  let afterId = input.afterId ?? "00000000-0000-0000-0000-000000000000";
  while (result.length < input.limit) {
    signal.throwIfAborted();
    const candidates = await listAccessRecipientUserIds({ accessIds: access.map((row) => row.access_id),
      afterId, userId: input.userId, limit: input.limit - result.length });
    if (!candidates.length) break;
    const projections = candidates.map((user) => {
      const principal = buildAccessPrincipalCondition({ subject: { type: "user", userId: user }, columns: {
        userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`, authenticatedOnly: sql`a.authenticated_only`,
      } });
      return sql`SELECT ${user}::uuid AS user_id,'base'::text AS "resourceType",${base.id}::uuid AS "resourceId",
        CASE WHEN a.user_id IS NOT NULL THEN 'user' WHEN a.group_id IS NOT NULL THEN 'group' ELSE 'authenticated' END AS "principalTier",
        a.permission AS level FROM grids.base_access ba JOIN auth.access a ON a.id=ba.access_id
        WHERE ba.base_id=${base.id}::uuid AND ${principal}`;
    });
    const query = projections.slice(1).reduce((all, part) => sql`${all} UNION ALL ${part}`, projections[0]!);
    const grants = await sql<(Grant & { user_id: string })[]>`${query}`;
    for (const user of candidates) if (resolveEffectivePermission(grants.filter((grant) => grant.user_id === user), { baseId: base.id }) === "admin") result.push(user);
    afterId = candidates.at(-1)!;
  }
  return result;
}
