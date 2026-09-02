import { accounts, serviceAccounts, toPgTextArray } from "@valentinkolb/cloud/services";
import { isAccountExpired } from "@valentinkolb/cloud/services/account-model";
import { sql } from "bun";
import * as jose from "jose";
import { DYNAMIC_CLIENT_SCOPES, type OAuthClient, type OAuthScope } from "@/contracts";
import * as refreshTokens from "./refresh-tokens";
import {
  issueOAuthTokenBatch,
  OAuthAuthorityGrantRejectedError,
  type OAuthIssuanceMode,
  type OAuthTokenRequest,
  type OAuthUserGrantReference,
  oauthIssuanceMode,
  probeOAuthTokenAuthority,
  type ServiceAccessTokenRequest,
  type UserAccessTokenRequest,
  type UserIdTokenRequest,
} from "./token-authority";

export { OAuthAuthorityGrantRejectedError } from "./token-authority";

// ==========================
// OAuth Tokens Service (JWT with jose)
// ==========================

type DbKey = {
  id: string;
  private_key: string;
  public_key: string;
  kid: string;
  created_at: Date;
  retired_at: Date | null;
};

type AuthorityKey = {
  public_jwk: jose.JWK | string;
  kid: string;
  state: string;
  verify_until: Date;
};

type KeyPair = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  kid: string;
};

const ACCESS_TOKEN_LIFETIME_SECONDS = 60 * 60;
const SIGNING_KEY_ROTATION_MS = 30 * 24 * 60 * 60 * 1_000;
const SIGNING_KEY_GRACE_MS = 2 * 60 * 60 * 1_000;
const importedKeyPairs = new Map<string, KeyPair>();
const OAUTH_JWKS_CACHE_MS = 5 * 60_000;
let localVerifier: { key: jose.JWTVerifyGetKey; expiresAt: number } | null = null;
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

