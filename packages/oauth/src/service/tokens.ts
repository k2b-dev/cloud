import { sql } from "@k2b/cloud";
import { env } from "@k2b/cloud/config";
import type { User } from "@k2b/cloud/contracts";
import { accounts, isStandaloneServiceAccountKind, serviceAccounts } from "@k2b/cloud/services";
import { resolveOAuthJwksUrl } from "@k2b/cloud/services/identity/runtime-config";
import * as settings from "@k2b/cloud/services/settings";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import * as jose from "jose";
import { type OAuthClient, type OAuthScope, OAuthScopeSchema } from "@/contracts";
import { notifyPendingOAuthNewAccess } from "./access-notices";
import {
  finalizeOAuthAuthority,
  InvalidIssuerAuthorityError,
  type OAuthTokenRequest,
  releaseOAuthAuthority,
  stageOAuthAuthority,
} from "./issuer-authority";
import * as refreshTokens from "./refresh-tokens";
import {
  issueOAuthTokenBatch,
  OAuthAuthorityGrantRejectedError,
  OAuthAuthorityRejectedError,
  type OAuthUserGrantReference,
} from "./token-authority";

export { OAuthAuthorityGrantRejectedError } from "./token-authority";

// ==========================
// OAuth Tokens Service (JWT with jose)
// ==========================

type AuthorityKey = {
  public_jwk: jose.JWK | string;
  kid: string;
  state: string;
  verify_until: Date;
};

const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const OAUTH_JWKS_CACHE_MS = 5 * 60_000;
let localVerifier: { key: jose.JWTVerifyGetKey; expiresAt: number } | null = null;
let lastUnknownKeyRefreshAt = 0;
const remoteVerifiers = new Map<string, jose.JWTVerifyGetKey>();

export class InvalidOAuthScopeError extends Error {
  constructor() {
    super("Requested scope is not allowed for this client");
  }
}

export class InvalidOAuthServiceAccountError extends Error {
  constructor() {
    super("Client is not bound to an active service account");
  }
}

export class InvalidOAuthResourceError extends Error {
  constructor() {
    super("Requested resource is not allowed for this client");
  }
}

const dedupe = (values: string[]): string[] => Array.from(new Set(values.filter((value) => value.length > 0)));

const parseScopes = (scope: string | undefined): string[] =>
  scope
    ?.split(" ")
    .map((value) => value.trim())
    .filter((value) => value.length > 0) ?? [];

const resolveRequestedScopes = (client: OAuthClient, requestedScope?: string): OAuthScope[] => {
  const requested = parseScopes(requestedScope);
  if (requested.length === 0) return client.scopes;

  const allowed = new Set(client.scopes);
  if (requested.some((scope) => !allowed.has(scope as OAuthScope))) {
    throw new InvalidOAuthScopeError();
  }
  return requested as OAuthScope[];
};

const getAccessTokenAudience = (client: OAuthClient, resources: string[] = []): string[] =>
  dedupe(["cloud", client.clientId, ...client.audiences, ...resources]);

const validateRequestedResource = (client: OAuthClient, resource: string | undefined): string[] => {
  if (!resource) return [];
  const allowed = new Set(getAccessTokenAudience(client));
  if (!allowed.has(resource)) {
    throw new InvalidOAuthResourceError();
  }
  return [resource];
};

/** Publish only the OAuth-purpose public keys owned by Core. */
export const getJwks = async (): Promise<jose.JSONWebKeySet> => {
  const rows = await sql<AuthorityKey[]>`
    SELECT public_jwk, kid, state, verify_until
    FROM auth.signing_keys
    WHERE purpose = 'oauth'
      AND state IN ('pending', 'active', 'retired')
      AND verify_until > now()
    ORDER BY created_at
  `;
  return {
    keys: rows.map((row) => {
      const key: jose.JWK = typeof row.public_jwk === "string" ? JSON.parse(row.public_jwk) : row.public_jwk;
      return { kty: key.kty, n: key.n, e: key.e, kid: row.kid, use: "sig", alg: "RS256" };
    }),
  };
};

const getOAuthVerificationKey = async (): Promise<jose.JWTVerifyGetKey> => {
  const configuredOrigin = env.CLOUD_OAUTH_JWKS_ORIGIN ?? env.CLOUD_CORE_INTERNAL_ORIGIN;
  if (configuredOrigin) {
    const url = resolveOAuthJwksUrl(configuredOrigin);
    const cacheKey = url.toString();
    const cached = remoteVerifiers.get(cacheKey);
    if (cached) return cached;
    const remote = jose.createRemoteJWKSet(url, {
      cacheMaxAge: OAUTH_JWKS_CACHE_MS,
      cooldownDuration: 1_000,
      timeoutDuration: 5_000,
    });
    remoteVerifiers.set(cacheKey, remote);
    return remote;
  }
  if (localVerifier && localVerifier.expiresAt > Date.now()) return localVerifier.key;
  const key = jose.createLocalJWKSet(await getJwks());
  localVerifier = { key, expiresAt: Date.now() + OAUTH_JWKS_CACHE_MS };
  return key;
};

