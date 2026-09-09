import {
  type AccessEntry,
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getEffectivePermission,
  type PermissionLevel,
  type Principal,
  type ResourceAccessAdapter,
  resolveDisplayNames,
  updateAccess,
} from "@k2b/cloud/server";
import { type ServiceAccountCredential, serviceAccountCredentials } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { publishSpaceEvent } from "./events";

// ==========================
// Space Access Adapter
// ==========================

type DbSpaceAccess = {
  access_id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date;
};

export const SPACES_APP_ID = "spaces";
export const SPACE_RESOURCE_TYPE = "space";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isSpaceResourceId = (value: string | null | undefined): value is string => Boolean(value && UUID_PATTERN.test(value));

export type SpaceApiKey = ServiceAccountCredential & {
  permission: PermissionLevel;
};

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const permissionFromScopes = (scopes: string[]): PermissionLevel => {
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return "none";
};

const minPermission = (a: PermissionLevel, b: PermissionLevel): PermissionLevel => (PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b);

export const resolveSpaceApiKeyPermission = (accessPermission: PermissionLevel, credentialScopes: string[]): PermissionLevel => {
  return minPermission(accessPermission, permissionFromScopes(credentialScopes));
};

/** Canonical principal predicate for joined `auth.access a` rows. */
export const buildSpacePrincipalCondition = (subject: AccessSubject) =>
  buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });

/**
 * List all access entries for a space with resolved display names.
 */
export const listSpaceAccess = async (spaceId: string): Promise<AccessEntry[]> => {
  const rows = await sql<DbSpaceAccess[]>`
    SELECT
      a.id as access_id,
      a.user_id,
      a.group_id,
      a.service_account_id,
      a.authenticated_only,
      a.permission,
      a.created_at
    FROM spaces.space_access sa
    JOIN auth.access a ON sa.access_id = a.id
    WHERE sa.space_id = ${spaceId}::uuid
    ORDER BY
      CASE
        WHEN a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND a.authenticated_only = false THEN 4
        WHEN a.authenticated_only THEN 3
        WHEN a.group_id IS NOT NULL THEN 2
        WHEN a.service_account_id IS NOT NULL THEN 2
        ELSE 1
      END,
      a.created_at
  `;

  const entries: AccessEntry[] = rows.map((row) => ({
    id: row.access_id,
    principal: row.user_id
      ? { type: "user" as const, userId: row.user_id }
      : row.group_id
        ? { type: "group" as const, groupId: row.group_id }
        : row.service_account_id
          ? { type: "service_account" as const, serviceAccountId: row.service_account_id }
          : row.authenticated_only
            ? { type: "authenticated" as const }
            : { type: "public" as const },
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
  }));

  return resolveDisplayNames(entries);
};

/**
 * Add an access entry to a space.
 */
export const addSpaceAccess = async (spaceId: string, accessId: string): Promise<Result<void>> => {
  try {
    await sql`
      INSERT INTO spaces.space_access (space_id, access_id)
      VALUES (${spaceId}::uuid, ${accessId}::uuid)
    `;
    return ok();
  } catch (e: unknown) {
    const error = e as { code?: string };
    if (error.code === "23505") {
      // unique_violation
      return fail(err.conflict("Access entry"));
    }
    if (error.code === "23503") {
      // foreign_key_violation
      return fail(err.notFound("Space or access entry"));
    }
    throw e;
  }
};

/**
 * Remove an access entry from a space.
 * Also deletes the auth.access entry (CASCADE will handle junction).
 */
export const removeSpaceAccess = async (spaceId: string, accessId: string): Promise<Result<void>> => {
  // First verify it belongs to this space
  const [exists] = await sql<{ access_id: string }[]>`
    SELECT access_id FROM spaces.space_access
    WHERE space_id = ${spaceId}::uuid AND access_id = ${accessId}::uuid
  `;

  if (!exists) {
    return fail(err.notFound("Access entry for this space"));
  }

  // Delete the auth.access entry (CASCADE will remove junction row)
  return deleteAccess({ id: accessId });
};

/**
 * Count access entries for a space.
 */
