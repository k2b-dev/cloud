import { sql } from "@k2b/cloud";
import { authenticateSignedAppRequest } from "@k2b/cloud/api";
import { type OAuthAuthorityStatement, OAuthAuthorityStatementSchema, OAuthNewAccessNoticeSchema } from "@k2b/cloud/contracts";
import { AppApprovalError, isAccountAllowed, readAppApprovalConfig, toPgTextArray } from "@k2b/cloud/services";
import { withActiveIdentitySigner } from "@k2b/cloud/services/identity";
import * as settings from "@k2b/cloud/services/settings";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { SignJWT } from "jose";
import type { CoreNotificationSender } from "../notifications";

type AuthorityState = {
  authEpoch: number;
  clientId: string;
  grantedScopes: string[];
  grantedAudiences: string[];
  nonce: string | null;
  notAfter: Date | null;
  user: null | {
    id: string;
    uid: string;
    profile: string;
    displayName: string;
    givenName: string;
    familyName: string;
    email: string | null;
    groups: string[];
  };
  serviceAccount: null | {
    id: string;
    kind: string;
    appId: string | null;
    resourceType: string | null;
    resourceId: string | null;
  };
};

class InvalidOAuthGrantAuthorityError extends Error {}

/** Platform facts only: the trusted issuer owns client policy and consumes its own grants. */
const resolveAuthorityState = async ({
  request,
  appId,
  db = sql,
}: {
  request: OAuthAuthorityStatement;
  appId: string;
  db?: typeof sql;
}): Promise<AuthorityState | null> => {
  const state: AuthorityState = {
    authEpoch: 0,
    clientId: request.clientId,
    grantedScopes: request.scopes,
    grantedAudiences: request.audiences,
    nonce: request.nonce,
    notAfter: request.loginExpiresAt ? new Date(request.loginExpiresAt) : null,
    user: null,
    serviceAccount: null,
  };
  if (request.subject.kind === "user") {
    const [user] = await db<
      {
        id: string;
        uid: string;
        auth_epoch: string | number;
        provider: "local" | "ipa";
        profile: "user" | "guest";
        display_name: string;
        given_name: string;
        sn: string;
        mail: string | null;
        account_expires: Date | null;
      }[]
    >`SELECT id,uid,auth_epoch,provider,profile,display_name,given_name,sn,mail,account_expires
      FROM auth.users WHERE id=${request.subject.userId}::uuid FOR SHARE`;
    if (
      !user ||
      Number(user.auth_epoch) !== request.subject.authEpoch ||
      (user.profile !== "user" && user.profile !== "guest") ||
      (user.account_expires !== null && user.account_expires.getTime() <= Date.now()) ||
      !(await isAccountAllowed(user, db))
    )
      return null;
    const groups = await db<{ name: string }[]>`WITH RECURSIVE user_all_groups AS (
      SELECT ug.group_id,g.provider FROM auth.user_groups_v2 ug JOIN auth.groups g ON g.id=ug.group_id
        WHERE ug.user_id=${user.id}::uuid
      UNION
      SELECT gg.parent_group_id,parent.provider FROM auth.group_groups_v2 gg
        JOIN auth.groups parent ON parent.id=gg.parent_group_id
        JOIN user_all_groups child ON child.group_id=gg.child_group_id WHERE parent.provider=child.provider
    ) SELECT DISTINCT g.name FROM user_all_groups ug JOIN auth.groups g ON g.id=ug.group_id
      WHERE NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id=g.id) ORDER BY g.name`;
    state.authEpoch = request.subject.authEpoch;
    state.user = {
      id: user.id,
      uid: user.uid,
      profile: user.profile,
      displayName: user.display_name,
      givenName: user.given_name,
      familyName: user.sn,
      email: user.mail,
      groups: groups.map((g) => g.name),
    };
    if (user.account_expires && (!state.notAfter || user.account_expires < state.notAfter)) state.notAfter = user.account_expires;
  } else {
    const [account] = await db<
      {
        id: string;
        kind: string;
        status: string;
        delegated_user_id: string | null;
        app_id: string | null;
        resource_type: string | null;
        resource_id: string | null;
      }[]
    >`SELECT id,kind,status,delegated_user_id,app_id,resource_type,resource_id FROM auth.service_accounts
      WHERE id=${request.subject.serviceAccountId}::uuid FOR SHARE`;
    // The driver will replace this eligibility check with serviceAccountMayHoldCredentials from feat/code.
    if (!account || account.status !== "active" || account.delegated_user_id !== null || account.resource_type === "cloud.app") return null;
    const resourceBound =
      account.kind === "resource_bound" && account.app_id !== null && account.resource_type !== null && account.resource_id !== null;
    const standalone =
      (account.kind === "standalone" || account.kind === "agent") &&
      account.app_id === null &&
      account.resource_type === null &&
      account.resource_id === null;
    if (!resourceBound && !standalone) return null;
    state.serviceAccount = {
      id: account.id,
      kind: account.kind,
      appId: account.app_id,
      resourceType: account.resource_type,
      resourceId: account.resource_id,
    };
  }
  const [client] = await db<{ service_account_id: string | null }[]>`SELECT service_account_id FROM auth.oauth_clients
    WHERE client_id=${request.clientId} AND issuer_app_id=${appId} AND status='active' FOR SHARE`;
  if (!client || (state.serviceAccount && client.service_account_id !== state.serviceAccount.id)) return null;
  if (state.notAfter && state.notAfter.getTime() <= Date.now()) return null;
  if (request.terminalLoginId !== null) {
    if (!state.user || !state.notAfter) return null;
    const [login] = await db<
      { id: string; issuer: string; approved_by: string; device_authorization_id: string; lifetime_seconds: number }[]
    >`
      SELECT id,issuer,approved_by,device_authorization_id,lifetime_seconds FROM auth.app_logins
      WHERE id=${request.terminalLoginId}::uuid AND kind='terminal' AND state='approved'
        AND oauth_issuer_app_id=${appId} AND client_id=${request.clientId} AND user_id=${state.user.id}::uuid
        AND auth_epoch=${state.authEpoch}::bigint AND device_authorization_id IS NOT NULL
        AND oauth_grant_expires_at > clock_timestamp()
        AND scopes @> ${toPgTextArray(request.scopes)}::text[] AND scopes <@ ${toPgTextArray(request.scopes)}::text[]
        AND ${state.notAfter} <= now() + lifetime_seconds * interval '1 second'`;
    if (!login) return null;
    let cfg: Awaited<ReturnType<typeof readAppApprovalConfig>>;
    try {
      cfg = await readAppApprovalConfig(db);
    } catch (error) {
      if (error instanceof AppApprovalError) return null;
      throw error;
    }
    if (!cfg.enabled || !cfg.appOrigin || login.issuer !== cfg.issuer) return null;
    const [device] = await db`SELECT id FROM auth.app_devices WHERE id=${login.approved_by}::uuid
      AND issuer=${cfg.issuer} AND user_id=${state.user.id}::uuid AND revoked_at IS NULL FOR UPDATE`;
    if (!device) return null;
    const [consumed] = await db`UPDATE auth.app_logins SET state='consumed'
      WHERE id=${login.id}::uuid AND kind='terminal' AND state='approved' AND issuer=${cfg.issuer}
        AND oauth_issuer_app_id=${appId} AND device_authorization_id=${login.device_authorization_id}::uuid
        AND client_id=${request.clientId} AND user_id=${state.user.id}::uuid AND auth_epoch=${state.authEpoch}::bigint
        AND approved_by=${login.approved_by}::uuid AND lifetime_seconds=${login.lifetime_seconds}
        AND oauth_grant_expires_at > clock_timestamp()
        AND scopes @> ${toPgTextArray(request.scopes)}::text[] AND scopes <@ ${toPgTextArray(request.scopes)}::text[]
        RETURNING id`;
    if (!consumed) return null;
  }
  return state;
};

