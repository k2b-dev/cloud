import { timingSafeEqual } from "node:crypto";
import { isAccountCategoryAllowed } from "@k2b/cloud/services";
import { withActiveIdentitySigner } from "@k2b/cloud/services/identity";
import * as settings from "@k2b/cloud/services/settings";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { sql } from "bun";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { z } from "zod";

const UUID = z.string().uuid();
const bounded = z.string().min(1).max(2_048);
const AuthorizationCodeGrantSchema = z.object({ kind: z.literal("authorization_code"), code: bounded, nonce: UUID }).strict();
const RefreshTokenGrantSchema = z.object({ kind: z.literal("refresh_token"), tokenId: UUID, nonce: UUID }).strict();
const ClientCredentialsGrantSchema = z.object({ kind: z.literal("client_credentials"), grantId: UUID, nonce: UUID }).strict();
const UserGrantSchema = z.discriminatedUnion("kind", [AuthorizationCodeGrantSchema, RefreshTokenGrantSchema]);
const common = { expiresIn: z.literal(3_600) };
const OAuthTokenRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_access"), grant: UserGrantSchema, ...common }).strict(),
  z.object({ kind: z.literal("user_id"), grant: UserGrantSchema, ...common }).strict(),
  z
    .object({
      kind: z.literal("service_access"),
      grant: ClientCredentialsGrantSchema,
      ...common,
    })
    .strict(),
]);
const OAuthTokenBatchSchema = z.object({ tokens: z.array(OAuthTokenRequestSchema).min(1).max(2) }).strict();
type OAuthTokenRequest = z.infer<typeof OAuthTokenRequestSchema>;

type AuthorityState = {
  clientId: string;
  clientScopes: string[];
  clientAudiences: string[];
  clientServiceAccountId: string | null;
  registrationKind: string;
  allowedProfiles: string[];
  accessMode: string;
  specificAccess: boolean;
  grantedScopes: string[];
  grantedAudiences: string[];
  resource: string | null;
  nonce: string | null;
  user: null | {
    id: string;
    uid: string;
    profile: string;
    displayName: string;
    givenName: string;
    familyName: string;
    email: string | null;
    accountExpires: Date | null;
    groups: string[];
  };
  serviceAccount: null | {
    id: string;
    kind: string;
    status: string;
    delegatedUserId: string | null;
    appId: string | null;
    resourceType: string | null;
    resourceId: string | null;
  };
};

type AuthorityRow = {
  client_id: string;
  client_scopes: string[];
  client_audiences: string[];
  client_service_account_id: string | null;
  registration_kind: string;
  allowed_profiles: string[];
  access_mode: string;
  specific_access: boolean;
  user_id: string | null;
  uid: string | null;
  profile: string | null;
  provider: "local" | "ipa" | null;
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  mail: string | null;
  account_expires: Date | null;
  groups: string[];
  service_account_id: string | null;
  service_account_kind: string | null;
  service_account_status: string | null;
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
};

type GrantRow = {
  client_id: string;
  user_id: string | null;
  scopes: string[];
  audiences: string[];
  resource: string | null;
  nonce: string | null;
};

