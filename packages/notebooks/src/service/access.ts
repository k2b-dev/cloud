import { hasRole } from "@k2b/cloud/contracts";
import {
  type AccessEntry,
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  ensureManagerRemains,
  getEffectivePermission,
  type PermissionLevel,
  type Principal,
  type RequestActor,
  updateAccess,
} from "@k2b/cloud/server";
import {
  isStandaloneServiceAccountKind,
  type ServiceAccountCredential,
  type ServiceAccountKind,
  serviceAccountCredentials,
  serviceAccounts,
} from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { resolveNotebookApiKeyPermission } from "./api-key-permissions";
import { invalidated } from "./workspace-events";

// ==========================
// Notebook Access Adapter
// ==========================

type DbNotebookAccess = {
  access_id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date;
  user_display_name: string | null;
  user_uid: string | null;
  user_avatar_hash: string | null;
  group_name: string | null;
  service_account_name: string | null;
  service_account_kind: ServiceAccountKind | null;
};

export const NOTEBOOKS_APP_ID = "notebooks";
export const NOTEBOOK_RESOURCE_TYPE = "notebook";

export type NotebookApiKey = ServiceAccountCredential & {
  permission: PermissionLevel;
};

/** Request callers are reauthorized after acquiring the resource lock. Omitted only by trusted initialization/key/adapter paths. */
export type NotebookAccessCaller = {
  actor: RequestActor;
  accessSubject: AccessSubject;
  locale?: string;
};

const authorizeAccessMutation = async (
  notebookId: string,
  entries: AccessEntry[],
  caller: NotebookAccessCaller | undefined,
  db: SQL,
): Promise<boolean> => {
  if (!caller) return true;
  const user = caller.actor.kind === "user" ? caller.actor.user : caller.actor.delegatedUser;
  if (user && hasRole(user, "admin")) return true;
  const account = caller.actor.kind === "service_account" ? caller.actor.serviceAccount : null;
  if (
    account?.kind === "resource_bound" &&
    (account.appId !== NOTEBOOKS_APP_ID || account.resourceType !== NOTEBOOK_RESOURCE_TYPE || account.resourceId !== notebookId)
  )
    return false;
  let permission = await getEffectivePermission({ accessIds: entries.map((entry) => entry.id), subject: caller.accessSubject }, db);
  if (caller.actor.kind === "service_account" && account?.kind !== "user_delegated") {
    permission = resolveNotebookApiKeyPermission(permission, caller.actor.scopes);
  }
  return permission === "admin";
};

/**
 * Reads across Notebooks. A resource-bound service account must pass its bound
 * Notebook; a standalone or agent account is limited only by its own grants.
 * The kind is read from the account row, so a caller that omits a binding
 * fails closed.
 */
export const mayReadAcrossNotebooks = async (params: {
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
}): Promise<boolean> => {
  if (!params.serviceAccountId || params.boundNotebookId) return true;
  const account = await serviceAccounts.get({ id: params.serviceAccountId });
  return Boolean(account && isStandaloneServiceAccountKind(account.kind));
};

export const buildNotebookVisibleAccessCondition = (params: { userId?: string | null; serviceAccountId?: string | null }) => {
  const subject: AccessSubject | null = params.userId
    ? { type: "user", userId: params.userId }
    : params.serviceAccountId
      ? { type: "service_account", serviceAccountId: params.serviceAccountId }
      : null;
  const principalMatch = buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  return sql`${principalMatch} AND a.permission <> 'none'`;
};

const mapAccessRow = (row: DbNotebookAccess): AccessEntry => {
  const principal: AccessEntry["principal"] = row.user_id
    ? { type: "user", userId: row.user_id }
    : row.group_id
      ? { type: "group", groupId: row.group_id }
      : row.service_account_id
        ? { type: "service_account", serviceAccountId: row.service_account_id }
        : row.authenticated_only
          ? { type: "authenticated" }
          : { type: "public" };

  const displayName =
    principal.type === "user"
      ? row.user_display_name || row.user_uid || undefined
      : principal.type === "group"
        ? row.group_name || undefined
        : principal.type === "service_account"
          ? row.service_account_name || undefined
          : undefined;

  return {
    id: row.access_id,
    principal,
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
    displayName,
    ...(principal.type === "user" ? { avatarHash: row.user_avatar_hash } : {}),
    serviceAccountKind: row.service_account_kind ?? undefined,
  };
};