export class InactiveOAuthUserError extends Error {
  constructor() {
    super("User account is missing or expired");
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

const importKeyPair = async (row: DbKey): Promise<KeyPair> => {
  const cached = importedKeyPairs.get(row.kid);
  if (cached) return cached;
  const pair = {
    privateKey: await jose.importPKCS8(row.private_key, "RS256"),
    publicKey: await jose.importSPKI(row.public_key, "RS256"),
    kid: row.kid,
  };
  importedKeyPairs.set(row.kid, pair);
  return pair;
};

const generateKeyMaterial = async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair("RS256", {
    modulusLength: 2048,
    extractable: true,
  });
  return {
    privateKey: await jose.exportPKCS8(privateKey),
    publicKey: await jose.exportSPKI(publicKey),
    kid: crypto.randomUUID(),
  };
};

const publicJwk = (value: jose.JWK | string): jose.JWK => (typeof value === "string" ? (JSON.parse(value) as jose.JWK) : value);

const missingSigningKeyTable = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "42P01";

/** New OAuth may roll out before the Core migration; absence means legacy-only read, never an auth bypass. */
const loadAuthorityKeys = async (kid?: string): Promise<AuthorityKey[]> => {
  try {
    return await sql<AuthorityKey[]>`
      SELECT public_jwk, kid, state, verify_until
      FROM auth.signing_keys
      WHERE purpose = 'oauth'
        AND (${kid ?? null}::text IS NULL OR kid = ${kid ?? null})
      ORDER BY created_at
    `;
  } catch (error) {
    if (missingSigningKeyTable(error)) return [];
    throw error;
  }
};

type LegacyTokenRequest = {
  claims: Record<string, unknown>;
  subject: string;
  audiences: string | string[];
  expiresIn: number;
  jti: boolean;
};

const signLegacyRequest = async (request: LegacyTokenRequest, issuer: string, pair: KeyPair): Promise<string> => {
  const now = Math.floor(Date.now() / 1_000);
  let token = new jose.SignJWT(request.claims)
    .setProtectedHeader({ alg: "RS256", kid: pair.kid })
    .setIssuer(issuer)
    .setSubject(request.subject)
    .setAudience(request.audiences)
    .setIssuedAt(now)
    .setExpirationTime(now + request.expiresIn);
  if (request.jti) token = token.setJti(crypto.randomUUID());
  return token.sign(pair.privateKey);
};

const claimLegacyAuthority = async (requests: OAuthTokenRequest[], db: typeof sql): Promise<void> => {
  const access = requests.find((request) => request.kind === "user_access" || request.kind === "service_access");
  if (!access) throw new OAuthAuthorityGrantRejectedError();
  if (access.kind === "service_access") {
    const consumed = await db<{ id: string }[]>`
      UPDATE oauth.client_credentials_authority_grants
      SET consumed_at = now()
      WHERE id = ${access.grant.grantId}::uuid
        AND nonce = ${access.grant.nonce}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id
    `;
    if (consumed.length !== 1) throw new OAuthAuthorityGrantRejectedError();
    return;
  }
  if (access.grant.kind === "authorization_code") {
    if (access.grant.code === "legacy") return;
    const claimed = await db<{ code: string }[]>`
      UPDATE oauth.codes
      SET authority_issued_at = now()
      WHERE code = ${access.grant.code}
        AND authority_nonce = ${access.grant.nonce}::uuid
        AND used = true
        AND authority_issued_at IS NULL
        AND expires_at >= now()
      RETURNING code
    `;
    if (claimed.length !== 1) throw new OAuthAuthorityGrantRejectedError();
    return;
  }
  const claimed = await db<{ id: string }[]>`
    UPDATE oauth.refresh_tokens token
    SET authority_issued_at = now()
    FROM oauth.refresh_token_families family
    WHERE token.id = ${access.grant.tokenId}::uuid
      AND token.authority_nonce = ${access.grant.nonce}::uuid
      AND token.status = 'issuing'
      AND token.authority_issued_at IS NULL
      AND token.expires_at > now()
      AND family.id = token.family_id
      AND family.status = 'active'
      AND family.expires_at > now()
    RETURNING token.id
  `;
  if (claimed.length !== 1) throw new OAuthAuthorityGrantRejectedError();
};

const retireLegacySigningKeys = async (db: typeof sql = sql): Promise<void> => {
  const retired = await db<{ kid: string }[]>`
    UPDATE oauth.keys
    SET retired_at = now(), private_key = ''
    WHERE retired_at IS NULL
    RETURNING kid
  `;
  for (const row of retired) importedKeyPairs.delete(row.kid);
};

const signOAuthTokenBatch = async (
  requests: OAuthTokenRequest[],
  legacyRequests: LegacyTokenRequest[],
  issuer: string,
): Promise<{ tokens: string[]; mode: OAuthIssuanceMode }> => {
  const configuredMode = await ensureConfiguredIssuanceMode();
  if (configuredMode === "core") {
    const tokens = await issueOAuthTokenBatch(requests);
    return { tokens, mode: "core" };
  }
  if (legacyRequests.length !== requests.length) throw new Error("OAuth legacy and authority token batches do not match");
  const signed = await sql.begin(async (tx) => {
    const [state] = await tx<{ mode: OAuthIssuanceMode }[]>`
      SELECT mode FROM oauth.issuance_state WHERE singleton = true FOR SHARE
    `;
    if (!state || state.mode === "core") return null;
    await claimLegacyAuthority(requests, tx as typeof sql);
    const pair = await getOrCreateKeyPairInTransaction(tx as typeof sql);
    return Promise.all(legacyRequests.map((request) => signLegacyRequest(request, issuer, pair)));
  });
  if (signed) return { tokens: signed, mode: "legacy" };
  return { tokens: await issueOAuthTokenBatch(requests), mode: "core" };
};

const loadActiveKey = async (db: typeof sql = sql): Promise<DbKey | null> => {
  const [row] = await db<DbKey[]>`
    SELECT id, private_key, public_key, kid, created_at, retired_at
    FROM oauth.keys
    WHERE retired_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ?? null;
};

const getOrCreateKeyPairInTransaction = async (db: typeof sql): Promise<KeyPair> => {
  const rotationCutoff = new Date(Date.now() - SIGNING_KEY_ROTATION_MS);
  const active = await loadActiveKey(db);
  if (active && active.created_at > rotationCutoff) return importKeyPair(active);

  const generated = await generateKeyMaterial();
  await db`LOCK TABLE oauth.keys IN EXCLUSIVE MODE`;
  const current = await loadActiveKey(db);
  if (current && current.created_at > rotationCutoff) return importKeyPair(current);

  if (current) {
    await db`UPDATE oauth.keys SET retired_at = now(), private_key = '' WHERE id = ${current.id}`;
    importedKeyPairs.delete(current.kid);
  }

  const [persisted] = await db<DbKey[]>`
    INSERT INTO oauth.keys (id, private_key, public_key, kid)
    VALUES (${crypto.randomUUID()}, ${generated.privateKey}, ${generated.publicKey}, ${generated.kid})
    RETURNING id, private_key, public_key, kid, created_at, retired_at
  `;
  if (!persisted) throw new Error("Failed to persist OAuth signing key");

  return importKeyPair(persisted);
};

export const getOAuthIssuanceMode = async (): Promise<OAuthIssuanceMode> => {
  const [state] = await sql<{ mode: OAuthIssuanceMode }[]>`
    SELECT mode FROM oauth.issuance_state WHERE singleton = true
  `;
  if (!state) throw new Error("OAuth issuance state is missing");
  return state.mode;
};

/** Apply the one-way operator cutover after readiness; a database row is authoritative for every replica. */
export const ensureConfiguredIssuanceMode = async (options: { probe?: () => Promise<void> } = {}): Promise<OAuthIssuanceMode> => {
  if (oauthIssuanceMode() !== "core") return getOAuthIssuanceMode();
  if ((await getOAuthIssuanceMode()) === "core") return "core";
  await (options.probe ?? probeOAuthTokenAuthority)();
  return sql.begin(async (tx) => {
    const [state] = await tx<{ mode: OAuthIssuanceMode }[]>`
      SELECT mode FROM oauth.issuance_state WHERE singleton = true FOR UPDATE
    `;
    if (!state) throw new Error("OAuth issuance state is missing");
    if (state.mode === "legacy") {
      await tx`
        UPDATE oauth.issuance_state
        SET mode = 'core', cutover_at = now(), updated_at = now()
        WHERE singleton = true AND mode = 'legacy'
      `;
      await retireLegacySigningKeys(tx as typeof sql);
    }
    return "core" as const;
  });
};

/** Get the active legacy key only while holding the database cutover read lock. */
export const getOrCreateKeyPair = async (): Promise<KeyPair> =>
  sql.begin(async (tx) => {
    const [state] = await tx<{ mode: OAuthIssuanceMode }[]>`
      SELECT mode FROM oauth.issuance_state WHERE singleton = true FOR SHARE
    `;
    if (!state || state.mode !== "legacy") throw new Error("Legacy OAuth signing is disabled by the database cutover");
    return getOrCreateKeyPairInTransaction(tx as typeof sql);
  });

/**
 * Get JWKS (JSON Web Key Set) for public key distribution
 */
export const getJwks = async (): Promise<jose.JSONWebKeySet> => {
  if ((await ensureConfiguredIssuanceMode()) === "legacy") await getOrCreateKeyPair();
  const graceCutoff = new Date(Date.now() - SIGNING_KEY_GRACE_MS);
  const [legacyRows, allAuthorityRows] = await Promise.all([
    sql<DbKey[]>`
    SELECT id, private_key, public_key, kid, created_at, retired_at
    FROM oauth.keys
    WHERE retired_at IS NULL OR retired_at > ${graceCutoff}
    ORDER BY retired_at NULLS FIRST, created_at DESC
  `,
    loadAuthorityKeys(),
  ]);
  const authorityKids = new Set(allAuthorityRows.map((row) => row.kid));
  const authorityRows = allAuthorityRows.filter(
    (row) => ["pending", "active", "retired"].includes(row.state) && new Date(row.verify_until).getTime() > Date.now(),
  );
  const legacyKeys = await Promise.all(
    legacyRows
      .filter((row) => !authorityKids.has(row.kid))
      .map(async (row) => {
        const publicKey = await jose.importSPKI(row.public_key, "RS256");
        return {
          ...(await jose.exportJWK(publicKey)),
          kid: row.kid,
          use: "sig" as const,
          alg: "RS256",
        };
      }),
  );
  const authorityKeys = authorityRows.map((row) => ({ ...publicJwk(row.public_jwk), kid: row.kid, use: "sig" as const, alg: "RS256" }));

  return { keys: [...legacyKeys, ...authorityKeys] };
};

export const cleanupSigningKeys = async (): Promise<number> => {
  const graceCutoff = new Date(Date.now() - SIGNING_KEY_GRACE_MS);
  const deleted = await sql<{ kid: string }[]>`
    DELETE FROM oauth.keys
    WHERE retired_at IS NOT NULL
      AND retired_at <= ${graceCutoff}
    RETURNING kid
  `;
  for (const row of deleted) importedKeyPairs.delete(row.kid);
  return deleted.length;
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
  issuer: string;
  nonce?: string | null;
  scopes?: OAuthScope[];
  audiences?: string[];
  resource?: string | null;
  issueRefreshToken?: boolean;
  refreshTokenLabel?: string | null;
  authorityGrant?: OAuthUserGrantReference;
}): Promise<{
  accessToken: string;
  idToken: string | null;
  expiresIn: number;
  scope: string;
  authorityMode: OAuthIssuanceMode;
  refreshToken?: string;
}> => {
  const { userId, client, issuer, nonce } = params;
  const scopes = params.scopes ?? client.scopes;
  const audiences = params.audiences ?? client.audiences;
  const accessTokenAudiences = params.audiences ? dedupe(params.audiences) : dedupe(["cloud", client.clientId, ...audiences]);

  // Load user to get uid for sub claim
  const user = await accounts.users.get({ id: userId });
  if (!user || isAccountExpired(user.accountExpires)) throw new InactiveOAuthUserError();

  const expiresIn = ACCESS_TOKEN_LIFETIME_SECONDS;
  const scopeValue = scopes.join(" ");

  const subject = user.id;
  if (oauthIssuanceMode() === "core" && !params.authorityGrant) throw new Error("Core OAuth issuance requires an opaque grant reference");
  const authorityGrant = params.authorityGrant ?? { kind: "authorization_code" as const, code: "legacy", nonce: crypto.randomUUID() };
  const requests: OAuthTokenRequest[] = [
    {
      kind: "user_access",
      grant: authorityGrant,
      expiresIn,
    } satisfies UserAccessTokenRequest,
  ];
  const legacyRequests: LegacyTokenRequest[] = [
    {
      claims: {
        token_use: "access",
        principal_type: "user",
        uid: user.uid,
        id: user.id,
        client_id: client.clientId,
        azp: client.clientId,
        scope: scopeValue,
      },
      subject,
      audiences: accessTokenAudiences,
      expiresIn,
      jti: true,
    },
  ];

  if (scopes.includes("openid")) {
    const idTokenRequest: UserIdTokenRequest = {
      kind: "user_id",
      grant: authorityGrant,
      expiresIn,
    };

    requests.push(idTokenRequest);
    const idClaims: Record<string, unknown> = { uid: user.uid, id: user.id };
    if (nonce !== undefined && nonce !== null) idClaims.nonce = nonce;
    if (scopes.includes("profile")) {
      idClaims.name = user.displayName;
      idClaims.display_name = user.displayName;
      idClaims.given_name = user.givenname;
      idClaims.family_name = user.sn;
    }
    if (scopes.includes("email") && user.mail) idClaims.email = user.mail;
    if (scopes.includes("groups")) idClaims.groups = await accounts.users.getGroups({ id: userId, recursive: true });
    legacyRequests.push({ claims: idClaims, subject, audiences: client.clientId, expiresIn, jti: false });
  }

  const signed = await signOAuthTokenBatch(requests, legacyRequests, issuer);
  const accessToken = signed.tokens[0]!;
  const idToken = signed.tokens[1] ?? null;

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
    authorityMode: signed.mode,
    ...(refreshToken ? { refreshToken: refreshToken.refreshToken } : {}),
  };
};

/**
 * Create a client-credentials access token for a resource-bound service account.
 */
export const createClientCredentialsToken = async (params: {
  client: OAuthClient;
  issuer: string;
  scope?: string;
  resource?: string;
}): Promise<{ accessToken: string; expiresIn: number; scope: string }> => {
  const { client, issuer, scope, resource } = params;

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

  const serviceClaims = {
    token_use: "access",
    principal_type: "service_account",
    service_account_id: serviceAccount.id,
    service_account_kind: serviceAccount.kind,
    app_id: serviceAccount.appId,
    resource_type: serviceAccount.resourceType,
    resource_id: serviceAccount.resourceId,
    client_id: client.clientId,
    azp: client.clientId,
    scope: scopeValue,
  };
  const signed = await signOAuthTokenBatch(
    [
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
    ],
    [{ claims: serviceClaims, subject: serviceAccount.id, audiences: accessTokenAudiences, expiresIn, jti: true }],
    issuer,
  );

  return { accessToken: signed.tokens[0]!, expiresIn, scope: scopeValue };
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
      localVerifier = null;
      try {
        const { payload } = await jose.jwtVerify(params.token, await getOAuthVerificationKey(), {
          issuer: params.issuer,
          algorithms: ["RS256"],
        });
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
