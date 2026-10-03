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
  const requestedLimit = Math.min(Math.max(params.limit ?? params.userIds?.length ?? 20, 1), 500);
  const users = await listUsersWithAccess({
    accessIds: rows.map((row) => row.access_id),
    userIds: params.userIds,
    minimumPermission: params.minimumPermission,
    search: params.search,
    limit: 500,
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
  userIds: string[];
  minimumPermission: "read" | "write" | "admin";
  db?: SqlClient;
}): Promise<Set<string>> => {
  const db = params.db ?? sql;
  const active = await activeUsers(db, params.userIds);
  const result = new Set(active.filter((user) => user.admin).map((user) => user.id));
  const candidates = active.filter((user) => !user.admin).map((user) => user.id);
  if (candidates.length === 0) return result;
  const users = await listCurrentMailboxUsers({
    mailboxId: params.mailboxId,
    db,
    userIds: candidates,
    minimumPermission: params.minimumPermission,
    limit: candidates.length,
  });
  for (const user of users) result.add(user.id);
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

export type LapsedAssignee = { mailbox_id: string; user_id: string };

/**
 * Assignees of open conversations in these mailboxes who no longer have write access there, for
 * example because their access was revoked or their account expired. Views and counts treat their
 * conversations as unassigned so the team still finds them; the conversation keeps its assignee.
 */
export const listLapsedAssignees = async (params: { mailboxIds: readonly string[]; db?: SqlClient }): Promise<LapsedAssignee[]> => {
  const db = params.db ?? sql;
  if (params.mailboxIds.length === 0) return [];
  const assigned = await db<LapsedAssignee[]>`
    SELECT DISTINCT mailbox_id, assignee_user_id AS user_id
    FROM mail.conversations
    WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(params.mailboxIds)]}::jsonb))
      AND assignee_user_id IS NOT NULL
      AND work_status <> 'done'
  `;
  const byMailbox = Map.groupBy(assigned, (row) => row.mailbox_id);
  const lapsed: LapsedAssignee[] = [];
  for (const [mailboxId, rows] of byMailbox) {
    const current = await currentMailboxUserIds({
      mailboxId,
      userIds: rows.map((row) => row.user_id),
      minimumPermission: "write",
      db,
    });
    lapsed.push(...rows.filter((row) => !current.has(row.user_id)));
  }
  return lapsed;
};

/** Whether a conversation (`c`) has no assignee who can still work on it. */
export const isUnassignedConversation = (lapsed: readonly LapsedAssignee[]) => sql`(
  c.assignee_user_id IS NULL
  OR (c.mailbox_id, c.assignee_user_id) IN (
    SELECT lapsed.mailbox_id, lapsed.user_id
    FROM jsonb_to_recordset(${lapsed}::jsonb) AS lapsed(mailbox_id uuid, user_id uuid)
  )
)`;
