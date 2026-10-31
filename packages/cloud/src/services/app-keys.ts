import { err, fail, ok, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { appKeyFingerprint, validateAppKeyAppId } from "../app-key";
import type { User } from "../contracts/shared";
import { audit } from "./audit";
import { serviceAccounts } from "./service-accounts";

type AdminActor = Pick<User, "id" | "uid" | "provider" | "roles">;
export type AppKeyMetadata = {
  keyId: string;
  appId: string;
  serviceAccountId: string;
  kind: "app_key";
  name: string;
  publicKey: string;
  grants: "oauth:issue"[];
  fingerprint: string;
  status: "active" | "expired" | "revoked";
  accountStatus: "active" | "disabled";
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
};
type Row = {
  id: string;
  app_id: string;
  service_account_id: string;
  name: string;
  public_key: string;
  oauth_issue_allowed: boolean;
  fingerprint: string;
  key_status: AppKeyMetadata["status"];
  account_status: AppKeyMetadata["accountStatus"];
  created_at: Date;
  created_by: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  last_used_at: Date | null;
};
const map = (row: Row): AppKeyMetadata => ({
  keyId: row.id,
  appId: row.app_id,
  serviceAccountId: row.service_account_id,
  kind: "app_key",
  name: row.name,
  publicKey: row.public_key,
  grants: row.oauth_issue_allowed ? ["oauth:issue"] : [],
  fingerprint: row.fingerprint,
  status: row.key_status,
  accountStatus: row.account_status,
  createdAt: row.created_at.toISOString(),
  createdBy: row.created_by,
  expiresAt: row.expires_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null,
  revokedBy: row.revoked_by,
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
});
const columns = `c.*, sa.app_id, sa.status AS account_status,
  CASE WHEN c.status = 'revoked' THEN 'revoked' WHEN c.expires_at <= now() THEN 'expired' ELSE 'active' END AS key_status`;
const actorForAudit = (actor: AdminActor) => ({ userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles });
const validateAdmin = (actor: AdminActor, appId?: string): Result<void> => {
  if (!actor.roles.includes("admin")) return fail(err.forbidden("Administrator access required"));
  if (appId !== undefined) {
    try {
      validateAppKeyAppId(appId);
    } catch {
      return fail(err.badInput("Invalid or reserved app ID"));
    }
  }
  return ok();
};
const pageParams = (params: { page?: number; perPage?: number }) => ({
  page: Math.max(1, Math.trunc(params.page ?? 1)),
  perPage: Math.min(500, Math.max(1, Math.trunc(params.perPage ?? 100))),
});

/** Durable DB identity, initialized transactionally by Core's migration; never cached or read from env. */
export const getInstallationId = async (db: SQL = sql): Promise<string> => {
  const [row] = await db<{ id: string }[]>`SELECT id FROM auth.installation WHERE singleton = true`;
  if (!row) throw new Error("Core installation identity is not initialized; run Core migrations");
  return row.id;
};

export const registerAppKey = async (params: {
  actor: AdminActor;
  appId: string;
  publicKey: string;
  name?: string;
  expiresAt?: string;
  grants?: "oauth:issue"[];
}): Promise<
  Result<{
    keyId: string;
    installationId: string;
    fingerprint: string;
    status: AppKeyMetadata["status"];
    accountStatus: AppKeyMetadata["accountStatus"];
  }>
> => {
  const valid = validateAdmin(params.actor, params.appId);
  if (!valid.ok) return valid;
  if (params.grants?.some((grant) => grant !== "oauth:issue")) return fail(err.badInput("Unknown app key grant"));
  const name = params.name?.trim() ?? "App key";
  if (!name || name.length > 120) return fail(err.badInput("Key name must contain 1 to 120 characters"));
  let fingerprint: string;
  try {
    fingerprint = await appKeyFingerprint(params.publicKey);
  } catch {
    return fail(err.badInput("Invalid Ed25519 public key: expected a canonical 32-byte base64url point"));
  }
  const expiresAt = params.expiresAt ? new Date(params.expiresAt) : null;
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) return fail(err.badInput("Expiry must be in the future"));
  const account = await serviceAccounts.getOrCreateResourceBound({
    name: `${params.appId} workload`,
    appId: params.appId,
    resourceType: "cloud.app",
    resourceId: params.appId,
    createdBy: params.actor.id,
  });
  if (!account.ok) return account;
  return sql.begin(async (db) => {
    // Resource-bound accounts carry no unique index, so concurrent first enrollments can
    // create more than one account for an app. One transaction lock per app serializes
    // enrollment across Core replicas; keys count and land on the oldest account, the
    // same one getByResource returns.
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`app_key:${params.appId}`}, 0))`;
    const [locked] = await db<{ id: string; status: AppKeyMetadata["accountStatus"] }[]>`
      SELECT id, status FROM auth.service_accounts
      WHERE kind = 'resource_bound' AND app_id = ${params.appId} AND resource_type = 'cloud.app' AND resource_id = ${params.appId}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE`;
    if (!locked) return fail(err.notFound("Service account"));
    const accountId = locked.id;
    const accountStatus = locked.status;
    const installationId = await getInstallationId(db);
    const [existing] = await db<{ id: string; fingerprint: string; status: AppKeyMetadata["status"] }[]>`
      SELECT c.id, c.fingerprint,
        CASE WHEN c.status = 'revoked' THEN 'revoked' WHEN c.expires_at <= now() THEN 'expired' ELSE 'active' END AS status
      FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE sa.kind = 'resource_bound' AND sa.app_id = ${params.appId} AND sa.resource_type = 'cloud.app'
        AND sa.resource_id = ${params.appId} AND c.kind = 'app_key' AND c.public_key = ${params.publicKey}
    `;
    // Revoked/expired keys remain idempotent and are never reactivated.
    if (existing)
      return ok({ keyId: existing.id, installationId, fingerprint: existing.fingerprint, status: existing.status, accountStatus });
    if (accountStatus !== "active")
      return fail({
        ...err.conflict("Service account"),
        message: "The app service account is disabled; enable it before enrolling a new key",
      });
    if (expiresAt && expiresAt.getTime() <= Date.now()) return fail(err.badInput("Expiry must be in the future"));
    const [count] = await db<{ active: number }[]>`
      SELECT count(*)::int AS active FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE sa.kind = 'resource_bound' AND sa.app_id = ${params.appId} AND sa.resource_type = 'cloud.app'
        AND sa.resource_id = ${params.appId} AND c.kind = 'app_key' AND c.status = 'active'
        AND (c.expires_at IS NULL OR c.expires_at > now())
    `;
    if ((count?.active ?? 0) >= 2)
      return fail({ ...err.conflict("App key"), message: "An app can have at most two active keys; revoke an old key first" });
    // Grants are explicit on every new enrollment, including rotation.
    const [row] = await db<{ id: string }[]>`
      INSERT INTO auth.service_account_credentials
        (service_account_id, name, kind, public_key, fingerprint, created_by, expires_at, oauth_issue_allowed)
      VALUES (${accountId}::uuid, ${name}, 'app_key', ${params.publicKey}, ${fingerprint}, ${params.actor.id}::uuid, ${expiresAt}, ${params.grants?.includes("oauth:issue") ?? false})
      RETURNING id
    `;
    if (!row) throw new Error("App key registration returned no key");
    await audit.record(
      {
        action: "app_key.create",
        outcome: "allowed",
        actor: actorForAudit(params.actor),
        target: { type: "service_account_credential", id: row.id, label: name },
        metadata: { appId: params.appId, serviceAccountId: accountId, fingerprint, grants: params.grants ?? [] },
      },
      db,
    );
    return ok({ keyId: row.id, installationId, fingerprint, status: "active" as const, accountStatus });
  });
};

export const listAppKeys = async (params: { actor: AdminActor; appId: string; page?: number; perPage?: number }) => {
  const valid = validateAdmin(params.actor, params.appId);
  if (!valid.ok) return valid;
  const { page, perPage } = pageParams(params);
  const rows = await sql<(Row & { total: number })[]>`
    SELECT ${sql.unsafe(columns)}, count(*) OVER()::int AS total FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.kind = 'app_key' AND sa.kind = 'resource_bound' AND sa.app_id = ${params.appId}
      AND sa.resource_type = 'cloud.app' AND sa.resource_id = ${params.appId}
    ORDER BY c.created_at DESC, c.id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `;
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    const [count] = await sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.kind = 'app_key' AND sa.kind = 'resource_bound' AND sa.app_id = ${params.appId}
        AND sa.resource_type = 'cloud.app' AND sa.resource_id = ${params.appId}
    `;
    total = count?.total ?? 0;
  }
  return ok({ installationId: await getInstallationId(), items: rows.map(map), page, perPage, total, hasNext: page * perPage < total });
};

