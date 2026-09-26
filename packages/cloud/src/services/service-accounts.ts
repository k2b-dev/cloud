import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { isUniqueViolation } from "./postgres";

export type ServiceAccountKind = "user_delegated" | "resource_bound" | "standalone" | "agent";
export type ServiceAccountStatus = "active" | "disabled";

/**
 * Kinds of a standalone principal: not delegated by a user and not bound to one
 * app resource. `agent` is a standalone account that surfaces as an agent
 * (badge, pickers, activity); it carries no extra permission.
 */
export type StandaloneServiceAccountKind = Extract<ServiceAccountKind, "standalone" | "agent">;
export const STANDALONE_SERVICE_ACCOUNT_KINDS = ["standalone", "agent"] as const satisfies readonly StandaloneServiceAccountKind[];

export const isStandaloneServiceAccountKind = (kind: ServiceAccountKind): kind is StandaloneServiceAccountKind =>
  kind === "standalone" || kind === "agent";

export type ServiceAccount = {
  id: string;
  name: string;
  kind: ServiceAccountKind;
  status: ServiceAccountStatus;
  delegatedUserId: string | null;
  appId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  createdBy: string | null;
  createdAt: string;
};

type DbServiceAccount = {
  id: string;
  name: string;
  kind: ServiceAccountKind;
  status: ServiceAccountStatus;
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_by: string | null;
  created_at: Date;
};

const mapServiceAccount = (row: DbServiceAccount): ServiceAccount => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  status: row.status,
  delegatedUserId: row.delegated_user_id,
  appId: row.app_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

const trimRequired = (value: string): string => value.trim();

const isForeignKeyViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === "23503";
const RESOURCE_BOUND_UNIQUE_CONSTRAINT = "uniq_service_accounts_resource_bound";
const STANDALONE_NAME_UNIQUE_CONSTRAINT = "uniq_service_accounts_standalone_name";
const MAX_NAME_LENGTH = 120;

export const getByResource = async (params: {
  appId: string;
  resourceType: string;
  resourceId: string;
}): Promise<ServiceAccount | null> => {
  const [row] = await sql<DbServiceAccount[]>`
    SELECT id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    FROM auth.service_accounts
    WHERE kind = 'resource_bound'
      AND app_id = ${params.appId}
      AND resource_type = ${params.resourceType}
      AND resource_id = ${params.resourceId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return row ? mapServiceAccount(row) : null;
};

export const get = async (params: { id: string }): Promise<ServiceAccount | null> => {
  const [row] = await sql<DbServiceAccount[]>`
    SELECT id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    FROM auth.service_accounts
    WHERE id = ${params.id}::uuid
  `;
  return row ? mapServiceAccount(row) : null;
};

export const createUserDelegated = async (params: {
  name: string;
  delegatedUserId: string;
  createdBy?: string | null;
}): Promise<Result<ServiceAccount>> => {
  const name = trimRequired(params.name);
  if (!name) return fail(err.badInput("Service account name is required"));

  try {
    const [row] = await sql<DbServiceAccount[]>`
      INSERT INTO auth.service_accounts (name, kind, delegated_user_id, created_by)
      VALUES (${name}, 'user_delegated', ${params.delegatedUserId}::uuid, ${params.createdBy ?? null}::uuid)
      RETURNING id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    `;
    return row ? ok(mapServiceAccount(row)) : fail(err.internal("Failed to create service account"));
  } catch (error) {
    if (isForeignKeyViolation(error)) return fail(err.notFound("Delegated user"));
    throw error;
  }
};

export const createResourceBound = async (params: {
  name: string;
  appId: string;
  resourceType: string;
  resourceId: string;
  createdBy?: string | null;
}): Promise<Result<ServiceAccount>> => {
  const name = trimRequired(params.name);
  const appId = trimRequired(params.appId);
  const resourceType = trimRequired(params.resourceType);
  const resourceId = trimRequired(params.resourceId);
  if (!name) return fail(err.badInput("Service account name is required"));
  if (!appId || !resourceType || !resourceId) return fail(err.badInput("Resource binding is required"));

  try {
    const [row] = await sql<DbServiceAccount[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id, created_by)
      VALUES (${name}, 'resource_bound', ${appId}, ${resourceType}, ${resourceId}, ${params.createdBy ?? null}::uuid)
      RETURNING id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    `;
    return row ? ok(mapServiceAccount(row)) : fail(err.internal("Failed to create service account"));
  } catch (error) {
    if (isForeignKeyViolation(error)) return fail(err.notFound("Creator"));
    if (isUniqueViolation(error, RESOURCE_BOUND_UNIQUE_CONSTRAINT)) return fail(err.conflict("Resource service account"));
    throw error;
  }
};

