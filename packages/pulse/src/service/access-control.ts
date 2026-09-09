import type { RequestActor, ServiceAccount } from "@k2b/cloud/contracts";
import {
  type AccessSubject,
  buildAccessPrincipalCondition,
  err,
  fail,
  ok,
  type PermissionLevel,
  type Result,
} from "@k2b/cloud/server";
import { sql } from "bun";

export type UserScope = {
  id: string;
};

export type ResourceScope = {
  subject: Extract<AccessSubject, { type: "service_account" }>;
  serviceAccount: Pick<ServiceAccount, "appId" | "resourceType" | "resourceId">;
  scopes: readonly string[];
};

export type AccessScope = UserScope | ResourceScope;

export const PULSE_BASE_RESOURCE_TYPE = "pulse_base";

const PERMISSION_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2, admin: 3 };

const isResourceScope = (scope: AccessScope): scope is ResourceScope => "subject" in scope;

export const accessScopeFor = (actor: RequestActor, subject: AccessSubject): Result<AccessScope> => {
  if (subject.type === "user") return ok({ id: subject.userId });
  if (actor.kind !== "service_account" || actor.delegatedUser) {
    return fail(err.forbidden("Resource access subject does not match the authenticated actor"));
  }
  return ok({ subject, serviceAccount: actor.serviceAccount, scopes: actor.scopes });
};

const subjectForScope = (scope: AccessScope): AccessSubject =>
  isResourceScope(scope) ? scope.subject : { type: "user", userId: scope.id };

export const userIdForScope = (scope: AccessScope): string | null => (isResourceScope(scope) ? null : scope.id);

const scopedPermission = (scope: AccessScope): PermissionLevel => {
  if (!isResourceScope(scope)) return "admin";
  if (scope.scopes.includes("admin")) return "admin";
  if (scope.scopes.includes("write")) return "write";
  if (scope.scopes.includes("read")) return "read";
  return "none";
};

const boundBaseShortId = (scope: AccessScope): string | null => {
  if (!isResourceScope(scope)) return null;
  return scope.serviceAccount.appId === "pulse" && scope.serviceAccount.resourceType === PULSE_BASE_RESOURCE_TYPE
    ? scope.serviceAccount.resourceId
    : null;
};

const canRequestPermission = (scope: AccessScope, required: PermissionLevel): boolean =>
  PERMISSION_RANK[scopedPermission(scope)] >= PERMISSION_RANK[required];

export const readableScopeFilter = (scope: AccessScope): { subject: AccessSubject; boundBaseShortId: string | null } | null => {
  if (!canRequestPermission(scope, "read")) return null;
  const bound = boundBaseShortId(scope);
  if (isResourceScope(scope) && !bound) return null;
  return { subject: subjectForScope(scope), boundBaseShortId: bound };
};

export const requireBaseAccess = async (baseId: string, scope: AccessScope, required: PermissionLevel): Promise<Result<void>> => {
  if (!canRequestPermission(scope, required)) return fail(err.forbidden("Access denied"));
  const bound = boundBaseShortId(scope);
  if (isResourceScope(scope) && !bound) return fail(err.forbidden("Access denied"));

  const principalMatch = buildAccessPrincipalCondition({
    subject: subjectForScope(scope),
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const [row] = await sql<{ permission: PermissionLevel }[]>`
    SELECT MAX(a.permission)::text AS permission
    FROM pulse.base_access ba
    JOIN pulse.bases b ON b.id = ba.base_id
    JOIN auth.access a ON a.id = ba.access_id
    WHERE ba.base_id = ${baseId}::uuid
      AND (${bound}::text IS NULL OR b.short_id = ${bound})
      AND ${principalMatch}
  `;
  const level = row?.permission ?? "none";
  return PERMISSION_RANK[level] >= PERMISSION_RANK[required] ? ok() : fail(err.forbidden("Access denied"));
};

export const listBaseIdsVisibleTo = async (
  scope: AccessScope,
  params: { query?: string | null; limit?: number; offset?: number } = {},
): Promise<string[]> => {
  const visibility = readableScopeFilter(scope);
  if (!visibility) return [];

  const principalMatch = buildAccessPrincipalCondition({
    subject: visibility.subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const query = params.query?.trim() || null;
  const pattern = query ? `%${query.replace(/([\\%_])/g, "\\$1")}%` : null;
  const limit = params.limit === undefined ? null : Math.min(1_000, Math.max(1, params.limit));
  const offset = Math.max(0, params.offset ?? 0);
  const rows = await sql<{ id: string }[]>`
    SELECT visible.id
    FROM (
      SELECT DISTINCT ba.base_id AS id, b.updated_at, b.name
      FROM pulse.base_access ba
      JOIN auth.access a ON a.id = ba.access_id
      JOIN pulse.bases b ON b.id = ba.base_id
      WHERE ${principalMatch}
        AND a.permission <> 'none'
        AND (${visibility.boundBaseShortId}::text IS NULL OR b.short_id = ${visibility.boundBaseShortId})
        AND b.deletion_started_at IS NULL
        AND (${pattern}::text IS NULL OR b.name ILIKE ${pattern} ESCAPE '\\' OR b.description ILIKE ${pattern} ESCAPE '\\')
    ) visible
    ORDER BY visible.updated_at DESC, visible.name ASC, visible.id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
  return rows.map((row) => row.id);
};

export const requireBaseActive = async (baseId: string): Promise<Result<void>> => {
  const [row] = await sql<
    {
      deletion_started_at: Date | string | null;
      data_clear_started_at: Date | string | null;
      data_clear_completed_at: Date | string | null;
      data_clear_failed_at: Date | string | null;
    }[]
  >`
    SELECT deletion_started_at, data_clear_started_at, data_clear_completed_at, data_clear_failed_at
    FROM pulse.bases
    WHERE id = ${baseId}::uuid
  `;
  if (!row) return fail(err.notFound("Pulse base"));
  if (row.deletion_started_at) return fail(err.conflict("Pulse base is being deleted"));
  if (row.data_clear_started_at && !row.data_clear_completed_at && !row.data_clear_failed_at) {
    return fail(err.conflict("Pulse base data is being cleared"));
  }
  return ok();
};