export const clearOAuthVerifierCacheForTest = (): void => {
  localVerifier = null;
  lastUnknownKeyRefreshAt = 0;
  remoteVerifiers.clear();
};

/**
 * Get OpenID Connect discovery configuration
 */
export const getOpenIdConfiguration = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  userinfo_endpoint: `${issuer}/oauth/userinfo`,
  end_session_endpoint: `${issuer}/oauth/logout`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: [...OAuthScopeSchema.options],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  claims_supported: [
    "sub",
    "uid",
    "id",
    "iss",
    "aud",
    "exp",
    "iat",
    "name",
    "display_name",
    "given_name",
    "family_name",
    "email",
    "nonce",
    "groups",
    "token_use",
    "principal_type",
    "client_id",
    "azp",
    "scope",
    "auth_epoch",
    "service_account_id",
    "service_account_kind",
    "app_id",
    "resource_type",
    "resource_id",
  ],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"],
  resource_parameter_supported: true,
  cloud_login_ttl_supported: true,
  cloud_login_hint_supported: true,
  // Authorization responses include RFC 9207 `iss`; keep its optional support
  // flag unadvertised until current loopback MCP clients preserve the value.
});

type InitialUserGrant = Exclude<OAuthUserGrantReference, { kind: "refresh_token" }>;
type TokenGrantParams =
  | { authorityGrant: InitialUserGrant; authEpoch: number }
  | { authorityGrant: Extract<OAuthUserGrantReference, { kind: "refresh_token" }> };

/** Create access and optional ID tokens from the current grant authority. */
export const createTokens = async (
  params: {
    userId: string;
    client: OAuthClient;
    scopes?: OAuthScope[];
    audiences?: string[];
    resource?: string | null;
    issueRefreshToken?: boolean;
    refreshTokenLabel?: string | null;
    login: { lifetimeSeconds: number } | { endsAt: Date };
  } & TokenGrantParams,
): Promise<{
  accessToken: string;
  idToken: string | null;
  expiresIn: number;
  scope: string;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}> => {
  const { userId, client } = params;
  const scopes = params.scopes ?? client.scopes;
  const audiences = params.audiences ?? client.audiences;
  const accessTokenAudiences = params.audiences ? dedupe(params.audiences) : dedupe(["cloud", client.clientId, ...audiences]);

  const endsAt = "lifetimeSeconds" in params.login ? new Date(Date.now() + params.login.lifetimeSeconds * 1000) : params.login.endsAt;
  const expiresIn = Math.min(ACCESS_TOKEN_LIFETIME_SECONDS, Math.floor((endsAt.getTime() - Date.now()) / 1000));
  if (expiresIn < 1) throw new OAuthAuthorityGrantRejectedError();
  const scopeValue = scopes.join(" ");

  const reservation =
    "authEpoch" in params && params.issueRefreshToken && refreshTokens.shouldIssueRefreshToken(scopes)
      ? await refreshTokens.reserve({
          userId,
          authEpoch: params.authEpoch,
          client,
          scopes,
          audiences: accessTokenAudiences,
          resource: params.resource,
          label: params.refreshTokenLabel,
          expiresAt: endsAt,
        })
      : null;
  const authorityGrant: OAuthUserGrantReference =
    params.authorityGrant.kind !== "refresh_token" && reservation
      ? { ...params.authorityGrant, familyId: reservation.familyId }
      : params.authorityGrant;
  const requests: OAuthTokenRequest[] = [
    {
      kind: "user_access",
      grant: authorityGrant,
      expiresIn,
    },
  ];
  if (scopes.includes("openid")) {
    const idTokenRequest: OAuthTokenRequest = {
      kind: "user_id",
      grant: authorityGrant,
      expiresIn,
    };

    requests.push(idTokenRequest);
  }

  let signed: string[];
  try {
    const issuer = publicCloudOrigin(await settings.get<string>("app.url"));
    const staged = await stageOAuthAuthority(requests, issuer, endsAt);
    signed = await issueOAuthTokenBatch(staged.statement);
    await finalizeOAuthAuthority(staged);
    if (staged.familyId && !staged.terminalConfirmed)
      void notifyPendingOAuthNewAccess({ familyId: staged.familyId }).catch(() => {
        console.error("[oauth] new-access notice remains pending for maintenance");
      });
  } catch (error) {
    if (
      params.authorityGrant.kind !== "refresh_token" &&
      (error instanceof OAuthAuthorityRejectedError || error instanceof InvalidIssuerAuthorityError)
    ) {
      await releaseOAuthAuthority(params.authorityGrant);
    }
    if (reservation) await refreshTokens.revokeFamily(reservation.familyId, "authority_issuance_failed");
    if (error instanceof InvalidIssuerAuthorityError) throw new OAuthAuthorityGrantRejectedError();
    throw error;
  }
  const accessToken = signed[0]!;
  const idToken = signed[1] ?? null;

  return {
    accessToken,
    idToken,
    // Account for time spent signing at the absolute login end.
    expiresIn: Math.min(expiresIn, Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000))),
    scope: scopeValue,
    ...(reservation
      ? { refreshToken: reservation.refreshToken, refreshTokenExpiresIn: Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000)) }
      : {}),
  };
};

