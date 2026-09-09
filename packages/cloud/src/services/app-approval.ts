import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { sql, type SQL } from "bun";
import {
  APP_APPROVAL_LIMITS as limits,
  APP_APPROVAL_PATH,
  APP_APPROVAL_PROTOCOL,
  AppDevicePublicKeySchema,
  appDeviceProofMessage,
  appPairingProofMessage,
  type AppDevicePublicKey,
  type AppDeviceRequest,
  type AppDeviceView,
  type AppPendingLogin,
} from "../contracts/app-approval";
import { accountCategory, type AccountCategory } from "../contracts/account-categories";
import { isAccountCategoryAllowed } from "./account-category-policy";
import { audit } from "./audit";
import { decryptValue } from "./settings/crypto";
import { publicCloudOrigin } from "../shared/app-url";
import { CORE_SETTINGS } from "./settings/core-settings";

export class AppApprovalError extends Error {
  constructor(
    public code: "UNAVAILABLE" | "FORBIDDEN" | "REAUTHENTICATE" | "INVALID_REQUEST" | "CONFLICT" | "LIMIT_REACHED",
    public status: 400 | 403 | 404 | 409 | 429 | 503,
  ) {
    super(code);
  }
}
const reject = (code: AppApprovalError["code"], status: AppApprovalError["status"]): never => {
  throw new AppApprovalError(code, status);
};
const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const matches = (value: string, expected: string) => timingSafeEqual(Buffer.from(hash(value), "hex"), Buffer.from(expected, "hex"));
const comparison = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
const iso = (value: Date | string) => new Date(value).toISOString();
const future = (seconds: number) => new Date(Date.now() + seconds * 1000);

export type AppApprovalConfig = { issuer: string; appOrigin: string; enabled: boolean; adminPairing: boolean };
export const readAppApprovalConfig = async (db: SQL = sql, requireAppOrigin = true): Promise<AppApprovalConfig> => {
  const rows = await db<
    { key: string; value: string }[]
  >`SELECT key, value FROM settings.entries WHERE key IN ('app.url','user.app_approval.enabled','user.app_approval.origin','user.app_approval.admin_pairing')`;
  const values = new Map(await Promise.all(rows.map(async (row) => [row.key, await decryptValue(row.value)] as const)));
  const enabled = values.get("user.app_approval.enabled") ?? false;
  const adminPairing = values.get("user.app_approval.admin_pairing") ?? false;
  if (typeof enabled !== "boolean" || typeof adminPairing !== "boolean") return reject("UNAVAILABLE", 503);
  // The issuer is the operator's canonical URL, never the request Host header.
  const rawIssuer = values.get("app.url") ?? process.env.APP_URL ?? "localhost:3000";
  const rawOrigin = values.get("user.app_approval.origin") ?? CORE_SETTINGS["user.app_approval.origin"].default;
  const origin = (value: unknown) => {
    if (typeof value !== "string") return reject("UNAVAILABLE", 503);
    try {
      const url = new URL(value);
      const development = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        (url.protocol !== "https:" && !(url.protocol === "http:" && development)) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return reject("UNAVAILABLE", 503);
      return url.origin;
    } catch {
      return reject("UNAVAILABLE", 503);
    }
  };
  if (typeof rawIssuer !== "string") return reject("UNAVAILABLE", 503);
  let issuer: string;
  try {
    issuer = origin(publicCloudOrigin(rawIssuer));
  } catch {
    return reject("UNAVAILABLE", 503);
  }
  if (!enabled) return { issuer, appOrigin: "", enabled: false, adminPairing };
  let appOrigin = "";
  try {
    appOrigin = origin(rawOrigin);
  } catch (error) {
    // Missing setup must not prevent same-origin device inspection/revocation.
    // Pairing, discovery and sign-in still require a valid trusted origin.
    if (requireAppOrigin) throw error;
  }
  return { issuer, appOrigin, enabled, adminPairing };
};

