import { type SQL, sql } from "bun";
import type { z } from "zod";
import { lazySync } from "../_internal/process-sync";
import { env } from "../config/env";
import { type AccountCategory, accountCategory } from "../contracts/account-categories";
import {
  APP_ACTION_LIMITS,
  APP_APPROVAL_FEATURES,
  APP_APPROVAL_PATH,
  APP_APPROVAL_PROTOCOL,
  type AppActionSummary,
  type AppActionView,
  type AppApprovalAccept,
  type AppDeviceChange,
  type AppDeviceChangeStatus,
  type AppDevicePublicKey,
  AppDevicePublicKeySchema,
  type AppDeviceRequest,
  type AppDeviceRevokeResultSchema,
  type AppDeviceView,
  AppLoginContextSchema,
  type AppPairingConfirmResultSchema,
  type AppPendingLogin,
  appDeviceProofMessage,
  appPairingProofMessage,
  APP_APPROVAL_LIMITS as limits,
} from "../contracts/app-approval";
import { addressPrefix } from "../server/request-context/address";
import { publicCloudOrigin } from "../shared/app-url";
import { isAccountCategoryAllowed } from "./account-category-policy";
import { appApprovalText } from "./approvals/device";
import { audit } from "./audit";
import { countryHistory, findBrowser, trustState } from "./known-browsers";
import { logger } from "./logging";
import { type AppLoginAddressStore, appLoginAddressMatches, appLoginAddressProof, valkeyAppLoginAddressStore } from "./login-address-store";
import { type AppLoginRequestContext, buildLoginContext, trimAppLoginResponse } from "./login-context";
import { pairingSecret } from "./pairing-secret";
import { toPgTextArray } from "./postgres";
import { requireEligibleAccount, requireRecentWebSession } from "./session/recent";
import { CORE_SETTINGS } from "./settings/core-settings";
import { decryptValue } from "./settings/crypto";

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
const { create: secret, hash, matches, code: comparison } = pairingSecret;
const iso = (value: Date | string) => new Date(value).toISOString();
const future = (seconds: number) => new Date(Date.now() + seconds * 1000);

export type AppApprovalConfig = { issuer: string; appOrigin: string; enabled: boolean; adminPairing: boolean; label?: string };
export const readAppApprovalConfig = async (db: SQL = sql, requireAppOrigin = true): Promise<AppApprovalConfig> => {
  const rows = await db<
    { key: string; value: string }[]
  >`SELECT key, value FROM settings.entries WHERE key IN ('app.url','app.name','user.app_approval.label','user.app_approval.enabled','user.app_approval.origin','user.app_approval.admin_pairing')`;
  const values = new Map(await Promise.all(rows.map(async (row) => [row.key, await decryptValue(row.value)] as const)));
  const enabled = values.get("user.app_approval.enabled") ?? false;
  const adminPairing = values.get("user.app_approval.admin_pairing") ?? false;
  if (typeof enabled !== "boolean" || typeof adminPairing !== "boolean") return reject("UNAVAILABLE", 503);
  // The issuer is the operator's canonical URL, never the request Host header.
  const rawIssuer = values.get("app.url") ?? env.APP_URL ?? "localhost:3000";
  const rawOrigin = values.get("user.app_approval.origin") ?? CORE_SETTINGS["user.app_approval.origin"].default;
  const origin = (value: unknown) => {
    if (typeof value !== "string") return reject("UNAVAILABLE", 503);
    try {
      const url = new URL(value);
      const development = env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
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
  const label = [values.get("user.app_approval.label"), values.get("app.name"), CORE_SETTINGS["app.name"].default]
    .find((value): value is string => typeof value === "string" && !!value.trim())!
    .trim()
    .slice(0, 80);
  if (!enabled) return { issuer, appOrigin: "", enabled: false, adminPairing };
  let appOrigin = "";
  try {
    appOrigin = origin(rawOrigin);
  } catch (error) {
    // Missing setup must not prevent same-origin device inspection/revocation.
    // Pairing, discovery and sign-in still require a valid trusted origin.
    if (requireAppOrigin) throw error;
  }
  return { issuer, appOrigin, enabled, adminPairing, label };
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
  accepts: string[] | null;
};
type PairingRow = {
  id: string;
  user_id: string;
  initiated_by: string;
  initiator_sid: string;
  assisted: boolean;
  /** The target account's epoch at start; a sign-out everywhere moves it and voids the pairing. */
  auth_epoch: string | null;
  secret_hash: string;
  state: string;
  expires_at: Date;
  public_key: unknown;
  name: string | null;
  device_id: string | null;
  comparison: string | null;
};
type ChangeRow = {
  id: string;
  issuer: string;
  user_id: string;
  kind: "pair" | "revoke";
  pairing_id: string | null;
  device_id: string | null;
  end_sessions: boolean;
  requested_by_sid: string;
  auth_epoch: string;
  state: "pending" | "approved" | "denied" | "cancelled";
  created_at: Date;
  expires_at: Date;
};
const changeStatus = (row: ChangeRow): AppDeviceChangeStatus => ({
  state: row.state === "pending" && new Date(row.expires_at).getTime() <= Date.now() ? "expired" : row.state,
  expiresAt: iso(row.expires_at),
});
const changeName = (name: string) =>
  Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ""))
    .slice(0, 80)
    .join("");
