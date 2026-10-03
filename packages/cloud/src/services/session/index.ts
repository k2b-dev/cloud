import { type SQL, sql } from "bun";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env";
import { PWA_AUTH_PATH, PWA_COOKIES } from "../../contracts/pwa";
import type { User } from "../../contracts/shared";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { isAccountExpired } from "../account-model";
import { audit } from "../audit";
import { IDENTITY_CLOCK_TOLERANCE_SECONDS, IDENTITY_ROLLOUT_MARGIN_MS } from "../identity/constants";
import { invalidateIdentitySignerCache, type PreparedIdentitySigner, prepareIdentitySigner } from "../identity/key-ring";
import { getIdentityRuntimeConfig } from "../identity/runtime-config";
import { type CloudSessionClaims, isSessionJwtCandidate, signSessionToken, verifySessionToken } from "../identity/session-token";
import * as settings from "../settings";
import { loadJwtSession, loadJwtSessionIdentity } from "./user";

export type SessionKind = "web" | "app";

export type SessionData = {
  userId: string;
  sid: string;
  authEpoch: number;
  expiresAt: string;
  /** `"app"` for a session of a paired phone in the mobile app; derived from the family, never from the cookie. */
  kind: SessionKind;
  /** The paired phone of an app session. */
  deviceId?: string;
};

export type AuthenticatedSession = { data: SessionData; user: User };

/** Every request below `/pwa/` except Core's `/pwa/_auth` belongs to the mobile app. */
export const isAppPagePath = (path: string): boolean =>
  (path === "/pwa" || path.startsWith("/pwa/")) && path !== PWA_AUTH_PATH && !path.startsWith(`${PWA_AUTH_PATH}/`);

/** Documents, iframes and form posts. Only the web session navigates outside the app. */
export const isNavigationRequest = (c: Context): boolean => c.req.header("Sec-Fetch-Mode") === "navigate";

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

/** Moves the account's authentication epoch, which ends every session issued before it.
 * Request-time expiry uses only this: device operations check expiry themselves and an
 * administrator can lift it, so revoking devices would depend on which request came first. */
const endSessions = async (db: SQL, userId: string): Promise<void> => {
  const [updated] = await db<Array<{ id: string }>>`
    UPDATE auth.users SET auth_epoch = auth_epoch + 1
    WHERE id = ${userId}::uuid RETURNING id
  `;
  if (!updated) throw new Error("Cannot revoke sessions for an unknown user");
};

const authenticateVerified = async (credential: CloudSessionClaims): Promise<AuthenticatedSession | null> => {
  const { groupsAdmin } = await getIdentityRuntimeConfig();
  const loaded = await loadJwtSession({
    userId: credential.sub,
    sid: credential.sid,
    authEpoch: credential.auth_epoch,
    groupsAdmin,
  });
  if (!loaded) return null;
  const { user, pwaDeviceId } = loaded;
  if (isAccountExpired(user.accountExpires)) {
    await endSessions(sql, user.id);
    return null;
  }
  return {
    user,
    data: {
      userId: user.id,
      sid: credential.sid,
      authEpoch: credential.auth_epoch,
      expiresAt: new Date(credential.exp * 1_000).toISOString(),
      kind: pwaDeviceId ? "app" : "web",
      ...(pwaDeviceId ? { deviceId: pwaDeviceId } : {}),
    },
  };
};

const authenticateToken = async (token: string): Promise<AuthenticatedSession | null> => {
  const credential = await verifyCredential(token);
  return credential ? authenticateVerified(credential) : null;
};

