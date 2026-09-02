import { createHash, timingSafeEqual } from "node:crypto";
import { crypto, err, fail, ok, type PageParams, type Paginated, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import type { User } from "../contracts/shared";
import { accounts } from "./accounts";
import { audit } from "./audit";
import { isUniqueViolation, toPgTextArray } from "./postgres";
import { type ServiceAccount, serviceAccounts } from "./service-accounts";

export type ServiceAccountCredentialStatus = "active" | "revoked";
export type ServiceAccountCredentialKind = "api_token";

export type ServiceAccountCredential = {
  id: string;
  serviceAccountId: string;
  name: string;
  kind: ServiceAccountCredentialKind;
  status: ServiceAccountCredentialStatus;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
};

export type AuthenticatedServiceAccountCredential = {
  credential: ServiceAccountCredential;
  serviceAccount: ServiceAccount;
  delegatedUser: User | null;
};

export type ServiceAccountCredentialOwner =
  | {
      type: "user";
      userId: string;
      uid: string;
      displayName: string;
      mail: string | null;
      avatarHash: string | null;
    }
  | {
      type: "resource";
      appId: string;
      resourceType: string;
      resourceId: string;
    };

export type ServiceAccountCredentialOverview = ServiceAccountCredential & {
  serviceAccount: ServiceAccount;
  owner: ServiceAccountCredentialOwner;
};

type DbCredentialRow = {
  id: string;
  service_account_id: string;
  name: string;
  kind: ServiceAccountCredentialKind;
  status: ServiceAccountCredentialStatus;
  token_prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
};

type DbCredentialWithSecretRow = DbCredentialRow & {
  activity_due: boolean;
  secret_hash: string;
} & DbCredentialServiceAccountFields;

type DbCredentialServiceAccountFields = {
  service_account_id: string;
  service_account_name: string;
  service_account_kind: ServiceAccount["kind"];
  service_account_status: ServiceAccount["status"];
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  service_account_created_by: string | null;
  service_account_created_at: Date;
};

type SqlRunner = SQL;
type DbCredentialOverviewRow = DbCredentialRow &
  DbCredentialServiceAccountFields & {
    delegated_uid: string | null;
    delegated_display_name: string | null;
    delegated_mail: string | null;
    delegated_avatar_hash: string | null;
  };

const TOKEN_PREFIX = "cld";
const TOKEN_PATTERN = /^cld_([0-9a-f]{24})_([0-9a-f]{64})$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_HASH_PATTERN = /^sha256:([0-9a-f]{64})$/;
const SUCCESS_ACTIVITY_INTERVAL_MS = 60_000;

const isForeignKeyViolation = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; errno?: string };
  return e.code === "23503" || e.errno === "23503";
};

const USER_DELEGATED_UNIQUE_CONSTRAINT = "uniq_service_accounts_user_delegated";

const mapCredential = (row: DbCredentialRow): ServiceAccountCredential => ({
  id: row.id,
  serviceAccountId: row.service_account_id,
  name: row.name,
  kind: row.kind,
  status: row.status,
  tokenPrefix: row.token_prefix,
  scopes: row.scopes ?? [],
  expiresAt: row.expires_at?.toISOString() ?? null,
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revokedBy: row.revoked_by,
});

const mapServiceAccount = (row: DbCredentialServiceAccountFields): ServiceAccount => ({
  id: row.service_account_id,
  name: row.service_account_name,
  kind: row.service_account_kind,
  status: row.service_account_status,
  delegatedUserId: row.delegated_user_id,
  appId: row.app_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  createdBy: row.service_account_created_by,
  createdAt: row.service_account_created_at.toISOString(),
});

const mapCredentialOverview = (row: DbCredentialOverviewRow): ServiceAccountCredentialOverview => {
  const serviceAccount = mapServiceAccount(row);
  return {
    ...mapCredential(row),
    serviceAccount,
    owner:
      serviceAccount.kind === "user_delegated" && serviceAccount.delegatedUserId
        ? {
            type: "user",
            userId: serviceAccount.delegatedUserId,
            uid: row.delegated_uid ?? serviceAccount.delegatedUserId,
            displayName: row.delegated_display_name ?? "",
            mail: row.delegated_mail,
            avatarHash: row.delegated_avatar_hash,
          }
        : {
            type: "resource",
            appId: serviceAccount.appId ?? "",
            resourceType: serviceAccount.resourceType ?? "",
            resourceId: serviceAccount.resourceId ?? "",
          },
  };
};