type LoginRow = {
  context: unknown;
  kind: "browser" | "terminal";
  device_authorization_id: string | null;
  client_id: string | null;
  scopes: string[] | null;
  lifetime_seconds: number | null;
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
/** Administration of another account's devices needs current admin authority, not a recent session. */
export type AppDeviceAdministrator = Pick<AppApprovalActor, "userId" | "admin">;
export type AppDeviceEnrollmentNotice = { deviceId: string; userId: string; name: string; assisted: boolean };
/** Best-effort wake-ups for browsers waiting on a login decision. Postgres stays authoritative. */
export type AppLoginDecisionHints = {
  /** Call after the decision commits. Must not throw or delay the caller. */
  publish(requestId: string): void;
  /** Settles on the first hint for this request, or when `signal` aborts. */
  wait(requestId: string, signal: AbortSignal): Promise<void>;
};
/** Open Action approvals of a device's account, as the device shows and decides them. */
export type AppDeviceActions = {
  inbox(input: { userId: string; issuer: string }): Promise<{ actions: AppActionSummary[]; moreActions: number }>;
  view(input: { userId: string; issuer: string; actionId: string }): Promise<AppActionView | null>;
  /** True when this decision applied; false when the request is gone, decided, expired, or its view changed. */
  decide(input: {
    userId: string;
    deviceId: string;
    issuer: string;
    actionId: string;
    digest: string;
    approved: boolean;
  }): Promise<boolean>;
};
export type AppTerminalLoginInput = {
  deviceAuthorizationId: string;
  identifier: string;
  clientId: string;
  scopes: string[];
  lifetimeSeconds: number;
};
export type AppTerminalLogins = {
  /** Live pending authorizations whose registry client still allows the device grant. */
  describe(tx: SQL, ids: string[]): Promise<Map<string, { id: string; name: string }>>;
  /** In the sign-in decision transaction; false aborts both decisions and their audits. */
  decide(
    tx: SQL,
    input: {
      deviceAuthorizationId: string;
      clientId: string;
      user: Pick<AccountRow, "id" | "uid" | "provider" | "profile" | "auth_epoch">;
      decision: "approve" | "deny";
    },
  ): Promise<boolean>;
};
// Bundle sign-in and Action wake-ups for 30 seconds while the previously woken request is still open.
// Cloud Login gives Actions a separate 30-per-token budget in five minutes, preserving the full sign-in budget.
const WAKE_SECONDS = 30;
/** Best-effort sign-in wake-ups through the trusted authenticator; returns the HTTP status. */
export type AppLoginPushSender = (
  appOrigin: string,
  body: { token: string; cloudOrigin: string; requestRef: string; kind?: "action" },
) => Promise<number>;
export const fetchPushSender: AppLoginPushSender = async (appOrigin, body) => {
  const response = await fetch(`${appOrigin}/push/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  return response.status;
};
const log = logger("app-approval");
const decisionTopic = lazySync((sync) =>
  sync.topic<null>({
    id: "cloud:app-login-decisions",
    owner: "cloud",
    retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
    maxPayloadBytes: 2000,
  }),
);
/** Core NATS broadcast reaches the waiting browser on any replica. */
export const syncLoginDecisionHints: AppLoginDecisionHints = {
  publish: (requestId) => {
    void Promise.resolve()
      .then(() => decisionTopic().publish({ tenantId: requestId, data: null }))
      .catch((error) => log.warn("App login decision hint failed", { error: String(error) }));
  },
  wait: async (requestId, signal) => {
    for await (const _event of decisionTopic().live({ tenantId: requestId, signal })) return;
  },
};
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
  hints: AppLoginDecisionHints = syncLoginDecisionHints,
  push: AppLoginPushSender = fetchPushSender,
  addresses: AppLoginAddressStore = valkeyAppLoginAddressStore,
) => {
  // Error messages may contain their inputs; log only the error class, never addresses or proofs.
  const addressFailure = (error: unknown) =>
    log.warn("App login address hint unavailable", { error: error instanceof Error ? error.name : "UnknownError" });
  const addSameNetwork = async (logins: AppPendingLogin[], address?: string) => {
    const prefix = addressPrefix(address ?? "unknown");
    const browserLogins = logins.filter((login) => !login.terminal && login.context);
    if (!prefix || !browserLogins.length) return;
    try {
      const proofs = await addresses.read(browserLogins.map((login) => login.requestId));
      for (const login of browserLogins) {
        const proof = proofs.get(login.requestId);
        if (proof && login.context && appLoginAddressMatches(proof, prefix)) login.context.sameNetwork = true;
      }
    } catch (error) {
      addressFailure(error);
    }
  };
  const config = async (requireEnabled = true) => {
    const value = await configuration(requireEnabled);
    if (requireEnabled && (!value.enabled || !value.appOrigin)) return reject("UNAVAILABLE", 503);
    return value;
  };
  const forbidden = (code: "REAUTHENTICATE" | "FORBIDDEN") => reject(code, 403);
  const eligible = (tx: SQL, id: string): Promise<AccountRow> => requireEligibleAccount(tx, id, forbidden);
  const fresh = (tx: SQL, actor: AppApprovalActor) => requireRecentWebSession(tx, actor, limits.recentSessionSeconds, forbidden);
  const record = (tx: SQL, action: string, userId: string, id: string, metadata: Record<string, unknown> = {}) =>
    audit.record({ action: `auth.app.${action}`, outcome: "allowed", actor: { userId }, target: { type: "app_device", id }, metadata }, tx);
  const cleanup = async () => {
    // Bounded opportunistic maintenance: each accepted write retires up to 100
    // expired rows per table, so bursts cannot trigger an unbounded sweep.
    await db`DELETE FROM auth.app_device_changes WHERE id IN (SELECT id FROM auth.app_device_changes WHERE expires_at < now() - interval '1 minute' ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM auth.app_pairings WHERE id IN (SELECT p.id FROM auth.app_pairings p
      WHERE p.expires_at < now() - interval '1 minute' AND NOT EXISTS (SELECT 1 FROM auth.app_device_changes c WHERE c.pairing_id=p.id)
      ORDER BY p.expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM auth.app_logins WHERE id IN (SELECT id FROM auth.app_logins WHERE expires_at < now() AND NOT (kind='terminal' AND state='approved') ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
    await db`DELETE FROM auth.app_device_proofs WHERE (device_id,jti) IN (SELECT device_id,jti FROM auth.app_device_proofs WHERE expires_at < now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
  };
  const pairingOwner = async (tx: SQL, actor: AppApprovalActor, pairing: PairingRow, cfg: AppApprovalConfig) => {
    if (
      pairing.initiated_by !== actor.userId ||
      pairing.initiator_sid !== actor.sid ||
      (pairing.assisted && (!actor.admin || !cfg.adminPairing))
    )
      return reject("FORBIDDEN", 403);
    return eligible(tx, pairing.user_id);
  };
  const authorizePairing = async (tx: SQL, actor: AppApprovalActor, pairing: PairingRow, cfg: AppApprovalConfig) => {
    await fresh(tx, actor);
    return pairingOwner(tx, actor, pairing, cfg);
  };
  const activeDevice = async (tx: SQL, id: string, issuer: string): Promise<DeviceRow> => {
    const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.app_devices WHERE id = ${id}::uuid AND issuer = ${issuer} FOR UPDATE`;
    if (!device || device.revoked_at) return reject("FORBIDDEN", 403);
    await eligible(tx, device.user_id);
    return device;
  };

  const enrollPairing = async (tx: SQL, p: PairingRow, issuer: string) => {
    if (!p.device_id || !p.name) return reject("CONFLICT", 409);
    const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.app_devices
      WHERE issuer=${issuer} AND user_id=${p.user_id}::uuid AND revoked_at IS NULL`;
    if ((count?.count ?? 0) >= limits.devicesPerAccount) return reject("LIMIT_REACHED", 429);
    const key = AppDevicePublicKeySchema.parse(p.public_key);
    const existing =
      await tx`SELECT id FROM auth.app_devices WHERE issuer=${issuer} AND user_id=${p.user_id}::uuid AND public_key=${JSON.stringify(key)}::text::jsonb`;
    if (existing.length) return reject("CONFLICT", 409);
    await tx`INSERT INTO auth.app_devices(id,issuer,user_id,name,public_key,assisted,enrolled_by)
      VALUES (${p.device_id}::uuid,${issuer},${p.user_id}::uuid,${p.name},${JSON.stringify(key)}::text::jsonb,${p.assisted},${p.initiated_by}::uuid)`;
    await tx`UPDATE auth.app_pairings SET state='confirmed' WHERE id=${p.id}::uuid`;
    await record(tx, "device.enroll", p.initiated_by, p.device_id, { targetUserId: p.user_id, assisted: p.assisted });
  };
  const createChange = async (
    tx: SQL,
    cfg: AppApprovalConfig,
    actor: AppApprovalActor,
    epoch: string,
    kind: ChangeRow["kind"],
    targetId: string,
    pairingId: string | null,
    endSessions: boolean,
  ) => {
    const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.app_device_changes
      WHERE issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid AND state='pending' AND expires_at>now()`;
    if ((count?.count ?? 0) >= limits.pendingPerAccount) return reject("LIMIT_REACHED", 429);
    const id = crypto.randomUUID(),
      expiresAt = future(limits.loginSeconds);
    const [row] = await tx<ChangeRow[]>`INSERT INTO auth.app_device_changes
      (id,issuer,user_id,kind,pairing_id,device_id,end_sessions,requested_by_sid,auth_epoch,expires_at)
      VALUES (${id}::uuid,${cfg.issuer},${actor.userId}::uuid,${kind},${pairingId}::uuid,
        ${kind === "revoke" ? targetId : null}::uuid,${endSessions},${actor.sid}::uuid,${epoch},${expiresAt}) RETURNING *`;
    // Audit metadata redacts keys that name sessions, so the choice is recorded as `endSignIns`.
    await record(tx, "device_change.request", actor.userId, targetId, { changeId: id, kind, endSignIns: endSessions });
    return row!;
  };
  const ownedChange = async (tx: SQL, cfg: AppApprovalConfig, actor: AppApprovalActor, id: string) => {
    const [row] = await tx<ChangeRow[]>`SELECT * FROM auth.app_device_changes
      WHERE id=${id}::uuid AND issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid AND requested_by_sid=${actor.sid}::uuid`;
    if (!row) return reject("UNAVAILABLE", 404);
    return row;
  };

  /** Runs after the login commit and never delays or fails it. The body names only
   * this Cloud and the request id; a 410 means the phone's subscription is gone. */
  const wake = async (cfg: AppApprovalConfig, userId: string, requestId: string, options?: { accept: AppApprovalAccept }) => {
    if (!cfg.enabled || !cfg.appOrigin) return;
    try {
      // A withdrawn device change keeps its window, so withdrawing and asking again cannot push without bound.
      const rows = await db<{ push_token: string }[]>`
        UPDATE auth.app_devices d SET login_wake_at=now(), login_wake_ref=${requestId}::uuid
        WHERE issuer=${cfg.issuer} AND user_id=${userId}::uuid AND revoked_at IS NULL AND push_token IS NOT NULL
          AND (${options?.accept ?? null}::text IS NULL OR ${options?.accept ?? null}::text=ANY(d.accepts))
          AND (d.login_wake_at IS NULL OR d.login_wake_at <= now() - ${WAKE_SECONDS} * interval '1 second'
            OR (NOT EXISTS (SELECT 1 FROM auth.app_logins w
              WHERE w.id=d.login_wake_ref AND w.state='pending' AND w.expires_at > now())
              AND NOT EXISTS (SELECT 1 FROM auth.app_device_changes w
                WHERE w.id=d.login_wake_ref AND w.state IN ('pending','cancelled') AND w.expires_at > now())))
        RETURNING push_token`;
      await Promise.all(
        Array.from(new Set(rows.map((row) => row.push_token)), async (token) => {
          const status = await push(cfg.appOrigin, { token, cloudOrigin: cfg.issuer, requestRef: requestId });
          if (status === 410)
            await db`UPDATE auth.app_devices SET push_token=NULL WHERE issuer=${cfg.issuer} AND user_id=${userId}::uuid AND push_token=${token}`;
        }),
      );
    } catch (error) {
      log.warn("App login push wake-up failed", { error: error instanceof Error ? error.name : "UnknownError" });
    }
  };

  const loginCandidate = async (tx: SQL, identifier: string, category?: AccountCategory) => {
    const candidates = await tx<AccountRow[]>`
      SELECT id,uid,provider,profile,auth_epoch,account_expires FROM auth.users
      WHERE lower(uid)=lower(${identifier}) OR lower(btrim(mail))=lower(${identifier}) LIMIT 2`;
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (
      candidate &&
      ((category !== undefined && accountCategory(candidate) !== category) ||
        (candidate.account_expires && new Date(candidate.account_expires).getTime() <= Date.now()) ||
        !(await isAccountCategoryAllowed(candidate, tx)))
    )
      return undefined;
    if (!candidate) return undefined;
    // Re-read under the account lock: starts share one budget, and epoch changes cannot race the snapshot.
    const [locked] = await tx<AccountRow[]>`SELECT id,uid,provider,profile,auth_epoch,account_expires
      FROM auth.users WHERE id=${candidate.id}::uuid FOR UPDATE`;
    if (locked?.account_expires && new Date(locked.account_expires).getTime() <= Date.now()) return undefined;
    return locked;
  };
  const loginBudget = async (tx: SQL, issuer: string, userId: string) => {
    const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.app_logins
      WHERE issuer=${issuer} AND user_id=${userId}::uuid AND expires_at > now() AND state IN ('pending','approved')`;
    return (count?.count ?? 0) < limits.pendingPerAccount;
  };

  return {
    config,
    cleanup,
    wakeForAction: async (approvalId: string): Promise<void> => {
      try {
        const cfg = await config(false);
        if (!cfg.enabled || !cfg.appOrigin) return;
        const rows = await db<{ push_token: string; user_id: string }[]>`
          UPDATE auth.app_devices d SET action_wake_at=now(), action_wake_ref=${approvalId}::uuid
          WHERE d.id IN (
            SELECT device.id FROM auth.app_devices device JOIN approvals.requests r ON r.approver_user_id=device.user_id
            JOIN auth.users u ON u.id=r.approver_user_id
            WHERE r.id=${approvalId}::uuid AND r.status='pending' AND r.expires_at > now() AND r.approver_auth_epoch=u.auth_epoch
              AND EXISTS (SELECT 1 FROM ai.pending_actions p JOIN ai.turns t ON t.id=p.turn_id
                WHERE p.approval_id=r.id AND p.status='pending' AND t.run_config->>'signedInSession' IS NULL)
              AND device.issuer=${cfg.issuer} AND device.revoked_at IS NULL AND device.push_token IS NOT NULL
              AND device.actions_at IS NOT NULL
            LIMIT ${limits.devicesPerAccount}
          ) AND (d.action_wake_at IS NULL OR d.action_wake_at <= now() - ${WAKE_SECONDS} * interval '1 second'
            OR NOT EXISTS (SELECT 1 FROM approvals.requests w
              WHERE w.id=d.action_wake_ref AND w.status='pending' AND w.expires_at > now()))
          RETURNING d.push_token,d.user_id`;
        const tokens = new Map(rows.map((row) => [row.push_token, row.user_id]));
        await Promise.all(
          Array.from(tokens, async ([token, userId]) => {
            const status = await push(cfg.appOrigin, { token, cloudOrigin: cfg.issuer, requestRef: approvalId, kind: "action" });
            if (status === 410)
              await db`UPDATE auth.app_devices SET push_token=NULL WHERE issuer=${cfg.issuer} AND user_id=${userId}::uuid AND push_token=${token}`;
          }),
        );
      } catch (error) {
        log.warn("App action push wake-up failed", { error: error instanceof Error ? error.name : "UnknownError" });
      }
    },
    maintain: async (notify: (notice: AppDeviceEnrollmentNotice) => Promise<unknown>, signal?: AbortSignal) => {
      await cleanup();
      const rows = await db<(DeviceRow & { has_email: boolean })[]>`
        SELECT d.*, COALESCE(btrim(u.mail), '') <> '' AS has_email
        FROM auth.app_devices d JOIN auth.users u ON u.id = d.user_id
        WHERE d.notified_at IS NULL ORDER BY d.created_at LIMIT ${limits.pageSize}`;
      for (const row of rows) {
        signal?.throwIfAborted();
        // The notification owner deduplicates by deviceId. A crash after send
        // but before this marker is safe; no external effect precedes enrollment.
        // The notice is email-only, so an account without email relies on the
        // enrollment audit entry instead of a delivery that can only fail.
        if (row.has_email) await notify({ deviceId: row.id, userId: row.user_id, name: row.name, assisted: row.assisted });
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
        features: [...APP_APPROVAL_FEATURES],
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
        const target = await eligible(tx, targetId);
        const [count] = await tx<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM auth.app_pairings WHERE issuer = ${cfg.issuer} AND user_id = ${targetId}::uuid AND expires_at > now() AND state IN ('pending','claimed')`;
        if ((count?.count ?? 0) >= limits.pendingPerAccount) return reject("LIMIT_REACHED", 429);
        await tx`INSERT INTO auth.app_pairings(id, issuer, user_id, initiated_by, initiator_sid, assisted, auth_epoch, secret_hash, expires_at)
          VALUES (${id}::uuid,${cfg.issuer},${targetId}::uuid,${actor.userId}::uuid,${actor.sid}::uuid,${targetId !== actor.userId},${target.auth_epoch},${hash(token)},${expiresAt})`;
        await record(tx, "pairing.start", actor.userId, id, { targetUserId: targetId, assisted: targetId !== actor.userId });
        return {
          protocol: APP_APPROVAL_PROTOCOL,
          issuer: cfg.issuer,
          pairingId: id,
          secret: token,
          expiresAt: iso(expiresAt),
          ...(cfg.label ? { label: cfg.label } : {}),
        };
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
      if (!p || !matches(token, p.secret_hash)) return reject("FORBIDDEN", 403);
      const age = Date.now() - new Date(p.expires_at).getTime();
      if (age >= 0 && !(age < 60_000 && (p.state === "confirmed" || p.state === "cancelled"))) return reject("FORBIDDEN", 403);
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
        if (!p) return reject("UNAVAILABLE", 404);
        const [change] = await tx<ChangeRow[]>`SELECT * FROM auth.app_device_changes WHERE pairing_id=${p.id}::uuid`;
        const age = Date.now() - new Date(p.expires_at).getTime();
        if (age >= 0 && !(age < 60_000 && (p.state === "confirmed" || change !== undefined))) return reject("UNAVAILABLE", 404);
        // A pairing from before the account was signed out everywhere reads as expired.
        const user = await (change ? pairingOwner(tx, actor, p, cfg) : authorizePairing(tx, actor, p, cfg));
        if (user.auth_epoch !== p.auth_epoch) return reject("UNAVAILABLE", 404);
        return {
          state: p.state,
          name: p.name,
          comparison: p.comparison,
          deviceId: p.device_id,
          userId: p.user_id,
          approval: change ? changeStatus(change) : null,
        };
      });
    },
    confirmPairing: async (actor: AppApprovalActor, id: string, code: string): Promise<z.infer<typeof AppPairingConfirmResultSchema>> => {
      const cfg = await config();
      let wakeId: string | undefined;
      const result = await db.begin(async (tx) => {
        const [snapshot] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id=${id}::uuid AND issuer=${cfg.issuer}`;
        if (!snapshot) return reject("CONFLICT", 409);
        await tx`SELECT id FROM auth.users WHERE id=${snapshot.user_id}::uuid FOR NO KEY UPDATE`;
        await tx`SELECT id FROM auth.app_devices WHERE issuer=${cfg.issuer} AND user_id=${snapshot.user_id}::uuid AND revoked_at IS NULL ORDER BY id FOR UPDATE`;
        const [change] = await tx<ChangeRow[]>`SELECT * FROM auth.app_device_changes WHERE pairing_id=${id}::uuid FOR UPDATE`;
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id=${id}::uuid AND issuer=${cfg.issuer} FOR UPDATE`;
        if (
          !p ||
          p.state !== "claimed" ||
          new Date(p.expires_at).getTime() <= Date.now() ||
          p.comparison !== code ||
          !p.device_id ||
          !p.name
        )
          return reject("CONFLICT", 409);
        const user = await authorizePairing(tx, actor, p, cfg);
        if (user.auth_epoch !== p.auth_epoch) return reject("CONFLICT", 409);
        if (change) {
          if (changeStatus(change).state !== "pending") return reject("CONFLICT", 409);
          return { deviceId: p.device_id, approval: changeStatus(change) };
        }
        const [active] =
          await tx`SELECT id FROM auth.app_devices WHERE issuer=${cfg.issuer} AND user_id=${p.user_id}::uuid AND revoked_at IS NULL LIMIT 1`;
        if (!p.assisted && active) {
          const requested = await createChange(tx, cfg, actor, user.auth_epoch, "pair", p.device_id, p.id, false);
          await tx`UPDATE auth.app_pairings SET expires_at=GREATEST(expires_at,${requested.expires_at}) WHERE id=${p.id}::uuid`;
          wakeId = requested.id;
          return { deviceId: p.device_id, approval: changeStatus(requested) };
        }
        await enrollPairing(tx, p, cfg.issuer);
        return { deviceId: p.device_id, approval: null };
      });
      if (wakeId) void wake(cfg, actor.userId, wakeId, { accept: "device-changes" });
      return result;
    },
    cancelPairing: async (actor: AppApprovalActor, id: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        const [snapshot] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id=${id}::uuid AND issuer=${cfg.issuer}`;
        if (!snapshot) return reject("UNAVAILABLE", 404);
        await tx`SELECT id FROM auth.users WHERE id=${snapshot.user_id}::uuid FOR NO KEY UPDATE`;
        const [change] = await tx`SELECT id FROM auth.app_device_changes WHERE pairing_id=${id}::uuid FOR UPDATE`;
        const [p] = await tx<PairingRow[]>`SELECT * FROM auth.app_pairings WHERE id=${id}::uuid AND issuer=${cfg.issuer} FOR UPDATE`;
        if (!p) return reject("UNAVAILABLE", 404);
        if (change) await pairingOwner(tx, actor, p, cfg);
        else await authorizePairing(tx, actor, p, cfg);
        if (p.state === "confirmed") return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_device_changes SET state='cancelled' WHERE pairing_id=${id}::uuid AND state='pending'`;
        await tx`UPDATE auth.app_pairings SET state='cancelled' WHERE id=${id}::uuid`;
        await record(tx, "pairing.cancel", actor.userId, id);
      });
    },
    /** This session's newest removal of a device, so a browser that lost the answer can follow or withdraw it. */
    findRemoval: async (actor: AppApprovalActor, lookup: { changeId: string } | { deviceId: string }) => {
      const cfg = await config(false);
      const changeId = "changeId" in lookup ? lookup.changeId : null,
        deviceId = "deviceId" in lookup ? lookup.deviceId : null;
      const [row] = await db<ChangeRow[]>`SELECT * FROM auth.app_device_changes
        WHERE issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid AND requested_by_sid=${actor.sid}::uuid AND kind='revoke'
          AND (${changeId}::uuid IS NULL OR id=${changeId}::uuid) AND (${deviceId}::uuid IS NULL OR device_id=${deviceId}::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 1`;
      if (!row) return reject("UNAVAILABLE", 404);
      return { changeId: row.id, endSessions: row.end_sessions, ...changeStatus(row) };
    },
    cancelChange: async (actor: AppApprovalActor, id: string) => {
      const cfg = await config(false);
      return db.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id=${actor.userId}::uuid FOR NO KEY UPDATE`;
        const change = await ownedChange(tx, cfg, actor, id);
        if (changeStatus(change).state !== "pending") return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_device_changes SET state='cancelled' WHERE id=${id}::uuid`;
        if (change.pairing_id)
          await tx`UPDATE auth.app_pairings SET state='cancelled' WHERE id=${change.pairing_id}::uuid AND state='claimed'`;
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
    mutateDevice: async (
      actor: AppApprovalActor,
      id: string,
      name?: string,
      endSessions = true,
    ): Promise<z.infer<typeof AppDeviceRevokeResultSchema> | undefined> => {
      const cfg = await config(false);
      let wakeId: string | undefined;
      const result = await db.begin(async (tx) => {
        await tx`SELECT id FROM auth.users WHERE id=${actor.userId}::uuid FOR NO KEY UPDATE`;
        const user = await fresh(tx, actor);
        const [device] = await tx<DeviceRow[]>`SELECT * FROM auth.app_devices
          WHERE id=${id}::uuid AND issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid FOR UPDATE`;
        if (!device) return reject("UNAVAILABLE", 404);
        if (name !== undefined) {
          await tx`UPDATE auth.app_devices SET name=${name} WHERE id=${id}::uuid`;
          await record(tx, "device.rename", actor.userId, id);
          return;
        }
        if (device.revoked_at) return { state: "revoked" as const };
        // Only a configured Cloud can ask its devices; without one, an administrator revokes.
        if (!cfg.enabled || !cfg.appOrigin) return reject("UNAVAILABLE", 503);
        // A retry after a lost answer gets the same request; a changed session choice replaces it.
        const [open] = await tx<ChangeRow[]>`SELECT * FROM auth.app_device_changes
          WHERE issuer=${cfg.issuer} AND user_id=${actor.userId}::uuid AND kind='revoke' AND device_id=${id}::uuid
            AND requested_by_sid=${actor.sid}::uuid AND state='pending' AND expires_at>now() FOR UPDATE`;
        if (open?.end_sessions === endSessions) return { state: "pending" as const, changeId: open.id, expiresAt: iso(open.expires_at) };
        if (open) await tx`UPDATE auth.app_device_changes SET state='cancelled' WHERE id=${open.id}::uuid`;
        const requested = await createChange(tx, cfg, actor, user.auth_epoch, "revoke", id, null, endSessions);
        wakeId = requested.id;
        return { state: "pending" as const, changeId: requested.id, expiresAt: iso(requested.expires_at) };
      });
      if (wakeId) void wake(cfg, actor.userId, wakeId, { accept: "device-changes" });
      return result;
    },
    /** Active devices of any account, for administrators. Bounded by the active-device limit. */
    listUserDevices: async (actor: AppDeviceAdministrator, userId: string): Promise<AppDeviceView[]> => {
      if (!actor.admin) return reject("FORBIDDEN", 403);
      const cfg = await config(false);
      const rows = await db<
        DeviceRow[]
      >`SELECT * FROM auth.app_devices WHERE issuer=${cfg.issuer} AND user_id=${userId}::uuid AND revoked_at IS NULL ORDER BY created_at, id LIMIT ${limits.devicesPerAccount}`;
      return rows.map(view);
    },
    /** Idempotent: `revoked` is true only for the call that revoked the device. Works while the account is
     * expired or app sign-in is disabled, because revocation only removes access. */
    revokeUserDevice: async (actor: AppDeviceAdministrator, userId: string, id: string) => {
      if (!actor.admin) return reject("FORBIDDEN", 403);
      const cfg = await config(false);
      return db.begin(async (tx) => {
        const [device] = await tx<
          DeviceRow[]
        >`SELECT * FROM auth.app_devices WHERE id=${id}::uuid AND issuer=${cfg.issuer} AND user_id=${userId}::uuid FOR UPDATE`;
        if (!device) return reject("UNAVAILABLE", 404);
        if (device.revoked_at) return { device: view(device), revoked: false };
        const [row] = await tx<DeviceRow[]>`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${id}::uuid RETURNING *`;
        await record(tx, "device.revoke", actor.userId, id, { targetUserId: userId });
        return { device: view(row!), revoked: true };
      });
    },
    startLogin: async (identifier: string, category: AccountCategory, request?: AppLoginRequestContext) => {
      const cfg = await config();
      await cleanup();
      const id = crypto.randomUUID(),
        browserSecret = secret(),
        challenge = secret(),
        code = comparison(),
        expiresAt = future(limits.loginSeconds);
      let owner: string | undefined;
      await db.begin(async (tx) => {
        let candidate = await loginCandidate(tx, identifier, category);
        if (candidate && !(await loginBudget(tx, cfg.issuer, candidate.id))) candidate = undefined;
        const now = new Date();
        // These reads also run for decoys; the helpers use random account IDs when absent.
        const browser = await findBrowser(tx, { userId: candidate?.id, cookie: request?.cookie ?? null, now });
        const trust = await trustState(tx, now);
        const countries = await countryHistory(tx, { userId: candidate?.id, country: request?.country ?? null, now });
        const context = buildLoginContext({ request, browser, trust, countries, now });
        // Unknown, ambiguous, disabled and throttled accounts keep the identical public shape.
        await tx`INSERT INTO auth.app_logins(id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,expires_at,context)
          VALUES (${id}::uuid,${cfg.issuer},${candidate?.id ?? null}::uuid,${candidate?.auth_epoch ?? null},${category},${hash(browserSecret)},${challenge},${code},${expiresAt},${candidate && context ? JSON.stringify(context) : null}::text::jsonb)`;
        owner = candidate?.id;
      });
      // No cache I/O in SQL transactions; decoys do the same address work as real requests.
      if (request?.prefix) {
        try {
          await addresses.remember(id, appLoginAddressProof(request.prefix), expiresAt);
        } catch (error) {
          addressFailure(error);
        }
      }
      // Not awaited: decoy and real requests answer alike, and push is only a wake-up.
      if (owner) void wake(cfg, owner, id);
      return { requestId: id, browserSecret, comparison: code, expiresAt: iso(expiresAt), pollAfterSeconds: limits.pollSeconds };
    },
    startTerminalLogin: async (
      input: AppTerminalLoginInput,
      access: (tx: SQL, account: Pick<AccountRow, "id" | "profile">) => Promise<boolean>,
    ) => {
      const cfg = await config();
      await cleanup();
      const id = crypto.randomUUID(),
        code = comparison(),
        expiresAt = future(limits.loginSeconds);
      let owner: string | undefined;
      await db.begin(async (tx) => {
        let candidate = await loginCandidate(tx, input.identifier);
        const subject = candidate ?? { id: crypto.randomUUID(), profile: "user" as const };
        // Even a decoy performs the client-access, device and shared-budget queries.
        const allowed = await access(tx, subject);
        const devices = await tx`SELECT id FROM auth.app_devices WHERE issuer=${cfg.issuer}
          AND user_id=${subject.id}::uuid AND revoked_at IS NULL LIMIT 1`;
        const budget = await loginBudget(tx, cfg.issuer, subject.id);
        if (!allowed || !devices.length || !budget) candidate = undefined;
        const inserted = await tx`INSERT INTO auth.app_logins
          (id,issuer,user_id,auth_epoch,category,browser_hash,challenge,comparison,expires_at,kind,device_authorization_id,client_id,scopes,lifetime_seconds)
          VALUES (${id}::uuid,${cfg.issuer},${candidate?.id ?? null}::uuid,${candidate?.auth_epoch ?? null},
            ${candidate ? accountCategory(candidate) : "login"},${hash(secret())},${secret()},${code},${expiresAt},'terminal',
            ${input.deviceAuthorizationId}::uuid,${input.clientId},${toPgTextArray(input.scopes)}::text[],${input.lifetimeSeconds})
          ON CONFLICT (device_authorization_id) WHERE device_authorization_id IS NOT NULL DO NOTHING RETURNING id`;
        if (!inserted.length) return reject("CONFLICT", 409);
        owner = candidate?.id;
      });
      if (owner) void wake(cfg, owner, id, { accept: "terminal-logins" });
      return { comparison: code, expiresAt: iso(expiresAt) };
    },
    deviceCommand: async (
      request: AppDeviceRequest,
      actions: AppDeviceActions,
      terminal?: AppTerminalLogins,
      options?: { address?: string },
    ) => {
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
      let decidedBrowserId: string | undefined;
      const outcome = await db.begin(async (tx) => {
        let changeUserId: string | undefined;
        if (proof.command.operation === "change") {
          const [snapshot] = await tx<
            Pick<DeviceRow, "user_id">[]
          >`SELECT user_id FROM auth.app_devices WHERE id=${proof.deviceId}::uuid AND issuer=${cfg.issuer}`;
          if (!snapshot) return reject("FORBIDDEN", 403);
          changeUserId = snapshot.user_id;
          await tx`SELECT id FROM auth.users WHERE id=${changeUserId}::uuid FOR NO KEY UPDATE`;
        }
        const device = await activeDevice(tx, proof.deviceId, cfg.issuer);
        if (changeUserId && device.user_id !== changeUserId) return reject("CONFLICT", 409);
        if (!(await verify(AppDevicePublicKeySchema.parse(device.public_key), appDeviceProofMessage(proof), signature)))
          return reject("FORBIDDEN", 403);
        const used =
          await tx`INSERT INTO auth.app_device_proofs(device_id,jti,expires_at) VALUES (${device.id}::uuid,${proof.jti}::uuid,${new Date((proof.expiresAt + 5) * 1000)}) ON CONFLICT DO NOTHING RETURNING jti`;
        if (!used.length) return reject("CONFLICT", 409);
        await tx`UPDATE auth.app_devices SET last_used_at=now() WHERE id=${device.id}::uuid`;
        const command = proof.command;
        if (command.operation === "change") {
          // Like terminal sign-ins, only a device whose latest inbox opted in may decide device changes.
          if (!device.accepts?.includes("device-changes")) return reject("CONFLICT", 409);
          let target: DeviceRow | undefined;
          if (command.kind === "revoke") {
            [target] = await tx<DeviceRow[]>`SELECT * FROM auth.app_devices
              WHERE id=${command.targetId}::uuid AND issuer=${cfg.issuer} AND user_id=${device.user_id}::uuid FOR UPDATE`;
          }
          const [change] = await tx<ChangeRow[]>`SELECT * FROM auth.app_device_changes
            WHERE id=${command.changeId}::uuid AND issuer=${cfg.issuer} AND user_id=${device.user_id}::uuid FOR UPDATE`;
          const user = await eligible(tx, device.user_id);
          if (
            !change ||
            changeStatus(change).state !== "pending" ||
            change.kind !== command.kind ||
            change.end_sessions !== command.endSessions ||
            change.auth_epoch !== user.auth_epoch
          )
            return reject("CONFLICT", 409);
          let pairing: PairingRow | undefined;
          if (change.kind === "pair") {
            [pairing] = await tx<
              PairingRow[]
            >`SELECT * FROM auth.app_pairings WHERE id=${change.pairing_id}::uuid AND issuer=${cfg.issuer} FOR UPDATE`;
            if (
              !pairing ||
              pairing.user_id !== user.id ||
              pairing.state !== "claimed" ||
              new Date(pairing.expires_at).getTime() <= Date.now() ||
              pairing.auth_epoch !== user.auth_epoch ||
              pairing.device_id !== command.targetId
            )
              return reject("CONFLICT", 409);
            const [initiator] = await tx`SELECT sid FROM auth.session_families WHERE sid=${pairing.initiator_sid}::uuid
              AND user_id=${pairing.initiated_by}::uuid AND auth_epoch=${user.auth_epoch} AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`;
            if (!initiator) return reject("CONFLICT", 409);
          } else {
            if (!target || change.device_id !== command.targetId) return reject("CONFLICT", 409);
            if (command.decision === "deny" && device.id === change.device_id) return reject("CONFLICT", 409);
            const [requester] = await tx`SELECT sid FROM auth.session_families WHERE sid=${change.requested_by_sid}::uuid
              AND user_id=${change.user_id}::uuid AND auth_epoch=${user.auth_epoch} AND revoked_at IS NULL AND expires_at>now() FOR UPDATE`;
            if (!requester) return reject("CONFLICT", 409);
          }
          const state = command.decision === "approve" ? ("approved" as const) : ("denied" as const);
          // Locks above may outlive the request. Expiry wins before applying either decision.
          const decided = await tx`UPDATE auth.app_device_changes SET state=${state},decided_by=${device.id}::uuid
            WHERE id=${change.id}::uuid AND state='pending' AND expires_at > clock_timestamp() RETURNING id`;
          if (!decided.length) return reject("CONFLICT", 409);
          let ended = 0;
          if (state === "denied") {
            if (pairing) await tx`UPDATE auth.app_pairings SET state='cancelled' WHERE id=${pairing.id}::uuid`;
          } else if (pairing) {
            await enrollPairing(tx, pairing, cfg.issuer);
          } else {
            await tx`UPDATE auth.app_devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${command.targetId}::uuid`;
            if (change.end_sessions) {
              const families = await tx`UPDATE auth.session_families SET revoked_at=now(), revocation_reason='app_device_removed'
                WHERE user_id=${user.id}::uuid AND app_device_id=${command.targetId}::uuid AND sid<>${change.requested_by_sid}::uuid
                  AND revoked_at IS NULL AND expires_at>now() AND auth_epoch=${user.auth_epoch} RETURNING sid`;
              ended = families.length;
            }
            await record(tx, "device.revoke", user.id, command.targetId, { changeId: change.id });
          }
          await record(tx, `device_change.${command.decision}`, user.id, command.targetId, {
            changeId: change.id,
            kind: change.kind,
            endSignIns: change.end_sessions,
            ended,
          });
          return { state };
        }
        if (command.operation === "push") {
          await tx`UPDATE auth.app_devices SET push_token=${command.token} WHERE id=${device.id}::uuid`;
          return { state: "updated" as const };
        }
        if (command.operation === "account") {
          // Only the account this device signs in; activeDevice already checked it exists and may use app approval.
          const [user] = await tx<
            { uid: string; display_name: string; mail: string | null }[]
          >`SELECT uid, display_name, mail FROM auth.users WHERE id=${device.user_id}::uuid`;
          if (!user) return reject("FORBIDDEN", 403);
          return {
            account: { uid: user.uid, displayName: user.display_name, mail: user.mail || null },
            device: { name: device.name, createdAt: iso(device.created_at) },
          };
        }
        if (command.operation === "revoke") {
          await tx`UPDATE auth.app_devices SET revoked_at=now() WHERE id=${device.id}::uuid`;
          await record(tx, "device.revoke", device.user_id, device.id);
          return { state: "revoked" as const };
        }
        if (command.operation === "action" || command.operation === "act")
          return { operation: command.operation, userId: device.user_id, deviceId: device.id };
        if (command.operation === "pending" || command.operation === "inbox") {
          const user = await eligible(tx, device.user_id);
          const acceptsTerminal =
            command.operation === "inbox" && command.accept?.includes("terminal-logins") === true && terminal !== undefined;
          const rows = await tx<
            LoginRow[]
          >`SELECT * FROM auth.app_logins WHERE (kind='browser' OR ${acceptsTerminal}) AND issuer=${cfg.issuer} AND user_id=${device.user_id}::uuid AND state='pending' AND expires_at>now() AND auth_epoch=${user.auth_epoch} AND category=${accountCategory(user)} ORDER BY created_at LIMIT ${limits.pendingPerAccount}`;
          const clients =
            acceptsTerminal && terminal
              ? await terminal.describe(
                  tx,
                  rows.flatMap((row) => (row.device_authorization_id ? [row.device_authorization_id] : [])),
                )
              : new Map<string, { id: string; name: string }>();
          const requests: AppPendingLogin[] = [];
          for (const row of rows) {
            const login: AppPendingLogin = {
              requestId: row.id,
              challenge: row.challenge,
              comparison: row.comparison,
              createdAt: iso(row.created_at),
              expiresAt: iso(row.expires_at),
            };
            if (row.kind === "terminal") {
              const client = row.device_authorization_id ? clients.get(row.device_authorization_id) : undefined;
              if (!client || client.id !== row.client_id || !row.scopes || !row.lifetime_seconds) continue;
              login.terminal = {
                client: { id: client.id, name: appApprovalText(client.name || client.id, APP_ACTION_LIMITS.nameChars) || "OAuth" },
                scopes: row.scopes,
                lifetimeSeconds: row.lifetime_seconds,
              };
            }
            if (row.kind === "browser" && command.accept?.includes("login-context")) {
              const parsed = AppLoginContextSchema.safeParse(row.context);
              if (parsed.success) {
                // sameNetwork is transient, even if an unexpected stored value contains it.
                const { sameNetwork: _transient, ...context } = parsed.data;
                login.context = context;
              }
            }
            requests.push(login);
          }
          if (command.operation === "inbox") {
            await tx`UPDATE auth.app_devices SET actions_at=now(), accepts=${toPgTextArray(command.accept ?? [])}::text[] WHERE id=${device.id}::uuid`;
            let changes: AppDeviceChange[] | undefined;
            if (command.accept?.includes("device-changes")) {
              const rows = await tx<
                (ChangeRow & { target_id: string; name: string })[]
              >`SELECT c.*, COALESCE(p.device_id,d.id) AS target_id, COALESCE(p.name,d.name) AS name
                FROM auth.app_device_changes c LEFT JOIN auth.app_pairings p ON p.id=c.pairing_id LEFT JOIN auth.app_devices d ON d.id=c.device_id
                WHERE c.issuer=${cfg.issuer} AND c.user_id=${device.user_id}::uuid AND c.state='pending' AND c.expires_at>now() AND c.auth_epoch=${user.auth_epoch}
                  AND ((c.kind='revoke' AND EXISTS (SELECT 1 FROM auth.session_families f
                    WHERE f.sid=c.requested_by_sid AND f.user_id=c.user_id
                      AND f.revoked_at IS NULL AND f.expires_at>now() AND f.auth_epoch=${user.auth_epoch}))
                    OR (p.state='claimed' AND p.expires_at>now() AND p.auth_epoch=${user.auth_epoch}
                    AND EXISTS (SELECT 1 FROM auth.session_families f WHERE f.sid=p.initiator_sid AND f.user_id=p.initiated_by
                      AND f.revoked_at IS NULL AND f.expires_at>now() AND f.auth_epoch=${user.auth_epoch})))
                ORDER BY c.created_at,c.id LIMIT ${limits.pendingPerAccount}`;
              changes = rows.map((row) => ({
                changeId: row.id,
                kind: row.kind,
                device: { id: row.target_id, name: changeName(row.name) },
                endSessions: row.end_sessions,
                createdAt: iso(row.created_at),
                expiresAt: iso(row.expires_at),
              }));
            }
            return { operation: "inbox" as const, userId: device.user_id, logins: requests, changes };
          }
          return { requests, pollAfterSeconds: limits.pollSeconds };
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
        if (
          row.kind === "terminal" &&
          (!device.accepts?.includes("terminal-logins") ||
            !terminal ||
            !row.device_authorization_id ||
            !row.client_id ||
            !(await terminal.decide(tx, {
              deviceAuthorizationId: row.device_authorization_id,
              clientId: row.client_id,
              user,
              decision: command.decision,
            })))
        )
          return reject("CONFLICT", 409);
        const state = command.decision === "approve" ? "approved" : "denied";
        // A hook may wait on another transaction. Expiry still wins before either decision commits.
        const decided = await tx`UPDATE auth.app_logins SET state=${state},approved_by=${device.id}::uuid
          WHERE id=${row.id}::uuid AND expires_at > clock_timestamp() RETURNING id`;
        if (!decided.length) return reject("CONFLICT", 409);
        const storedContext = row.kind === "browser" ? AppLoginContextSchema.safeParse(row.context) : null;
        await record(tx, `login.${command.decision}`, device.user_id, device.id, {
          requestId: row.id,
          ...(row.kind === "terminal" ? { kind: "terminal", clientId: row.client_id, deviceGrantId: row.device_authorization_id } : {}),
          ...(storedContext?.success ? { level: storedContext.data.level } : {}),
        });
        if (row.kind === "browser") decidedBrowserId = row.id;
        return { state };
      });
      if (outcome.operation !== undefined) {
        const command = proof.command;
        const input = { userId: outcome.userId, issuer: cfg.issuer };
        if (outcome.operation === "inbox") {
          const inbox = {
            logins: outcome.logins,
            ...(outcome.changes === undefined ? {} : { changes: outcome.changes, moreChanges: 0 }),
            ...(await actions.inbox(input)),
            pollAfterSeconds: limits.pollSeconds,
          };
          await addSameNetwork(inbox.logins, options?.address);
          return trimAppLoginResponse(inbox);
        }
        if (command.operation === "action") {
          const view = await actions.view({ ...input, actionId: command.actionId });
          return view ?? reject("CONFLICT", 409);
        }
        if (command.operation === "act") {
          const approved = command.decision === "approve";
          const applied = await actions.decide({
            ...input,
            deviceId: outcome.deviceId,
            actionId: command.actionId,
            digest: command.digest,
            approved,
          });
          if (!applied) return reject("CONFLICT", 409);
          return { state: approved ? ("approved" as const) : ("denied" as const) };
        }
        return reject("INVALID_REQUEST", 400);
      }
      if (outcome.requests !== undefined) {
        await addSameNetwork(outcome.requests, options?.address);
        return trimAppLoginResponse(outcome);
      }
      // Only after commit: the waiting browser re-reads Postgres, so a hint never grants anything.
      if (proof.command.operation === "decide") hints.publish(proof.command.requestId);
      if (decidedBrowserId) {
        try {
          await addresses.forget(decidedBrowserId);
        } catch (error) {
          addressFailure(error);
        }
      }
      return outcome;
    },
    /** With `hold`, a pending request is answered on its decision, its expiry, or after `hold.ms`, whichever comes first. */
    browserStatus: async (id: string, token: string, hold?: { ms: number; signal?: AbortSignal }) => {
      const cfg = await config();
      const read = async () => {
        const [row] = await db<LoginRow[]>`SELECT * FROM auth.app_logins WHERE kind='browser' AND id=${id}::uuid AND issuer=${cfg.issuer}`;
        if (!row || !matches(token, row.browser_hash)) return reject("UNAVAILABLE", 404);
        const expiresIn = new Date(row.expires_at).getTime() - Date.now();
        return { state: expiresIn <= 0 ? "expired" : row.state, expiresIn };
      };
      const result = (state: string) => ({ state, pollAfterSeconds: limits.pollSeconds });
      if (!hold) return result((await read()).state);
      // Listen before the first read so a decision committed in between usually wakes this request.
      // live() has no subscription-ready barrier, so the hint is best effort; the deadline re-read is the guarantee.
      const waiting = new AbortController();
      const ended = new Promise((resolve) => waiting.signal.addEventListener("abort", resolve, { once: true }));
      const stop = () => waiting.abort();
      hold.signal?.addEventListener("abort", stop, { once: true });
      if (hold.signal?.aborted) stop();
      const hint = hints.wait(id, waiting.signal).catch(() => {});
      try {
        const first = await read();
        if (first.state !== "pending") return result(first.state);
        const timer = setTimeout(stop, Math.min(hold.ms, first.expiresIn));
        await Promise.race([hint, ended]);
        clearTimeout(timer);
        return result((await read()).state);
      } finally {
        hold.signal?.removeEventListener("abort", stop);
        stop();
      }
    },
    consumeLogin: async (id: string, token: string) => {
      const cfg = await config();
      return db.begin(async (tx) => {
        // Lock order is device -> request for both approval and completion.
        const [snapshot] = await tx<
          LoginRow[]
        >`SELECT * FROM auth.app_logins WHERE kind='browser' AND id=${id}::uuid AND issuer=${cfg.issuer}`;
        if (!snapshot || !snapshot.approved_by || !matches(token, snapshot.browser_hash)) return reject("CONFLICT", 409);
        const device = await activeDevice(tx, snapshot.approved_by, cfg.issuer);
        const [row] = await tx<
          LoginRow[]
        >`SELECT * FROM auth.app_logins WHERE kind='browser' AND id=${id}::uuid AND issuer=${cfg.issuer} FOR UPDATE`;
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
        return { userId: user.id, authEpoch: Number(row.auth_epoch), deviceId: device.id, deviceName: device.name };
      });
    },
  };
};

export const appApproval = createAppApprovalService();
