import { redis, sql } from "bun";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { User } from "../../contracts/shared";
import { env } from "../../config/env";
import { isAccountExpired } from "../account-model";
import {
  isSessionJwtCandidate,
  invalidateIdentitySignerCache,
  prepareIdentitySigner,
  signSessionToken,
  type CloudSessionClaims,
  verifySessionToken,
} from "../identity";
import { identityMetrics } from "../identity/metrics";
import { getIdentityRuntimeConfig } from "../identity/runtime-config";
import { logger } from "../logging";
import * as settings from "../settings";
import { loadJwtSessionUser, loadLegacySessionUser } from "./user";

export type SessionData = {
  userId: string;
  gen: number;
  /** Present for JWT-aware consumers; optional to preserve the legacy dependency-injection contract. */
  kind?: "jwt" | "legacy";
  sid?: string | null;
  authEpoch?: number | null;
  expiresAt?: string | null;
};

export type AuthenticatedSession = { data: SessionData; user: User };

type LegacyStoredSession = { userId: string; gen: number };
type VerifiedCredential =
  | { kind: "jwt"; claims: CloudSessionClaims }
  | { kind: "legacy"; data: LegacyStoredSession };

const sessionKey = (userId: string, randomToken: string) => `session:${userId}:${randomToken}`;
const genKey = (userId: string) => `session:gen:${userId}`;
const log = logger("cloud:session");
const DISABLE_LEGACY_GENERATION = Number.MAX_SAFE_INTEGER;
let lastLegacyUseLogAt = 0;

const sessionIssuanceMode = (): "legacy" | "jwt" => {
  const value = (process.env.CLOUD_SESSION_ISSUANCE_MODE ?? "legacy").trim().toLowerCase();
  if (value !== "legacy" && value !== "jwt") throw new Error("CLOUD_SESSION_ISSUANCE_MODE must be legacy or jwt");
  return value;
};

const readGen = async (userId: string): Promise<number> => {
  const raw = await redis.get(genKey(userId));
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const parseToken = (token: string): { userId: string; randomToken: string } | null => {
  const colonIndex = token.indexOf(":");
  if (colonIndex === -1) return null;
  const userId = token.slice(0, colonIndex);
  const randomToken = token.slice(colonIndex + 1);
  if (!userId || !randomToken) return null;
  return { userId, randomToken };
};

const parseBearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
};

const isCloudApiToken = (token: string | null): boolean => Boolean(token?.startsWith("cld_"));

const createLegacyToken = async (userId: string, ttlSeconds: number): Promise<string> => {
  const randomToken = crypto.randomUUID();
  const gen = await readGen(userId);
  const data: LegacyStoredSession = { userId, gen };
  await redis.set(sessionKey(userId, randomToken), JSON.stringify(data), "EX", ttlSeconds);
  return `${userId}:${randomToken}`;
};

const readLegacyCredential = async (token: string): Promise<VerifiedCredential | null> => {
  const parsed = parseToken(token);
  if (!parsed) return null;
  const raw = await redis.get(sessionKey(parsed.userId, parsed.randomToken));
  if (!raw) return null;
  let data: LegacyStoredSession;
  try {
    data = JSON.parse(raw) as LegacyStoredSession;
  } catch {
    return null;
  }
  if (data.userId !== parsed.userId || !Number.isFinite(data.gen)) return null;
  const currentGen = await readGen(parsed.userId);
  if (data.gen < currentGen) return null;
  identityMetrics.increment("legacy_session_use");
  if (Date.now() - lastLegacyUseLogAt >= 60_000) {
    lastLegacyUseLogAt = Date.now();
    log.info("Legacy session compatibility path used");
  }
  return { kind: "legacy", data };
};

const verifyCredential = async (token: string): Promise<VerifiedCredential | null> => {
  if (isSessionJwtCandidate(token)) {
    const claims = await verifySessionToken(token);
    return claims ? { kind: "jwt", claims } : null;
  }
  return readLegacyCredential(token);
};

const verificationByRequest = new WeakMap<Context, Map<string, Promise<VerifiedCredential | null>>>();
const authenticationByRequest = new WeakMap<Context, Map<string, Promise<AuthenticatedSession | null>>>();