type AccountRow = {
  id: string;
  uid: string;
  provider: "local" | "ipa";
  profile: "guest" | "user";
  auth_epoch: string;
  account_expires: Date | null;
};
type DeviceRow = {
  id: string;
  issuer: string;
  user_id: string;
  name: string;
  public_key: unknown;
  revoked_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
  assisted: boolean;
};
type PairingRow = {
  id: string;
  user_id: string;
  initiated_by: string;
  initiator_sid: string;
  assisted: boolean;
  secret_hash: string;
  state: string;
  expires_at: Date;
  public_key: unknown;
  name: string | null;
  device_id: string | null;
  comparison: string | null;
};
type LoginRow = {
  id: string;
  user_id: string | null;
  auth_epoch: string | null;
  category: AccountCategory;
  browser_hash: string;
  state: string;
  approved_by: string | null;
  challenge: string;
  comparison: string;
  created_at: Date;
  expires_at: Date;
};
export type AppApprovalActor = { userId: string; sid: string; admin: boolean };
export type AppDeviceEnrollmentNotice = { deviceId: string; userId: string; name: string; assisted: boolean };
const view = (row: DeviceRow): AppDeviceView => ({
  id: row.id,
  name: row.name,
  createdAt: iso(row.created_at),
  lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
  revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  assisted: row.assisted,
});
const verify = async (key: AppDevicePublicKey, message: string, signature: string): Promise<boolean> => {
  try {
    const imported = await crypto.subtle.importKey("jwk", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      imported,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
};

/** One owner for production API and isolated HTTP consumers. Config is re-read
 * per operation; SQL transactions serialize device decisions and revocation. */
export const createAppApprovalService = (
  db: SQL = sql,
  configuration = (requireEnabled = true) => readAppApprovalConfig(db, requireEnabled),
) => {
  const config = async (requireEnabled = true) => {
    const value = await configuration(requireEnabled);
    if (requireEnabled && (!value.enabled || !value.appOrigin)) return reject("UNAVAILABLE", 503);
    return value;
  };
  const eligible = async (tx: SQL, id: string): Promise<AccountRow> => {
    const [row] = await tx<
      AccountRow[]
    >`SELECT id, uid, provider, profile, auth_epoch, account_expires FROM auth.users WHERE id = ${id}::uuid`;
    if (
      !row ||
      (row.account_expires && new Date(row.account_expires).getTime() <= Date.now()) ||
      !(await isAccountCategoryAllowed(row, tx))
    )
      return reject("FORBIDDEN", 403);
    return row;
  };
  const fresh = async (tx: SQL, actor: AppApprovalActor) => {
    const [row] = await tx`SELECT sid FROM auth.session_families f JOIN auth.users u ON u.id = f.user_id
      WHERE f.sid = ${actor.sid}::uuid AND f.user_id = ${actor.userId}::uuid AND f.revoked_at IS NULL
        AND f.auth_epoch = u.auth_epoch AND f.expires_at > now()
        AND f.issued_at > now() - ${limits.recentSessionSeconds} * interval '1 second'`;
    if (!row) return reject("REAUTHENTICATE", 403);
    await eligible(tx, actor.userId);
  };
  const record = (tx: SQL, action: string, userId: string, id: string, metadata: Record<string, unknown> = {}) =>
    audit.record({ action: `auth.app.${action}`, outcome: "allowed", actor: { userId }, target: { type: "app_device", id }, metadata }, tx);
  const cleanup = async () => {
    // Bounded opportunistic maintenance: each accepted write retires up to 100
    // expired rows per table, so bursts cannot trigger an unbounded sweep.
    await db`DELETE FROM auth.app_pairings WHERE id IN (SELECT id FROM auth.app_pairings WHERE expires_at < now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM auth.app_logins WHERE id IN (SELECT id FROM auth.app_logins WHERE expires_at < now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM auth.app_device_proofs WHERE (device_id,jti) IN (SELECT device_id,jti FROM auth.app_device_proofs WHERE expires_at < now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
  };
  const authorizePairing = async (tx: SQL, actor: AppApprovalActor, pairing: PairingRow, cfg: AppApprovalConfig) => {
    await fresh(tx, actor);
    if (
      pairing.initiated_by !== actor.userId ||
      pairing.initiator_sid !== actor.sid ||
      (pairing.assisted && (!actor.admin || !cfg.adminPairing))
    )
      return reject("FORBIDDEN", 403);
    await eligible(tx, pairing.user_id);
  };
  const activeDevice = async (tx: SQL, id: string, issuer: string): Promise<DeviceRow> => {
    const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.app_devices WHERE id = ${id}::uuid AND issuer = ${issuer} FOR UPDATE`;
    if (!device || device.revoked_at) return reject("FORBIDDEN", 403);
    await eligible(tx, device.user_id);
    return device;
  };

  return {
    config,
    cleanup,
    maintain: async (notify: (notice: AppDeviceEnrollmentNotice) => Promise<unknown>, signal?: AbortSignal) => {
      await cleanup();
      const rows = await db<
        DeviceRow[]
      >`SELECT * FROM auth.app_devices WHERE notified_at IS NULL ORDER BY created_at LIMIT ${limits.pageSize}`;
      for (const row of rows) {
        signal?.throwIfAborted();
        // The notification owner deduplicates by deviceId. A crash after send
        // but before this marker is safe; no external effect precedes enrollment.
        await notify({ deviceId: row.id, userId: row.user_id, name: row.name, assisted: row.assisted });
        await db`UPDATE auth.app_devices SET notified_at=now() WHERE id=${row.id}::uuid AND notified_at IS NULL`;
      }
    },
    info: async () => {
      const cfg = await config();
      return {
        protocol: APP_APPROVAL_PROTOCOL,
        issuer: cfg.issuer,
        api: cfg.issuer + APP_APPROVAL_PATH,
        appOrigin: cfg.appOrigin,
        algorithm: "ES256",
        limits,
      };
    },
    startPairing: async (actor: AppApprovalActor, targetId = actor.userId) => {
      const cfg = await config();
      await cleanup();
      const id = crypto.randomUUID(),
        token = secret(),
        expiresAt = future(limits.pairingSeconds);
      return db.begin(async (tx) => {
        await fresh(tx, actor);
        if (targetId !== actor.userId && (!actor.admin || !cfg.adminPairing)) return reject("FORBIDDEN", 403);
        await tx`SELECT id FROM auth.users WHERE id = ${targetId}::uuid FOR UPDATE`;
        await eligible(tx, targetId);
        const [count] = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM auth.app_pairings WHERE issuer = ${cfg.issuer} AND user_id = ${targetId}::uuid AND expires_at > now() AND state IN ('pending','claimed')`;
        if ((count?.count ?? 0) >= limits.pendingPerAccount) return reject("LIMIT_REACHED", 429);
        await tx`INSERT INTO auth.app_pairings(id, issuer, user_id, initiated_by, initiator_sid, assisted, secret_hash, expires_at)
          VALUES (${id}::uuid,${cfg.issuer},${targetId}::uuid,${actor.userId}::uuid,${actor.sid}::uuid,${targetId !== actor.userId},${hash(token)},${expiresAt})`;
        await record(tx, "pairing.start", actor.userId, id, { targetUserId: targetId, assisted: targetId !== actor.userId });
        return { protocol: APP_APPROVAL_PROTOCOL, issuer: cfg.issuer, pairingId: id, secret: token, expiresAt: iso(expiresAt) };
      });
    },
    claimPairing: async (claim: { pairingId: string; secret: string; publicKey: AppDevicePublicKey; name: string; signature: string }) => {
      const cfg = await config();
      if (!(await verify(claim.publicKey, appPairingProofMessage(cfg.issuer, claim), claim.signature))) return reject("FORBIDDEN", 403);
      return db.begin(async (tx) => {
        const [p] = await tx<
          PairingRow[]
        >`SELECT * FROM auth.app_pairings WHERE id = ${claim.pairingId}::uuid AND issuer = ${cfg.issuer} FOR UPDATE`;
        if (!p || !matches(claim.secret, p.secret_hash) || new Date(p.expires_at).getTime() <= Date.now()) return reject("FORBIDDEN", 403);
        await eligible(tx, p.user_id);
        if (p.state !== "pending") return reject("CONFLICT", 409);
        const code = comparison(),
          deviceId = crypto.randomUUID();
        await tx`UPDATE auth.app_pairings SET state = 'claimed', public_key = ${JSON.stringify(claim.publicKey)}::text::jsonb, name = ${claim.name}, device_id = ${deviceId}::uuid, comparison = ${code} WHERE id = ${p.id}::uuid`;
        return { deviceId, comparison: code, expiresAt: iso(p.expires_at) };
      });
    },
    pairingResult: async (id: string, token: string, key: AppDevicePublicKey) => {
      const cfg = await config();
      const [p] = await db<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id = ${id}::uuid AND issuer = ${cfg.issuer}`;
      if (!p || !matches(token, p.secret_hash) || new Date(p.expires_at).getTime() <= Date.now()) return reject("FORBIDDEN", 403);
      if (p.public_key) {
        const claimed = AppDevicePublicKeySchema.parse(p.public_key);
        if (claimed.x !== key.x || claimed.y !== key.y) return reject("FORBIDDEN", 403);
      }
      return { state: p.state, deviceId: p.device_id, comparison: p.state === "claimed" ? p.comparison : null };
    },
    inspectPairing: async (actor: AppApprovalActor, id: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id = ${id}::uuid AND issuer = ${cfg.issuer}`;
        if (!p || new Date(p.expires_at).getTime() <= Date.now()) return reject("UNAVAILABLE", 404);
        await authorizePairing(tx, actor, p, cfg);
        return { state: p.state, name: p.name, comparison: p.comparison, deviceId: p.device_id, userId: p.user_id };
      });
    },
    confirmPairing: async (actor: AppApprovalActor, id: string, code: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id = ${id}::uuid AND issuer = ${cfg.issuer} FOR UPDATE`;
        if (
          !p ||
          p.state !== "claimed" ||
          new Date(p.expires_at).getTime() <= Date.now() ||
          p.comparison !== code ||
          !p.device_id ||
          !p.name
        )
          return reject("CONFLICT", 409);
        await authorizePairing(tx, actor, p, cfg);
        await tx`SELECT id FROM auth.users WHERE id = ${p.user_id}::uuid FOR UPDATE`;
        const [count] = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM auth.app_devices WHERE issuer = ${cfg.issuer} AND user_id = ${p.user_id}::uuid AND revoked_at IS NULL`;
        if ((count?.count ?? 0) >= limits.devicesPerAccount) return reject("LIMIT_REACHED", 429);
        const key = AppDevicePublicKeySchema.parse(p.public_key);
        const existing =
          await tx`SELECT id FROM auth.app_devices WHERE issuer=${cfg.issuer} AND user_id=${p.user_id}::uuid AND public_key=${JSON.stringify(key)}::text::jsonb`;
        if (existing.length) return reject("CONFLICT", 409);
        await tx`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,enrolled_by) VALUES (${p.device_id}::uuid,${cfg.issuer},${p.user_id}::uuid,${p.name},${JSON.stringify(key)}::text::jsonb,${p.assisted},${actor.userId}::uuid)`;
        await tx`UPDATE auth.app_pairings SET state = 'confirmed' WHERE id = ${id}::uuid`;
        await record(tx, "device.enroll", actor.userId, p.device_id, { targetUserId: p.user_id, assisted: p.assisted });
        return { deviceId: p.device_id };
      });
    },
    cancelPairing: async (actor: AppApprovalActor, id: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id = ${id}::uuid AND issuer = ${cfg.issuer} FOR UPDATE`;
        if (!p) return reject("UNAVAILABLE", 404);
        await authorizePairing(tx, actor, p, cfg);
        if (p.state === "confirmed") return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_pairings SET state='cancelled' WHERE id=${id}::uuid`;
        await record(tx, "pairing.cancel", actor.userId, id);
      });
    },
    listDevices: async (actor: AppApprovalActor, after?: string) => {
      const cfg = await config(false);
      const rows = await db<
        DeviceRow[]
      >`SELECT * FROM auth.app_devices WHERE issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid AND (${after ?? null}::uuid IS NULL OR id > ${after ?? null}::uuid) ORDER BY id LIMIT ${limits.pageSize + 1}`;
      return {
        items: rows.slice(0, limits.pageSize).map(view),
        nextCursor: rows.length > limits.pageSize ? rows[limits.pageSize - 1]!.id : null,
      };
    },
    mutateDevice: async (actor: AppApprovalActor, id: string, name?: string) => {
      const cfg = await config(false);
      return db.begin(async (tx) => {
        await fresh(tx, actor);
        const [device] = await tx<
          DeviceRow[]
        >`SELECT * FROM auth.app_devices WHERE id=${id}::uuid AND issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid FOR UPDATE`;
        if (!device) return reject("UNAVAILABLE", 404);
        if (name !== undefined) await tx`UPDATE auth.app_devices SET name=${name} WHERE id=${id}::uuid`;
        else await tx`UPDATE auth.app_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${id}::uuid`;
        await record(tx, name === undefined ? "device.revoke" : "device.rename", actor.userId, id);
      });
    },
    startLogin: async (identifier: string, category: AccountCategory) => {
      const cfg = await config();
      await cleanup();
      const id = crypto.randomUUID(),
        browserSecret = secret(),
        challenge = secret(),
        code = comparison(),
        expiresAt = future(limits.loginSeconds);
      await db.begin(async (tx) => {
        const candidates = await tx<
          AccountRow[]
        >`SELECT id,uid,provider,profile,auth_epoch,account_expires FROM auth.users WHERE lower(uid)=lower(${identifier}) OR lower(btrim(mail))=lower(${identifier}) LIMIT 2`;
        let candidate = candidates.length === 1 ? candidates[0] : undefined;
        if (
          candidate &&
          (accountCategory(candidate) !== category ||
            (candidate.account_expires && new Date(candidate.account_expires).getTime() <= Date.now()) ||
            !(await isAccountCategoryAllowed(candidate, tx)))
        )
          candidate = undefined;
        if (candidate) {
          await tx`SELECT id FROM auth.users WHERE id=${candidate.id}::uuid FOR UPDATE`;
          const [count] = await tx<
            { count: number }[]
          >`SELECT count(*)::int AS count FROM auth.app_logins WHERE issuer=${cfg.issuer} AND user_id=${candidate.id}::uuid AND expires_at > now() AND state IN ('pending','approved')`;
          if ((count?.count ?? 0) >= limits.pendingPerAccount) candidate = undefined;
        }
        // Unknown, ambiguous, disabled and throttled accounts have the identical
        // public shape and a decoy pending transaction; no account enumeration.
        await tx`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,expires_at)
          VALUES (${id}::uuid,${cfg.issuer},${candidate?.id ?? null}::uuid,${candidate?.auth_epoch ?? null},${category},${hash(browserSecret)},${challenge},${code},${expiresAt})`;
      });
      return { requestId: id, browserSecret, comparison: code, expiresAt: iso(expiresAt), pollAfterSeconds: limits.pollSeconds };
    },
    deviceCommand: async (request: AppDeviceRequest) => {
      const cfg = await config();
      const { proof, signature } = request;
      const now = Math.floor(Date.now() / 1000);
      if (
        proof.issuer !== cfg.issuer ||
        proof.issuedAt > now + 5 ||
        proof.issuedAt < now - limits.proofSeconds ||
        proof.expiresAt <= now ||
        proof.expiresAt <= proof.issuedAt ||
        proof.expiresAt > proof.issuedAt + limits.proofSeconds
      )
        return reject("FORBIDDEN", 403);
      await cleanup();
      return db.begin(async (tx) => {
        const device = await activeDevice(tx, proof.deviceId, cfg.issuer);
        if (!(await verify(AppDevicePublicKeySchema.parse(device.public_key), appDeviceProofMessage(proof), signature)))
          return reject("FORBIDDEN", 403);
        const used =
          await tx`INSERT INTO auth.app_device_proofs(device_id,jti,expires_at) VALUES (${device.id}::uuid,${proof.jti}::uuid,${new Date((proof.expiresAt + 5) * 1000)}) ON CONFLICT DO NOTHING RETURNING jti`;
        if (!used.length) return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_devices SET last_used_at=now() WHERE id=${device.id}::uuid`;
        const command = proof.command;
        if (command.operation === "revoke") {
          await tx`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${device.id}::uuid`;
          await record(tx, "device.revoke", device.user_id, device.id);
          return { state: "revoked" as const };
        }
        if (command.operation === "pending") {
          const user = await eligible(tx, device.user_id);
          const rows = await tx<
            LoginRow[]
          >`SELECT * FROM auth.app_logins WHERE issuer=${cfg.issuer} AND user_id=${device.user_id}::uuid AND state='pending' AND expires_at>now() AND auth_epoch=${user.auth_epoch} AND category=${accountCategory(user)} ORDER BY created_at LIMIT ${limits.pendingPerAccount}`;
          return {
            requests: rows.map(
              (row): AppPendingLogin => ({
                requestId: row.id,
                challenge: row.challenge,
                comparison: row.comparison,
                createdAt: iso(row.created_at),
                expiresAt: iso(row.expires_at),
              }),
            ),
            pollAfterSeconds: limits.pollSeconds,
          };
        }
        const [row] = await tx<
          LoginRow[]
        >`SELECT * FROM auth.app_logins WHERE id=${command.requestId}::uuid AND issuer=${cfg.issuer} AND user_id=${device.user_id}::uuid FOR UPDATE`;
        const user = await eligible(tx, device.user_id);
        if (
          !row ||
          row.state !== "pending" ||
          new Date(row.expires_at).getTime() <= Date.now() ||
          row.challenge !== command.challenge ||
          row.comparison !== command.comparison ||
          row.auth_epoch !== user.auth_epoch ||
          row.category !== accountCategory(user)
        )
          return reject("CONFLICT", 409);
        const state = command.decision === "approve" ? "approved" : "denied";
        await tx`UPDATE auth.app_logins SET state=${state},approved_by=${device.id}::uuid WHERE id=${row.id}::uuid`;
        await record(tx, `login.${command.decision}`, device.user_id, device.id, { requestId: row.id });
        return { state };
      });
    },
    browserStatus: async (id: string, token: string) => {
      const cfg = await config();
      const [row] = await db<LoginRow[]>`SELECT * FROM auth.app_logins WHERE id=${id}::uuid AND issuer=${cfg.issuer}`;
      if (!row || !matches(token, row.browser_hash)) return reject("UNAVAILABLE", 404);
      return { state: new Date(row.expires_at).getTime() <= Date.now() ? "expired" : row.state, pollAfterSeconds: limits.pollSeconds };
    },
    consumeLogin: async (id: string, token: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        // Lock order is device -> request for both approval and completion.
        const [snapshot] = await tx<LoginRow[]>`SELECT * FROM auth.app_logins WHERE id=${id}::uuid AND issuer=${cfg.issuer}`;
        if (!snapshot || !snapshot.approved_by || !matches(token, snapshot.browser_hash)) return reject("CONFLICT", 409);
        const device = await activeDevice(tx, snapshot.approved_by, cfg.issuer);
        const [row] = await tx<LoginRow[]>`SELECT * FROM auth.app_logins WHERE id=${id}::uuid AND issuer=${cfg.issuer} FOR UPDATE`;
        const user = await eligible(tx, device.user_id);
        if (
          !row ||
          row.state !== "approved" ||
          row.user_id !== device.user_id ||
          row.approved_by !== device.id ||
          new Date(row.expires_at).getTime() <= Date.now() ||
          row.auth_epoch !== user.auth_epoch ||
          row.category !== accountCategory(user)
        )
          return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_logins SET state='consumed' WHERE id=${id}::uuid`;
        await record(tx, "login.consume", user.id, device.id, { requestId: id });
        // This commit is the authorization boundary. A later issuance/network
        // failure requires a new login, never replay of the consumed approval.
        return user.id;
      });
    },
  };
};

export const appApproval = createAppApprovalService();
