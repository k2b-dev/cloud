import { sql } from "@k2b/cloud";
import { listResourceManagers } from "@k2b/cloud/capabilities/server";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { resolveResourceReaders } from "@k2b/cloud/services/identity";
import type { SQL } from "bun";

export type CodeManagerCandidate = {
  version_id: string;
  user_id: string | null;
  code_id: string;
  owner_kind: string;
  owner_user_id: string | null;
  owner_app_id: string | null;
  owner_type: string | null;
  owner_id: string | null;
};

/** Current account and management grants as data. One SQL projection for the whole delivery batch.
 * External owner checks use the existing app workload identity, never a recipient's synthetic session. */
export async function currentChatManagers(
  rows: readonly CodeManagerCandidate[],
  signal: AbortSignal,
  db: SQL = sql,
  resourceManagers?: ReadonlySet<string>,
): Promise<Set<string>> {
  const readers = await resolveResourceReaders(
    [...new Set(rows.flatMap((row) => (row.user_id ? [row.user_id] : [])))].map((userId) => ({ type: "user" as const, userId })),
  );
  const users = await db<{ id: string }[]>`SELECT id FROM auth.users WHERE id=ANY(${sql.array(
    readers.flatMap((reader) => (reader.subject.type === "user" ? [reader.subject.userId] : [])),
    "uuid",
  )}) AND profile='user'`;
  const active = new Set(users.map((user) => user.id));
  const candidates = rows.filter((row) => row.user_id && active.has(row.user_id));
  if (!candidates.length) return new Set();
  const projections = candidates.map((row) => {
    const principal = buildAccessPrincipalCondition({
      subject: { type: "user", userId: row.user_id! },
      columns: {
        userId: sql`a.user_id`,
        groupId: sql`a.group_id`,
        serviceAccountId: sql`a.service_account_id`,
        authenticatedOnly: sql`a.authenticated_only`,
      },
    });
    return sql`SELECT ${row.version_id}::uuid AS version_id, (
      ${row.owner_kind === "person" && row.owner_user_id === row.user_id}
      OR EXISTS(SELECT 1 FROM code.shares s JOIN auth.access a ON a.id=s.access_id
        WHERE s.code_id=${row.code_id} AND a.permission IN ('write','admin') AND ${principal})
      OR (${row.owner_kind === "app"} AND EXISTS(SELECT 1 FROM auth.app_access s JOIN auth.access a ON a.id=s.access_id
        WHERE s.app_id=${row.owner_app_id} AND a.permission='admin' AND ${principal}))
    ) AS allowed`;
  });
  const query = projections.slice(1).reduce((all, part) => sql`${all} UNION ALL ${part}`, projections[0]!);
  const local = await db<{ version_id: string; allowed: boolean }[]>`${query}`;
  const allowed = new Set(local.filter((row) => row.allowed).map((row) => row.version_id));
  // Collapse repeated decisions for the same owner/person to one bounded provider read.
  const external = new Map<string, Promise<string[]>>();
  for (const row of candidates) {
    if (allowed.has(row.version_id) || row.owner_kind !== "resource" || !row.owner_type || !row.owner_id) continue;
    if (resourceManagers) {
      if (resourceManagers.has(row.version_id)) allowed.add(row.version_id);
      continue;
    }
    const key = JSON.stringify([row.owner_type, row.owner_id, row.user_id]);
    let check = external.get(key);
    if (!check) {
      check = listResourceManagers({ ref: { type: row.owner_type, id: row.owner_id }, userId: row.user_id!, limit: 1, signal });
      external.set(key, check);
    }
    try {
      if ((await check).includes(row.user_id!)) allowed.add(row.version_id);
    } catch {
      signal.throwIfAborted(); /* An unavailable owner yields no current management grant. */
    }
  }
  return allowed;
}
