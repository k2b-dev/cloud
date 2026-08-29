import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { AccessEntry, AccessSubject, PermissionLevel, Principal } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { logAudit, type SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import { emitMetadataEvent } from "./metadata-events";
import { hasAtLeast, loadBaseGrantsForSubject, resolveEffectivePermission } from "./permission-resolver";

const ACCESS_RESOURCES = {
  base: {
    junctionTable: "grids.base_access",
    junctionResourceColumn: "base_id",
    resourceTable: "grids.bases",
    allowedPermissions: ["read", "write", "admin", "none"],
    invalidPermissionMessage: "Base grants only accept 'read', 'write', 'admin', or 'none'",
  },
  customApp: {
    junctionTable: "grids.custom_app_access",
    junctionResourceColumn: "custom_app_id",
    resourceTable: "grids.custom_apps",
    allowedPermissions: ["read", "none"],
    invalidPermissionMessage: "Grids App grants only accept 'read' or 'none'",
  },
} as const;

export type AccessResourceType = keyof typeof ACCESS_RESOURCES;

type DbAccessRow = {
  access_id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date;
  display_name: string | null;
};

type DbAccessSnapshot = {
  id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
};

export type BaseAdminAuthorization = {
  subject: AccessSubject | null;
  permissionCap: PermissionLevel;
  resourceBoundBaseId?: string | null;
};

export type AccessBinding = { resourceType: "base"; baseId: string } | { resourceType: "customApp"; baseId: string; customAppId: string };

type ScopedAccessEntry = AccessEntry & {
  resourceType: AccessResourceType;
  resourceId: string;
  resourceName: string;
  tableId: null;
  tableName: null;
};

export const lockBaseAuthorization = async (baseIds: readonly string[], client: SqlClient): Promise<void> => {
  for (const baseId of [...new Set(baseIds)].sort()) {
    await client`SELECT pg_advisory_xact_lock(hashtextextended(${`grids:base-authorization:${baseId}`}, 0))`;
  }
  await client`LOCK TABLE auth.user_groups_v2, auth.group_groups_v2 IN SHARE MODE`;
};

export const hasTransactionalBaseAdmin = async (
  baseId: string,
  authorization: BaseAdminAuthorization,
  client: SqlClient,
): Promise<boolean> => {
  if (authorization.resourceBoundBaseId !== undefined && authorization.resourceBoundBaseId !== baseId) return false;
  if (!hasAtLeast(authorization.permissionCap, "admin")) return false;
  const grants = await loadBaseGrantsForSubject({ baseId, subject: authorization.subject }, client as typeof sql);
  return hasAtLeast(resolveEffectivePermission(grants, { baseId }), "admin");
};

const authorizeMutation = async (
  binding: AccessBinding,
  authorization: BaseAdminAuthorization | undefined,
  client: SqlClient,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  if (!authorization) return ok();
  return (await hasTransactionalBaseAdmin(binding.baseId, authorization, client)) ? ok() : fail(err.forbidden(messages.adminAccessLost));
};

export const validateAccessPermission = (resourceType: AccessResourceType, permission: string, locale?: string): string | null => {
  const messages = getGridsCrudMessages(locale);
  const definition = ACCESS_RESOURCES[resourceType];
  return (definition.allowedPermissions as readonly string[]).includes(permission)
    ? null
    : resourceType === "base"
      ? messages.basePermissionInvalid
      : messages.appPermissionInvalid;
};

export const validateAccessPrincipal = (resourceType: AccessResourceType, principal: Principal, locale?: string): string | null => {
  const messages = getGridsCrudMessages(locale);
  if (resourceType === "base" && principal.type === "public") return messages.publicAccessAppsOnly;
  if (resourceType === "customApp" && principal.type === "service_account") {
    return messages.appServiceAccountUnsupported;
  }
  return null;
};

const principalFromRow = (row: Pick<DbAccessRow, "user_id" | "group_id" | "service_account_id" | "authenticated_only">): Principal => {
  if (row.user_id) return { type: "user", userId: row.user_id };
  if (row.group_id) return { type: "group", groupId: row.group_id };
  if (row.service_account_id) return { type: "service_account", serviceAccountId: row.service_account_id };
  if (row.authenticated_only) return { type: "authenticated" };
  return { type: "public" };
};

const mapAccessRow = (row: DbAccessRow): AccessEntry => ({
  id: row.access_id,
  principal: principalFromRow(row),
  permission: row.permission,
  createdAt: row.created_at.toISOString(),
  displayName: row.display_name ?? undefined,
});

const resourceIdFromBinding = (binding: AccessBinding): string => (binding.resourceType === "base" ? binding.baseId : binding.customAppId);

type AccessAuditSnapshot = {
  id: string;
  resourceType: AccessResourceType;
  resourceId: string;
  principal: Principal;
  permission: PermissionLevel;
};

export const buildAccessAuditDiff = (
  action: "access.granted" | "access.updated" | "access.revoked",
  binding: AccessBinding,
  access: Pick<DbAccessSnapshot, "id" | "permission" | "user_id" | "group_id" | "service_account_id" | "authenticated_only">,
  nextPermission: PermissionLevel | null,
): { access: { old: AccessAuditSnapshot | null; new: AccessAuditSnapshot | null } } => {
  const snapshot: AccessAuditSnapshot = {
    id: access.id,
    resourceType: binding.resourceType,
    resourceId: resourceIdFromBinding(binding),
    principal: principalFromRow(access),
    permission: access.permission,
  };
  return {
    access: {
      old: action === "access.granted" ? null : snapshot,
      new: nextPermission === null ? null : { ...snapshot, permission: nextPermission },
    },
  };
};

const getAccessSnapshot = async (accessId: string, client: SqlClient = sql): Promise<DbAccessSnapshot | null> => {
  const [row] = await client<DbAccessSnapshot[]>`
    SELECT id, user_id, group_id, service_account_id, authenticated_only, permission
    FROM auth.access
    WHERE id = ${accessId}::uuid
  `;
  return row ?? null;
};

const insertAccessRow = async (
  params: { principal: Principal; permission: PermissionLevel },
  client: SqlClient,
  locale?: string,
): Promise<Result<{ id: string }>> => {
  const messages = getGridsCrudMessages(locale);
  let userId: string | null = null;
  let groupId: string | null = null;
  let serviceAccountId: string | null = null;
  let authenticatedOnly = false;

  if (params.principal.type === "user") {
    userId = params.principal.userId;
    const [user] = await client<{ id: string }[]>`SELECT id FROM auth.users WHERE id = ${userId}::uuid`;
    if (!user) return fail(err.notFound(messages.user));
  } else if (params.principal.type === "group") {
    groupId = params.principal.groupId;
    const [group] = await client<{ id: string }[]>`SELECT id FROM auth.groups WHERE id = ${groupId}::uuid`;
    if (!group) return fail(err.notFound(messages.group));
  } else if (params.principal.type === "service_account") {
    serviceAccountId = params.principal.serviceAccountId;
    const [account] = await client<{ id: string }[]>`
      SELECT id FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid AND status = 'active'
    `;
    if (!account) return fail(err.notFound(messages.serviceAccount));
  } else if (params.principal.type === "authenticated") {
    authenticatedOnly = true;
  }

  const [row] = await client<{ id: string }[]>`
    INSERT INTO auth.access (user_id, group_id, service_account_id, authenticated_only, permission)
    VALUES (${userId}::uuid, ${groupId}::uuid, ${serviceAccountId}::uuid, ${authenticatedOnly}, ${params.permission}::auth.permission_level)
    RETURNING id
  `;
  return row ? ok({ id: row.id }) : fail(err.internal(messages.accessCreateFailed));
};

const insertAccessBinding = async (
  resourceType: AccessResourceType,
  resourceId: string,
  accessId: string,
  client: SqlClient,
): Promise<void> => {
  const definition = ACCESS_RESOURCES[resourceType];
  await client`
    INSERT INTO ${client.unsafe(definition.junctionTable)}
      (${client.unsafe(definition.junctionResourceColumn)}, access_id)
    VALUES (${resourceId}::uuid, ${accessId}::uuid)
  `;
};

const logAccessAudit = async (params: {
  action: "access.granted" | "access.updated" | "access.revoked";
  binding: AccessBinding;
  access: DbAccessSnapshot;
  actorId: string | null;
  nextPermission: PermissionLevel | null;
  client: SqlClient;
}): Promise<void> => {
  await logAudit(
    {
      baseId: params.binding.baseId,
      tableId: null,
      userId: params.actorId,
      action: params.action,
      diff: buildAccessAuditDiff(params.action, params.binding, params.access, params.nextPermission),
    },
    params.client,
  );
};

const emitAccessChanged = async (binding: AccessBinding | null, accessId: string, actorId: string | null): Promise<void> => {
  if (!binding) return;
  await emitMetadataEvent({
    type: "access.changed",
    baseId: binding.baseId,
    resource: { kind: "access", id: accessId },
    actorId,
  });
};

export const grantAccess = async (params: {
  resourceType: AccessResourceType;
  resourceId: string;
  principal: Principal;
  permission: PermissionLevel;
  actorId?: string | null;
  authorization?: BaseAdminAuthorization;
  locale?: string;
}): Promise<Result<{ accessId: string }>> => {
  const messages = getGridsCrudMessages(params.locale);
  const validationError = validateAccessPermission(params.resourceType, params.permission, params.locale);
  if (validationError) return fail(err.badInput(validationError));
  const principalError = validateAccessPrincipal(params.resourceType, params.principal, params.locale);
  if (principalError) return fail(err.badInput(principalError));
  const result = await sql.begin(async (tx): Promise<Result<{ accessId: string }>> => {
    const binding = await resolveResourceBinding(params.resourceType, params.resourceId, { client: tx });
    if (!binding) return fail(err.notFound(messages.resource));
    await lockBaseAuthorization([binding.baseId], tx);
    const authorized = await authorizeMutation(binding, params.authorization, tx, params.locale);
    if (!authorized.ok) return fail(authorized.error);
    const created = await insertAccessRow({ principal: params.principal, permission: params.permission }, tx, params.locale);
    if (!created.ok) return fail(created.error);
    await insertAccessBinding(params.resourceType, params.resourceId, created.data.id, tx);
    const access = await getAccessSnapshot(created.data.id, tx);
    if (!access) throw err.internal(messages.accessResolveFailed);
    await logAccessAudit({
      action: "access.granted",
      binding,
      access,
      actorId: params.actorId ?? null,
      nextPermission: params.permission,
      client: tx,
    });
    return ok({ accessId: created.data.id });
  });
  if (!result.ok) return fail(result.error);
  await emitAccessChanged(await resolveAccessBinding(result.data.accessId), result.data.accessId, params.actorId ?? null);
  return result;
};

const listAccess = async (resourceType: AccessResourceType, resourceId: string): Promise<AccessEntry[]> => {
  const definition = ACCESS_RESOURCES[resourceType];
  const rows = await sql<DbAccessRow[]>`
    SELECT a.id AS access_id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only,
           a.permission, a.created_at, COALESCE(u.uid, g.name, sa.name, NULL) AS display_name
    FROM ${sql.unsafe(definition.junctionTable)} binding
    JOIN auth.access a ON a.id = binding.access_id
    LEFT JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN auth.groups g ON g.id = a.group_id
    LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
    WHERE ${sql.unsafe(`binding.${definition.junctionResourceColumn}`)} = ${resourceId}::uuid
    ORDER BY a.created_at
  `;
  return rows.map(mapAccessRow);
};

export const listBaseAccess = (baseId: string) => listAccess("base", baseId);
export const listCustomAppAccess = (customAppId: string) => listAccess("customApp", customAppId);

export const listAccessForBaseTree = async (baseId: string): Promise<ScopedAccessEntry[]> => {
  const rows = await sql<(DbAccessRow & { resource_type: AccessResourceType; resource_id: string; resource_name: string })[]>`
    SELECT 'base'::text AS resource_type, b.id::text AS resource_id, b.name AS resource_name,
           a.id AS access_id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only,
           a.permission, a.created_at, COALESCE(u.uid, g.name, sa.name, NULL) AS display_name
    FROM grids.base_access ba
    JOIN grids.bases b ON b.id = ba.base_id AND b.deleted_at IS NULL
    JOIN auth.access a ON a.id = ba.access_id
    LEFT JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN auth.groups g ON g.id = a.group_id
    LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
    WHERE ba.base_id = ${baseId}::uuid

    UNION ALL

    SELECT 'customApp'::text, app.id::text, app.name,
           a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only,
           a.permission, a.created_at, COALESCE(u.uid, g.name, sa.name, NULL)
    FROM grids.custom_app_access caa
    JOIN grids.custom_apps app ON app.id = caa.custom_app_id AND app.deleted_at IS NULL
    JOIN auth.access a ON a.id = caa.access_id
    LEFT JOIN auth.users u ON u.id = a.user_id
    LEFT JOIN auth.groups g ON g.id = a.group_id
    LEFT JOIN auth.service_accounts sa ON sa.id = a.service_account_id
    WHERE app.base_id = ${baseId}::uuid

    ORDER BY resource_type, resource_name, created_at
  `;
  return rows.map((row) => ({
    ...mapAccessRow(row),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    tableId: null,
    tableName: null,
  }));
};

export const updateAccessLevel = async (
  accessId: string,
  level: PermissionLevel,
  actorId: string | null = null,
  authorization?: BaseAdminAuthorization,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const result = await sql.begin(async (tx): Promise<Result<AccessBinding>> => {
    const binding = await resolveAccessBinding(accessId, tx);
    if (!binding) return fail(err.notFound(messages.accessEntry));
    const validationError = validateAccessPermission(binding.resourceType, level, locale);
    if (validationError) return fail(err.badInput(validationError));
    await lockBaseAuthorization([binding.baseId], tx);
    const authorized = await authorizeMutation(binding, authorization, tx, locale);
    if (!authorized.ok) return fail(authorized.error);
    const access = await getAccessSnapshot(accessId, tx);
    if (!access) return fail(err.notFound(messages.accessEntry));
    const update = await tx`
      UPDATE auth.access SET permission = ${level}::auth.permission_level WHERE id = ${accessId}::uuid
    `;
    if (update.count === 0) return fail(err.notFound(messages.accessEntry));
    if (access.permission !== level) {
      await logAccessAudit({ action: "access.updated", binding, access, actorId, nextPermission: level, client: tx });
    }
    return ok(binding);
  });
  if (!result.ok) return fail(result.error);
  await emitAccessChanged(result.data, accessId, actorId);
  return ok();
};

export const revokeAccess = async (
  accessId: string,
  actorId: string | null = null,
  authorization?: BaseAdminAuthorization,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  const result = await sql.begin(async (tx): Promise<Result<AccessBinding>> => {
    const binding = await resolveAccessBinding(accessId, tx);
    if (!binding) return fail(err.notFound(messages.accessEntry));
    await lockBaseAuthorization([binding.baseId], tx);
    const authorized = await authorizeMutation(binding, authorization, tx, locale);
    if (!authorized.ok) return fail(authorized.error);
    const access = await getAccessSnapshot(accessId, tx);
    if (!access) return fail(err.notFound(messages.accessEntry));
    const deleted = await tx`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    if (deleted.count === 0) return fail(err.notFound(messages.accessEntry));
    await logAccessAudit({ action: "access.revoked", binding, access, actorId, nextPermission: null, client: tx });
    return ok(binding);
  });
  if (!result.ok) return fail(result.error);
  await emitAccessChanged(result.data, accessId, actorId);
  return ok();
};

type DbAccessBinding = {
  resource_type: AccessResourceType;
  resource_id: string;
  base_id: string;
};

const mapAccessBinding = (row: DbAccessBinding): AccessBinding =>
  row.resource_type === "base"
    ? { resourceType: "base", baseId: row.base_id }
    : { resourceType: "customApp", baseId: row.base_id, customAppId: row.resource_id };

export const resolveResourceBinding = async (
  resourceType: AccessResourceType,
  resourceId: string,
  options: { includeDeleted?: boolean; client?: SqlClient } = {},
): Promise<AccessBinding | null> => {
  const client = options.client ?? sql;
  const alive = options.includeDeleted === false ? client`AND deleted_at IS NULL` : client``;
  const [row] =
    resourceType === "base"
      ? await client<DbAccessBinding[]>`
          SELECT 'base'::text AS resource_type, id::text AS resource_id, id::text AS base_id
          FROM grids.bases WHERE id = ${resourceId}::uuid ${alive}
        `
      : await client<DbAccessBinding[]>`
          SELECT 'customApp'::text AS resource_type, id::text AS resource_id, base_id::text AS base_id
          FROM grids.custom_apps WHERE id = ${resourceId}::uuid ${alive}
        `;
  return row ? mapAccessBinding(row) : null;
};

export const resolveAccessBinding = async (accessId: string, client: SqlClient = sql): Promise<AccessBinding | null> => {
  const [row] = await client<DbAccessBinding[]>`
    SELECT 'base'::text AS resource_type, b.id::text AS resource_id, b.id::text AS base_id, 0 AS sort_order
    FROM grids.base_access ba
    JOIN grids.bases b ON b.id = ba.base_id
    WHERE ba.access_id = ${accessId}::uuid

    UNION ALL

    SELECT 'customApp'::text, app.id::text, app.base_id::text, 1
    FROM grids.custom_app_access caa
    JOIN grids.custom_apps app ON app.id = caa.custom_app_id
    WHERE caa.access_id = ${accessId}::uuid

    ORDER BY sort_order
    LIMIT 1
  `;
  return row ? mapAccessBinding(row) : null;
};
