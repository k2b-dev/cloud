import {
  type AccessEntry,
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getEffectivePermission,
  type PermissionLevel,
  type Principal,
  updateAccess,
} from "@k2b/cloud/server";
import { type ServiceAccountCredential, serviceAccountCredentials } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
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
  group_name: string | null;
  service_account_name: string | null;
};

export const NOTEBOOKS_APP_ID = "notebooks";
export const NOTEBOOK_RESOURCE_TYPE = "notebook";

export type NotebookApiKey = ServiceAccountCredential & {
  permission: PermissionLevel;
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
      ? row.user_display_name || row.user_uid || "Unknown User"
      : principal.type === "group"
        ? row.group_name || "Unknown Group"
        : principal.type === "service_account"
          ? row.service_account_name || "Unknown Service Account"
          : principal.type === "authenticated"
            ? "All users (incl. guests)"
            : "Public";

  return {
    id: row.access_id,
    principal,
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
    displayName,
  };
};

/**
 * List all access entries for a notebook with resolved display names.
 */
export const listNotebookAccess = async (notebookId: string): Promise<AccessEntry[]> => {
  const result = await listNotebookAccessPage({ notebookId });
  return result.items;
};

/**
 * List access entries with SQL-side filtering and pagination.
 */
export const listNotebookAccessPage = async (config: {
  notebookId: string;
  query?: string;
  principalType?: AccessEntry["principal"]["type"];
  pagination?: { limit: number; offset: number };
}): Promise<{ items: AccessEntry[]; total: number }> => {
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
      ? await sql<DbNotebookAccess[]>`
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
            g.name AS group_name,
            sa.name AS service_account_name
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
      : await sql<DbNotebookAccess[]>`
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
            g.name AS group_name,
            sa.name AS service_account_name
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

  const [countRow] = await sql<{ count: number }[]>`
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
export const removeNotebookAccess = async (notebookId: string, accessId: string): Promise<Result<void>> => {
  const [exists] = await sql<{ access_id: string }[]>`
    SELECT access_id FROM notebooks.notebook_access
    WHERE notebook_id = ${notebookId}::uuid AND access_id = ${accessId}::uuid
  `;

  if (!exists) {
    return fail(err.notFound("Access entry for this notebook"));
  }

  const result = await deleteAccess({ id: accessId });
  if (result.ok) {
    await invalidated({ notebookId, reason: "permissions", scopes: ["permissions"] });
  }
  return result;
};

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

/**
 * Read guard information needed for safe access updates/removals.
 */
export const getNotebookAccessGuard = async (params: {
  notebookId: string;
  accessId: string;
}): Promise<{
  total: number;
  otherAdmins: number;
  currentPermission: PermissionLevel | null;
}> => {
  const [row] = await sql<
    {
      total: number;
      other_admins: number;
      current_permission: PermissionLevel | null;
    }[]
  >`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (
        WHERE a.permission = 'admin'::auth.permission_level
          AND a.id <> ${params.accessId}::uuid
      )::int as other_admins,
      MAX(CASE WHEN a.id = ${params.accessId}::uuid THEN a.permission END) as current_permission
    FROM notebooks.notebook_access na
    JOIN auth.access a ON na.access_id = a.id
    WHERE na.notebook_id = ${params.notebookId}::uuid
  `;

  return {
    total: row?.total ?? 0,
    otherAdmins: row?.other_admins ?? 0,
    currentPermission: row?.current_permission ?? null,
  };
};

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
}): Promise<Result<AccessEntry>> => {
  const { notebookId, principal, permission } = params;

  // Check for duplicate principal
  const existing = await listNotebookAccess(notebookId);
  const duplicate = existing.find((e) => {
    if (principal.type === "public" && e.principal.type === "public") return true;
    if (principal.type === "authenticated" && e.principal.type === "authenticated") return true;
    if (principal.type === "user" && e.principal.type === "user" && principal.userId === e.principal.userId) return true;
    if (principal.type === "group" && e.principal.type === "group" && principal.groupId === e.principal.groupId) return true;
    if (
      principal.type === "service_account" &&
      e.principal.type === "service_account" &&
      principal.serviceAccountId === e.principal.serviceAccountId
    ) {
      return true;
    }
    return false;
  });

  if (duplicate) {
    return fail({
      code: "CONFLICT",
      message: "This principal already has access to this notebook",
      status: 409,
    });
  }

  const createResult = await createAccess({ principal, permission });
  if (!createResult.ok) return createResult;

  const linkResult = await addNotebookAccess(notebookId, createResult.data.id);
  if (!linkResult.ok) {
    await deleteAccess({ id: createResult.data.id });
    return linkResult;
  }

  const entries = await listNotebookAccess(notebookId);
  const created = entries.find((e) => e.id === createResult.data.id);

  if (!created) {
    await deleteAccess({ id: createResult.data.id });
    return fail(err.internal("Failed to retrieve created access entry"));
  }

  return ok(created);
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

export const updateNotebookAccess = async (params: {
  notebookId: string;
  accessId: string;
  permission: PermissionLevel;
}): Promise<Result<void>> => {
  const result = await updateAccess({ id: params.accessId, permission: params.permission });
  if (result.ok) {
    await invalidated({ notebookId: params.notebookId, reason: "permissions", scopes: ["permissions"] });
  }
  return result;
};