type Dependencies = {
  notifyNewAccess: CoreNotificationSender["sendOAuthNewAccess"];
  ownsClient: (clientId: string, appId: string) => Promise<boolean>;
  authenticate: typeof authenticateSignedAppRequest;
  authorize: (c: Context) => Promise<Response | null>;
  withActiveSigner: typeof withActiveIdentitySigner;
  issuer: () => Promise<string>;
  resolve: typeof resolveAuthorityState;
  now: () => number;
};

/** Every issuer needs the operator-owned oauth:issue key grant. */
export const authorizeOAuthRequest = async (
  c: Context,
  authenticate: typeof authenticateSignedAppRequest = authenticateSignedAppRequest,
): Promise<Response | null> => {
  const authenticated = await authenticate(c, "oauth:issue");
  if (authenticated instanceof Response) return authenticated;
  c.set("oauthIssuerAppId", authenticated.appId);
  return null;
};

const defaultDependencies: Dependencies = {
  notifyNewAccess: async () => {
    throw new Error("New-access notification sender is not configured");
  },
  ownsClient: async (clientId, appId) => {
    const [client] = await sql`SELECT client_id FROM auth.oauth_clients
      WHERE client_id=${clientId} AND issuer_app_id=${appId} AND status='active'`;
    return !!client;
  },
  authenticate: authenticateSignedAppRequest,
  authorize: authorizeOAuthRequest,
  withActiveSigner: withActiveIdentitySigner,
  issuer: async () => publicCloudOrigin(await settings.get<string>("app.url")),
  resolve: resolveAuthorityState,
  now: () => Math.floor(Date.now() / 1_000),
};

