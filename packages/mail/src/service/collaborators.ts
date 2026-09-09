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