const actorForUser = (user: Pick<User, "id" | "uid" | "provider" | "roles">) => ({
  userId: user.id,
  uid: user.uid,
  provider: user.provider,
  roles: user.roles,
});

const normalizeName = (value: string): string => value.trim();

const parseToken = (token: string): { tokenPrefix: string; secret: string } | null => {
  const match = token.match(TOKEN_PATTERN);
  if (!match) return null;
  return { tokenPrefix: match[1]!.toLowerCase(), secret: match[2]!.toLowerCase() };
};

const generateTokenParts = (): { tokenPrefix: string; secret: string; token: string } => {
  const tokenPrefix = crypto.common.generateKey(12);
  const secret = crypto.common.generateKey(32);
  return { tokenPrefix, secret, token: `${TOKEN_PREFIX}_${tokenPrefix}_${secret}` };
};

// API token secrets carry 256 bits of entropy, so a fast digest is sufficient and avoids password-KDF cost per request.
const hashApiTokenSecret = (secret: string): string => `sha256:${createHash("sha256").update(secret).digest("hex")}`;

const verifyApiTokenSecret = async (secret: string, storedHash: string): Promise<boolean> => {
  const match = storedHash.match(SECRET_HASH_PATTERN);
  if (match) {
    const actual = Buffer.from(hashApiTokenSecret(secret).slice("sha256:".length), "hex");
    const expected = Buffer.from(match[1]!, "hex");
    return timingSafeEqual(actual, expected);
  }

  try {
    return await Bun.password.verify(secret, storedHash);
  } catch {
    return false;
  }
};