const resolveAuthorityState = async (params: { request: OAuthTokenRequest; db?: typeof sql }): Promise<AuthorityState | null> => {
  const db = params.db ?? sql;
  let grant: GrantRow | null = null;
  if (params.request.kind === "service_access") {
    const [row] = await db<GrantRow[]>`
      UPDATE oauth.client_credentials_authority_grants
      SET consumed_at = now()
      WHERE id = ${params.request.grant.grantId}::uuid
        AND nonce = ${params.request.grant.nonce}::uuid
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING client_id, NULL::uuid AS user_id, scopes, audiences, resource, NULL::text AS nonce
    `;
    grant = row ?? null;
  } else {
    if (params.request.grant.kind === "authorization_code") {
      const [row] = await db<GrantRow[]>`
        UPDATE oauth.codes
        SET authority_issued_at = now()
        WHERE code = ${params.request.grant.code}
          AND authority_nonce = ${params.request.grant.nonce}::uuid
          AND used = true
          AND authority_issued_at IS NULL
          AND expires_at >= now()
        RETURNING client_id, user_id, scopes, audiences, resource, nonce
      `;
      grant = row ?? null;
    } else {
      const [row] = await db<GrantRow[]>`
        UPDATE oauth.refresh_tokens token
        SET authority_issued_at = now()
        FROM oauth.refresh_token_families family
        WHERE token.id = ${params.request.grant.tokenId}::uuid
          AND token.authority_nonce = ${params.request.grant.nonce}::uuid
          AND token.status = 'issuing'
          AND token.authority_issued_at IS NULL
          AND token.expires_at > now()
          AND family.id = token.family_id
          AND family.status = 'active'
          AND family.expires_at > now()
        RETURNING family.client_id, family.user_id, token.authority_scopes AS scopes,
          token.authority_audiences AS audiences, token.authority_resource AS resource, NULL::text AS nonce
      `;
      grant = row ?? null;
    }
    if (!grant) return null;
  }
  const clientId = grant?.client_id ?? null;
  if (!clientId) return null;
  const grantUserId = grant?.user_id ?? null;
  const [row] = await db<AuthorityRow[]>`
    WITH RECURSIVE user_all_groups AS (
      SELECT ug.group_id, g.provider
      FROM auth.user_groups_v2 ug
      JOIN auth.groups g ON g.id = ug.group_id
      WHERE ug.user_id = ${grantUserId}::uuid
      UNION
      SELECT gg.parent_group_id, parent.provider
      FROM auth.group_groups_v2 gg
      JOIN auth.groups parent ON parent.id = gg.parent_group_id
      JOIN user_all_groups child ON child.group_id = gg.child_group_id
      WHERE parent.provider = child.provider
    )
    SELECT c.client_id, c.scopes AS client_scopes, c.audiences AS client_audiences, c.service_account_id AS client_service_account_id,
      c.registration_kind, c.allowed_profiles, c.access_mode,
      (
        EXISTS (SELECT 1 FROM oauth.client_access_users cau WHERE cau.client_id = c.id AND cau.user_id = u.id)
        OR EXISTS (SELECT 1 FROM oauth.client_access_groups cag JOIN user_all_groups ug ON ug.group_id = cag.group_id WHERE cag.client_id = c.id)
      ) AS specific_access,
      u.id AS user_id, u.uid, u.profile, u.provider, u.display_name, u.given_name, u.sn AS family_name,
      u.mail, u.account_expires,
      COALESCE(ARRAY(SELECT DISTINCT g.name FROM user_all_groups ug JOIN auth.groups g ON g.id = ug.group_id ORDER BY g.name), ARRAY[]::text[]) AS groups,
      sa.id AS service_account_id, sa.kind AS service_account_kind, sa.status AS service_account_status,
      sa.delegated_user_id, sa.app_id, sa.resource_type, sa.resource_id
    FROM oauth.clients c
    LEFT JOIN auth.users u ON u.id = ${grantUserId}::uuid
    LEFT JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.client_id = ${clientId}
    LIMIT 1
  `;
  if (!row) return null;
  if (
    row.user_id !== null &&
    (!row.provider ||
      (row.profile !== "guest" && row.profile !== "user") ||
      !(await isAccountCategoryAllowed({ provider: row.provider, profile: row.profile }, db)))
  )
    return null;
  if (row.user_id !== null && (row.uid === null || row.profile === null)) return null;
  if (row.service_account_id !== null && (row.service_account_kind === null || row.service_account_status === null)) return null;
  const resolvedUserId = row.user_id;
  const uid = row.uid;
  const profile = row.profile;
  const serviceAccountId = row.service_account_id;
  const serviceAccountKind = row.service_account_kind;
  const serviceAccountStatus = row.service_account_status;
  return {
    clientId: row.client_id,
    clientScopes: row.client_scopes,
    clientAudiences: row.client_audiences,
    clientServiceAccountId: row.client_service_account_id,
    registrationKind: row.registration_kind,
    allowedProfiles: row.allowed_profiles,
    accessMode: row.access_mode,
    specificAccess: row.specific_access,
    grantedScopes: grant?.scopes ?? row.client_scopes,
    grantedAudiences: grant?.audiences ?? [],
    resource: grant?.resource ?? null,
    nonce: grant?.nonce ?? null,
    user:
      resolvedUserId !== null && uid !== null && profile !== null
        ? {
            id: resolvedUserId,
            uid,
            profile,
            displayName: row.display_name ?? "",
            givenName: row.given_name ?? "",
            familyName: row.family_name ?? "",
            email: row.mail,
            accountExpires: row.account_expires,
            groups: row.groups,
          }
        : null,
    serviceAccount:
      serviceAccountId !== null && serviceAccountKind !== null && serviceAccountStatus !== null
        ? {
            id: serviceAccountId,
            kind: serviceAccountKind,
            status: serviceAccountStatus,
            delegatedUserId: row.delegated_user_id,
            appId: row.app_id,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
          }
        : null,
  };
};

