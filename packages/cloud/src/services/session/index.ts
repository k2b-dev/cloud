import { type SQL, sql } from "bun";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { env } from "../../config/env";
import { PWA_AUTH_PATH, PWA_COOKIES } from "../../contracts/pwa";
import type { User } from "../../contracts/shared";
import { getLocale } from "../../server/locale";
import { describeRequest } from "../../server/request-context";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { isAccountExpired } from "../account-model";
import { audit } from "../audit";
import { IDENTITY_CLOCK_TOLERANCE_SECONDS, IDENTITY_ROLLOUT_MARGIN_MS } from "../identity/constants";
import { invalidateIdentitySignerCache, type PreparedIdentitySigner, prepareIdentitySigner } from "../identity/key-ring";
import { getIdentityRuntimeConfig } from "../identity/runtime-config";
import { type CloudSessionClaims, isSessionJwtCandidate, signSessionToken, verifySessionToken } from "../identity/session-token";
import {
  announceNewBrowser,
  type NewBrowserSignInNotice,
  type NewBrowserSignInNotifier,
  newBrowserCookie,
  noticeFirstName,
  readBrowserCookie,
  rememberSignIn,
  type SignInMethod,
  setBrowserCookie,
} from "../known-browsers";
import { logger } from "../logging";
import * as settings from "../settings";
import { loadJwtSession, loadJwtSessionIdentity } from "./user";

const log = logger("auth:session");

