import { sql } from "bun";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env";
import type { User } from "../../contracts/shared";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { isAccountExpired } from "../account-model";
import {
  type CloudSessionClaims,
  invalidateIdentitySignerCache,
  isSessionJwtCandidate,
  prepareIdentitySigner,
  signSessionToken,
  verifySessionToken,
} from "../identity";
import { IDENTITY_CLOCK_TOLERANCE_SECONDS, IDENTITY_ROLLOUT_MARGIN_MS } from "../identity/constants";
import { getIdentityRuntimeConfig } from "../identity/runtime-config";
import * as settings from "../settings";
import { loadJwtSessionUser } from "./user";

export type SessionData = {
  userId: string;
  sid: string;
  authEpoch: number;
  expiresAt: string;
};

export type AuthenticatedSession = { data: SessionData; user: User };

const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
};

const isCloudApiToken = (token: string | null): boolean => Boolean(token?.startsWith("cld_"));

const verifyCredential = async (token: string): Promise<CloudSessionClaims | null> => {
  if (!isSessionJwtCandidate(token)) return null;
  return verifySessionToken(token);
};

const verificationByRequest = new WeakMap<Context, Map<string, Promise<CloudSessionClaims | null>>>();
const authenticationByRequest = new WeakMap<Context, Map<string, Promise<AuthenticatedSession | null>>>();

const requestCached = <T>(
  cache: WeakMap<Context, Map<string, Promise<T>>>,
  c: Context,
  token: string,
  load: () => Promise<T>,
): Promise<T> => {
  let requests = cache.get(c);
  if (!requests) {
    requests = new Map();
    cache.set(c, requests);
  }
  const existing = requests.get(token);
  if (existing) return existing;
  const pending = load();
  requests.set(token, pending);
  return pending;
};

const verifyForRequest = (c: Context, token: string): Promise<CloudSessionClaims | null> =>
  requestCached(verificationByRequest, c, token, () => verifyCredential(token));

const authenticateVerified = async (credential: CloudSessionClaims): Promise<AuthenticatedSession | null> => {
  const { groupsAdmin } = await getIdentityRuntimeConfig();
  const user = await loadJwtSessionUser({
    userId: credential.sub,
    sid: credential.sid,
    authEpoch: credential.auth_epoch,
    groupsAdmin,
  });
  if (!user) return null;
  if (!(await isAccountCategoryAllowed(user))) return null;
  if (isAccountExpired(user.accountExpires)) {
    await session.revokeAllForUser(user.id);
    return null;
  }
  return {
    user,
    data: {
      userId: user.id,
      sid: credential.sid,
      authEpoch: credential.auth_epoch,
      expiresAt: new Date(credential.exp * 1_000).toISOString(),
    },
  };
};

const authenticateToken = async (token: string): Promise<AuthenticatedSession | null> => {
  const credential = await verifyCredential(token);
  return credential ? authenticateVerified(credential) : null;
};

const revokeToken = async (token: string, requestId?: string | null): Promise<void> => {
  if (isSessionJwtCandidate(token)) {
    const claims = await verifySessionToken(token);
    if (!claims) return;
    await sql`
      UPDATE auth.session_families
      SET revoked_at = COALESCE(revoked_at, now()),
          revocation_reason = COALESCE(revocation_reason, 'logout'),
          revoked_request_id = COALESCE(revoked_request_id, ${requestId?.slice(0, 64) ?? null})
      WHERE sid = ${claims.sid}::uuid AND user_id = ${claims.sub}::uuid
    `;
    return;
  }
};