const claims = (
  request: OAuthAuthorityStatement["tokens"][number],
  state: AuthorityState,
  grantedScopes: string[],
): Record<string, unknown> => {
  if (request.kind === "user_access") {
    const user = state.user;
    if (!user) throw new Error("Validated OAuth user authority is missing");
    return {
      token_use: "access",
      principal_type: "user",
      auth_epoch: state.authEpoch,
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
      service_account_kind: account.kind,
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
  request: OAuthAuthorityStatement["tokens"][number],
  state: AuthorityState,
  grantedScopes: string[],
  options: { issuer: string; kid: string; key: CryptoKey; now: number },
): Promise<string> => {
  const exp = Math.min(options.now + request.expiresIn, state.notAfter ? Math.floor(state.notAfter.getTime() / 1000) : Infinity);
  if (exp <= options.now) throw new InvalidOAuthGrantAuthorityError();
  let token = new SignJWT(claims(request, state, grantedScopes))
    .setProtectedHeader({ alg: "RS256", kid: options.kid })
    .setIssuer(options.issuer)
    .setIssuedAt(options.now)
    .setExpirationTime(exp);
  if (request.kind === "service_access") {
    const audiences = state.grantedAudiences;
    if (!audiences) throw new Error("Validated OAuth audience is missing");
    const account = state.serviceAccount;
    if (!account) throw new Error("Validated OAuth service authority is missing");
    token = token.setSubject(account.id).setAudience(audiences).setJti(crypto.randomUUID());
  } else if (request.kind === "user_access") {
    const audiences = state.grantedAudiences;
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

/** Closed authority endpoint shared by built-in and third-party trusted issuers. */
export const createIdentityOAuthIssuanceRoutes = (overrides: Partial<Dependencies> = {}) => {
  const dependencies = { ...defaultDependencies, ...overrides };
  const authorize = overrides.authorize ?? ((c: Context) => authorizeOAuthRequest(c, dependencies.authenticate));
  const routes = new Hono<{ Variables: { oauthIssuerAppId: string } }>();
  routes.post("/oauth/ready", async (c) => {
    c.header("Cache-Control", "no-store");
    const denied = await authorize(c);
    if (denied) return denied;
    await dependencies.withActiveSigner("oauth", async () => undefined, { timeoutMs: 5_000 });
    return c.body(null, 204);
  });
  routes.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const denied = await authorize(c);
    if (denied) return denied;
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
    const parsed = OAuthAuthorityStatementSchema.safeParse(body);
    if (!parsed.success) return c.json({ message: "Invalid request" }, 400);
    const appId = c.get("oauthIssuerAppId");
    if (typeof appId !== "string") return c.json({ message: "Forbidden" }, 403);
    const issuer = await dependencies.issuer();
    try {
      const tokens = await dependencies.withActiveSigner(
        "oauth",
        async (signer, db) => {
          const state = await dependencies.resolve({ request: parsed.data, appId, db });
          if (!state) throw new InvalidOAuthGrantAuthorityError();
          const now = dependencies.now();
          return Promise.all(
            parsed.data.tokens.map((request) =>
              sign(request, state, state.grantedScopes, { issuer, kid: signer.kid, key: signer.key, now }),
            ),
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
  // The issuer owns the retry record. Core only renders its existing platform notification.
  routes.post("/oauth/new-access", async (c) => {
    c.header("Cache-Control", "no-store");
    const denied = await authorize(c);
    if (denied) return denied;
    const parsed = OAuthNewAccessNoticeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "Invalid request" }, 400);
    const appId = c.get("oauthIssuerAppId");
    if (typeof appId !== "string") return c.json({ message: "Forbidden" }, 403);
    const { clientId, ...notice } = parsed.data;
    if (!(await dependencies.ownsClient(clientId, appId))) return c.json({ message: "Forbidden" }, 403);
    await dependencies.notifyNewAccess({ ...notice, kind: appId === "oauth" && clientId === "cloud-cli" ? "command_line" : "app" });
    return c.body(null, 204);
  });
  return routes;
};

export default createIdentityOAuthIssuanceRoutes();
