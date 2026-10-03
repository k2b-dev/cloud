import { timingSafeEqual } from "node:crypto";
import { type SQL, sql } from "bun";
import type { Context } from "hono";
import { PWA_LIMITS as limits, type PwaDeviceView, type PwaErrorCode, type PwaPairingState, type PwaPlatform } from "../contracts/pwa";
import { isAccountCategoryAllowed } from "./account-category-policy";
import { audit } from "./audit";
import { pairingSecret } from "./pairing-secret";
import { type AuthenticatedSession, session } from "./session";
import { requireRecentWebSession } from "./session/recent";

/**
 * Paired phones of the mobile app (preview). A phone holds a device key that only Core
 * receives and a 24-hour app session that every application validates like a web session.
 * Lock order everywhere: the user row, then the pairing or device row.
 */
export class PwaError extends Error {
  constructor(
    public code: PwaErrorCode,
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503,
    public attemptsLeft?: number,
  ) {
    super(code);
  }
}

const fail = (code: PwaErrorCode, status: PwaError["status"], attemptsLeft?: number): never => {
  throw new PwaError(code, status, attemptsLeft);
};

/** The initiating web session of a pairing. */
export type PwaWebActor = { userId: string; sid: string };
/** Administration of another account's phones needs current admin authority. */
export type PwaDeviceAdministrator = { userId: string; admin: boolean };
export type PwaRevocationReason = "user" | "unpaired" | "admin" | "replaced" | "account_expired";