/**
 * List all access entries for a notebook with resolved display names.
 */
export const listNotebookAccess = async (notebookId: string, db: SQL = sql): Promise<AccessEntry[]> => {
  const result = await listNotebookAccessPage({ notebookId }, db);
  return result.items;
};

/**
 * List access entries with SQL-side filtering and pagination.
 */
export const listNotebookAccessPage = async (
  config: {
    notebookId: string;
    query?: string;
    principalType?: AccessEntry["principal"]["type"];
    pagination?: { limit: number; offset: number };
  },
  db: SQL = sql,
): Promise<{ items: AccessEntry[]; total: number }> => {
  const query = config.query?.trim().toLowerCase();
  const pattern = query && query.length > 0 ? `%${query}%` : null;
  const principalType = config.principalType;
  const principalCondition =
    principalType === undefined
      ? sql`true`
      : principalType === "user"
        ? sql`a.user_id IS NOT NULL`
        : principalType === "group"
          ? sql`a.group_id IS NOT NULL`
          : principalType === "service_account"
            ? sql`a.service_account_id IS NOT NULL`
            : principalType === "authenticated"
              ? sql`a.authenticated_only = true`
              : sql`a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND a.authenticated_only = false`;

  const baseQuery = sql`
    FROM notebooks.notebook_access na
    JOIN auth.access a ON na.access_id = a.id
    LEFT JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN auth.groups g ON g.id = a.group_id
    LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
    WHERE na.notebook_id = ${config.notebookId}::uuid
      AND ${principalCondition}
      AND (
        ${pattern}::text IS NULL
        OR LOWER(COALESCE(u.display_name, u.uid, '')) LIKE ${pattern}
        OR LOWER(COALESCE(g.name, '')) LIKE ${pattern}
        OR LOWER(COALESCE(sa.name, '')) LIKE ${pattern}
        OR LOWER(COALESCE(a.user_id::text, '')) LIKE ${pattern}
        OR LOWER(COALESCE(a.service_account_id::text, '')) LIKE ${pattern}
        OR (a.authenticated_only = true AND 'all users incl guests authenticated' LIKE ${pattern})
        OR (
          a.user_id IS NULL
          AND a.group_id IS NULL
          AND a.service_account_id IS NULL
          AND a.authenticated_only = false
          AND 'public' LIKE ${pattern}
        )
      )
  `;

  const rows =
    config.pagination === undefined
      ? await db<DbNotebookAccess[]>`
          SELECT
            a.id as access_id,
            a.user_id,
            a.group_id,
            a.service_account_id,
            a.authenticated_only,
            a.permission,
            a.created_at,
            u.display_name AS user_display_name,
            u.uid AS user_uid,
            u.avatar_hash AS user_avatar_hash,
            g.name AS group_name,
            sa.name AS service_account_name,
            sa.kind AS service_account_kind
          ${baseQuery}
          ORDER BY
            CASE
              WHEN a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND a.authenticated_only = false THEN 4
              WHEN a.authenticated_only THEN 3
              WHEN a.group_id IS NOT NULL THEN 2
              WHEN a.service_account_id IS NOT NULL THEN 2
              ELSE 1
            END,
            a.created_at
        `
      : await db<DbNotebookAccess[]>`
          SELECT
            a.id as access_id,
            a.user_id,
            a.group_id,
            a.service_account_id,
            a.authenticated_only,
            a.permission,
            a.created_at,
            u.display_name AS user_display_name,
            u.uid AS user_uid,
            u.avatar_hash AS user_avatar_hash,
            g.name AS group_name,
            sa.name AS service_account_name,
            sa.kind AS service_account_kind
          ${baseQuery}
          ORDER BY
            CASE
              WHEN a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND a.authenticated_only = false THEN 4
              WHEN a.authenticated_only THEN 3
              WHEN a.group_id IS NOT NULL THEN 2
              WHEN a.service_account_id IS NOT NULL THEN 2
              ELSE 1
            END,
            a.created_at
          LIMIT ${config.pagination.limit}
          OFFSET ${config.pagination.offset}
        `;

  const [countRow] = await db<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    ${baseQuery}
  `;

  return {
    items: rows.map(mapAccessRow),
    total: countRow?.count ?? 0,
  };
};

/**
 * Add an access entry to a notebook.
 */
export const addNotebookAccess = async (notebookId: string, accessId: string): Promise<Result<void>> => {
  try {
    await sql`
      INSERT INTO notebooks.notebook_access (notebook_id, access_id)
      VALUES (${notebookId}::uuid, ${accessId}::uuid)
    `;
    await invalidated({ notebookId, reason: "permissions", scopes: ["permissions"] });
    return ok();
  } catch (e: unknown) {
    const error = e as { code?: string };
    if (error.code === "23505") {
      return fail(err.conflict("Access entry"));
    }
    if (error.code === "23503") {
      return fail(err.notFound("Notebook or access entry"));
    }
    throw e;
  }
};

/**
 * Remove an access entry from a notebook.
 * Also deletes the auth.access entry (CASCADE will handle junction).
 */
export const removeNotebookAccess = (notebookId: string, accessId: string): Promise<Result<void>> =>
  revokeNotebookAccess({ notebookId, accessId });

/**
 * Count access entries for a notebook.
 */
export const countNotebookAccess = async (notebookId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count
    FROM notebooks.notebook_access
    WHERE notebook_id = ${notebookId}::uuid
  `;
  return row?.count ?? 0;
};