const requestCached = <T>(cache: WeakMap<Context, Map<string, Promise<T>>>, c: Context, token: string, load: () => Promise<T>): Promise<T> => {
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

const verifyForRequest = (c: Context, token: string): Promise<VerifiedCredential | null> =>
  requestCached(verificationByRequest, c, token, () => verifyCredential(token));

const authenticateVerified = async (credential: VerifiedCredential): Promise<AuthenticatedSession | null> => {
  const { groupsAdmin } = await getIdentityRuntimeConfig();
  if (credential.kind === "jwt") {
    const user = await loadJwtSessionUser({
      userId: credential.claims.sub,
      sid: credential.claims.sid,
      authEpoch: credential.claims.auth_epoch,
      groupsAdmin,
    });
    if (!user) return null;
    if (isAccountExpired(user.accountExpires)) {
      await session.revokeAllForUser(user.id);
      return null;
    }
    return {
      user,
      data: {
        userId: user.id,
        gen: 0,
        kind: "jwt",
        sid: credential.claims.sid,
        authEpoch: credential.claims.auth_epoch,
        expiresAt: new Date(credential.claims.exp * 1_000).toISOString(),
      },
    };
  }

  const user = await loadLegacySessionUser({
    userId: credential.data.userId,
    sessionGeneration: credential.data.gen,
    groupsAdmin,
  });
  if (!user) return null;
  if (isAccountExpired(user.accountExpires)) {
    await session.revokeAllForUser(user.id);
    return null;
  }
  return {
    user,
    data: {
      userId: user.id,
      gen: credential.data.gen,
      kind: "legacy",
      sid: null,
      authEpoch: null,
      expiresAt: null,
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
  const parsed = parseToken(token);
  if (parsed) await redis.del(sessionKey(parsed.userId, parsed.randomToken));
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
      const [user] = await tx<Array<{ auth_epoch: string | number | bigint }>>`
        SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE
      `;
      if (!user) throw new Error("Cannot create a session for an unknown user");
      const epoch = Number(user.auth_epoch);
      if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("User auth_epoch is invalid");
      const [activeKey] = await tx<Array<{ kid: string }>>`
        SELECT kid FROM auth.signing_keys
        WHERE kid = ${signer.kid} AND purpose = 'session' AND state = 'active'
        FOR SHARE
      `;
      if (!activeKey) throw new Error("Prepared Cloud session signer is no longer active");
      await tx`
        INSERT INTO auth.session_families (
          sid, user_id, auth_epoch, signing_kid, issued_at, expires_at, created_request_id, created_user_agent
        ) VALUES (${sid}, ${userId}, ${epoch}, ${signer.kid}, ${issuedAt}, ${expiresAt}, ${requestId}, ${userAgent})
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
  parseToken,

  create: async (c: Context, userId: string): Promise<string> => {
    const expiryHours = await settings.get<number>("user.session.expiry_hours");
    if (!Number.isFinite(expiryHours) || expiryHours < 1) throw new Error("user.session.expiry_hours must be a positive number");
    const ttlSeconds = Math.floor(expiryHours * 60 * 60);
    const issuedAt = new Date();
    let clientToken: string;
    if (sessionIssuanceMode() === "legacy") {
      clientToken = await createLegacyToken(userId, ttlSeconds);
      await sql`UPDATE auth.users SET last_login_local = ${issuedAt} WHERE id = ${userId}::uuid`;
    } else {
      clientToken = await issueJwtSession(c, userId, ttlSeconds);
    }

    setCookie(c, "session_token", clientToken, {
      httpOnly: true,
      secure: !env.IS_DEVELOPMENT,
      sameSite: "Lax",
      maxAge: ttlSeconds,
      path: "/",
    });
    return clientToken;
  },

  /** Compatibility-only delegation path. Invocation JWTs replace this in the next identity slice. */
  createDelegation: (userId: string, ttlSeconds = 60): Promise<string> => {
    const ttl = Number.isFinite(ttlSeconds) ? Math.max(5, Math.min(Math.floor(ttlSeconds), 120)) : 60;
    return createLegacyToken(userId, ttl);
  },

  revoke: revokeToken,

  delete: async (c: Context): Promise<void> => {
    const token = session.getToken(c);
    if (token) await revokeToken(token, c.req.header("x-request-id"));
    deleteCookie(c, "session_token", { path: "/" });
  },

  revokeAllForUser: async (userId: string): Promise<void> => {
    let observedLegacyGeneration: number | null = null;
    try {
      observedLegacyGeneration = await readGen(userId);
    } catch (error) {
      log.warn("Legacy session generation unavailable during durable revoke-all", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const requestedFloor = observedLegacyGeneration === null ? DISABLE_LEGACY_GENERATION : observedLegacyGeneration + 1;
    const [updated] = await sql<Array<{ legacy_session_generation: string | number | bigint }>>`
      UPDATE auth.users
      SET auth_epoch = auth_epoch + 1,
          legacy_session_generation = GREATEST(legacy_session_generation + 1, ${requestedFloor})
      WHERE id = ${userId}::uuid
      RETURNING legacy_session_generation
    `;
    if (!updated) throw new Error("Cannot revoke sessions for an unknown user");

    const durableFloor = Number(updated.legacy_session_generation);
    if (!Number.isSafeInteger(durableFloor) || durableFloor < 0) {
      throw new Error("Durable legacy session generation is invalid");
    }
    if (durableFloor === DISABLE_LEGACY_GENERATION) return;

    try {
      await redis.send("EVAL", [
        "local current = tonumber(redis.call('GET', KEYS[1]) or '0'); local target = tonumber(ARGV[1]); if current < target then redis.call('SET', KEYS[1], ARGV[1]); return target end; return current",
        "1",
        genKey(userId),
        String(durableFloor),
      ]);
    } catch (error) {
      log.warn("Legacy Redis generation could not be synchronized after durable revoke-all", {
        userId,
        durableFloor,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  authenticate: authenticateToken,

  authenticateRequest: (c: Context, token: string): Promise<AuthenticatedSession | null> =>
    requestCached(authenticationByRequest, c, token, async () => {
      const credential = await verifyForRequest(c, token);
      return credential ? authenticateVerified(credential) : null;
    }),

  getRequestSubject: async (c: Context, token: string): Promise<string | null> => {
    const credential = await verifyForRequest(c, token);
    return credential?.kind === "jwt" ? credential.claims.sub : (credential?.data.userId ?? null);
  },

  getData: async (token: string): Promise<SessionData | null> => (await authenticateToken(token))?.data ?? null,
};
