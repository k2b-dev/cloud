import { accounts, serviceAccounts, toPgTextArray } from "@valentinkolb/cloud/services";
import { isAccountExpired } from "@valentinkolb/cloud/services/account-model";
import { sql } from "bun";
import * as jose from "jose";
import { DYNAMIC_CLIENT_SCOPES, type OAuthClient, type OAuthScope } from "@/contracts";
import * as refreshTokens from "./refresh-tokens";
import {
  issueOAuthTokenBatch,
  type OAuthTokenRequest,
  type OAuthUserGrantReference,
  type ServiceAccessTokenRequest,
  type UserAccessTokenRequest,
  type UserIdTokenRequest,
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
    super("Client is not bound to an active resource service account");
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

const createClientCredentialsAuthorityGrant = async (params: {
  clientId: string;
  scopes: OAuthScope[];
  audiences: string[];
  resource: string | null;
}): Promise<{ kind: "client_credentials"; grantId: string; nonce: string }> => {
  const [grant] = await sql<{ id: string; nonce: string }[]>`
    INSERT INTO oauth.client_credentials_authority_grants (client_id, scopes, audiences, resource)
    VALUES (
      ${params.clientId},
      ${toPgTextArray(params.scopes)}::text[],
      ${toPgTextArray(params.audiences)}::text[],
      ${params.resource}
    )
    RETURNING id, nonce
  `;
  if (!grant) throw new Error("Failed to reserve OAuth client credentials authority");
  return { kind: "client_credentials", grantId: grant.id, nonce: grant.nonce };
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

export const cleanupAuthorityGrants = async (): Promise<number> => {
  const deleted = await sql`
    DELETE FROM oauth.client_credentials_authority_grants
    WHERE expires_at < now() OR consumed_at < now() - INTERVAL '1 hour'
  `;
  return deleted.count;
};

const getOAuthVerificationKey = async (): Promise<jose.JWTVerifyGetKey> => {
  const configuredOrigin = process.env.CLOUD_OAUTH_JWKS_ORIGIN?.trim();
  if (configuredOrigin) {
    const url = new URL("/.well-known/jwks.json", configuredOrigin);
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
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  userinfo_endpoint: `${issuer}/oauth/userinfo`,
  end_session_endpoint: `${issuer}/oauth/logout`,
  revocation_endpoint: `${issuer}/oauth/revoke`,
  jwks_uri: `${issuer}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  scopes_supported: [...DYNAMIC_CLIENT_SCOPES],
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
    "service_account_id",
    "service_account_kind",
    "app_id",
    "resource_type",
    "resource_id",
  ],
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
  resource_parameter_supported: true,
  // Authorization responses include RFC 9207 `iss`; keep its optional support
  // flag unadvertised until current loopback MCP clients preserve the value.
});

/**
 * Create access token and optionally id_token
 */
export const createTokens = async (params: {
  userId: string;
  client: OAuthClient;
  scopes?: OAuthScope[];
  audiences?: string[];
  resource?: string | null;
  issueRefreshToken?: boolean;
  refreshTokenLabel?: string | null;
  authorityGrant: OAuthUserGrantReference;
}): Promise<{
  accessToken: string;
  idToken: string | null;
  expiresIn: number;
  scope: string;
  refreshToken?: string;
}> => {
  const { userId, client, authorityGrant } = params;
  const scopes = params.scopes ?? client.scopes;
  const audiences = params.audiences ?? client.audiences;
  const accessTokenAudiences = params.audiences ? dedupe(params.audiences) : dedupe(["cloud", client.clientId, ...audiences]);

  const expiresIn = ACCESS_TOKEN_LIFETIME_SECONDS;
  const scopeValue = scopes.join(" ");

  const requests: OAuthTokenRequest[] = [
    {
      kind: "user_access",
      grant: authorityGrant,
      expiresIn,
    } satisfies UserAccessTokenRequest,
  ];
  if (scopes.includes("openid")) {
    const idTokenRequest: UserIdTokenRequest = {
      kind: "user_id",
      grant: authorityGrant,
      expiresIn,
    };

    requests.push(idTokenRequest);
  }

  const signed = await issueOAuthTokenBatch(requests);
  const accessToken = signed[0]!;
  const idToken = signed[1] ?? null;

  const refreshToken =
    params.issueRefreshToken && refreshTokens.shouldIssueRefreshToken(scopes)
      ? await refreshTokens.create({
          userId,
          client,
          scopes,
          audiences: accessTokenAudiences,
          resource: params.resource,
          label: params.refreshTokenLabel,
        })
      : null;

  return {
    accessToken,
    idToken,
    expiresIn,
    scope: scopeValue,
    ...(refreshToken ? { refreshToken: refreshToken.refreshToken } : {}),
  };
};

/**
 * Create a client-credentials access token for a resource-bound service account.
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
  if (
    !serviceAccount ||
    serviceAccount.status !== "active" ||
    serviceAccount.kind !== "resource_bound" ||
    !serviceAccount.appId ||
    !serviceAccount.resourceType ||
    !serviceAccount.resourceId
  ) {
    throw new InvalidOAuthServiceAccountError();
  }

  const requestedScopes = resolveRequestedScopes(client, scope);
  const expiresIn = ACCESS_TOKEN_LIFETIME_SECONDS;
  const scopeValue = requestedScopes.join(" ");
  const resourceAudiences = validateRequestedResource(client, resource);
  const accessTokenAudiences = resource ? resourceAudiences : getAccessTokenAudience(client);

  const signed = await issueOAuthTokenBatch([
    {
      kind: "service_access",
      grant: await createClientCredentialsAuthorityGrant({
        clientId: client.clientId,
        scopes: requestedScopes,
        audiences: accessTokenAudiences,
        resource: resource ?? null,
      }),
      expiresIn,
    } satisfies ServiceAccessTokenRequest,
  ]);

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
    if (error instanceof jose.errors.JWKSNoMatchingKey && !process.env.CLOUD_OAUTH_JWKS_ORIGIN?.trim()) {
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
export const createUserInfo = async (params: {
  userId: string;
  subject: string;
  scopes: OAuthScope[];
}): Promise<Record<string, unknown> | null> => {
  const { userId, subject, scopes } = params;
  const user = await accounts.users.get({ id: userId });
  if (!user || isAccountExpired(user.accountExpires)) return null;

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