export const countSpaceAccess = async (spaceId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count
    FROM spaces.space_access
    WHERE space_id = ${spaceId}::uuid
  `;
  return row?.count ?? 0;
};

/** Remove an access entry while preventing accidental orphaning. */
export const revokeSpaceAccess = async (params: { spaceId: string; accessId: string }): Promise<Result<void>> => {
  const result = await sql.begin(async (tx) => {
    const [guard] = await tx<
      {
        total: number;
        other_admins: number;
        current_permission: PermissionLevel | null;
      }[]
    >`
      WITH locked AS (
        SELECT a.id, a.permission
        FROM spaces.space_access sa
        JOIN auth.access a ON sa.access_id = a.id
        WHERE sa.space_id = ${params.spaceId}::uuid
        FOR UPDATE OF sa, a
      )
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE permission = 'admin'::auth.permission_level
            AND id <> ${params.accessId}::uuid
        )::int AS other_admins,
        MAX(CASE WHEN id = ${params.accessId}::uuid THEN permission END) AS current_permission
      FROM locked
    `;

    if (!guard?.current_permission) return fail(err.notFound("Access entry for this space"));
    if (guard.total <= 1) return fail(err.badInput("Cannot remove the last access entry"));
    if (guard.current_permission === "admin" && guard.other_admins <= 0) {
      return fail(err.badInput("Cannot remove the last admin"));
    }

    const result = await tx`DELETE FROM auth.access WHERE id = ${params.accessId}::uuid`;
    return result.count > 0 ? ok() : fail(err.notFound("Access entry for this space"));
  });
  if (result.ok) await publishSpaceEvent({ type: "access.changed", spaceId: params.spaceId });
  return result;
};

/** Update a permission while preserving at least one Space admin. */
export const updateSpaceAccessPermission = async (params: {
  spaceId: string;
  accessId: string;
  permission: PermissionLevel;
}): Promise<Result<void>> => {
  const result = await sql.begin(async (tx) => {
    const [guard] = await tx<
      {
        other_admins: number;
        current_permission: PermissionLevel | null;
      }[]
    >`
      WITH locked AS (
        SELECT a.id, a.permission
        FROM spaces.space_access sa
        JOIN auth.access a ON sa.access_id = a.id
        WHERE sa.space_id = ${params.spaceId}::uuid
        FOR UPDATE OF sa, a
      )
      SELECT
        COUNT(*) FILTER (
          WHERE permission = 'admin'::auth.permission_level
            AND id <> ${params.accessId}::uuid
        )::int AS other_admins,
        MAX(CASE WHEN id = ${params.accessId}::uuid THEN permission END) AS current_permission
      FROM locked
    `;

    if (!guard?.current_permission) return fail(err.notFound("Access entry for this space"));
    if (guard.current_permission === "admin" && params.permission !== "admin" && guard.other_admins <= 0) {
      return fail(err.badInput("Cannot remove the last admin"));
    }

    return updateAccess({ id: params.accessId, permission: params.permission }, tx);
  });
  if (result.ok) await publishSpaceEvent({ type: "access.changed", spaceId: params.spaceId });
  return result;
};

/**
 * Get the effective permission level for an actor on a space.
 */
export const getSpacePermission = async (params: { spaceId: string; subject: AccessSubject }): Promise<PermissionLevel> => {
  const { spaceId } = params;

  // Get all access IDs for this space
  const accessRows = await sql<{ access_id: string }[]>`
    SELECT access_id FROM spaces.space_access
    WHERE space_id = ${spaceId}::uuid
  `;

  const accessIds = accessRows.map((r) => r.access_id);

  return getEffectivePermission({
    accessIds,
    subject: params.subject,
  });
};

/**
 * Create a new access entry and add it to a space.
 * Combined operation for convenience.
 */
export const grantSpaceAccess = async (params: {
  spaceId: string;
  principal: Principal;
  permission: PermissionLevel;
}): Promise<Result<AccessEntry>> => {
  const { spaceId, principal, permission } = params;

  // Check for duplicate principal on this space
  const existing = await listSpaceAccess(spaceId);
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
      message: "This principal already has access to this space",
      status: 409,
    });
  }

  // Create access entry
  const createResult = await createAccess({ principal, permission });
  if (!createResult.ok) return createResult;

  // Link to space
  const linkResult = await addSpaceAccess(spaceId, createResult.data.id);
  if (!linkResult.ok) {
    // Cleanup: delete the orphaned access entry
    await deleteAccess({ id: createResult.data.id });
    return linkResult;
  }

  // Return the created entry with display name
  const entries = await listSpaceAccess(spaceId);
  const created = entries.find((e) => e.id === createResult.data.id);

  if (!created) {
    return fail(err.internal("Failed to retrieve created access entry"));
  }

  await publishSpaceEvent({ type: "access.changed", spaceId });
  return ok(created);
};

export const ensureSpaceServiceAccountAccess = async (params: {
  spaceId: string;
  serviceAccountId: string;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<AccessEntry>> => {
  const entries = await listSpaceAccess(params.spaceId);
  const existing = entries.find(
    (entry) => entry.principal.type === "service_account" && entry.principal.serviceAccountId === params.serviceAccountId,
  );

  if (!existing) {
    return grantSpaceAccess({
      spaceId: params.spaceId,
      principal: { type: "service_account", serviceAccountId: params.serviceAccountId },
      permission: params.permission,
    });
  }

  if (existing.permission === params.permission) return ok(existing);

  const updated = await updateAccess({ id: existing.id, permission: params.permission });
  if (!updated.ok) return fail(updated.error);

  return ok({ ...existing, permission: params.permission });
};

export const listSpaceApiKeys = async (spaceId: string): Promise<SpaceApiKey[]> => {
  const [keys, accessEntries] = await Promise.all([
    serviceAccountCredentials.listOverview({
      pagination: { page: 1, perPage: 500 },
      filter: {
        serviceAccountKind: "resource_bound",
        credentialStatus: "active",
        appId: SPACES_APP_ID,
        resourceType: SPACE_RESOURCE_TYPE,
        resourceId: spaceId,
      },
    }),
    listSpaceAccess(spaceId),
  ]);

  const permissionByServiceAccountId = new Map(
    accessEntries
      .filter((entry) => entry.principal.type === "service_account")
      .map((entry) => [(entry.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId, entry.permission]),
  );

  return keys.items.map((item) => {
    const accessPermission = permissionByServiceAccountId.get(item.serviceAccount.id) ?? "none";
    const permission = resolveSpaceApiKeyPermission(accessPermission, item.scopes);
    const { serviceAccount: _serviceAccount, owner: _owner, ...credential } = item;
    return { ...credential, permission };
  });
};

/**
 * ResourceAccessAdapter implementation for spaces.
 */
export const spaceAccessAdapter: ResourceAccessAdapter = {
  list: listSpaceAccess,
  add: addSpaceAccess,
  remove: removeSpaceAccess,
  count: countSpaceAccess,
};