type PairingRow = {
  id: string;
  user_id: string;
  initiator_sid: string;
  auth_epoch: string;
  comparison: string | null;
  platform: PwaPlatform | null;
  device_name: string | null;
  failed_attempts: number;
  state: PwaPairingState;
  device_id: string | null;
  claim_until: Date;
  expires_at: Date;
};
type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  platform: PwaPlatform;
  auth_epoch: string;
  secret_hash: string;
  previous_secret_hash: string | null;
  rotated_at: Date;
  created_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
};
type UserRow = {
  id: string;
  uid: string;
  display_name: string | null;
  provider: "local" | "ipa";
  profile: "guest" | "user";
  auth_epoch: string;
  account_expires: Date | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();
const passed = (value: Date | string) => new Date(value).getTime() <= Date.now();
const DEVICE_KEY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

/** `<deviceId>.<secret>` from the `pwa_device` cookie, or null when malformed. */
export const parseDeviceKey = (value: string | null | undefined): { deviceId: string; secret: string } | null => {
  const match = value ? DEVICE_KEY.exec(value) : null;
  return match ? { deviceId: match[1]!, secret: match[2]! } : null;
};

/** Untranslated default names; the person renames the phone in the app. */
export const defaultDeviceName = (platform: PwaPlatform, userAgent: string | undefined): string =>
  platform === "ios" ? (/\biPad\b/.test(userAgent ?? "") ? "iPad" : "iPhone") : platform === "android" ? "Android" : "Phone";

const accountName = (user: Pick<UserRow, "display_name" | "uid">) => user.display_name?.trim() || user.uid;

const sameCode = (typed: string, expected: string | null) =>
  expected !== null && typed.length === expected.length && timingSafeEqual(Buffer.from(typed), Buffer.from(expected));

const view = (row: DeviceRow, currentDeviceId?: string | null): PwaDeviceView => ({
  id: row.id,
  name: row.name,
  platform: row.platform,
  createdAt: iso(row.created_at),
  lastUsedAt: iso(row.last_used_at),
  current: row.id === currentDeviceId,
});

const lockUser = async (tx: SQL, userId: string): Promise<UserRow | undefined> => {
  const [user] = await tx<UserRow[]>`
    SELECT id, uid, display_name, provider, profile, auth_epoch, account_expires FROM auth.users WHERE id = ${userId}::uuid FOR UPDATE
  `;
  return user;
};

/** An active phone (alias `d`): not revoked, used within the idle window, and enrolled in the current account epoch. */
const activeDevice = () => sql`d.revoked_at IS NULL
  AND d.rotated_at > now() - ${limits.idleDays} * interval '1 day'
  AND d.auth_epoch = (SELECT auth_epoch FROM auth.users WHERE id = d.user_id)`;

/** The web family that started a pairing is still valid (the session validator's predicate). */
const initiatorValid = async (tx: SQL, pairing: PairingRow): Promise<boolean> => {
  const [row] = await tx`
    SELECT 1 FROM auth.session_families sf
    JOIN auth.users u ON u.id = sf.user_id
    JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
    WHERE sf.sid = ${pairing.initiator_sid}::uuid AND sf.user_id = ${pairing.user_id}::uuid
      AND sf.revoked_at IS NULL AND sf.expires_at > now() AND sf.auth_epoch = u.auth_epoch AND sf.pwa_device_id IS NULL
  `;
  return Boolean(row);
};

const accountExpired = (user: UserRow) => Boolean(user.account_expires && passed(user.account_expires));
const legalAccepted = async (tx: SQL, userId: string) =>
  (await tx`SELECT 1 FROM auth.legal_acceptances WHERE user_id = ${userId}::uuid`).length > 0;

const record = (
  tx: SQL,
  action: string,
  target: { type: "pwa_pairing" | "pwa_device"; id: string },
  actorUserId: string | null,
  metadata: Record<string, unknown> = {},
) =>
  audit.record(
    {
      action: `auth.pwa.${action}`,
      outcome: "allowed",
      ...(actorUserId ? { actor: { userId: actorUserId } } : {}),
      target,
      metadata: actorUserId ? metadata : { ...metadata, provenance: "system" },
    },
    tx,
  );

/** Ends a device and every app session it holds, in the caller's transaction. */
const revokeDevice = async (
  tx: SQL,
  device: Pick<DeviceRow, "id" | "user_id">,
  reason: PwaRevocationReason,
  actorUserId: string | null,
): Promise<boolean> => {
  const revoked = await tx`
    UPDATE auth.pwa_devices SET revoked_at = now(), revocation_reason = ${reason}
    WHERE id = ${device.id}::uuid AND revoked_at IS NULL RETURNING id
  `;
  if (!revoked.length) return false;
  await tx`
    UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'app_device_revoked'
    WHERE pwa_device_id = ${device.id}::uuid AND revoked_at IS NULL
  `;
  await record(tx, "device.revoke", { type: "pwa_device", id: device.id }, actorUserId, {
    reason,
    ...(actorUserId !== device.user_id ? { targetUserId: device.user_id } : {}),
  });
  return true;
};

type KeyMatch = "current" | "previous" | null;
const matchKey = (device: DeviceRow, secret: string): KeyMatch =>
  pairingSecret.matches(secret, device.secret_hash)
    ? "current"
    : device.previous_secret_hash && pairingSecret.matches(secret, device.previous_secret_hash)
      ? "previous"
      : null;

/** Reads a presented device key without locks. Null unless it is a key of an active phone. */
const presentedDevice = async (key: string | null | undefined): Promise<{ device: DeviceRow; secret: string } | null> => {
  const parsed = parseDeviceKey(key);
  if (!parsed) return null;
  const [device] = await sql<DeviceRow[]>`SELECT d.* FROM auth.pwa_devices d WHERE d.id = ${parsed.deviceId}::uuid AND ${activeDevice()}`;
  return device && matchKey(device, parsed.secret) ? { device, secret: parsed.secret } : null;
};

const isActive = (device: DeviceRow, user: UserRow) =>
  !device.revoked_at &&
  Date.now() - new Date(device.rotated_at).getTime() < limits.idleDays * 86_400_000 &&
  device.auth_epoch === user.auth_epoch;

/** Cookie values to set after a successful pairing, recovery or renewal. */
export type PwaCredentials = { deviceKey: string; sessionToken: string };

export type PwaRenewal =
  | { outcome: "renewed"; userId: string; credentials: PwaCredentials }
  | { outcome: "current"; userId: string }
  | { outcome: "missing" }
  | { outcome: "ended" }
  | { outcome: "blocked" };

export type PwaCompletion =
  | { state: "paired"; credentials: PwaCredentials | null; platform: PwaPlatform }
  | { state: "waiting"; code: string; account: { name: string }; expiresAt: string };

export const createPwaDeviceService = () => {
  const appSession = (deviceId: string) => ({ ttlSeconds: limits.sessionSeconds, pwaDeviceId: deviceId, recordLogin: false });

  /**
   * A new device key. `rotate` keeps the old key as the previous one until the phone presents the
   * new one; `recover` keeps the previous key as it is; `replace` accepts only the new key.
   */
  const newKey = async (tx: SQL, deviceId: string, mode: "rotate" | "recover" | "replace") => {
    const secret = pairingSecret.create();
    const hash = pairingSecret.hash(secret);
    if (mode === "rotate")
      await tx`UPDATE auth.pwa_devices SET previous_secret_hash = secret_hash, secret_hash = ${hash},
        rotated_at = now(), last_used_at = now() WHERE id = ${deviceId}::uuid`;
    else if (mode === "recover")
      await tx`UPDATE auth.pwa_devices SET secret_hash = ${hash}, rotated_at = now(), last_used_at = now() WHERE id = ${deviceId}::uuid`;
    else
      await tx`UPDATE auth.pwa_devices SET previous_secret_hash = NULL, secret_hash = ${hash},
        rotated_at = now(), last_used_at = now() WHERE id = ${deviceId}::uuid`;
    return `${deviceId}.${secret}`;
  };

  const renewal = async (
    c: Context,
    input: { deviceKey: string | null | undefined; appSession: AuthenticatedSession | null },
  ): Promise<PwaRenewal> => {
    const parsed = parseDeviceKey(input.deviceKey);
    if (!parsed) return { outcome: "missing" };
    const [snapshot] = await sql<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${parsed.deviceId}::uuid`;
    if (!snapshot) return { outcome: "ended" };
    type Step = { outcome: "ended" | "blocked" } | { outcome: "current" } | { outcome: "renewed"; deviceKey: string };
    const { value, token } = await session.issueInTransaction<Step>(c, async (tx, issue) => {
      const user = await lockUser(tx, snapshot.user_id);
      const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${parsed.deviceId}::uuid FOR UPDATE`;
      if (!user || !device || !isActive(device, user)) return { outcome: "ended" };
      const match = matchKey(device, parsed.secret);
      if (!match) return { outcome: "ended" };
      if (accountExpired(user)) {
        // Extending the account later must not revive the phone.
        await revokeDevice(tx, device, "account_expired", null);
        return { outcome: "ended" };
      }
      if (!(await isAccountCategoryAllowed(user, tx)) || !(await legalAccepted(tx, user.id))) return { outcome: "blocked" };
      if (match === "current") {
        // The phone uses the newest key, so the older one stops working.
        if (device.previous_secret_hash) await tx`UPDATE auth.pwa_devices SET previous_secret_hash = NULL WHERE id = ${device.id}::uuid`;
        const live = input.appSession;
        const remaining = live ? new Date(live.data.expiresAt).getTime() - Date.now() : 0;
        if (live?.data.deviceId === device.id && live.user.id === user.id && remaining > limits.renewWithinSeconds * 1000) {
          await tx`UPDATE auth.pwa_devices SET last_used_at = now() WHERE id = ${device.id}::uuid AND last_used_at < date_trunc('day', now())`;
          return { outcome: "current" };
        }
        const deviceKey = await newKey(tx, device.id, "rotate");
        await issue(user.id, appSession(device.id));
        return { outcome: "renewed", deviceKey };
      }
      // The previous key: a parallel renewal is running, or the phone missed the last answer.
      if (Date.now() - new Date(device.rotated_at).getTime() < limits.rotationGraceSeconds * 1000) return { outcome: "current" };
      const deviceKey = await newKey(tx, device.id, "recover");
      await issue(user.id, appSession(device.id));
      await record(tx, "device.recover", { type: "pwa_device", id: device.id }, user.id);
      return { outcome: "renewed", deviceKey };
    });
    if (value.outcome === "renewed") {
      if (!token) throw new Error("App session was not issued");
      return { outcome: "renewed", userId: snapshot.user_id, credentials: { deviceKey: value.deviceKey, sessionToken: token } };
    }
    if (value.outcome === "current") return { outcome: "current", userId: snapshot.user_id };
    return value;
  };

  return {
    // ---------- Web side: the initiating web session ----------

    startPairing: async (actor: PwaWebActor) => {
      const id = crypto.randomUUID();
      const secret = pairingSecret.create();
      const now = Date.now();
      const claimUntil = new Date(now + limits.linkClaimSeconds * 1000);
      const expiresAt = new Date(now + limits.pairingSeconds * 1000);
      await sql.begin(async (tx) => {
        await lockUser(tx, actor.userId);
        const account = await requireRecentWebSession(tx, actor, limits.recentSessionSeconds, (code) => fail(code, 403));
        const [open] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM auth.pwa_pairings
          WHERE user_id = ${actor.userId}::uuid AND expires_at > now() AND state IN ('pending', 'claimed', 'confirmed')
        `;
        if ((open?.count ?? 0) >= limits.pendingPerAccount) fail("LIMIT_REACHED", 429);
        await tx`INSERT INTO auth.pwa_pairings (id, user_id, initiator_sid, auth_epoch, link_secret_hash, state, claim_until, expires_at)
          VALUES (${id}::uuid, ${actor.userId}::uuid, ${actor.sid}::uuid, ${account.auth_epoch}, ${pairingSecret.hash(secret)}, 'pending', ${claimUntil}, ${expiresAt})`;
        await record(tx, "pairing.start", { type: "pwa_pairing", id }, actor.userId);
      });
      return { id, secret, claimUntil: iso(claimUntil), expiresAt: iso(expiresAt) };
    },

    /** Never returns the code: the person types what the phone shows. */
    inspectPairing: async (actor: PwaWebActor, id: string) => {
      const [p] = await sql<(PairingRow & { current_epoch: string })[]>`
        SELECT p.*, u.auth_epoch AS current_epoch FROM auth.pwa_pairings p JOIN auth.users u ON u.id = p.user_id
        WHERE p.id = ${id}::uuid AND p.user_id = ${actor.userId}::uuid AND p.initiator_sid = ${actor.sid}::uuid
      `;
      if (!p) return fail("NOT_FOUND", 404);
      if (passed(p.expires_at) || p.current_epoch !== p.auth_epoch || (p.state === "pending" && passed(p.claim_until)))
        return fail("EXPIRED", 410);
      return {
        state: p.state,
        claimUntil: iso(p.claim_until),
        expiresAt: iso(p.expires_at),
        device: p.state === "pending" || !p.device_name || !p.platform ? null : { name: p.device_name, platform: p.platform },
        attemptsLeft: Math.max(0, limits.confirmAttempts - p.failed_attempts),
      };
    },

    confirmPairing: async (actor: PwaWebActor, id: string, code: string) => {
      type Outcome = { ok: true } | { ok: false; code: PwaErrorCode; status: PwaError["status"]; attemptsLeft?: number };
      const outcome = await sql.begin(async (tx): Promise<Outcome> => {
        const user = await lockUser(tx, actor.userId);
        const [p] = await tx<PairingRow[]>`
          SELECT * FROM auth.pwa_pairings WHERE id = ${id}::uuid AND user_id = ${actor.userId}::uuid AND initiator_sid = ${actor.sid}::uuid FOR UPDATE
        `;
        if (!user || !p) return { ok: false, code: "NOT_FOUND", status: 404 };
        if (p.state === "cancelled" || passed(p.expires_at) || user.auth_epoch !== p.auth_epoch || !(await initiatorValid(tx, p)))
          return { ok: false, code: "EXPIRED", status: 410 };
        if (p.state !== "claimed") return { ok: false, code: "CONFLICT", status: 409 };
        if (accountExpired(user) || !(await isAccountCategoryAllowed(user, tx))) return { ok: false, code: "FORBIDDEN", status: 403 };
        if (!sameCode(code, p.comparison)) {
          const failed = p.failed_attempts + 1;
          if (failed >= limits.confirmAttempts) {
            // A guessed or photographed code gets three tries; then the link is spent.
            await tx`UPDATE auth.pwa_pairings SET failed_attempts = ${failed}, state = 'cancelled' WHERE id = ${p.id}::uuid`;
            await record(tx, "pairing.cancel", { type: "pwa_pairing", id: p.id }, actor.userId, { reason: "wrong_code" });
            return { ok: false, code: "EXPIRED", status: 410, attemptsLeft: 0 };
          }
          await tx`UPDATE auth.pwa_pairings SET failed_attempts = ${failed} WHERE id = ${p.id}::uuid`;
          return { ok: false, code: "WRONG_CODE", status: 409, attemptsLeft: limits.confirmAttempts - failed };
        }
        await tx`UPDATE auth.pwa_pairings SET state = 'confirmed' WHERE id = ${p.id}::uuid`;
        await record(tx, "pairing.confirm", { type: "pwa_pairing", id: p.id }, actor.userId, { platform: p.platform });
        return { ok: true };
      });
      if (!outcome.ok) fail(outcome.code, outcome.status, outcome.attemptsLeft);
    },

    cancelPairing: async (actor: PwaWebActor, id: string) => {
      await sql.begin(async (tx) => {
        await lockUser(tx, actor.userId);
        const [p] = await tx<PairingRow[]>`
          SELECT * FROM auth.pwa_pairings WHERE id = ${id}::uuid AND user_id = ${actor.userId}::uuid AND initiator_sid = ${actor.sid}::uuid FOR UPDATE
        `;
        if (!p) return fail("NOT_FOUND", 404);
        if (p.state === "completed") return fail("CONFLICT", 409);
        if (p.state === "cancelled") return;
        await tx`UPDATE auth.pwa_pairings SET state = 'cancelled' WHERE id = ${p.id}::uuid`;
        await record(tx, "pairing.cancel", { type: "pwa_pairing", id: p.id }, actor.userId, { reason: "user" });
      });
    },

    /** Active phones of the person. `currentDeviceId` marks the phone this request comes from. */
    list: async (actor: { userId: string }, currentDeviceId?: string | null): Promise<PwaDeviceView[]> => {
      const rows = await sql<DeviceRow[]>`
        SELECT d.* FROM auth.pwa_devices d WHERE d.user_id = ${actor.userId}::uuid AND ${activeDevice()}
        ORDER BY d.created_at, d.id LIMIT ${limits.devicesPerAccount}
      `;
      return rows.map((row) => view(row, currentDeviceId));
    },

    /** Idempotent removal of the person's own phone. */
    revoke: async (actor: { userId: string }, deviceId: string) => {
      await sql.begin(async (tx) => {
        await lockUser(tx, actor.userId);
        const [device] = await tx<DeviceRow[]>`
          SELECT * FROM auth.pwa_devices WHERE id = ${deviceId}::uuid AND user_id = ${actor.userId}::uuid FOR UPDATE
        `;
        if (!device) return fail("NOT_FOUND", 404);
        await revokeDevice(tx, device, "user", actor.userId);
      });
    },

    // ---------- Phone side: the installed app ----------

    /** Single use. Returns the completion secret for the `pwa_pairing` cookie and the code the phone shows. */
    claimPairing: async (input: { secret: string; platform: PwaPlatform; userAgent?: string }) => {
      const [snapshot] = await sql<PairingRow[]>`
        SELECT * FROM auth.pwa_pairings WHERE link_secret_hash = ${pairingSecret.hash(input.secret)}
      `;
      if (!snapshot) return fail("EXPIRED", 410);
      const completionSecret = pairingSecret.create();
      const code = pairingSecret.code();
      const result = await sql.begin(async (tx) => {
        const user = await lockUser(tx, snapshot.user_id);
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.pwa_pairings WHERE id = ${snapshot.id}::uuid FOR UPDATE`;
        if (!user || !p || p.state === "cancelled" || passed(p.expires_at) || passed(p.claim_until)) return fail("EXPIRED", 410);
        if (p.state !== "pending") return fail("ALREADY_USED", 409);
        if (user.auth_epoch !== p.auth_epoch || accountExpired(user) || !(await isAccountCategoryAllowed(user, tx)))
          return fail("EXPIRED", 410);
        await tx`UPDATE auth.pwa_pairings SET state = 'claimed', completion_secret_hash = ${pairingSecret.hash(completionSecret)},
          comparison = ${code}, platform = ${input.platform}, device_name = ${defaultDeviceName(input.platform, input.userAgent)}
          WHERE id = ${p.id}::uuid`;
        return { account: { name: accountName(user) }, expiresAt: p.expires_at };
      });
      return { code, account: result.account, expiresAt: iso(result.expiresAt), completionSecret };
    },

    /**
     * Finishes a confirmed pairing in the app. `webUserId` is the owner of a valid web session in
     * the same cookie jar; `appSession` is a valid app session presented with the request.
     */
    completePairing: async (
      c: Context,
      input: {
        completionSecret: string | null | undefined;
        deviceKey: string | null | undefined;
        appSession: AuthenticatedSession | null;
        webUserId: string | null;
      },
    ): Promise<PwaCompletion> => {
      if (!input.completionSecret) return fail("EXPIRED", 410);
      const [snapshot] = await sql<PairingRow[]>`
        SELECT * FROM auth.pwa_pairings WHERE completion_secret_hash = ${pairingSecret.hash(input.completionSecret)}
      `;
      if (!snapshot || snapshot.state === "cancelled" || passed(snapshot.expires_at)) return fail("EXPIRED", 410);
      if (snapshot.state === "claimed") {
        const [user] = await sql<UserRow[]>`SELECT * FROM auth.users WHERE id = ${snapshot.user_id}::uuid`;
        // Signing out on the web, or everywhere, voids the pairing at once.
        if (!user || !snapshot.comparison || user.auth_epoch !== snapshot.auth_epoch || !(await initiatorValid(sql, snapshot)))
          return fail("EXPIRED", 410);
        return { state: "waiting", code: snapshot.comparison, account: { name: accountName(user) }, expiresAt: iso(snapshot.expires_at) };
      }
      if (snapshot.state !== "confirmed" && snapshot.state !== "completed") return fail("EXPIRED", 410);
      // The device key of this app, read before the locks; it is rechecked under them.
      const presented = await presentedDevice(input.deviceKey);
      type Step = { kind: "already" } | { kind: "issued"; deviceKey: string };
      const { value, token } = await session.issueInTransaction<Step>(c, async (tx, issue) => {
        const user = await lockUser(tx, snapshot.user_id);
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.pwa_pairings WHERE id = ${snapshot.id}::uuid FOR UPDATE`;
        if (!user || !p || passed(p.expires_at) || user.auth_epoch !== p.auth_epoch) return fail("EXPIRED", 410);
        if (p.state === "completed" && p.device_id) {
          // A lost response: answer again without creating a second device.
          const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${p.device_id}::uuid FOR UPDATE`;
          if (!device || !isActive(device, user)) return fail("EXPIRED", 410);
          if (input.appSession?.data.deviceId === device.id) return { kind: "already" };
          await tx`UPDATE auth.session_families SET revoked_at = now(), revocation_reason = 'app_device_rotated'
            WHERE pwa_device_id = ${device.id}::uuid AND revoked_at IS NULL`;
          const deviceKey = await newKey(tx, device.id, "replace");
          await issue(user.id, appSession(device.id));
          return { kind: "issued", deviceKey };
        }
        if (p.state !== "confirmed" || !p.platform || !p.device_name) return fail("EXPIRED", 410);
        if (!(await initiatorValid(tx, p))) return fail("EXPIRED", 410);
        if (accountExpired(user) || !(await isAccountCategoryAllowed(user, tx)) || !(await legalAccepted(tx, user.id)))
          return fail("ACCOUNT_BLOCKED", 403);
        if (presented && presented.device.user_id !== user.id) return fail("ALREADY_PAIRED", 409);
        if (presented) {
          // Pairing again in the same app replaces its phone instead of adding a second one.
          const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${presented.device.id}::uuid FOR UPDATE`;
          if (device && matchKey(device, presented.secret)) await revokeDevice(tx, device, "replaced", user.id);
        }
        // iOS keeps the app's cookies apart from Safari, so a web session there is only a copy.
        if (p.platform !== "ios" && input.webUserId && input.webUserId !== user.id) return fail("ACCOUNT_MISMATCH", 409);
        const [active] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM auth.pwa_devices d WHERE d.user_id = ${user.id}::uuid AND ${activeDevice()}
        `;
        if ((active?.count ?? 0) >= limits.devicesPerAccount) return fail("LIMIT_REACHED", 429);
        const deviceId = crypto.randomUUID();
        const secret = pairingSecret.create();
        await tx`INSERT INTO auth.pwa_devices (id, user_id, name, platform, auth_epoch, secret_hash, rotated_at)
          VALUES (${deviceId}::uuid, ${user.id}::uuid, ${p.device_name}, ${p.platform}, ${user.auth_epoch}, ${pairingSecret.hash(secret)}, now())`;
        await issue(user.id, appSession(deviceId));
        await tx`UPDATE auth.pwa_pairings SET state = 'completed', device_id = ${deviceId}::uuid WHERE id = ${p.id}::uuid`;
        await record(tx, "device.enroll", { type: "pwa_device", id: deviceId }, user.id, { platform: p.platform, pairingId: p.id });
        return { kind: "issued", deviceKey: `${deviceId}.${secret}` };
      });
      const platform = snapshot.platform ?? "other";
      if (value.kind === "already") return { state: "paired", credentials: null, platform };
      if (!token) throw new Error("App session was not issued");
      return { state: "paired", credentials: { deviceKey: value.deviceKey, sessionToken: token }, platform };
    },

    /** Renewal with device-key rotation; `launch` and `renew` share it. */
    renew: renewal,

    rename: async (deviceKey: string | null | undefined, name: string) => {
      const presented = await presentedDevice(deviceKey);
      if (!presented) return fail("UNPAIRED", 401);
      await sql.begin(async (tx) => {
        const user = await lockUser(tx, presented.device.user_id);
        const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${presented.device.id}::uuid FOR UPDATE`;
        if (!user || !device || !isActive(device, user) || !matchKey(device, presented.secret)) return fail("UNPAIRED", 401);
        await tx`UPDATE auth.pwa_devices SET name = ${name} WHERE id = ${device.id}::uuid`;
        await record(tx, "device.rename", { type: "pwa_device", id: device.id }, user.id);
      });
    },

    /** "Sign out of the app". Idempotent. */
    unpair: async (deviceKey: string | null | undefined) => {
      const presented = await presentedDevice(deviceKey);
      if (!presented) return;
      await sql.begin(async (tx) => {
        await lockUser(tx, presented.device.user_id);
        const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.pwa_devices WHERE id = ${presented.device.id}::uuid FOR UPDATE`;
        if (!device || !matchKey(device, presented.secret)) return;
        await revokeDevice(tx, device, "unpaired", device.user_id);
      });
    },

    /** The phone of this request's app session, for the app's Settings. */
    current: async (c: Context): Promise<PwaDeviceView | null> => {
      const token = session.getAppToken(c);
      const authenticated = token ? await session.authenticateRequest(c, token) : null;
      if (authenticated?.data.kind !== "app" || !authenticated.data.deviceId) return null;
      const [row] = await sql<DeviceRow[]>`
        SELECT d.* FROM auth.pwa_devices d WHERE d.id = ${authenticated.data.deviceId}::uuid AND ${activeDevice()}
      `;
      return row ? view(row, row.id) : null;
    },

    // ---------- Administration ----------

    listUserDevices: async (admin: PwaDeviceAdministrator, userId: string): Promise<PwaDeviceView[]> => {
      if (!admin.admin) return fail("FORBIDDEN", 403);
      const rows = await sql<DeviceRow[]>`
        SELECT d.* FROM auth.pwa_devices d WHERE d.user_id = ${userId}::uuid AND ${activeDevice()}
        ORDER BY d.created_at, d.id LIMIT ${limits.devicesPerAccount}
      `;
      return rows.map((row) => view(row));
    },

    /** Idempotent: `revoked` is true only for the call that revoked the phone. */
    revokeUserDevice: async (admin: PwaDeviceAdministrator, userId: string, deviceId: string) => {
      if (!admin.admin) return fail("FORBIDDEN", 403);
      return sql.begin(async (tx) => {
        await lockUser(tx, userId);
        const [device] = await tx<DeviceRow[]>`
          SELECT * FROM auth.pwa_devices WHERE id = ${deviceId}::uuid AND user_id = ${userId}::uuid FOR UPDATE
        `;
        if (!device) return fail("NOT_FOUND", 404);
        return { revoked: await revokeDevice(tx, device, "admin", admin.userId) };
      });
    },

    // ---------- Maintenance ----------

    /** Bounded to 100 rows per step; runs every minute from Core's scheduler. */
    maintain: async (signal?: AbortSignal) => {
      await sql`DELETE FROM auth.pwa_pairings WHERE id IN (
        SELECT id FROM auth.pwa_pairings WHERE expires_at < now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
      signal?.throwIfAborted();
      const expired = await sql<{ id: string; user_id: string }[]>`
        SELECT d.id, d.user_id FROM auth.pwa_devices d JOIN auth.users u ON u.id = d.user_id
        WHERE d.revoked_at IS NULL AND u.account_expires IS NOT NULL AND u.account_expires <= now()
        ORDER BY d.id LIMIT 100
      `;
      for (const row of expired) {
        signal?.throwIfAborted();
        await sql.begin(async (tx) => {
          const user = await lockUser(tx, row.user_id);
          if (user && accountExpired(user)) await revokeDevice(tx, row, "account_expired", null);
        });
      }
      signal?.throwIfAborted();
      // Families are purged a day after expiry; a device row goes once none refers to it.
      await sql`DELETE FROM auth.pwa_devices WHERE id IN (
        SELECT d.id FROM auth.pwa_devices d
        WHERE (d.revoked_at < now() - interval '30 days' OR d.rotated_at < now() - ${limits.idleDays + 30} * interval '1 day')
          AND NOT EXISTS (SELECT 1 FROM auth.session_families f WHERE f.pwa_device_id = d.id)
        ORDER BY d.id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    },
  };
};

export const pwaDevices = createPwaDeviceService();
