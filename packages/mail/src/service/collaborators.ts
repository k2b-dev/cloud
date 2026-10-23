import { type AccessUser, listUsersWithAccess, recursiveServiceAccountGroupIdsSubquery } from "@k2b/cloud/server";
import { sql } from "bun";

type SqlClient = typeof sql;

const uniqueUserIds = (userIds: string[]): string[] => [...new Set(userIds)];

const activeUsers = async (db: SqlClient, userIds: string[]): Promise<Array<{ id: string; admin: boolean }>> => {
  const ids = uniqueUserIds(userIds);
  if (ids.length === 0) return [];
  return db<{ id: string; admin: boolean }[]>`
    SELECT id, admin
    FROM auth.users
    WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))
      AND (account_expires IS NULL OR account_expires > now())
  `;
};

/** The most users one access lookup returns (`listUsersWithAccess`). */
const ACCESS_LOOKUP_LIMIT = 500;

export const listCurrentMailboxUsers = async (params: {
  mailboxId: string;
  db?: SqlClient;
  userIds?: string[];
  minimumPermission?: "read" | "write" | "admin";
  search?: string;
  limit?: number;
}): Promise<AccessUser[]> => {
  const db = params.db ?? sql;
  const rows = await db<{ access_id: string }[]>`
    SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${params.mailboxId}::uuid
  `;
  const requestedLimit = Math.min(Math.max(params.limit ?? params.userIds?.length ?? 20, 1), ACCESS_LOOKUP_LIMIT);
  const users = await listUsersWithAccess({
    accessIds: rows.map((row) => row.access_id),
    userIds: params.userIds,
    minimumPermission: params.minimumPermission,
    search: params.search,
    limit: ACCESS_LOOKUP_LIMIT,
    db,
  });
  const activeUserIds = new Set(
    (
      await activeUsers(
        db,
        users.map((user) => user.id),
      )
    ).map((user) => user.id),
  );
  return users.filter((user) => activeUserIds.has(user.id)).slice(0, requestedLimit);
};

export const currentMailboxUserIds = async (params: {
  mailboxId: string;
  conversationId?: string;
  userIds: string[];
  minimumPermission: "read" | "write" | "admin";
  db?: SqlClient;
}): Promise<Set<string>> => {
  const db = params.db ?? sql;
  const active = await activeUsers(db, params.userIds);
  // Platform administration never substitutes for a mailbox grant. In particular, an
  // administrator with assigned-only access must not receive mailbox-wide workflow notices.
  const result = new Set<string>();
  const candidates = active.map((user) => user.id);
  if (candidates.length === 0) return result;
  const users = await listCurrentMailboxUsers({
    mailboxId: params.mailboxId,
    db,
    userIds: candidates,
    minimumPermission: params.minimumPermission,
    limit: candidates.length,
  });
  for (const user of users) result.add(user.id);
  if (params.conversationId && params.minimumPermission !== "admin") {
    const grants = await db<
      { access_id: string }[]
    >`SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${params.mailboxId}::uuid`;
    const assigned = await listUsersWithAccess({
      accessIds: grants.map((row) => row.access_id),
      userIds: candidates,
      minimumPermission: params.minimumPermission,
      limit: ACCESS_LOOKUP_LIMIT,
      db,
    });
    const assignees = await db<
      { user_id: string }[]
    >`SELECT user_id FROM mail.conversation_assignees WHERE conversation_id = ${params.conversationId}::uuid AND user_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${assigned.map((user) => user.id)}::jsonb))`;
    for (const assignee of assignees) result.add(assignee.user_id);
  }
  return result;
};

export const hasCurrentMailboxUserPermission = async (params: {
  mailboxId: string;
  userId: string;
  minimumPermission: "read" | "write" | "admin";
  db?: SqlClient;
}): Promise<boolean> => {
  const users = await currentMailboxUserIds({ ...params, userIds: [params.userId] });
  return users.has(params.userId);
};

export type EligibleAssignee = AccessUser & {
  type?: "user" | "service_account";
  serviceAccountKind?: "standalone" | "agent" | "resource_bound";
  scope: "mailbox" | "assigned";
};