type Dependencies = {
  authenticate: (token: string | null) => boolean;
  withActiveSigner: typeof withActiveIdentitySigner;
  issuer: () => Promise<string>;
  resolve: typeof resolveAuthorityState;
  now: () => number;
};

const defaultDependencies: Dependencies = {
  authenticate: (token) => {
    const secret = process.env.CLOUD_OAUTH_BROKER_SECRET?.trim();
    // OAuth is optional. Missing or malformed configuration disables its broker.
    if (!secret || !/^[a-fA-F0-9]{64}$/.test(secret) || !token || !/^[a-fA-F0-9]{64}$/.test(token)) return false;
    return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(secret, "hex"));
  },
  withActiveSigner: withActiveIdentitySigner,
  issuer: async () => publicCloudOrigin(await settings.get<string>("app.url")),
  resolve: resolveAuthorityState,
  now: () => Math.floor(Date.now() / 1_000),
};

class InvalidOAuthGrantAuthorityError extends Error {}

const bearer = (value: string | undefined): string | null => {
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return token || null;
};

const resolveAudiences = (state: AuthorityState, issuer: string): string[] | null => {
  const resource = state.resource;
  const granted = Array.from(new Set(state.grantedAudiences));
  if (granted.length === 0) return null;
  if (state.registrationKind === "dynamic") {
    if (!resource || granted.length !== 1 || granted[0] !== resource) return null;
    try {
      return new URL(resource).origin === new URL(issuer).origin ? granted : null;
    } catch {
      return null;
    }
  }
  if (resource) return granted.length === 1 && granted[0] === resource && state.clientAudiences.includes(resource) ? granted : null;
  const currentlyAllowed = new Set(["cloud", state.clientId, ...state.clientAudiences]);
  return granted.every((audience) => currentlyAllowed.has(audience)) ? granted : null;
};

const validateAuthority = (requests: OAuthTokenRequest[], state: AuthorityState, issuer: string, now: number): boolean => {
  const first = requests[0];
  if (!first) return false;
  if (first.kind === "service_access") {
    if (requests.length !== 1 || !state.serviceAccount || state.user) return false;
    const account = state.serviceAccount;
    return (
      state.clientServiceAccountId === account.id &&
      account.status === "active" &&
      account.kind === "resource_bound" &&
      account.delegatedUserId === null &&
      account.appId !== null &&
      account.resourceType !== null &&
      account.resourceId !== null &&
      state.grantedScopes.every((scope) => state.clientScopes.includes(scope)) &&
      resolveAudiences(state, issuer) !== null
    );
  }
  const accessRequests = requests.filter((request) => request.kind === "user_access");
  const idTokenRequests = requests.filter((request) => request.kind === "user_id");
  const access = accessRequests[0];
  const idToken = idTokenRequests[0];
  if (
    !access ||
    accessRequests.length !== 1 ||
    idTokenRequests.length > 1 ||
    (idTokenRequests.length === 1 && !state.grantedScopes.includes("openid")) ||
    !state.user ||
    state.serviceAccount ||
    requests.some((request) => request.kind === "service_access")
  ) {
    return false;
  }
  if (idToken && JSON.stringify(idToken.grant) !== JSON.stringify(access.grant)) return false;
  const user = state.user;
  return (
    (!user.accountExpires || user.accountExpires.getTime() > now * 1_000) &&
    state.allowedProfiles.includes(user.profile) &&
    (state.accessMode === "profiles" || (state.accessMode === "specific" && state.specificAccess)) &&
    state.grantedScopes.every((scope) => state.clientScopes.includes(scope)) &&
    resolveAudiences(state, issuer) !== null
  );
};