const issueJwtSession = async (c: Context, userId: string, ttlSeconds: number, attempt = 0): Promise<string> => {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1_000);
  const sid = crypto.randomUUID();
  const signer = await prepareIdentitySigner("session");
  const requestId = c.req.header("x-request-id")?.slice(0, 64) ?? null;
  const userAgent = c.req.header("user-agent")?.slice(0, 256) ?? null;

  let authEpoch: number;
  try {
    authEpoch = await sql.begin(async (tx) => {
      const [user] = await tx<Array<{ auth_epoch: string | number | bigint; provider: "local" | "ipa"; profile: "guest" | "user" }>>`
        SELECT auth_epoch, provider, profile FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE
      `;
      if (!user) throw new Error("Cannot create a session for an unknown user");
      if (!(await isAccountCategoryAllowed(user, tx)))
        throw new HTTPException(403, { message: "This account category is disabled. Contact an administrator." });
      const epoch = Number(user.auth_epoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("User auth_epoch is invalid");
      const [activeKey] = await tx<Array<{ kid: string }>>`
        UPDATE auth.signing_keys
        SET verify_until = GREATEST(verify_until, ${new Date(
          expiresAt.getTime() + IDENTITY_CLOCK_TOLERANCE_SECONDS * 1_000 + IDENTITY_ROLLOUT_MARGIN_MS,
        )})
        WHERE kid = ${signer.kid} AND purpose = 'session' AND state = 'active' AND sign_until > now()
        RETURNING kid
      `;
      if (!activeKey) throw new Error("Prepared Cloud session signer is no longer active");
      await tx`
        INSERT INTO auth.session_families (
          sid, user_id, auth_epoch, signing_kid, issued_at, expires_at, created_request_id, created_user_agent, legal_pending
        ) VALUES (${sid}, ${userId}, ${epoch}, ${signer.kid}, ${issuedAt}, ${expiresAt}, ${requestId}, ${userAgent},
          NOT EXISTS (SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid))
      `;
      await tx`UPDATE auth.users SET last_login_local = ${issuedAt} WHERE id = ${userId}::uuid`;
      return epoch;
    });
  } catch (error) {
    if (attempt === 0 && error instanceof Error && error.message === "Prepared Cloud session signer is no longer active") {
      invalidateIdentitySignerCache("session", signer.kid);
      return issueJwtSession(c, userId, ttlSeconds, 1);
    }
    throw error;
  }

  let token: string;
  try {
    token = (await signSessionToken({ userId, sid, authEpoch, issuedAt, expiresAt, signer })).token;
  } catch (error) {
    await sql`
      UPDATE auth.session_families
      SET revoked_at = now(), revocation_reason = 'issuance_failed'
      WHERE sid = ${sid}::uuid AND revoked_at IS NULL
    `;
    throw error;
  }

  const [stillActive] = await sql<Array<{ active: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM auth.signing_keys
      WHERE kid = ${signer.kid} AND purpose = 'session' AND state = 'active'
    ) AS active
  `;
  if (stillActive?.active) return token;

  await sql`
    UPDATE auth.session_families
    SET revoked_at = now(), revocation_reason = 'signer_revoked_during_issuance'
    WHERE sid = ${sid}::uuid AND revoked_at IS NULL
  `;
  invalidateIdentitySignerCache("session", signer.kid);
  if (attempt === 0) return issueJwtSession(c, userId, ttlSeconds, 1);
  throw new Error("Cloud session signer changed repeatedly during issuance");
};

export const session = {
  getToken: (c: Context): string | null => {
    const authorization = c.req.header("Authorization");
    const bearer = parseBearer(authorization);
    if (/^Bearer(?:\s|$)/i.test(authorization ?? "")) return isCloudApiToken(bearer) ? null : bearer;
    return getCookie(c, "session_token") ?? null;
  },

  getBearerToken: (c: Context): string | null => parseBearer(c.req.header("Authorization")),

  create: async (c: Context, userId: string): Promise<string> => {
    const expiryHours = await settings.get<number>("user.session.expiry_hours");
    if (!Number.isFinite(expiryHours) || expiryHours < 1) throw new Error("user.session.expiry_hours must be a positive number");
    const ttlSeconds = Math.floor(expiryHours * 60 * 60);
    const clientToken = await issueJwtSession(c, userId, ttlSeconds);

    setCookie(c, "session_token", clientToken, {
      httpOnly: true,
      secure: !env.IS_DEVELOPMENT,
      sameSite: "Lax",
      maxAge: ttlSeconds,
      path: "/",
    });
    return clientToken;
  },

  revoke: revokeToken,

  delete: async (c: Context): Promise<void> => {
    const token = session.getToken(c);
    if (token) await revokeToken(token, c.req.header("x-request-id"));
    deleteCookie(c, "session_token", { path: "/" });
  },

  revokeAllForUser: async (userId: string): Promise<void> => {
    const [updated] = await sql<Array<{ id: string }>>`
      UPDATE auth.users SET auth_epoch = auth_epoch + 1
      WHERE id = ${userId}::uuid RETURNING id
    `;
    if (!updated) throw new Error("Cannot revoke sessions for an unknown user");
  },

  authenticate: authenticateToken,

  authenticateRequest: (c: Context, token: string): Promise<AuthenticatedSession | null> =>
    requestCached(authenticationByRequest, c, token, async () => {
      const credential = await verifyForRequest(c, token);
      return credential ? authenticateVerified(credential) : null;
    }),

  getRequestSubject: async (c: Context, token: string): Promise<string | null> => {
    const credential = await verifyForRequest(c, token);
    return credential?.sub ?? null;
  },
};