const generateUniqueTokenParts = async (): Promise<{ tokenPrefix: string; secret: string; token: string }> => {
  for (let i = 0; i < 5; i += 1) {
    const parts = generateTokenParts();
    const [row] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(
        SELECT 1 FROM auth.service_account_credentials WHERE token_prefix = ${parts.tokenPrefix}
      ) AS exists
    `;
    if (!row?.exists) return parts;
  }
  throw new Error("Failed to generate unique API token prefix");
};

export const isApiToken = (token: string | null | undefined): boolean => Boolean(token && TOKEN_PATTERN.test(token));

export const getOrCreateUserDelegatedServiceAccount = async (params: {
  userId: string;
  createdBy?: string | null;
}): Promise<Result<ServiceAccount>> => {
  const [existing] = await sql<
    {
      id: string;
      name: string;
      kind: ServiceAccount["kind"];
      status: ServiceAccount["status"];
      delegated_user_id: string | null;
      app_id: string | null;
      resource_type: string | null;
      resource_id: string | null;
      created_by: string | null;
      created_at: Date;
    }[]
  >`
    SELECT id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
    FROM auth.service_accounts
    WHERE kind = 'user_delegated'
      AND delegated_user_id = ${params.userId}::uuid
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (existing) {
    return ok({
      id: existing.id,
      name: existing.name,
      kind: existing.kind,
      status: existing.status,
      delegatedUserId: existing.delegated_user_id,
      appId: existing.app_id,
      resourceType: existing.resource_type,
      resourceId: existing.resource_id,
      createdBy: existing.created_by,
      createdAt: existing.created_at.toISOString(),
    });
  }

  try {
    return await serviceAccounts.createUserDelegated({
      name: "Personal API keys",
      delegatedUserId: params.userId,
      createdBy: params.createdBy ?? params.userId,
    });
  } catch (error) {
    if (!isUniqueViolation(error, USER_DELEGATED_UNIQUE_CONSTRAINT)) throw error;
    const [row] = await sql<
      {
        id: string;
        name: string;
        kind: ServiceAccount["kind"];
        status: ServiceAccount["status"];
        delegated_user_id: string | null;
        app_id: string | null;
        resource_type: string | null;
        resource_id: string | null;
        created_by: string | null;
        created_at: Date;
      }[]
    >`
      SELECT id, name, kind, status, delegated_user_id, app_id, resource_type, resource_id, created_by, created_at
      FROM auth.service_accounts
      WHERE kind = 'user_delegated'
        AND delegated_user_id = ${params.userId}::uuid
      LIMIT 1
    `;
    if (!row) return fail(err.internal("Failed to load user service account"));
    return ok({
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
  }
};

const insertApiToken = async (
  db: SqlRunner,
  params: {
    serviceAccountId: string;
    name: string;
    createdBy?: string | null;
    expiresAt?: string | null;
    scopes?: string[];
  },
): Promise<Result<{ credential: ServiceAccountCredential; token: string }>> => {
  if (!UUID_PATTERN.test(params.serviceAccountId)) return fail(err.notFound("Service account"));
  const name = normalizeName(params.name);
  if (!name) return fail(err.badInput("API key name is required"));
  if (name.length > 120) return fail(err.badInput("API key name must be 120 characters or fewer"));

  let expiresAt: Date | null = null;
  if (params.expiresAt) {
    expiresAt = new Date(params.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) return fail(err.badInput("Invalid expiry date"));
    if (expiresAt.getTime() <= Date.now()) return fail(err.badInput("Expiry must be in the future"));
  }

  const parts = await generateUniqueTokenParts();
  const secretHash = hashApiTokenSecret(parts.secret);

  try {
    const [row] = await db<DbCredentialRow[]>`
      INSERT INTO auth.service_account_credentials (
        service_account_id,
        name,
        token_prefix,
        secret_hash,
        scopes,
        expires_at,
        created_by
      )
      VALUES (
        ${params.serviceAccountId}::uuid,
        ${name},
        ${parts.tokenPrefix},
        ${secretHash},
        ${toPgTextArray(params.scopes ?? [])}::text[],
        ${expiresAt},
        ${params.createdBy ?? null}::uuid
      )
      RETURNING id, service_account_id, name, kind, status, token_prefix, scopes, expires_at, last_used_at, created_by, created_at, revoked_at, revoked_by
    `;
    if (!row) return fail(err.internal("Failed to create API key"));
    return ok({ credential: mapCredential(row), token: parts.token });
  } catch (error) {
    if (isForeignKeyViolation(error)) return fail(err.notFound("Service account"));
    if (isUniqueViolation(error)) return fail(err.conflict("API key"));
    throw error;
  }
};

export const createApiToken = (params: {
  serviceAccountId: string;
  name: string;
  createdBy?: string | null;
  expiresAt?: string | null;
  scopes?: string[];
}): Promise<Result<{ credential: ServiceAccountCredential; token: string }>> => insertApiToken(sql, params);

export const createUserApiToken = async (params: {
  user: User;
  name: string;
  expiresAt?: string | null;
}): Promise<Result<{ credential: ServiceAccountCredential; token: string }>> => {
  const serviceAccountResult = await getOrCreateUserDelegatedServiceAccount({
    userId: params.user.id,
    createdBy: params.user.id,
  });
  if (!serviceAccountResult.ok) return fail(serviceAccountResult.error);

  return sql.begin(async (tx) => {
    const result = await insertApiToken(tx, {
      serviceAccountId: serviceAccountResult.data.id,
      name: params.name,
      expiresAt: params.expiresAt,
      createdBy: params.user.id,
    });

    return audit.recordResult({
      action: "service_account_credential.create",
      actor: actorForUser(params.user),
      target: { type: "service_account_credential", id: result.ok ? result.data.credential.id : null, label: params.name },
      metadata: {
        serviceAccountId: serviceAccountResult.data.id,
        kind: "api_token",
        expiresAt: params.expiresAt ?? null,
      },
      result,
      db: tx,
    });
  });
};

export const createResourceApiToken = async (params: {
  serviceAccountId: string;
  actor: User;
  name: string;
  expiresAt?: string | null;
  scopes?: string[];
}): Promise<Result<{ credential: ServiceAccountCredential; token: string }>> => {
  const serviceAccount = await serviceAccounts.get({ id: params.serviceAccountId });
  if (!serviceAccount || serviceAccount.kind !== "resource_bound") return fail(err.notFound("Resource service account"));
  if (serviceAccount.status !== "active") return fail(err.badInput("Resource service account is disabled"));

  return sql.begin(async (tx) => {
    const result = await insertApiToken(tx, {
      serviceAccountId: serviceAccount.id,
      name: params.name,
      expiresAt: params.expiresAt,
      createdBy: params.actor.id,
      scopes: params.scopes,
    });

    return audit.recordResult({
      action: "service_account_credential.create",
      actor: actorForUser(params.actor),
      target: { type: "service_account_credential", id: result.ok ? result.data.credential.id : null, label: params.name },
      metadata: {
        serviceAccountId: serviceAccount.id,
        kind: "api_token",
        serviceAccountKind: serviceAccount.kind,
        appId: serviceAccount.appId,
        resourceType: serviceAccount.resourceType,
        resourceId: serviceAccount.resourceId,
        expiresAt: params.expiresAt ?? null,
      },
      result,
      db: tx,
    });
  });
};

export const listForDelegatedUser = async (params: { userId: string }): Promise<ServiceAccountCredential[]> => {
  const rows = await sql<DbCredentialRow[]>`
    SELECT c.id, c.service_account_id, c.name, c.kind, c.status, c.token_prefix, c.scopes, c.expires_at,
      c.last_used_at, c.created_by, c.created_at, c.revoked_at, c.revoked_by
    FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE sa.kind = 'user_delegated'
      AND sa.delegated_user_id = ${params.userId}::uuid
      AND c.status = 'active'
    ORDER BY c.created_at DESC
  `;
  return rows.map(mapCredential);
};

export const listOverview = async (config?: {
  pagination?: PageParams;
  filter?: {
    search?: string;
    serviceAccountKind?: ServiceAccount["kind"];
    credentialStatus?: ServiceAccountCredentialStatus;
    userId?: string;
    appId?: string;
    resourceType?: string;
    resourceId?: string;
    serviceAccountId?: string;
  };
}): Promise<Paginated<ServiceAccountCredentialOverview>> => {
  const page = Math.max(1, config?.pagination?.page ?? 1);
  const perPage = Math.max(1, Math.min(config?.pagination?.perPage ?? 100, 500));
  const offset = (page - 1) * perPage;
  const search = config?.filter?.search?.trim() || null;
  const serviceAccountKind = config?.filter?.serviceAccountKind ?? null;
  const credentialStatus = config?.filter?.credentialStatus ?? null;
  const userId = config?.filter?.userId ?? null;
  const appId = config?.filter?.appId ?? null;
  const resourceType = config?.filter?.resourceType ?? null;
  const resourceId = config?.filter?.resourceId ?? null;
  const serviceAccountId = config?.filter?.serviceAccountId ?? null;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    LEFT JOIN auth.users du ON du.id = sa.delegated_user_id
    WHERE (${serviceAccountKind}::text IS NULL OR sa.kind = ${serviceAccountKind})
      AND (${credentialStatus}::text IS NULL OR c.status = ${credentialStatus})
      AND (${userId}::uuid IS NULL OR sa.delegated_user_id = ${userId}::uuid)
      AND (${serviceAccountId}::uuid IS NULL OR sa.id = ${serviceAccountId}::uuid)
      AND (${appId}::text IS NULL OR sa.app_id = ${appId})
      AND (${resourceType}::text IS NULL OR sa.resource_type = ${resourceType})
      AND (${resourceId}::text IS NULL OR sa.resource_id = ${resourceId})
      AND (
        ${search}::text IS NULL
        OR c.name ILIKE '%' || ${search} || '%'
        OR c.token_prefix ILIKE '%' || ${search} || '%'
        OR sa.name ILIKE '%' || ${search} || '%'
        OR du.uid ILIKE '%' || ${search} || '%'
        OR du.display_name ILIKE '%' || ${search} || '%'
        OR du.mail ILIKE '%' || ${search} || '%'
        OR sa.app_id ILIKE '%' || ${search} || '%'
        OR sa.resource_type ILIKE '%' || ${search} || '%'
        OR sa.resource_id ILIKE '%' || ${search} || '%'
      )
  `;

  const rows = await sql<DbCredentialOverviewRow[]>`
    SELECT
      c.id,
      c.service_account_id,
      c.name,
      c.kind,
      c.status,
      c.token_prefix,
      c.scopes,
      c.expires_at,
      c.last_used_at,
      c.created_by,
      c.created_at,
      c.revoked_at,
      c.revoked_by,
      sa.name AS service_account_name,
      sa.kind AS service_account_kind,
      sa.status AS service_account_status,
      sa.delegated_user_id,
      sa.app_id,
      sa.resource_type,
      sa.resource_id,
      sa.created_by AS service_account_created_by,
      sa.created_at AS service_account_created_at,
      du.uid AS delegated_uid,
      du.display_name AS delegated_display_name,
      du.mail AS delegated_mail,
      du.avatar_hash AS delegated_avatar_hash
    FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    LEFT JOIN auth.users du ON du.id = sa.delegated_user_id
    WHERE (${serviceAccountKind}::text IS NULL OR sa.kind = ${serviceAccountKind})
      AND (${credentialStatus}::text IS NULL OR c.status = ${credentialStatus})
      AND (${userId}::uuid IS NULL OR sa.delegated_user_id = ${userId}::uuid)
      AND (${serviceAccountId}::uuid IS NULL OR sa.id = ${serviceAccountId}::uuid)
      AND (${appId}::text IS NULL OR sa.app_id = ${appId})
      AND (${resourceType}::text IS NULL OR sa.resource_type = ${resourceType})
      AND (${resourceId}::text IS NULL OR sa.resource_id = ${resourceId})
      AND (
        ${search}::text IS NULL
        OR c.name ILIKE '%' || ${search} || '%'
        OR c.token_prefix ILIKE '%' || ${search} || '%'
        OR sa.name ILIKE '%' || ${search} || '%'
        OR du.uid ILIKE '%' || ${search} || '%'
        OR du.display_name ILIKE '%' || ${search} || '%'
        OR du.mail ILIKE '%' || ${search} || '%'
        OR sa.app_id ILIKE '%' || ${search} || '%'
        OR sa.resource_type ILIKE '%' || ${search} || '%'
        OR sa.resource_id ILIKE '%' || ${search} || '%'
      )
    ORDER BY c.created_at DESC
    LIMIT ${perPage}
    OFFSET ${offset}
  `;

  const total = Number.parseInt(countRow?.count ?? "0", 10);
  return {
    items: rows.map(mapCredentialOverview),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

export const getOverview = async (params: { id: string }): Promise<ServiceAccountCredentialOverview | null> => {
  if (!UUID_PATTERN.test(params.id)) return null;
  const [row] = await sql<DbCredentialOverviewRow[]>`
    SELECT
      c.id,
      c.service_account_id,
      c.name,
      c.kind,
      c.status,
      c.token_prefix,
      c.scopes,
      c.expires_at,
      c.last_used_at,
      c.created_by,
      c.created_at,
      c.revoked_at,
      c.revoked_by,
      sa.name AS service_account_name,
      sa.kind AS service_account_kind,
      sa.status AS service_account_status,
      sa.delegated_user_id,
      sa.app_id,
      sa.resource_type,
      sa.resource_id,
      sa.created_by AS service_account_created_by,
      sa.created_at AS service_account_created_at,
      du.uid AS delegated_uid,
      du.display_name AS delegated_display_name,
      du.mail AS delegated_mail,
      du.avatar_hash AS delegated_avatar_hash
    FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    LEFT JOIN auth.users du ON du.id = sa.delegated_user_id
    WHERE c.id = ${params.id}::uuid
    LIMIT 1
  `;
  return row ? mapCredentialOverview(row) : null;
};

export const revokeForDelegatedUser = async (params: { credentialId: string; user: User }): Promise<Result<void>> => {
  if (!UUID_PATTERN.test(params.credentialId)) return fail(err.notFound("API key"));

  return sql.begin(async (tx) => {
    const [row] = await tx<DbCredentialRow[]>`
      UPDATE auth.service_account_credentials c
      SET status = 'revoked',
        revoked_at = now(),
        revoked_by = ${params.user.id}::uuid
      FROM auth.service_accounts sa
      WHERE c.id = ${params.credentialId}::uuid
        AND c.service_account_id = sa.id
        AND sa.kind = 'user_delegated'
        AND sa.delegated_user_id = ${params.user.id}::uuid
        AND c.status = 'active'
      RETURNING c.id, c.service_account_id, c.name, c.kind, c.status, c.token_prefix, c.scopes, c.expires_at,
        c.last_used_at, c.created_by, c.created_at, c.revoked_at, c.revoked_by
    `;

    const result = row ? ok() : fail(err.notFound("API key"));
    return audit.recordResult({
      action: "service_account_credential.revoke",
      actor: actorForUser(params.user),
      target: { type: "service_account_credential", id: params.credentialId, label: row?.name ?? null },
      metadata: { serviceAccountId: row?.service_account_id ?? null },
      result,
      db: tx,
    });
  });
};

type RevokeCredentialInput =
  | { credentialId: string; actor: User; system?: never }
  | { credentialId: string; actor?: never; system: { service: string; reason: string } };

export const revoke = async (params: RevokeCredentialInput, options: { db?: SQL } = {}): Promise<Result<void>> => {
  if (!UUID_PATTERN.test(params.credentialId)) return fail(err.notFound("API key"));

  const run = async (db: SQL): Promise<Result<void>> => {
    const [row] = await db<DbCredentialRow[]>`
      UPDATE auth.service_account_credentials
      SET status = 'revoked',
        revoked_at = now(),
        revoked_by = ${params.actor?.id ?? null}::uuid
      WHERE id = ${params.credentialId}::uuid
        AND status = 'active'
      RETURNING id, service_account_id, name, kind, status, token_prefix, scopes, expires_at,
        last_used_at, created_by, created_at, revoked_at, revoked_by
    `;

    const [existing] = row
      ? [row]
      : await db<DbCredentialRow[]>`
          SELECT id, service_account_id, name, kind, status, token_prefix, scopes, expires_at,
            last_used_at, created_by, created_at, revoked_at, revoked_by
          FROM auth.service_account_credentials
          WHERE id = ${params.credentialId}::uuid
          LIMIT 1
        `;
    const result = row || existing?.status === "revoked" ? ok() : fail(err.notFound("API key"));
    return audit.recordResult({
      action: "service_account_credential.revoke",
      actor: params.actor ? actorForUser(params.actor) : null,
      target: { type: "service_account_credential", id: params.credentialId, label: row?.name ?? existing?.name ?? null },
      metadata: {
        serviceAccountId: row?.service_account_id ?? existing?.service_account_id ?? null,
        ...(params.actor ? { adminAction: true } : { provenance: "system", service: params.system.service, reason: params.system.reason }),
      },
      result,
      db,
    });
  };
  return options.db ? run(options.db) : sql.begin(run);
};

const findActiveByTokenPrefix = async (tokenPrefix: string): Promise<DbCredentialWithSecretRow | null> => {
  const [row] = await sql<DbCredentialWithSecretRow[]>`
    SELECT
      c.id,
      c.service_account_id,
      c.name,
      c.kind,
      c.status,
      c.token_prefix,
      c.secret_hash,
      c.scopes,
      c.expires_at,
      c.last_used_at,
      (
        c.last_used_at IS NULL
        OR c.last_used_at < now() - (${SUCCESS_ACTIVITY_INTERVAL_MS} * interval '1 millisecond')
      ) AS activity_due,
      c.created_by,
      c.created_at,
      c.revoked_at,
      c.revoked_by,
      sa.name AS service_account_name,
      sa.kind AS service_account_kind,
      sa.status AS service_account_status,
      sa.delegated_user_id,
      sa.app_id,
      sa.resource_type,
      sa.resource_id,
      sa.created_by AS service_account_created_by,
      sa.created_at AS service_account_created_at
    FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.token_prefix = ${tokenPrefix}
      AND c.status = 'active'
      AND sa.status = 'active'
      AND (c.expires_at IS NULL OR c.expires_at > now())
    LIMIT 1
  `;
  return row ?? null;
};

const recordSuccessfulAuthentication = async (params: {
  row: DbCredentialWithSecretRow;
  secret: string;
  serviceAccount: ServiceAccount;
  delegatedUser: User | null;
}): Promise<void> => {
  const upgradedSecretHash = SECRET_HASH_PATTERN.test(params.row.secret_hash) ? null : hashApiTokenSecret(params.secret);
  if (!upgradedSecretHash && !params.row.activity_due) return;

  if (upgradedSecretHash) {
    await sql`
      UPDATE auth.service_account_credentials
      SET secret_hash = ${upgradedSecretHash}
      WHERE id = ${params.row.id}::uuid
        AND status = 'active'
        AND secret_hash = ${params.row.secret_hash}
    `;
  }
  if (!params.row.activity_due) return;

  await sql.begin(async (tx) => {
    // Authentication telemetry is best-effort under contention. SKIP LOCKED
    // keeps one replica from queuing live requests behind another replica.
    const [activity] = await tx<{ last_used_at: Date }[]>`
      WITH claimed AS (
        SELECT id
        FROM auth.service_account_credentials
        WHERE id = ${params.row.id}::uuid
          AND status = 'active'
          AND (
            last_used_at IS NULL
            OR last_used_at < now() - (${SUCCESS_ACTIVITY_INTERVAL_MS} * interval '1 millisecond')
          )
        FOR UPDATE SKIP LOCKED
      )
      UPDATE auth.service_account_credentials
      SET last_used_at = now()
      FROM claimed
      WHERE auth.service_account_credentials.id = claimed.id
      RETURNING auth.service_account_credentials.last_used_at
    `;
    if (!activity) return;

    await audit.record(
      {
        action: "service_account_credential.authenticate",
        outcome: "allowed",
        actor: params.delegatedUser ? actorForUser(params.delegatedUser) : null,
        target: { type: "service_account_credential", id: params.row.id, label: params.row.name },
        metadata: {
          serviceAccountId: params.row.service_account_id,
          serviceAccountKind: params.serviceAccount.kind,
        },
      },
      tx,
    );
  });
};

const pendingSecretVerifications = new Map<string, Promise<boolean>>();

const verifyApiTokenSecretOnce = async (secret: string, row: DbCredentialWithSecretRow): Promise<boolean> => {
  const key = `${row.id}:${row.secret_hash}:${hashApiTokenSecret(secret)}`;
  let pending = pendingSecretVerifications.get(key);
  if (!pending) {
    pending = verifyApiTokenSecret(secret, row.secret_hash);
    pendingSecretVerifications.set(key, pending);
  }
  try {
    return await pending;
  } finally {
    if (pendingSecretVerifications.get(key) === pending) pendingSecretVerifications.delete(key);
  }
};

const recordDeniedAuthentication = async (params: {
  reason: string;
  tokenPrefix: string;
  row?: DbCredentialWithSecretRow;
}): Promise<null> => {
  await audit.record({
    action: "service_account_credential.authenticate",
    outcome: "denied",
    ...(params.row ? { target: { type: "service_account_credential" as const, id: params.row.id, label: params.row.name } } : {}),
    reason: params.reason,
    metadata: {
      tokenPrefix: params.tokenPrefix,
      ...(params.row ? { serviceAccountId: params.row.service_account_id } : {}),
    },
  });
  return null;
};

export const authenticateApiToken = async (token: string): Promise<AuthenticatedServiceAccountCredential | null> => {
  const parsed = parseToken(token);
  if (!parsed) return null;

  let row = await findActiveByTokenPrefix(parsed.tokenPrefix);
  if (!row) {
    return recordDeniedAuthentication({
      reason: "API key not found, inactive, or expired",
      tokenPrefix: parsed.tokenPrefix,
    });
  }
  if (!(await verifyApiTokenSecretOnce(parsed.secret, row))) {
    return recordDeniedAuthentication({
      reason: "Invalid API key secret",
      tokenPrefix: parsed.tokenPrefix,
      row,
    });
  }

  // Verification may be expensive. Refresh authorization afterwards so a
  // request cannot join work that began before a credential was revoked.
  const current = await findActiveByTokenPrefix(parsed.tokenPrefix);
  if (!current || current.id !== row.id) {
    return recordDeniedAuthentication({
      reason: "API key not found, inactive, or expired",
      tokenPrefix: parsed.tokenPrefix,
      row,
    });
  }
  if (current.secret_hash !== row.secret_hash && !(await verifyApiTokenSecretOnce(parsed.secret, current))) {
    return recordDeniedAuthentication({
      reason: "Invalid API key secret",
      tokenPrefix: parsed.tokenPrefix,
      row: current,
    });
  }
  row = current;

  const serviceAccount = mapServiceAccount(row);
  const delegatedUser = serviceAccount.delegatedUserId ? await accounts.users.get({ id: serviceAccount.delegatedUserId }) : null;
  if (serviceAccount.kind === "user_delegated" && !delegatedUser) {
    return recordDeniedAuthentication({
      reason: "Delegated user is missing",
      tokenPrefix: parsed.tokenPrefix,
      row,
    });
  }

  await recordSuccessfulAuthentication({ row, secret: parsed.secret, serviceAccount, delegatedUser });

  return {
    credential: mapCredential({ ...row, last_used_at: new Date() }),
    serviceAccount,
    delegatedUser,
  };
};

export const serviceAccountCredentials = {
  isApiToken,
  getOrCreateUserDelegatedServiceAccount,
  createApiToken,
  createUserApiToken,
  createResourceApiToken,
  listForDelegatedUser,
  listOverview,
  getOverview,
  revokeForDelegatedUser,
  revoke,
  authenticateApiToken,
};