const claims = (request: OAuthTokenRequest, state: AuthorityState, grantedScopes: string[]): Record<string, unknown> => {
  if (request.kind === "user_access") {
    const user = state.user;
    if (!user) throw new Error("Validated OAuth user authority is missing");
    return {
      token_use: "access",
      principal_type: "user",
      uid: user.uid,
      id: user.id,
      client_id: state.clientId,
      azp: state.clientId,
      scope: state.grantedScopes.join(" "),
    };
  }
  if (request.kind === "service_access") {
    const account = state.serviceAccount;
    if (!account) throw new Error("Validated OAuth service authority is missing");
    return {
      token_use: "access",
      principal_type: "service_account",
      service_account_id: account.id,
      service_account_kind: "resource_bound",
      app_id: account.appId,
      resource_type: account.resourceType,
      resource_id: account.resourceId,
      client_id: state.clientId,
      azp: state.clientId,
      scope: state.grantedScopes.join(" "),
    };
  }
  const user = state.user;
  if (!user) throw new Error("Validated OAuth user authority is missing");
  return {
    uid: user.uid,
    id: user.id,
    ...(state.nonce !== null ? { nonce: state.nonce } : {}),
    ...(grantedScopes.includes("profile")
      ? { name: user.displayName, display_name: user.displayName, given_name: user.givenName, family_name: user.familyName }
      : {}),
    ...(grantedScopes.includes("email") && user.email ? { email: user.email } : {}),
    ...(grantedScopes.includes("groups") ? { groups: user.groups } : {}),
  };
};

const sign = async (
  request: OAuthTokenRequest,
  state: AuthorityState,
  grantedScopes: string[],
  options: { issuer: string; kid: string; key: CryptoKey; now: number },
): Promise<string> => {
  let token = new SignJWT(claims(request, state, grantedScopes))
    .setProtectedHeader({ alg: "RS256", kid: options.kid })
    .setIssuer(options.issuer)
    .setIssuedAt(options.now)
    .setExpirationTime(options.now + request.expiresIn);
  if (request.kind === "service_access") {
    const audiences = resolveAudiences(state, options.issuer);
    if (!audiences) throw new Error("Validated OAuth audience is missing");
    const account = state.serviceAccount;
    if (!account) throw new Error("Validated OAuth service authority is missing");
    token = token.setSubject(account.id).setAudience(audiences).setJti(crypto.randomUUID());
  } else if (request.kind === "user_access") {
    const audiences = resolveAudiences(state, options.issuer);
    if (!audiences) throw new Error("Validated OAuth audience is missing");
    const user = state.user;
    if (!user) throw new Error("Validated OAuth user authority is missing");
    token = token.setSubject(user.id).setAudience(audiences).setJti(crypto.randomUUID());
  } else {
    const user = state.user;
    if (!user) throw new Error("Validated OAuth user authority is missing");
    token = token.setSubject(user.id).setAudience(state.clientId);
  }
  return token.sign(options.key);
};

/** Closed Core authority endpoint for OAuth access and ID tokens. */
export const createIdentityOAuthIssuanceRoutes = (overrides: Partial<Dependencies> = {}) => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const routes = new Hono();
  routes.post("/oauth/ready", async (c) => {
    c.header("Cache-Control", "no-store");
    if (!dependencies.authenticate(bearer(c.req.header("authorization")))) return c.json({ message: "Unauthorized" }, 401);
    await dependencies.withActiveSigner("oauth", async () => undefined, { timeoutMs: 5_000 });
    return c.body(null, 204);
  });
  routes.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    if (!dependencies.authenticate(bearer(c.req.header("authorization")))) return c.json({ message: "Unauthorized" }, 401);

    const contentLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 262_144) return c.json({ message: "Request too large" }, 413);
    let body: unknown;
    try {
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > 262_144) return c.json({ message: "Request too large" }, 413);
      body = JSON.parse(text);
    } catch {
      return c.json({ message: "Invalid request" }, 400);
    }
    const parsed = OAuthTokenBatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ message: "Invalid request" }, 400);

    const first = parsed.data.tokens[0];
    if (!first) return c.json({ message: "Invalid request" }, 400);
    const issuer = await dependencies.issuer();
    try {
      const tokens = await dependencies.withActiveSigner(
        "oauth",
        async (signer, db) => {
          const state = await dependencies.resolve({ request: first, db });
          const now = dependencies.now();
          if (!state || !validateAuthority(parsed.data.tokens, state, issuer, now)) throw new InvalidOAuthGrantAuthorityError();
          const accessRequest = parsed.data.tokens.find((request) => request.kind === "user_access" || request.kind === "service_access");
          if (!accessRequest) throw new InvalidOAuthGrantAuthorityError();
          const grantedScopes = state.grantedScopes;
          return Promise.all(
            parsed.data.tokens.map((request) => sign(request, state, grantedScopes, { issuer, kid: signer.kid, key: signer.key, now })),
          );
        },
        { timeoutMs: 5_000 },
      );
      return c.json({ tokens });
    } catch (error) {
      if (error instanceof InvalidOAuthGrantAuthorityError) return c.json({ message: "Forbidden" }, 403);
      throw error;
    }
  });
  return routes;
};

export default createIdentityOAuthIssuanceRoutes();