export const listAppsWithKeys = async (params: { actor: AdminActor; page?: number; perPage?: number }) => {
  const valid = validateAdmin(params.actor);
  if (!valid.ok) return valid;
  const { page, perPage } = pageParams(params);
  const rows = await sql<
    { appId: string; accountStatus: AppKeyMetadata["accountStatus"]; totalKeys: number; activeKeys: number; total: number }[]
  >`
    SELECT sa.app_id AS "appId", sa.status AS "accountStatus", count(*)::int AS "totalKeys",
      count(*) FILTER (WHERE c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now()))::int AS "activeKeys",
      count(*) OVER()::int AS total
    FROM auth.service_account_credentials c JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.kind = 'app_key' AND sa.kind = 'resource_bound' AND sa.resource_type = 'cloud.app' AND sa.resource_id = sa.app_id
    GROUP BY sa.app_id, sa.status ORDER BY sa.app_id LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
  `;
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    const [count] = await sql<{ total: number }[]>`
      SELECT count(DISTINCT sa.app_id)::int AS total FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.kind = 'app_key' AND sa.kind = 'resource_bound' AND sa.resource_type = 'cloud.app' AND sa.resource_id = sa.app_id
    `;
    total = count?.total ?? 0;
  }
  return ok({
    installationId: await getInstallationId(),
    items: rows.map(({ total: _, ...row }) => row),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  });
};