/** A browser already signed in must prove that same account before continuing. */
export class SessionAccountMismatchError extends Error {
  constructor() {
    super("Sign in with the account already open in this browser.");
    this.name = "SessionAccountMismatchError";
  }
}

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
const endSessions = async (db: SQL, userId: string): Promise<number> => {
  const [updated] = await db<Array<{ auth_epoch: string | number | bigint }>>`
    UPDATE auth.users SET auth_epoch = auth_epoch + 1
    WHERE id = ${userId}::uuid RETURNING auth_epoch
  `;
  if (!updated) throw new Error("Cannot revoke sessions for an unknown user");
  return Number(updated.auth_epoch);
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

export class SessionEpochChangedError extends Error {}
/** The Cloud Login device that approved a sign-in was removed before the session was issued. */
export class SessionAppDeviceInactiveError extends Error {}

export type SessionIssueOptions = {
  authEpoch?: number;
  ttlSeconds: number;
  /** Only web session.create supplies browser persistence, never mobile issuance. */
  knownBrowser?: Pick<
    Parameters<typeof rememberSignIn>[1],
    "cookie" | "browser" | "os" | "country" | "city" | "method" | "device" | "locale" | "announce"
  >;
  /** Pre-chosen family id, for callers that record it in the same transaction. */
  sid?: string;
  /** Binds the family to a paired phone of the mobile app; the device must be active. */
  pwaDeviceId?: string | null;
  /** The active Cloud Login device that approved this web sign-in. */
  appDeviceId?: string;
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
  notice: NewBrowserSignInNotice | null;
};

const SIGNER_INACTIVE = "Prepared Cloud session signer is no longer active";
const isSignerInactive = (error: unknown) => error instanceof Error && error.message === SIGNER_INACTIVE;

/** Inserts one family in `tx`. Locks the user row first, like every caller that locks more rows; `NO KEY UPDATE`
 * serializes with every other account lock but lets foreign-key checks of concurrent writes pass. */
const insertFamily = async (
  tx: SQL,
  c: Context,
  userId: string,
  signer: PreparedIdentitySigner,
  options: SessionIssueOptions,
): Promise<PreparedFamily> => {
  const sid = options.sid ?? crypto.randomUUID();
  const requestId = c.req.header("x-request-id")?.slice(0, 64) ?? null;
  const userAgent = c.req.header("user-agent")?.slice(0, 256) ?? null;
  const [user] = await tx<
    Array<{ given_name: string | null; auth_epoch: string | number | bigint; provider: "local" | "ipa"; profile: "guest" | "user" }>
  >`
    SELECT given_name, auth_epoch, provider, profile FROM auth.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
  `;
  if (!user) throw new Error("Cannot create a session for an unknown user");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + options.ttlSeconds * 1_000);
  if (!(await isAccountCategoryAllowed(user, tx)))
    throw new HTTPException(403, { message: "This account category is disabled. Contact an administrator." });
  const epoch = Number(user.auth_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("User auth_epoch is invalid");
  if (options.authEpoch !== undefined && epoch !== options.authEpoch) throw new SessionEpochChangedError();
  if (options.pwaDeviceId) {
    // Device revocation locks the same user row first, so a revoked device never gets a new family.
    const [device] = await tx`
      SELECT id FROM auth.pwa_devices WHERE id = ${options.pwaDeviceId}::uuid AND user_id = ${userId}::uuid AND revoked_at IS NULL FOR UPDATE
    `;
    if (!device) throw new Error("Cannot create an app session for an inactive device");
  }
  if (options.appDeviceId) {
    // A device that decides a terminal sign-in holds its row and then takes a key-share lock on this user row, so the
    // user row above is held without blocking key-share locks. Removals that end the device's sign-ins hold the user
    // row too, so they wait for this family.
    const [device] = await tx`SELECT id FROM auth.app_devices
      WHERE id=${options.appDeviceId}::uuid AND user_id=${userId}::uuid AND revoked_at IS NULL`;
    if (!device) throw new SessionAppDeviceInactiveError("Cannot create a session for an inactive sign-in device");
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
      sid, user_id, auth_epoch, signing_kid, issued_at, expires_at, created_request_id, created_user_agent, legal_pending, pwa_device_id, app_device_id
    ) VALUES (${sid}, ${userId}, ${epoch}, ${signer.kid}, ${issuedAt}, ${expiresAt}, ${requestId}, ${userAgent},
      NOT EXISTS (SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid), ${options.pwaDeviceId ?? null}, ${options.appDeviceId ?? null})
  `;
  const notice = options.knownBrowser
    ? await rememberSignIn(tx, { ...options.knownBrowser, userId, firstName: noticeFirstName(user.given_name), now: issuedAt })
    : null;
  if (options.recordLogin !== false) await tx`UPDATE auth.users SET last_login_local = ${issuedAt} WHERE id = ${userId}::uuid`;
  return { userId, sid, authEpoch: epoch, issuedAt, expiresAt, signer, options, notice };
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
const issueJwtSession = async (
  c: Context,
  userId: string,
  options: SessionIssueOptions,
  attempt = 0,
  committedNotice: NewBrowserSignInNotice | null = null,
): Promise<{ token: string; expiresAt: Date; notice: NewBrowserSignInNotice | null }> => {
  const signer = await prepareIdentitySigner("session");
  let family: PreparedFamily;
  try {
    family = await sql.begin((tx) => insertFamily(tx, c, userId, signer, options));
  } catch (error) {
    if (attempt === 0 && isSignerInactive(error)) {
      invalidateIdentitySignerCache("session", signer.kid);
      return issueJwtSession(c, userId, options, 1, committedNotice);
    }
    throw error;
  }
  const token = await signFamily(family);
  const notice = committedNotice ?? family.notice;
  if (token) return { token, expiresAt: family.expiresAt, notice };
  if (attempt === 0) return issueJwtSession(c, userId, { ...options, sid: undefined }, 1, notice);
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
          family = await insertFamily(tx, c, userId, signer, { ...options, knownBrowser: undefined });
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
    return { value, token: token ?? (await issueJwtSession(c, family.userId, { ...family.options, sid: undefined }, 1)).token };
  }
};

/** Revokes the account's active mobile app phones and records each phone. */
const revokePhones = async (
  tx: SQL,
  userId: string,
  reason: "sign_out_everywhere" | "sign_out_others" | "password_change" | "password_reset",
): Promise<void> => {
  const phones = await tx<Array<{ id: string }>>`
    UPDATE auth.pwa_devices SET revoked_at = now(), revocation_reason = ${reason}
    WHERE user_id = ${userId}::uuid AND revoked_at IS NULL RETURNING id
  `;
  for (const phone of phones)
    await audit.record(
      {
        action: "auth.pwa.device.revoke",
        outcome: "allowed",
        target: { type: "pwa_device", id: phone.id },
        metadata: { targetUserId: userId, provenance: "system", reason },
      },
      tx,
    );
};

/** Copies a web family to a new sid, epoch and signer; sign-in time, expiry, origin and the Cloud Login device
 * that approved it stay the same, so removing that device still ends the copy. */
const copyFamily = async (tx: SQL, from: string, to: { sid: string; authEpoch: number; kid: string }): Promise<void> => {
  await tx`
    INSERT INTO auth.session_families (
      sid, user_id, auth_epoch, signing_kid, issued_at, expires_at, created_request_id, created_user_agent, legal_pending,
      pwa_device_id, app_device_id
    )
    SELECT ${to.sid}::uuid, user_id, ${to.authEpoch}, ${to.kid}, issued_at, expires_at,
      created_request_id, created_user_agent, legal_pending, pwa_device_id, app_device_id
    FROM auth.session_families WHERE sid = ${from}::uuid
  `;
};

/** Ends other sign-ins and moves the chosen browser to a new session id with its sign-in time and expiry.
 * The epoch change ends the account's other browser sessions, its OAuth sign-ins and access tokens, and pending
 * Cloud Login pairings and device changes; mobile app phones are revoked with an audit entry per phone. Unlike
 * `revokeAllForUser`, Cloud Login devices stay paired. API keys, passkeys and mandates stay valid.
 * `keep` is the browser sign-in the request authenticated, with the epoch it was authenticated at. The kept
 * family is revoked and replaced, so every check by session id rejects old copies of its cookie, and a
 * request that a concurrent change already ended keeps nothing.
 * If preparing the signer fails or it stays inactive after one retry, ends all sign-ins without keeping a browser.
 * If its signer changes after commit, retries once with a new family unless another sign-out intervened.
 * `kept` is null when no browser was kept: no `keep`, its epoch is no longer current, the family was not
 * a current active web session of the account, or signing it after the change failed. That browser must
 * sign in again. */
const endOtherSignIns = async (
  userId: string,
  options: { keep?: { sid: string; authEpoch: number } | null; reason: "password_change" | "password_reset" | "sign_out_others" },
): Promise<{ kept: { token: string; expiresAt: Date } | null }> => {
  const extendSigner = async (tx: SQL, signer: PreparedIdentitySigner, expiresAt: Date): Promise<void> => {
    const [activeKey] = await tx<Array<{ kid: string }>>`
      UPDATE auth.signing_keys
      SET verify_until = GREATEST(verify_until, ${new Date(expiresAt.getTime() + IDENTITY_CLOCK_TOLERANCE_SECONDS * 1_000 + IDENTITY_ROLLOUT_MARGIN_MS)})
      WHERE kid = ${signer.kid} AND purpose = 'session' AND state = 'active' AND sign_until > now()
      RETURNING kid
    `;
    if (!activeKey) throw new Error(SIGNER_INACTIVE);
  };
  let keep = options.keep ?? null;
  for (let attempt = 0; ; attempt += 1) {
    let signer: PreparedIdentitySigner | null = null;
    if (keep) {
      try {
        signer = await prepareIdentitySigner("session");
      } catch {
        log.warn("Could not prepare session signer; ending all sign-ins", { userId });
        keep = null;
      }
    }
    let family: PreparedFamily | null;
    try {
      family = await sql.begin(async (tx): Promise<PreparedFamily | null> => {
        const [user] = await tx<Array<{ auth_epoch: string | number | bigint }>>`
          SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
        `;
        if (!user) throw new Error("Cannot revoke sessions for an unknown user");
        const [kept] =
          keep && Number(user.auth_epoch) === keep.authEpoch
            ? // Locking the key orders this keep before a concurrent emergency key revocation. It is the
              // lock extendSigner takes for the same current key, so concurrent keeps queue instead of deadlocking.
              await tx<Array<{ sid: string; issued_at: Date; expires_at: Date }>>`
              SELECT sf.sid, sf.issued_at, sf.expires_at FROM auth.session_families sf
              JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
              WHERE sf.sid = ${keep.sid}::uuid AND sf.user_id = ${userId}::uuid
                AND sf.pwa_device_id IS NULL AND sf.revoked_at IS NULL AND sf.expires_at > now()
                AND sf.auth_epoch = ${user.auth_epoch}
              FOR UPDATE OF sf FOR NO KEY UPDATE OF sk
            `
            : [];
        const authEpoch = await endSessions(tx, userId);
        let prepared: PreparedFamily | null = null;
        if (kept && signer) {
          const issuedAt = new Date(kept.issued_at);
          const expiresAt = new Date(kept.expires_at);
          await extendSigner(tx, signer, expiresAt);
          const sid = crypto.randomUUID();
          await copyFamily(tx, kept.sid, { sid, authEpoch, kid: signer.kid });
          await tx`
            UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'rotated'
            WHERE sid = ${kept.sid}::uuid
          `;
          prepared = {
            userId,
            sid,
            authEpoch,
            issuedAt,
            expiresAt,
            signer,
            options: { ttlSeconds: (expiresAt.getTime() - issuedAt.getTime()) / 1_000, recordLogin: false },
            notice: null,
          };
        }
        await revokePhones(tx, userId, options.reason);
        return prepared;
      });
    } catch (error) {
      if (signer && isSignerInactive(error)) {
        if (attempt === 0) {
          invalidateIdentitySignerCache("session", signer.kid);
          continue;
        }
        if (attempt === 1) {
          log.warn("Session signer stayed inactive; ending all sign-ins", { userId });
          keep = null;
          continue;
        }
      }
      throw error;
    }
    if (!family) return { kept: null };
    try {
      const token = await signFamily(family);
      if (token) return { kept: { token, expiresAt: family.expiresAt } };
      const freshSigner = await prepareIdentitySigner("session");
      const replacement = await sql.begin(async (tx): Promise<PreparedFamily | null> => {
        const [user] = await tx<Array<{ auth_epoch: string | number | bigint }>>`
          SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
        `;
        if (!user || Number(user.auth_epoch) !== family.authEpoch) return null;
        // Device removal can skip this already-revoked family, so the replacement must recheck its device.
        const [revoked] = await tx<Array<{ sid: string }>>`
          SELECT sf.sid FROM auth.session_families sf
          WHERE sf.sid = ${family.sid}::uuid AND sf.user_id = ${userId}::uuid
            AND sf.revocation_reason = 'signer_revoked_during_issuance'
            AND (sf.app_device_id IS NULL OR EXISTS (
              SELECT 1 FROM auth.app_devices d WHERE d.id = sf.app_device_id AND d.revoked_at IS NULL
            )) FOR UPDATE
        `;
        if (!revoked) return null;
        await extendSigner(tx, freshSigner, family.expiresAt);
        const sid = crypto.randomUUID();
        await copyFamily(tx, revoked.sid, { sid, authEpoch: family.authEpoch, kid: freshSigner.kid });
        return { ...family, sid, signer: freshSigner };
      });
      if (!replacement) return { kept: null };
      const replacementToken = await signFamily(replacement);
      if (!replacementToken) throw new Error("Cloud session signer changed repeatedly during issuance");
      return { kept: { token: replacementToken, expiresAt: replacement.expiresAt } };
    } catch (error) {
      log.warn("Could not keep browser signed in after ending other sign-ins", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { kept: null };
    }
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

  /**
   * The app session to try when `token` (from `getToken`) did not authenticate: only for the web
   * cookie of a fetch outside `/pwa/` without an `Authorization` header. A copied, expired or revoked
   * web cookie must not hide a valid app session of the mobile app.
   */
  appSessionFallback: (c: Context, token: string | null): string | null => {
    const appToken = session.getAppToken(c);
    if (!appToken || !token || token === appToken || isAppPagePath(c.req.path)) return null;
    if (token !== session.getWebToken(c) || c.req.header("Authorization") || isNavigationRequest(c)) return null;
    return appToken;
  },

  /**
   * `getToken` with the validity fallback of the auth middleware, for handlers that authenticate
   * the token themselves (WebSockets, streams). Costs one extra check only while the request also
   * carries an app session.
   */
  resolveToken: async (c: Context): Promise<string | null> => {
    const token = session.getToken(c);
    const fallback = session.appSessionFallback(c, token);
    if (!token || !fallback) return token;
    return (await session.authenticateRequest(c, token)) ? token : fallback;
  },

  getWebToken: (c: Context): string | null => getCookie(c, "session_token") ?? null,

  getAppToken: (c: Context): string | null => getCookie(c, PWA_COOKIES.session) ?? null,

  getBearerToken: (c: Context): string | null => parseBearer(c.req.header("Authorization")),

  create: async (
    c: Context,
    userId: string,
    signIn: {
      method: SignInMethod;
      device?: string | null;
      /** Null means this sign-in announces nothing, including during maintenance. */
      notify: NewBrowserSignInNotifier | null;
      /** Account epoch an earlier approval was bound to; issuance fails when sign-out everywhere moved it. */
      authEpoch?: number;
      /** The Cloud Login device that approved this sign-in; removing the device can end the session. */
      appDeviceId?: string;
    },
  ): Promise<string> => {
    if (c.req.header("X-Cloud-Reauthenticate") === "1") {
      const currentToken = session.getWebToken(c);
      const current = currentToken ? await session.authenticateRequest(c, currentToken) : null;
      if (!current || current.user.id !== userId) throw new SessionAccountMismatchError();
    }

    const expiryHours = await settings.get<number>("user.session.expiry_hours");
    if (!Number.isFinite(expiryHours) || expiryHours < 1) throw new Error("user.session.expiry_hours must be a positive number");
    const ttlSeconds = Math.floor(expiryHours * 60 * 60);
    const cookie = readBrowserCookie(c) ?? newBrowserCookie();
    const { browser, os, country, city } = describeRequest(c);
    const {
      token: clientToken,
      expiresAt,
      notice,
    } = await issueJwtSession(c, userId, {
      ttlSeconds,
      authEpoch: signIn.authEpoch,
      appDeviceId: signIn.appDeviceId,
      knownBrowser: {
        cookie,
        browser,
        os,
        country,
        city,
        method: signIn.method,
        device: signIn.device ?? null,
        locale: getLocale(c),
        announce: signIn.notify !== null,
      },
    });
    // Handoff precedes the response so the person signing in cannot turn the notice off first.
    if (signIn.notify !== null && notice) await announceNewBrowser(signIn.notify, notice);

    session.setWebCookie(c, clientToken, expiresAt);
    setBrowserCookie(c, cookie);
    return clientToken;
  },

  /** Sets the `session_token` cookie the way `create` does. Use it for the token that `endOtherSignIns` keeps:
   * the max age runs to `expiresAt`, so that browser keeps its original expiry. */
  setWebCookie: (c: Context, token: string, expiresAt: Date): void => {
    setCookie(c, "session_token", token, {
      httpOnly: true,
      secure: !env.IS_DEVELOPMENT,
      sameSite: "Lax",
      maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)),
      path: "/",
    });
  },

  endOtherSignIns,

  revoke: revokeToken,

  /** Signs out the web session (or an explicit bearer session). The mobile app's session is unaffected. */
  delete: async (c: Context): Promise<void> => {
    const token = getWebOrBearerToken(c);
    if (token) await revokeToken(token, c.req.header("x-request-id"));
    deleteCookie(c, "session_token", { path: "/" });
  },

  issueInTransaction,

  /** Signs the account out everywhere: every session, every paired sign-in device and every paired phone, audited per device.
   * Returns the new authentication epoch so a following sign-in can stay bound to this sign-out. */
  revokeAllForUser: async (userId: string): Promise<number> => {
    return sql.begin(async (tx) => {
      const authEpoch = await endSessions(tx, userId);
      await revokePhones(tx, userId, "sign_out_everywhere");
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
      return authEpoch;
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