export const listEligibleAssignees = async (params: {
  mailboxId: string;
  db?: SqlClient;
  userIds?: string[];
  search?: string;
  limit?: number;
}): Promise<EligibleAssignee[]> => {
  if (params.userIds?.length === 0) return [];
  const db = params.db ?? sql;
  const grants = await db<{ access_id: string; scope: "mailbox" | "assigned" }[]>`
    SELECT access_id, 'mailbox' AS scope FROM mail.mailbox_access WHERE mailbox_id = ${params.mailboxId}::uuid
    UNION ALL
    SELECT access_id, 'assigned' AS scope FROM mail.mailbox_assigned_access WHERE mailbox_id = ${params.mailboxId}::uuid
  `;
  const users = new Map<string, EligibleAssignee>();
  for (const scope of ["mailbox", "assigned"] as const) {
    const found = await listUsersWithAccess({
      accessIds: grants.filter((grant) => grant.scope === scope).map((grant) => grant.access_id),
      userIds: params.userIds,
      search: params.search,
      minimumPermission: scope === "mailbox" ? "write" : "read",
      limit: ACCESS_LOOKUP_LIMIT,
      db,
    });
    for (const user of found) if (!users.has(user.id)) users.set(user.id, { ...user, scope });
  }
  if (params.search) {
    const assignedIds = [...users.values()].filter((user) => user.scope === "assigned").map((user) => user.id);
    if (assignedIds.length > 0) {
      // Search may match only an assigned grant's group; scope still reflects all eligible grants.
      const mailboxUsers = await listUsersWithAccess({
        accessIds: grants.filter((grant) => grant.scope === "mailbox").map((grant) => grant.access_id),
        userIds: assignedIds,
        minimumPermission: "write",
        limit: ACCESS_LOOKUP_LIMIT,
        db,
      });
      for (const user of mailboxUsers) users.set(user.id, { ...user, scope: "mailbox" });
    }
  }
  // Only named direct/local-group recipients qualify, never public/authenticated audiences.
  const accounts = await db<EligibleAssignee[]>`
    WITH eligible_account_grants AS (
      SELECT account.id, account.name, account.kind, grants.scope, a.permission,
        a.service_account_id IS NOT NULL AS direct, g.id AS group_id,
        COALESCE(NULLIF(g.name, ''), g.cn) AS group_name
      FROM auth.service_accounts account
      JOIN auth.access a ON a.service_account_id = account.id
        OR a.group_id IN (${recursiveServiceAccountGroupIdsSubquery(sql`account.id`)})
      JOIN jsonb_to_recordset(${grants}::jsonb) AS grants(access_id uuid, scope text) ON grants.access_id = a.id
      LEFT JOIN auth.groups g ON g.id = a.group_id
      WHERE account.status = 'active'
        AND (account.kind IN ('standalone', 'agent') OR (account.kind = 'resource_bound'
          AND account.app_id = 'mail' AND account.resource_type = 'mailbox' AND account.resource_id = ${params.mailboxId}))
        AND (grants.scope = 'mailbox' AND a.permission IN ('write', 'admin')
          OR grants.scope = 'assigned' AND a.permission IN ('read', 'write'))
        AND (${params.userIds === undefined} OR account.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${params.userIds ?? []}::jsonb)))
    ), scoped_accounts AS (
      SELECT *, bool_or(direct) OVER (PARTITION BY id, scope) AS has_direct
      FROM eligible_account_grants
    )
    SELECT DISTINCT ON (account.id) account.id, account.name AS uid, account.name AS "displayName",
      NULL::text AS "avatarHash", 'service_account' AS type, account.kind AS "serviceAccountKind",
      account.scope, account.permission,
      CASE WHEN account.has_direct THEN jsonb_build_object('type', 'direct')
        ELSE jsonb_build_object('type', 'group', 'groupId', account.group_id, 'groupName', account.group_name)
      END AS source
    FROM scoped_accounts account
    WHERE ${!params.search?.trim()} OR account.id IN (
      SELECT id FROM eligible_account_grants
      WHERE position(lower(${params.search?.trim() ?? ""}) in lower(name)) > 0
        OR position(lower(${params.search?.trim() ?? ""}) in lower(group_name)) > 0
    )
    -- Search cannot lower mailbox-wide eligibility to assigned-only access.
    ORDER BY account.id, (account.scope = 'mailbox') DESC,
      CASE account.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END DESC,
      account.direct DESC, account.group_name, account.group_id
    LIMIT ${ACCESS_LOOKUP_LIMIT}
  `;
  const active = new Set((await activeUsers(db, [...users.keys()])).map((user) => user.id));
  for (const account of accounts) {
    users.set(account.id, account);
    active.add(account.id);
  }
  const limit = Math.min(Math.max(params.limit ?? params.userIds?.length ?? 50, 1), ACCESS_LOOKUP_LIMIT);
  return [...users.values()]
    .filter((user) => active.has(user.id))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .slice(0, limit);
};

export const currentEligibleAssigneeIds = async (params: { mailboxId: string; userIds: string[]; db?: SqlClient }): Promise<Set<string>> =>
  new Set((await listEligibleAssignees({ ...params, limit: params.userIds.length })).map((user) => user.id));

export type LapsedAssignee = { mailbox_id: string; user_id: string };

/** Views treat a conversation with no eligible assignee as unassigned, retaining its stored assignments. */
export const listLapsedAssignees = async (params: { mailboxIds: readonly string[]; db?: SqlClient }): Promise<LapsedAssignee[]> => {
  const db = params.db ?? sql;
  if (params.mailboxIds.length === 0) return [];
  const assigned = await db<LapsedAssignee[]>`
    SELECT DISTINCT c.mailbox_id, a.principal_id AS user_id
    FROM mail.conversations c
    JOIN mail.conversation_assignees a ON a.conversation_id = c.id
    WHERE c.mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(params.mailboxIds)]}::jsonb))
  `;
  const lapsed: LapsedAssignee[] = [];
  for (const [mailboxId, rows] of Map.groupBy(assigned, (row) => row.mailbox_id)) {
    for (let start = 0; start < rows.length; start += ACCESS_LOOKUP_LIMIT) {
      const batch = rows.slice(start, start + ACCESS_LOOKUP_LIMIT);
      const current = await currentEligibleAssigneeIds({ mailboxId, userIds: batch.map((row) => row.user_id), db });
      lapsed.push(...batch.filter((row) => !current.has(row.user_id)));
    }
  }
  return lapsed;
};

/**
 * Whether a conversation, `c` unless named otherwise, has no eligible assignee. The lapsed list is an
 * uncorrelated `NOT IN`, so PostgreSQL hashes it once instead of reading it again for every assignee.
 */
export const isUnassignedConversation = (lapsed: readonly LapsedAssignee[], c: Bun.SQL.Query<unknown> = sql`c`) => sql`NOT EXISTS (
  SELECT 1 FROM mail.conversation_assignees a
  WHERE a.conversation_id = ${c}.id
    AND (${c}.mailbox_id, a.principal_id) NOT IN (
      SELECT lapsed.mailbox_id, lapsed.user_id
      FROM jsonb_to_recordset(${lapsed}::jsonb) AS lapsed(mailbox_id uuid, user_id uuid)
    )
)`;