/** Serialize grant mutations on the resource, then check the caller and the remaining managers. */
const mutateNotebookAccess = async (params: {
  notebookId: string;
  accessId: string;
  permission?: PermissionLevel;
  caller?: NotebookAccessCaller;
}): Promise<Result<void>> => {
  const result = await sql.begin(async (tx): Promise<Result<void>> => {
    const [resource] = await tx`SELECT id FROM notebooks.notebooks WHERE id = ${params.notebookId}::uuid FOR UPDATE`;
    if (!resource) return fail(err.notFound("Notebook"));
    const before = await listNotebookAccess(params.notebookId, tx);
    if (!(await authorizeAccessMutation(params.notebookId, before, params.caller, tx))) return fail(err.forbidden("Access denied"));
    if (!before.some((entry) => entry.id === params.accessId)) return fail(err.notFound("Access entry for this notebook"));
    const permission = params.permission;
    const after =
      permission === undefined
        ? before.filter((entry) => entry.id !== params.accessId)
        : before.map((entry) => (entry.id === params.accessId ? { ...entry, permission } : entry));
    const guarded = ensureManagerRemains({ before, after, locale: params.caller?.locale });
    if (!guarded.ok) return guarded;
    if (after.length === 0) return fail(err.badInput("Cannot remove the last access entry"));
    const changed =
      params.permission === undefined
        ? await deleteAccess({ id: params.accessId }, tx)
        : await updateAccess({ id: params.accessId, permission: params.permission }, tx);
    return changed;
  });
  if (result.ok) await invalidated({ notebookId: params.notebookId, reason: "permissions", scopes: ["permissions"] });
  return result;
};

export const revokeNotebookAccess = (params: {
  notebookId: string;
  accessId: string;
  caller?: NotebookAccessCaller;
}): Promise<Result<void>> => mutateNotebookAccess(params);

export const updateNotebookAccess = (params: {
  notebookId: string;
  accessId: string;
  permission: PermissionLevel;
  caller?: NotebookAccessCaller;
}): Promise<Result<void>> => mutateNotebookAccess(params);

/**
 * Get the effective permission level for an actor on a notebook.
 */
export const getNotebookPermission = async (params: {
  notebookId: string;
  userId?: string | null;
  serviceAccountId?: string | null;
}): Promise<PermissionLevel> => {
  const { notebookId } = params;

  const accessRows = await sql<{ access_id: string }[]>`
    SELECT access_id FROM notebooks.notebook_access
    WHERE notebook_id = ${notebookId}::uuid
  `;

  const accessIds = accessRows.map((r) => r.access_id);

  return getEffectivePermission({
    accessIds,
    subject: params.userId
      ? { type: "user", userId: params.userId }
      : params.serviceAccountId
        ? { type: "service_account", serviceAccountId: params.serviceAccountId }
        : null,
  });
};