/**
 * Create a client-credentials access token for the client's resource-bound or
 * standalone service account.
 */
export const createClientCredentialsToken = async (params: {
  client: OAuthClient;
  scope?: string;
  resource?: string;
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> => {
  const { client, scope, resource } = params;

  if (!client.serviceAccountId) {
    throw new InvalidOAuthServiceAccountError();
  }

  const serviceAccount = await serviceAccounts.get({ id: client.serviceAccountId });
  if (!serviceAccount || serviceAccount.status !== "active") throw new InvalidOAuthServiceAccountError();
  const resourceBound =
    serviceAccount.kind === "resource_bound" && serviceAccount.appId && serviceAccount.resourceType && serviceAccount.resourceId;
  if (!resourceBound && !isStandaloneServiceAccountKind(serviceAccount.kind)) throw new InvalidOAuthServiceAccountError();

  const requestedScopes = resolveRequestedScopes(client, scope);
  const expiresIn = ACCESS_TOKEN_LIFETIME_SECONDS;
  const scopeValue = requestedScopes.join(" ");
  const resourceAudiences = validateRequestedResource(client, resource);
  const accessTokenAudiences = resource ? resourceAudiences : getAccessTokenAudience(client);

  const issuer = publicCloudOrigin(await settings.get<string>("app.url"));
  let staged: Awaited<ReturnType<typeof stageOAuthAuthority>>;
  try {
    staged = await stageOAuthAuthority(
      [
        {
          kind: "service_access",
          expiresIn,
          authority: {
            client_id: client.clientId,
            user_id: null,
            scopes: requestedScopes,
            audiences: accessTokenAudiences,
            resource: resource ?? null,
            nonce: null,
            family_expires_at: null,
          },
        },
      ],
      issuer,
      null,
    );
  } catch (error) {
    if (error instanceof InvalidIssuerAuthorityError) throw new OAuthAuthorityGrantRejectedError();
    throw error;
  }
  const signed = await issueOAuthTokenBatch(staged.statement);

  return { accessToken: signed[0]!, expiresIn, scope: scopeValue };
};

/**
 * Verify access token and return claims
 */
export const verifyAccessToken = async (params: { token: string; issuer: string }): Promise<jose.JWTPayload | null> => {
  try {
    const { payload } = await jose.jwtVerify(params.token, await getOAuthVerificationKey(), {
      issuer: params.issuer,
      algorithms: ["RS256"],
    });
    return payload;
  } catch (error) {
    if (error instanceof jose.errors.JWKSNoMatchingKey && !env.CLOUD_OAUTH_JWKS_ORIGIN && !env.CLOUD_CORE_INTERNAL_ORIGIN) {
      const now = Date.now();
      if (now - lastUnknownKeyRefreshAt < 1_000) return null;
      lastUnknownKeyRefreshAt = now;
      try {
        // An unknown or forged kid must not destroy a still-valid warm cache.
        const key = jose.createLocalJWKSet(await getJwks());
        const { payload } = await jose.jwtVerify(params.token, key, {
          issuer: params.issuer,
          algorithms: ["RS256"],
        });
        localVerifier = { key, expiresAt: Date.now() + OAUTH_JWKS_CACHE_MS };
        return payload;
      } catch {
        return null;
      }
    }
    return null;
  }
};

/**
 * Create userinfo response based on scopes
 * Build UserInfo claims for the already validated access-token subject.
 */
export const createUserInfo = async (params: { user: User; subject: string; scopes: OAuthScope[] }): Promise<Record<string, unknown>> => {
  const { user, subject, scopes } = params;

  const userInfo: Record<string, unknown> = {
    sub: subject,
    uid: user.uid,
    id: user.id,
  };

  if (scopes.includes("profile")) {
    userInfo.name = user.displayName;
    userInfo.display_name = user.displayName;
    userInfo.given_name = user.givenname;
    userInfo.family_name = user.sn;
  }

  if (scopes.includes("email") && user.mail) {
    userInfo.email = user.mail;
  }

  if (scopes.includes("groups")) {
    const groups = await accounts.users.getGroups({ id: user.id, recursive: true });
    userInfo.groups = groups;
  }

  return userInfo;
};