export const revokeAppKey = async (params: { actor: AdminActor; appId: string; keyId: string }): Promise<Result<void>> => {
  const valid = validateAdmin(params.actor, params.appId);
  if (!valid.ok) return valid;
  if (params.keyId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.keyId))
    return fail(err.notFound("App key"));
  return sql.begin(async (db) => {
    const [key] = await db<{ id: string; service_account_id: string; status: string; name: string; fingerprint: string }[]>`
      SELECT c.id, c.service_account_id, c.status, c.name, c.fingerprint FROM auth.service_account_credentials c
      JOIN auth.service_accounts sa ON sa.id = c.service_account_id
      WHERE c.id = ${params.keyId}::uuid AND c.kind = 'app_key' AND sa.app_id = ${params.appId}
        AND sa.kind = 'resource_bound' AND sa.resource_type = 'cloud.app' AND sa.resource_id = ${params.appId}
      FOR UPDATE OF sa, c
    `;
    if (!key) return fail(err.notFound("App key"));
    if (key.status === "revoked") return ok();
    await db`UPDATE auth.service_account_credentials SET status = 'revoked', revoked_at = now(), revoked_by = ${params.actor.id}::uuid
      WHERE id = ${key.id}::uuid`;
    await audit.record(
      {
        action: "app_key.revoke",
        outcome: "allowed",
        actor: actorForAudit(params.actor),
        target: { type: "service_account_credential", id: key.id, label: key.name },
        metadata: { appId: params.appId, serviceAccountId: key.service_account_id, fingerprint: key.fingerprint },
      },
      db,
    );
    return ok();
  });
};

/** Bootstrap and signed workload requests must query this directly; no cache. */
export const getActiveAppKey = async (
  params: { appId: string; keyId: string },
  db: SQL = sql,
): Promise<(AppKeyMetadata & { connectionsAllowed: boolean; oauthIssueAllowed: boolean }) | null> => {
  try {
    validateAppKeyAppId(params.appId);
  } catch {
    return null;
  }
  if (params.keyId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.keyId))
    return null;
  const [row] = await db<(Row & { connections_allowed: boolean })[]>`
    SELECT ${db.unsafe(columns)} FROM auth.service_account_credentials c
    JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.kind = 'app_key' AND c.id = ${params.keyId}::uuid AND c.status = 'active'
      AND (c.expires_at IS NULL OR c.expires_at > now()) AND sa.status = 'active'
      AND sa.kind = 'resource_bound' AND sa.app_id = ${params.appId} AND sa.resource_type = 'cloud.app' AND sa.resource_id = ${params.appId}
  `;
  return row ? { ...map(row), connectionsAllowed: row.connections_allowed, oauthIssueAllowed: row.oauth_issue_allowed } : null;
};

/** Call only after successful authentication; a late touch cannot revive a key. */
export const touchAppKey = async (params: { appId: string; keyId: string }, db: SQL = sql): Promise<void> => {
  const key = await getActiveAppKey(params, db);
  if (!key) return;
  await db`UPDATE auth.service_account_credentials SET last_used_at = now() WHERE id = ${key.keyId}::uuid AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())`;
};

export const appKeys = { register: registerAppKey, list: listAppKeys, listApps: listAppsWithKeys, revoke: revokeAppKey };