const authenticateUserId = async (token: string): Promise<string | null> => {
  const credential = await verifyCredential(token);
  if (!credential) return null;
  const identity = await loadJwtSessionIdentity({ userId: credential.sub, sid: credential.sid, authEpoch: credential.auth_epoch });
  if (!identity) return null;
  if (isAccountExpired(identity.accountExpires)) {
    await endSessions(sql, identity.userId);
    return null;
  }
  return identity.userId;
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

export type SessionIssueOptions = {
  ttlSeconds: number;
  /** Pre-chosen family id, for callers that record it in the same transaction. */
  sid?: string;
  /** Binds the family to a paired phone of the mobile app; the device must be active. */
  pwaDeviceId?: string | null;
  /** Web sign-ins update `last_login_local`; app renewals track use per device instead. */
  recordLogin?: boolean;
};

type PreparedFamily = {
  userId: string;
  sid: string;
  authEpoch: number;
  issuedAt: Date;
  expiresAt: Date;
  signer: PreparedIdentitySigner;
  options: SessionIssueOptions;
};

const SIGNER_INACTIVE = "Prepared Cloud session signer is no longer active";
const isSignerInactive = (error: unknown) => error instanceof Error && error.message === SIGNER_INACTIVE;

/** Inserts one family in `tx`. Locks the user row first, like every caller that locks more rows. */
const insertFamily = async (
  tx: SQL,
  c: Context,
  userId: string,
  signer: PreparedIdentitySigner,
  options: SessionIssueOptions,
): Promise<PreparedFamily> => {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + options.ttlSeconds * 1_000);
  const sid = options.sid ?? crypto.randomUUID();
  const requestId = c.req.header("x-request-id")?.slice(0, 64) ?? null;
  const userAgent = c.req.header("user-agent")?.slice(0, 256) ?? null;
  const [user] = await tx<Array<{ auth_epoch: string | number | bigint; provider: "local" | "ipa"; profile: "guest" | "user" }>>`
    SELECT auth_epoch, provider, profile FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE
  `;
  if (!user) throw new Error("Cannot create a session for an unknown user");
  if (!(await isAccountCategoryAllowed(user, tx)))
    throw new HTTPException(403, { message: "This account category is disabled. Contact an administrator." });
  const epoch = Number(user.auth_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("User auth_epoch is invalid");
  if (options.pwaDeviceId) {
    // Device revocation locks the same user row first, so a revoked device never gets a new family.
    const [device] = await tx`
      SELECT id FROM auth.pwa_devices WHERE id = ${options.pwaDeviceId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL FOR UPDATE
    `;
    if (!device) throw new Error("Cannot create an app session for an inactive device");
  }
  const [activeKey] = await tx<Array<{ kid: string }>>`
    UPDATE auth.signing_keys
    SET verify_until = GREATEST(verify_until, ${new Date(expiresAt.getTime() + IDENTITY_CLOCK_TOLERANCE_SECONDS * 1_000 + IDENTITY_ROLLOUT_MARGIN_MS)})
    WHERE kid = ${signer.kid} AND purpose = 'session' AND state = 'active' AND sign_until > now()
    RETURNING kid
  `;
  if (!activeKey) throw new Error(SIGNER_INACTIVE);
  await tx`
    INSERT INTO auth.session_families (
      sid, user_id, auth_epoch, signing_kid, issued_at, expires_at, created_request_id, created_user_agent, legal_pending, pwa_device_id
    ) VALUES (${sid}, ${userId}, ${epoch}, ${signer.kid}, ${issuedAt}, ${expiresAt}, ${requestId}, ${userAgent},
      NOT EXISTS (SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid), ${options.pwaDeviceId ?? null})
  `;
  if (options.recordLogin !== false) await tx`UPDATE auth.users SET last_login_local = ${issuedAt} WHERE id = ${userId}::uuid`;
  return { userId, sid, authEpoch: epoch, issuedAt, expiresAt, signer, options };
};

/** Signs a committed family. Null when the signer was revoked meanwhile; the family is revoked then. */
const signFamily = async (family: PreparedFamily): Promise<string | null> => {
  let token: string;
  try {
    token = (await signSessionToken(family)).token;
  } catch (error) {
    await sql`
      UPDATE auth.session_families
      SET revoked_at = now(), revocation_reason = 'issuance_failed'
      WHERE sid = ${family.sid}::uuid AND revoked_at IS NULL
    `;
    throw error;
  }

  const [stillActive] = await sql<Array<{ active: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM auth.signing_keys
      WHERE kid = ${family.signer.kid} AND purpose = 'session' AND state = 'active'
    ) AS active
  `;
  if (stillActive?.active) return token;

  await sql`
    UPDATE auth.session_families
    SET revoked_at = now(), revocation_reason = 'signer_revoked_during_issuance'
    WHERE sid = ${family.sid}::uuid AND revoked_at IS NULL
  `;
  invalidateIdentitySignerCache("session", family.signer.kid);
  return null;
};

/** One issuance attempt is retried once when the signing key changes underneath it. */
const issueJwtSession = async (c: Context, userId: string, options: SessionIssueOptions, attempt = 0): Promise<string> => {
  const signer = await prepareIdentitySigner("session");
  let family: PreparedFamily;
  try {
    family = await sql.begin((tx) => insertFamily(tx, c, userId, signer, options));
  } catch (error) {
    if (attempt === 0 && isSignerInactive(error)) {
      invalidateIdentitySignerCache("session", signer.kid);
      return issueJwtSession(c, userId, options, 1);
    }
    throw error;
  }
  const token = await signFamily(family);
  if (token) return token;
  if (attempt === 0) return issueJwtSession(c, userId, { ...options, sid: undefined }, 1);
  throw new Error("Cloud session signer changed repeatedly during issuance");
};

/**
 * Runs `work` in one transaction in which `issue` may insert a single session family next to
 * the caller's own rows, then signs that family after the commit. `work` must lock the user
 * row before any pairing or device row (`issue` locks it too). The transaction is retried
 * once when the signing key changed before the commit; a signer revoked after the commit
 * gets a replacement family in its own transaction.
 */
const issueInTransaction = async <T>(
  c: Context,
  work: (tx: SQL, issue: (userId: string, options: SessionIssueOptions) => Promise<string>) => Promise<T>,
): Promise<{ value: T; token: string | null }> => {
  for (let attempt = 0; ; attempt += 1) {
    const signer = await prepareIdentitySigner("session");
    let family: PreparedFamily | undefined;
    let value: T;
    try {
      value = await sql.begin((tx) =>
        work(tx, async (userId, options) => {
          if (family) throw new Error("Only one session family per transaction");
          family = await insertFamily(tx, c, userId, signer, options);
          return family.sid;
        }),
      );
    } catch (error) {
      if (attempt === 0 && isSignerInactive(error)) {
        invalidateIdentitySignerCache("session", signer.kid);
        continue;
      }
      throw error;
    }
    if (!family) return { value, token: null };
    const token = await signFamily(family);
    return { value, token: token ?? (await issueJwtSession(c, family.userId, { ...family.options, sid: undefined }, 1)) };
  }
};

/** Today's web credential: an explicit non-API bearer, otherwise the `session_token` cookie. */
const getWebOrBearerToken = (c: Context): string | null => {
  const authorization = c.req.header("Authorization");
  const bearer = parseBearer(authorization);
  if (/^Bearer(?:\s|$)/i.test(authorization ?? "")) return isCloudApiToken(bearer) ? null : bearer;
  return getCookie(c, "session_token") ?? null;
};

export const session = {
  /**
   * The credential of this request. Below `/pwa/` (except `/pwa/_auth`) only the app session
   * counts. Navigations elsewhere use the web session only. Other requests prefer the web
   * session and fall back to the app session.
   */
  getToken: (c: Context): string | null => {
    if (isAppPagePath(c.req.path)) return session.getAppToken(c);
    const token = getWebOrBearerToken(c);
    if (token || c.req.header("Authorization") || isNavigationRequest(c)) return token;
    return session.getAppToken(c);
  },

  getWebToken: (c: Context): string | null => getCookie(c, "session_token") ?? null,

  getAppToken: (c: Context): string | null => getCookie(c, PWA_COOKIES.session) ?? null,

  getBearerToken: (c: Context): string | null => parseBearer(c.req.header("Authorization")),

  create: async (c: Context, userId: string): Promise<string> => {
    const expiryHours = await settings.get<number>("user.session.expiry_hours");
    if (!Number.isFinite(expiryHours) || expiryHours < 1) throw new Error("user.session.expiry_hours must be a positive number");
    const ttlSeconds = Math.floor(expiryHours * 60 * 60);
    const clientToken = await issueJwtSession(c, userId, { ttlSeconds });

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

  /** Signs out the web session (or an explicit bearer session). The mobile app's session is unaffected. */
  delete: async (c: Context): Promise<void> => {
    const token = getWebOrBearerToken(c);
    if (token) await revokeToken(token, c.req.header("x-request-id"));
    deleteCookie(c, "session_token", { path: "/" });
  },

  issueInTransaction,

  /** Signs the account out everywhere: every session, every paired sign-in device and every paired phone, audited per device. */
  revokeAllForUser: async (userId: string): Promise<void> => {
    await sql.begin(async (tx) => {
      await endSessions(tx, userId);
      // The epoch change already ends the phones; revoking them keeps lists and the audit log truthful.
      const phones = await tx<Array<{ id: string }>>`
        UPDATE auth.pwa_devices SET revoked_at = now(), revocation_reason = 'sign_out_everywhere'
        WHERE user_id = ${userId}::uuid AND revoked_at IS NULL RETURNING id
      `;
      for (const phone of phones)
        await audit.record(
          {
            action: "auth.pwa.device.revoke",
            outcome: "allowed",
            target: { type: "pwa_device", id: phone.id },
            metadata: { targetUserId: userId, provenance: "system", reason: "sign_out_everywhere" },
          },
          tx,
        );
      // A paired device approves new sign-ins on its own, so a lost one would outlive the epoch change.
      const devices = await tx<Array<{ id: string }>>`
        UPDATE auth.app_devices SET revoked_at = now() WHERE user_id = ${userId}::uuid AND revoked_at IS NULL RETURNING id
      `;
      for (const device of devices)
        await audit.record(
          {
            action: "auth.app.device.revoke",
            outcome: "allowed",
            target: { type: "app_device", id: device.id },
            metadata: { targetUserId: userId, provenance: "system", reason: "sign_out_everywhere" },
          },
          tx,
        );
    });
  },

  authenticate: authenticateToken,
  /** Fresh session validity for user-scoped streams; does not grant resource access. */
  authenticateUserId,

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
