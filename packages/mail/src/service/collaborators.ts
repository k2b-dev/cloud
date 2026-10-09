import { type AccessUser, listUsersWithAccess } from "@k2b/cloud/server";
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

export type EligibleAssignee = AccessUser & { scope: "mailbox" | "assigned" };

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
  const active = new Set((await activeUsers(db, [...users.keys()])).map((user) => user.id));
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
    SELECT DISTINCT c.mailbox_id, a.user_id
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

/** Whether a conversation, `c` unless named otherwise, has no eligible assignee. */
export const isUnassignedConversation = (lapsed: readonly LapsedAssignee[], c: Bun.SQL.Query<unknown> = sql`c`) => sql`NOT EXISTS (
  SELECT 1 FROM mail.conversation_assignees a
  WHERE a.conversation_id = ${c}.id
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(${lapsed}::jsonb) AS lapsed(mailbox_id uuid, user_id uuid)
      WHERE lapsed.mailbox_id = ${c}.mailbox_id AND lapsed.user_id = a.user_id
    )
)`;
