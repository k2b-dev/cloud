import { sql } from "bun";
import { createRemoteJWKSet, decodeProtectedHeader, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { User } from "../contracts/shared";
import { isAccountCategoryAllowed } from "./account-category-policy";
import { isAccountExpired } from "./account-model";
import { IDENTITY_JWKS_MAX_AGE_SECONDS } from "./identity/constants";
import { getIdentityRuntimeConfig } from "./identity/runtime-config";
import type { ServiceAccount } from "./service-accounts";
import { buildProjectedUser, userProjectionSql } from "./session/user";

type ServiceAccountActorRow = Record<string, unknown> & {
  service_account_id: string;
  service_account_name: string;
  service_account_kind: ServiceAccount["kind"];
  service_account_status: ServiceAccount["status"];
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  service_account_created_by: string | null;
  service_account_created_at: Date | string;
};

type RemoteSetState = { key: JWTVerifyGetKey; lastForcedRefreshAt: number };
const remoteSets = new Map<string, RemoteSetState>();

const createRemoteSet = (url: URL): JWTVerifyGetKey =>
  createRemoteJWKSet(url, {
    cacheMaxAge: IDENTITY_JWKS_MAX_AGE_SECONDS * 1_000,
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });

const remoteSet = (url: URL): RemoteSetState => {
  const existing = remoteSets.get(url.href);
  if (existing) return existing;
  const created = { key: createRemoteSet(url), lastForcedRefreshAt: 0 };
  remoteSets.set(url.href, created);
  return created;
};

const parseScopeClaim = (payload: JWTPayload): string[] => {
  const value = payload.scope;
  if (typeof value !== "string") return [];
  return value
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
};

export type AuthenticatedOAuthToken =
  | {
      kind: "user";
      payload: JWTPayload;
      user: User;
      scopes: string[];
    }
  | {
      kind: "service_account";
      payload: JWTPayload;
      serviceAccount: ServiceAccount;
      delegatedUser: User | null;
      scopes: string[];
    };

const getStringClaim = (payload: JWTPayload, key: string): string | null => {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const uuidClaim = (payload: JWTPayload, key: string): string | null => {
  const value = getStringClaim(payload, key);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
};

const mapServiceAccount = (row: ServiceAccountActorRow): ServiceAccount => ({
  id: row.service_account_id,
  name: row.service_account_name,
  kind: row.service_account_kind,
  status: row.service_account_status,
  delegatedUserId: row.delegated_user_id,
  appId: row.app_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  createdBy: row.service_account_created_by,
  createdAt: new Date(row.service_account_created_at).toISOString(),
});

/** Resolve the live OAuth client/principal, then check current account-category policy. */
export const resolveOAuthTokenActor = async (
  payload: JWTPayload,
  groupsAdmin: string[],
  query: typeof sql = sql,
): Promise<AuthenticatedOAuthToken | null> => {
  const clientId = getStringClaim(payload, "client_id");
  if (!clientId) return null;
  const scopes = parseScopeClaim(payload);
  const rawServiceAccountId = getStringClaim(payload, "service_account_id");

  if (rawServiceAccountId) {
    const serviceAccountId = uuidClaim(payload, "service_account_id");
    if (!serviceAccountId) return null;
    const rows = await query<ServiceAccountActorRow[]>`
      SELECT
        sa.id AS service_account_id,
        sa.name AS service_account_name,
        sa.kind AS service_account_kind,
        sa.status AS service_account_status,
        sa.delegated_user_id,
        sa.app_id,
        sa.resource_type,
        sa.resource_id,
        sa.created_by AS service_account_created_by,
        sa.created_at AS service_account_created_at,
        ${userProjectionSql(groupsAdmin)}
      FROM oauth.clients c
      JOIN auth.service_accounts sa ON sa.id = ${serviceAccountId}::uuid AND sa.status = 'active'
      LEFT JOIN auth.users u ON u.id = sa.delegated_user_id
      LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id
      WHERE c.client_id = ${clientId}
    `;
    const row = rows[0];
    if (!row) return null;
    const serviceAccount = mapServiceAccount(row);
    const delegatedUser = serviceAccount.delegatedUserId ? buildProjectedUser(row) : null;
    if (serviceAccount.kind === "user_delegated" && !delegatedUser) return null;
    if (delegatedUser && isAccountExpired(delegatedUser.accountExpires)) return null;
    if (delegatedUser && !(await isAccountCategoryAllowed(delegatedUser, query))) return null;
    return { kind: "service_account", payload, serviceAccount, delegatedUser, scopes };
  }

  const rawUserId = getStringClaim(payload, "id");
  const userId = rawUserId ? uuidClaim(payload, "id") : null;
  if (rawUserId && !userId) return null;
  const uid = getStringClaim(payload, "uid") ?? (typeof payload.sub === "string" ? payload.sub : null);
  if (!userId && !uid) return null;
  const predicate = userId ? sql`u.id = ${userId}::uuid` : sql`u.uid = ${uid}`;
  const rows = await query<Record<string, unknown>[]>`
    SELECT ${userProjectionSql(groupsAdmin)}
    FROM oauth.clients c
    JOIN auth.users u ON ${predicate}
    LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id
    WHERE c.client_id = ${clientId}
  `;
  const user = rows[0] ? buildProjectedUser(rows[0]) : null;
  if (!user || isAccountExpired(user.accountExpires)) return null;
  if (!(await isAccountCategoryAllowed(user, query))) return null;
  return { kind: "user", payload, user, scopes };
};

export const verifyAccessToken = async (
  token: string,
  expectedAudience: string | string[] = "cloud",
  options: {
    issuer?: string;
    key?: JWTVerifyGetKey;
    jwksUrl?: URL;
    groupsAdmin?: string[];
    query?: typeof sql;
  } = {},
): Promise<AuthenticatedOAuthToken | null> => {
  let remote: { url: URL; state: RemoteSetState } | null = null;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 200) return null;

    const completeOverride = Boolean(options.issuer && (options.key || options.jwksUrl) && options.groupsAdmin);
    const runtime = completeOverride ? null : await getIdentityRuntimeConfig();
    const issuer = options.issuer ?? runtime!.issuer;
    const jwksUrl = options.jwksUrl ?? runtime?.oauthJwksUrl;
    const groupsAdmin = options.groupsAdmin ?? runtime!.groupsAdmin;
    const state = options.key || !jwksUrl ? null : remoteSet(jwksUrl);
    if (state && jwksUrl) remote = { url: jwksUrl, state };
    let key = options.key ?? state?.key;
    if (!key) return null;

    const verify = (candidate: JWTVerifyGetKey) =>
      jwtVerify(token, candidate, {
        algorithms: ["RS256"],
        issuer,
        audience: expectedAudience,
      });
    let verified: Awaited<ReturnType<typeof verify>>;
    try {
      verified = await verify(key);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || !remote) throw error;
      const now = Date.now();
      if (now - remote.state.lastForcedRefreshAt < 30_000) throw error;
      remote.state.lastForcedRefreshAt = now;
      key = createRemoteSet(remote.url);
      remote.state.key = key;
      verified = await verify(key);
    }

    if (verified.payload.token_use !== "access") return null;
    return resolveOAuthTokenActor(verified.payload, groupsAdmin, options.query);
  } catch {
    return null;
  }
};

export const clearOAuthVerifierCachesForTest = (): void => {
  remoteSets.clear();
};

export const oauthTokens = {
  verifyAccessToken,
};
