import { type AccessSubject, buildAccessPrincipalCondition, type PermissionLevel } from "@valentinkolb/cloud/server";
import { sql } from "bun";
import { runBoundedQuery } from "./bounded-query";

const LEVEL_RANK: Record<PermissionLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
};

const LEVEL_BY_RANK: PermissionLevel[] = ["none", "read", "write", "admin"];

export type ResourceType = "base" | "customApp";
type PrincipalTier = "serviceAccount" | "user" | "group" | "authenticated" | "public";

export type Grant = {
  resourceType: ResourceType;
  resourceId: string;
  principalTier: PrincipalTier;
  level: PermissionLevel;
};

export type ResolveTarget = { baseId: string } | { customAppId: string };

const PRINCIPAL_TIERS: PrincipalTier[] = ["serviceAccount", "user", "group", "authenticated", "public"];

/**
 * The first matching principal tier decides. A deny shadows allows only inside
 * that tier; otherwise the tier's highest permission wins.
 */
const resolveResourceLevel = (grants: Grant[]): PermissionLevel => {
  for (const tier of PRINCIPAL_TIERS) {
    const tierGrants = grants.filter((grant) => grant.principalTier === tier);
    if (tierGrants.length === 0) continue;
    if (tierGrants.some((grant) => grant.level === "none")) return "none";
    let max = 0;
    for (const grant of tierGrants) max = Math.max(max, LEVEL_RANK[grant.level]);
    return LEVEL_BY_RANK[max] ?? "none";
  }
  return "none";
};

/** Resolve exactly one permission boundary. Base and Grids App grants never inherit from each other. */
export const resolveEffectivePermission = (grants: Grant[], target: ResolveTarget): PermissionLevel => {
  const resourceType: ResourceType = "baseId" in target ? "base" : "customApp";
  const resourceId = "baseId" in target ? target.baseId : target.customAppId;
  return resolveResourceLevel(grants.filter((grant) => grant.resourceType === resourceType && grant.resourceId === resourceId));
};

export const hasAtLeast = (level: PermissionLevel, required: PermissionLevel): boolean => LEVEL_RANK[level] >= LEVEL_RANK[required];

export const minPermission = (left: PermissionLevel, right: PermissionLevel): PermissionLevel =>
  LEVEL_RANK[left] <= LEVEL_RANK[right] ? left : right;

export const permissionFromCredentialScopes = (scopes: readonly string[]): PermissionLevel => {
  if (scopes.includes("admin") || scopes.includes("grids:admin") || scopes.includes("grids:*")) return "admin";
  if (scopes.includes("write") || scopes.includes("grids:write")) return "write";
  if (scopes.includes("read") || scopes.includes("grids:read")) return "read";
  return "none";
};

export const hasGrantsForResource = (grants: Grant[], resourceType: ResourceType, resourceId: string): boolean =>
  grants.some((grant) => grant.resourceType === resourceType && grant.resourceId === resourceId);

type DbRow = {
  resource_type: ResourceType;
  resource_id: string;
  principal_tier: PrincipalTier;
  level: PermissionLevel;
};

export type PermissionReadOptions = { signal?: AbortSignal; queryTimeoutMs?: number };

const loadExactGrants = async (
  params:
    | { resourceType: "base"; resourceId: string; subject: AccessSubject | null }
    | { resourceType: "customApp"; resourceId: string; subject: AccessSubject | null },
  db: typeof sql = sql,
  options: PermissionReadOptions = {},
): Promise<Grant[]> => {
  const tier = sql`CASE
    WHEN a.service_account_id IS NOT NULL THEN 'serviceAccount'
    WHEN a.user_id IS NOT NULL THEN 'user'
    WHEN a.group_id IS NOT NULL THEN 'group'
    WHEN a.authenticated_only = TRUE THEN 'authenticated'
    ELSE 'public'
  END`;
  const principal = buildAccessPrincipalCondition({
    subject: params.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });

  const query =
    params.resourceType === "base"
      ? db<DbRow[]>`
          SELECT 'base'::text AS resource_type,
                 ba.base_id::text AS resource_id,
                 a.permission AS level,
                 ${tier} AS principal_tier
          FROM grids.base_access ba
          JOIN auth.access a ON a.id = ba.access_id
          WHERE ba.base_id = ${params.resourceId}::uuid
            AND ${principal}
            AND (
              a.user_id IS NOT NULL
              OR a.group_id IS NOT NULL
              OR a.service_account_id IS NOT NULL
              OR a.authenticated_only = TRUE
            )
        `
      : db<DbRow[]>`
          SELECT 'customApp'::text AS resource_type,
                 caa.custom_app_id::text AS resource_id,
                 a.permission AS level,
                 ${tier} AS principal_tier
          FROM grids.custom_app_access caa
          JOIN auth.access a ON a.id = caa.access_id
          WHERE caa.custom_app_id = ${params.resourceId}::uuid AND ${principal}
        `;
  const rows =
    options.queryTimeoutMs !== undefined || options.signal
      ? await runBoundedQuery<DbRow>(query, options.queryTimeoutMs ?? 5_000, options.signal)
      : await query;

  return rows.map((row) => ({
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    principalTier: row.principal_tier,
    level: row.level,
  }));
};

export const loadBaseGrantsForSubject = (
  params: { baseId: string; subject: AccessSubject | null },
  db: typeof sql = sql,
  options: PermissionReadOptions = {},
): Promise<Grant[]> => loadExactGrants({ resourceType: "base", resourceId: params.baseId, subject: params.subject }, db, options);

export const loadCustomAppGrantsForSubject = (
  params: { customAppId: string; subject: AccessSubject | null },
  db: typeof sql = sql,
  options: PermissionReadOptions = {},
): Promise<Grant[]> => loadExactGrants({ resourceType: "customApp", resourceId: params.customAppId, subject: params.subject }, db, options);