/**
 * Create a new access entry and add it to a notebook.
 */
export const grantNotebookAccess = async (params: {
  notebookId: string;
  principal: Principal;
  permission: PermissionLevel;
  caller?: NotebookAccessCaller;
}): Promise<Result<AccessEntry>> => {
  const { notebookId, principal, permission } = params;
  const result = await sql.begin(async (tx): Promise<Result<string>> => {
    const [resource] = await tx`SELECT id FROM notebooks.notebooks WHERE id = ${notebookId}::uuid FOR UPDATE`;
    if (!resource) return fail(err.notFound("Notebook"));
    const before = await listNotebookAccess(notebookId, tx);
    if (!(await authorizeAccessMutation(notebookId, before, params.caller, tx))) return fail(err.forbidden("Access denied"));
    const duplicate = before.some(({ principal: existing }) => {
      switch (principal.type) {
        case "user":
          return existing.type === "user" && existing.userId === principal.userId;
        case "group":
          return existing.type === "group" && existing.groupId === principal.groupId;
        case "service_account":
          return existing.type === "service_account" && existing.serviceAccountId === principal.serviceAccountId;
        default:
          return existing.type === principal.type;
      }
    });
    if (duplicate)
      return fail({
        code: "CONFLICT",
        message: "This principal already has access to this notebook",
        status: 409,
      });
    const created = await createAccess({ principal, permission }, tx);
    if (!created.ok) return created;
    await tx`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${notebookId}::uuid, ${created.data.id}::uuid)`;
    return ok(created.data.id);
  });
  if (!result.ok) return result;
  await invalidated({ notebookId, reason: "permissions", scopes: ["permissions"] });
  const created = (await listNotebookAccess(notebookId)).find((entry) => entry.id === result.data);
  return created ? ok(created) : fail(err.internal("Failed to retrieve created access entry"));
};

export const ensureNotebookServiceAccountAccess = async (params: {
  notebookId: string;
  serviceAccountId: string;
  permission: PermissionLevel;
}): Promise<Result<AccessEntry>> => {
  const entries = await listNotebookAccess(params.notebookId);
  const existing = entries.find(
    (entry) => entry.principal.type === "service_account" && entry.principal.serviceAccountId === params.serviceAccountId,
  );

  if (!existing) {
    return grantNotebookAccess({
      notebookId: params.notebookId,
      principal: { type: "service_account", serviceAccountId: params.serviceAccountId },
      permission: params.permission,
    });
  }

  if (existing.permission === params.permission) return ok(existing);

  const updated = await updateNotebookAccess({
    notebookId: params.notebookId,
    accessId: existing.id,
    permission: params.permission,
  });
  if (!updated.ok) return fail(updated.error);

  return ok({ ...existing, permission: params.permission });
};

export const listNotebookApiKeys = async (notebookId: string): Promise<NotebookApiKey[]> => {
  const [keys, accessEntries] = await Promise.all([
    (async () => {
      const items: Awaited<ReturnType<typeof serviceAccountCredentials.listOverview>>["items"] = [];
      let page = 1;
      let hasNext = true;

      while (hasNext) {
        const result = await serviceAccountCredentials.listOverview({
          pagination: { page, perPage: 500 },
          filter: {
            serviceAccountKind: "resource_bound",
            credentialStatus: "active",
            appId: NOTEBOOKS_APP_ID,
            resourceType: NOTEBOOK_RESOURCE_TYPE,
            resourceId: notebookId,
          },
        });
        items.push(...result.items);
        hasNext = result.hasNext;
        page += 1;
      }

      return items;
    })(),
    listNotebookAccess(notebookId),
  ]);

  const permissionByServiceAccountId = new Map(
    accessEntries
      .filter((entry) => entry.principal.type === "service_account")
      .map((entry) => [(entry.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId, entry.permission]),
  );

  return keys.map((item) => {
    const accessPermission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const permission = resolveNotebookApiKeyPermission(accessPermission, item.scopes);
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });
};