export const createStandalone = async (params: {
  name: string;
  kind: StandaloneServiceAccountKind;
  createdBy?: string | null;
}): Promise<Result<ServiceAccount>> => {
  const name = trimRequired(params.name);
  if (!name) return fail(err.badInput("Service account name is required"));
  if (name.length > MAX_NAME_LENGTH) return fail(err.badInput(`Service account name must be ${MAX_NAME_LENGTH} characters or fewer`));
  if (!isStandaloneServiceAccountKind(params.kind)) return fail(err.badInput("Service account kind must be standalone or agent"));

  try {
    const [row] = await sql<DbServiceAccount[]>`
      INSERT INTO auth.service_accounts (name, kind, created_by)
      VALUES (${name}, ${params.kind}, ${params.createdBy ?? null}::uuid)
      RETURNING id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    `;
    return row ? ok(mapServiceAccount(row)) : fail(err.internal("Failed to create service account"));
  } catch (error) {
    if (isForeignKeyViolation(error)) return fail(err.notFound("Creator"));
    if (isUniqueViolation(error, STANDALONE_NAME_UNIQUE_CONSTRAINT)) return fail(err.conflict("Service account name"));
    throw error;
  }
};

/** Bounded page of standalone principals; user-delegated and resource-bound accounts stay with their owners. */
export const listStandalone = async (params: {
  kind?: StandaloneServiceAccountKind;
  status?: ServiceAccountStatus;
  search?: string;
  page?: number;
  perPage?: number;
}): Promise<{ items: ServiceAccount[]; page: number; perPage: number; total: number; hasNext: boolean }> => {
  const page = Math.max(1, params.page ?? 1);
  const perPage = Math.max(1, Math.min(params.perPage ?? 100, 500));
  const offset = (page - 1) * perPage;
  const kind = params.kind ?? null;
  const status = params.status ?? null;
  const search = params.search?.trim() || null;
  const rows = await sql<(DbServiceAccount & { total: number })[]>`
    SELECT id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at,
      COUNT(*) OVER()::int AS total
    FROM auth.service_accounts
    WHERE kind IN ('standalone', 'agent')
      AND (${kind}::text IS NULL OR kind = ${kind})
      AND (${status}::text IS NULL OR status = ${status})
      AND (${search}::text IS NULL OR name ILIKE '%' || ${search} || '%')
    ORDER BY created_at DESC, id DESC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;
  const total = rows[0]?.total ?? 0;
  return { items: rows.map(mapServiceAccount), page, perPage, total, hasNext: page * perPage < total };
};

export const getOrCreateResourceBound = async (params: {
  name: string;
  appId: string;
  resourceType: string;
  resourceId: string;
  createdBy?: string | null;
}): Promise<Result<ServiceAccount>> => {
  const existing = await getByResource(params);
  if (existing) return ok(existing);

  const created = await createResourceBound(params);
  if (created.ok || created.error.code !== "CONFLICT") return created;

  const raced = await getByResource(params);
  return raced ? ok(raced) : fail(err.internal("Failed to load resource service account"));
};

export const setStatus = async (params: { id: string; status: ServiceAccountStatus }): Promise<Result<void>> => {
  const result = await sql`
    UPDATE auth.service_accounts
    SET status = ${params.status}
    WHERE id = ${params.id}::uuid
  `;
  if (result.count === 0) return fail(err.notFound("Service account"));
  return ok();
};

export const delete_ = async (params: { id: string }): Promise<Result<void>> => {
  const result = await sql`
    DELETE FROM auth.service_accounts
    WHERE id = ${params.id}::uuid
  `;
  if (result.count === 0) return fail(err.notFound("Service account"));
  return ok();
};

export const deleteForResource = async (params: { appId: string; resourceType: string; resourceId: string }): Promise<number> => {
  const result = await sql`
    DELETE FROM auth.service_accounts
    WHERE kind = 'resource_bound'
      AND app_id = ${params.appId}
      AND resource_type = ${params.resourceType}
      AND resource_id = ${params.resourceId}
  `;
  return result.count;
};

export const serviceAccounts = {
  get,
  createUserDelegated,
  createResourceBound,
  createStandalone,
  listStandalone,
  getByResource,
  getOrCreateResourceBound,
  setStatus,
  delete: delete_,
  deleteForResource,
};
