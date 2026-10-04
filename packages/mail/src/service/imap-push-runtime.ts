import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, logger } from "@k2b/cloud/services";
import type { Lock, Mutex } from "@k2b/sync";
import { sql } from "bun";
import { parseConnectorCapabilities } from "../contracts";
import { sha256Json } from "./canonical";
import type { ConnectorChangeHint, ConnectorChangeListener, ConnectorChangeListenerMode } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { safeErrorDetail } from "./error-messages";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { providerErrorCode, providerErrorMessage } from "./provider-errors";
import { recordProviderReachable } from "./provider-operation-lock";
import { enqueueBindingRediscovery, enqueueFolderReconciliation, enqueueFolderSync } from "./sync-runtime";

const log = logger("mail:imap-push");

const LEADER_LEASE_MS = 60_000;
const CONNECTION_LEASE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
// A renewal that the lease store did not answer is retried until this long
// before the last confirmed extension runs out, which leaves time to close the
// IDLE connection before another process can take the lease over.
const LEASE_RENEWAL_MARGIN_MS = 10_000;
const MAX_RENEWAL_RETRY_DELAY_MS = 5_000;
const SCAN_INTERVAL_MS = 15_000;
const HINT_COALESCE_MS = 200;
const POLL_FALLBACK_MS = 30_000;
const MAX_PENDING_HINTS = 128;
const MAX_RECONNECT_DELAY_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;
// The sync scheduler already rediscovers every eligible binding whose last
// verification is older than 15 minutes (submitDueWork in sync-runtime); a
// flapping connection must not beat that cadence.
const DISCOVERY_INTERVAL_MS = 15 * 60_000;
// sync-runtime's fetchReconcileStep walks the full UID range at most every 6
// hours; a reconnect uses the same budget instead of restarting the walk.
const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;

export type ImapPushBindingPlan = {
  bindingId: string;
  mailboxId: string;
  remoteResourceId: string;
  connectionId: string;
  secretRevision: number;
  imapHost: string;
  folderId: string;
  folderPath: string;
  uidValidity: string;
  highestModseq: string | null;
  capabilities: {
    idle: boolean;
    condstore: boolean;
    qresync: boolean;
    notify: boolean;
  };
};

type ImapPushHealthState = "starting" | "listening" | "polling" | "reconnecting" | "stopped" | "degraded";

type ImapPushHealthPatch = {
  state: ImapPushHealthState;
  mode: ConnectorChangeListenerMode | "none";
  reconnectAttempt?: number;
  connected?: boolean;
  hint?: boolean;
  error?: unknown;
  clearError?: boolean;
};

type PermitLease = {
  locks: { scope: "global" | "host" | "mailbox"; lock: Lock }[];
};

/**
 * One lease extension: the store confirmed it, refused it (`rejected`, for
 * example because another owner holds the lease), or did not answer (`failed`).
 */
export type LeaseExtension = { lease: string; outcome: "extended" | "rejected" } | { lease: string; outcome: "failed"; error: unknown };

type PermitPool = {
  acquire(plan: Pick<ImapPushBindingPlan, "imapHost" | "mailboxId">): Promise<PermitLease | null>;
  extend(lease: PermitLease): Promise<LeaseExtension[]>;
  release(lease: PermitLease): Promise<void>;
};

type ImapPushLeaseLoss = {
  /** `leader` or the permit scope, for example `permit:mailbox`. */
  lease: string;
  /** `rejected`: the store refused the extension; `expired`: no extension was confirmed in time. */
  reason: "rejected" | "expired";
  sinceLastExtensionMs: number;
};

export class ImapPushLeaseLostError extends Error {
  readonly code = "IMAP_PUSH_LEASE_LOST";
  readonly loss: ImapPushLeaseLoss;

  constructor(loss: ImapPushLeaseLoss, cause?: unknown) {
    const seconds = Math.round(loss.sinceLastExtensionMs / 1_000);
    super(
      loss.reason === "rejected"
        ? `IMAP push listener lease was lost: the store rejected the ${loss.lease} lease ${seconds} s after its last extension`
        : `IMAP push listener lease was lost: the ${loss.lease} lease could not be extended for ${seconds} s`,
      cause === undefined ? undefined : { cause },
    );
    this.loss = loss;
  }
}

const errorDetail = (error: unknown): string | null => safeErrorDetail(error instanceof Error ? error.message : String(error));

/** Log fields that say why a listener stopped, including the original error behind a generic code. */
export const imapPushFailureFields = (error: unknown): Record<string, unknown> => {
  if (error instanceof ImapPushLeaseLostError) {
    return {
      code: error.code,
      lease: error.loss.lease,
      reason: error.loss.reason,
      sinceLastExtensionMs: error.loss.sinceLastExtensionMs,
      ...(error.cause === undefined ? {} : { error: errorDetail(error.cause) }),
    };
  }
  const code = providerErrorCode(error, "IMAP_PUSH_FAILED");
  const originalCode = (error as { code?: unknown } | null)?.code;
  return {
    code,
    ...(typeof originalCode === "string" && originalCode !== code ? { originalCode: originalCode.slice(0, 80) } : {}),
    error: errorDetail(error),
  };
};

const extendLock = async (mutex: Mutex, lease: string, lock: Lock, ttlMs: number): Promise<LeaseExtension> => {
  try {
    return { lease, outcome: (await mutex.extend(lock, { ttlMs })) ? "extended" : "rejected" };
  } catch (error) {
    return { lease, outcome: "failed", error };
  }
};

/**
 * Settles with the operation's result, or with `null` once `ms` pass or `stop`
 * aborts. The operation's signal aborts when it is abandoned this way.
 */
const answerWithin = async <T>(ms: number, stop: AbortSignal, operation: (abandoned: AbortSignal) => Promise<T>): Promise<T | null> => {
  const abandon = new AbortController();
  const timer = setTimeout(() => abandon.abort(), ms);
  const onStop = (): void => abandon.abort();
  stop.addEventListener("abort", onStop, { once: true });
  try {
    return await Promise.race([
      operation(abandon.signal),
      new Promise<null>((resolve) => {
        abandon.signal.addEventListener("abort", () => resolve(null), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  }
};

type ImapPushRuntimeDependencies = {
  listPlans(): Promise<ImapPushBindingPlan[]>;
  loadPlan(bindingId: string): Promise<ImapPushBindingPlan | null>;
  claimGeneration(plan: ImapPushBindingPlan): Promise<number>;
  updateHealth(bindingId: string, generation: number, patch: ImapPushHealthPatch): Promise<void>;
  loadRuntime: typeof loadProviderConnectionRuntimeSnapshot;
  listen: NonNullable<typeof imapSmtpConnector.listenForChanges>;
  enqueueFolder(folderId: string): Promise<void>;
  enqueueReconciliation(folderId: string, fromUid: number): Promise<void>;
  enqueueRediscovery(bindingId: string): Promise<void>;
  loadReconnectBudget(plan: ImapPushBindingPlan): Promise<ImapReconnectBudget>;
  /** The provider answered: closes the remote mailbox's provider breaker, so its waiting syncs run now. */
  recordProviderReachable(remoteResourceId: string): Promise<void>;
  leaderMutex: Mutex;
  permits: PermitPool;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

const listenerLeaderMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:imap-push-leader",
    ttlMs: LEADER_LEASE_MS,
    retry: { maxAttempts: 1 },
  }),
);

const listenerPermitMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:imap-push-connection",
    ttlMs: CONNECTION_LEASE_MS,
    retry: { maxAttempts: 1 },
  }),
);

const sleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const finish = (operation: () => void) => {
      signal.removeEventListener("abort", abort);
      operation();
    };
    const timer = setTimeout(() => finish(resolve), ms);
    const abort = () => {
      clearTimeout(timer);
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};

const acquireSlot = async (transport: Mutex, prefix: string, count: number): Promise<Lock | null> => {
  for (let slot = 0; slot < count; slot += 1) {
    const lock = await transport.acquire({ resource: `${prefix}:${slot}`, ttlMs: CONNECTION_LEASE_MS });
    if (lock) return lock;
  }
  return null;
};

export class FixedImapConnectionPermitPool implements PermitPool {
  readonly #transport: Mutex;
  readonly #globalLimit: number;
  readonly #hostLimit: number;
  readonly #mailboxLimit: number;

  constructor(transport: Mutex, limits: { global: number; host: number; mailbox: number } = { global: 100, host: 20, mailbox: 1 }) {
    if (![limits.global, limits.host, limits.mailbox].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error("IMAP connection limits must be positive integers");
    }
    this.#transport = transport;
    this.#globalLimit = limits.global;
    this.#hostLimit = limits.host;
    this.#mailboxLimit = limits.mailbox;
  }

  async acquire(plan: Pick<ImapPushBindingPlan, "imapHost" | "mailboxId">): Promise<PermitLease | null> {
    const locks: PermitLease["locks"] = [];
    try {
      const global = await acquireSlot(this.#transport, "global", this.#globalLimit);
      if (!global) return null;
      locks.push({ scope: "global", lock: global });
      const hostKey = sha256Json(plan.imapHost.trim().toLowerCase());
      const host = await acquireSlot(this.#transport, `host:${hostKey}`, this.#hostLimit);
      if (!host) return null;
      locks.push({ scope: "host", lock: host });
      const mailbox = await acquireSlot(this.#transport, `mailbox:${plan.mailboxId}`, this.#mailboxLimit);
      if (!mailbox) return null;
      locks.push({ scope: "mailbox", lock: mailbox });
      return { locks };
    } finally {
      if (locks.length < 3) {
        await Promise.all(locks.map(({ lock }) => this.#transport.release(lock).catch(() => undefined)));
      }
    }
  }

  extend(lease: PermitLease): Promise<LeaseExtension[]> {
    return Promise.all(lease.locks.map(({ scope, lock }) => extendLock(this.#transport, `permit:${scope}`, lock, CONNECTION_LEASE_MS)));
  }

  async release(lease: PermitLease): Promise<void> {
    await Promise.all(lease.locks.map(({ lock }) => this.#transport.release(lock).catch(() => undefined)));
  }
}

const permits = lazySync(() => new FixedImapConnectionPermitPool(listenerPermitMutex()));

const parseCapabilities = (value: Record<string, unknown> | string): ImapPushBindingPlan["capabilities"] => {
  const parsed = parseConnectorCapabilities(typeof value === "string" ? JSON.parse(value) : value);
  return {
    idle: parsed.idle,
    condstore: parsed.condstore,
    qresync: parsed.qresync,
    notify: parsed.notify,
  };
};

const queryPlans = async (bindingId: string | null): Promise<ImapPushBindingPlan[]> => {
  const rows = await sql<
    {
      binding_id: string;
      mailbox_id: string;
      remote_resource_id: string;
      connection_id: string;
      secret_revision: number;
      imap_host: string;
      capabilities: Record<string, unknown> | string;
      folder_id: string;
      remote_path: string;
      uid_validity: string | number;
      highest_modseq: string | number | null;
    }[]
  >`
    SELECT
      binding.id AS binding_id,
      resource.mailbox_id,
      resource.id AS remote_resource_id,
      connection.id AS connection_id,
      connection.secret_revision,
      connection.imap_host,
      binding.capabilities,
      selected_folder.folder_id,
      selected_folder.remote_path,
      selected_folder.uid_validity,
      selected_folder.highest_modseq
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource
      ON resource.id = binding.remote_resource_id
     AND resource.status IN ('active', 'degraded')
    JOIN mail.mailboxes mailbox
      ON mailbox.id = resource.mailbox_id
     AND mailbox.sync_enabled = true
     AND mailbox.deleted_at IS NULL
    JOIN mail.provider_connections connection
      ON connection.id = binding.connection_id
     AND connection.owner_mailbox_id = mailbox.id
     AND connection.status = 'active'
     AND connection.encrypted_secret IS NOT NULL
     AND connection.secret_revision = binding.verified_secret_revision
    JOIN LATERAL (
      SELECT
        ref.folder_id,
        ref.remote_path,
        ref.uid_validity,
        ref.highest_modseq
      FROM mail.binding_folder_refs ref
      JOIN mail.folders folder
        ON folder.id = ref.folder_id
       AND folder.remote_resource_id = resource.id
       AND folder.selected_for_sync = true
       AND folder.discovery_state = 'active'
       AND folder.sync_status <> 'excluded'
      WHERE ref.binding_id = binding.id
        AND ref.uid_validity IS NOT NULL
        AND ref.effective_rights @> ARRAY['read']::text[]
      ORDER BY CASE folder.role WHEN 'inbox' THEN 0 ELSE 1 END, folder.id
      LIMIT 1
    ) selected_folder ON true
    WHERE binding.state = 'active'
      AND binding.verified_scope_fingerprint = resource.scope_fingerprint
      AND (${bindingId}::uuid IS NULL OR binding.id = ${bindingId}::uuid)
    ORDER BY binding.id
  `;
  return rows.map((row) => ({
    bindingId: row.binding_id,
    mailboxId: row.mailbox_id,
    remoteResourceId: row.remote_resource_id,
    connectionId: row.connection_id,
    secretRevision: row.secret_revision,
    imapHost: row.imap_host,
    folderId: row.folder_id,
    folderPath: row.remote_path,
    uidValidity: String(row.uid_validity),
    highestModseq: row.highest_modseq == null ? null : String(row.highest_modseq),
    capabilities: parseCapabilities(row.capabilities),
  }));
};

const listPlans = async (): Promise<ImapPushBindingPlan[]> => queryPlans(null);

export const loadImapPushPlan = async (bindingId: string): Promise<ImapPushBindingPlan | null> => (await queryPlans(bindingId))[0] ?? null;

const timestampMs = (value: Date | string | null): number | null => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const loadReconnectBudget = async (plan: ImapPushBindingPlan): Promise<ImapReconnectBudget> => {
  const [row] = await sql<
    { last_discovery_at: Date | string | null; last_full_reconcile_at: string | null; full_reconcile_pending: boolean }[]
  >`
    SELECT
      resource.last_discovery_at,
      folder.envelope_cursor->>'lastFullReconcileAt' AS last_full_reconcile_at,
      folder.envelope_cursor->>'reconcileNextLow' IS NOT NULL AS full_reconcile_pending
    FROM mail.folders folder
    JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
    WHERE folder.id = ${plan.folderId}::uuid
  `;
  return {
    lastDiscoveryAt: timestampMs(row?.last_discovery_at ?? null),
    lastFullReconcileAt: timestampMs(row?.last_full_reconcile_at ?? null),
    fullReconcilePending: row?.full_reconcile_pending === true,
  };
};

const claimGeneration = async (plan: ImapPushBindingPlan): Promise<number> => {
  const [row] = await sql<{ generation: string | number }[]>`
    INSERT INTO mail.imap_push_listener_health (
      binding_id, generation, state, mode, folder_id, capabilities, reconnect_attempt,
      last_error_code, last_error_message, last_heartbeat_at
    )
    VALUES (
      ${plan.bindingId}::uuid, 1, 'starting', 'none', ${plan.folderId}::uuid,
      ${plan.capabilities}::jsonb, 0, NULL, NULL, now()
    )
    ON CONFLICT (binding_id) DO UPDATE SET
      generation = mail.imap_push_listener_health.generation + 1,
      state = 'starting',
      mode = 'none',
      folder_id = EXCLUDED.folder_id,
      capabilities = EXCLUDED.capabilities,
      reconnect_attempt = 0,
      last_error_code = NULL,
      last_error_message = NULL,
      last_heartbeat_at = now(),
      updated_at = now()
    RETURNING generation
  `;
  if (!row) throw new Error("IMAP push listener generation was not claimed");
  return Number(row.generation);
};

const updateHealth = async (bindingId: string, generation: number, patch: ImapPushHealthPatch): Promise<void> => {
  const errorCode = patch.error ? providerErrorCode(patch.error, "IMAP_PUSH_FAILED") : null;
  const errorMessage = patch.error ? providerErrorMessage(patch.error, "IMAP push listener failed") : null;
  await sql`
    UPDATE mail.imap_push_listener_health
    SET
      state = ${patch.state},
      mode = ${patch.mode},
      reconnect_attempt = COALESCE(${patch.reconnectAttempt ?? null}, reconnect_attempt),
      last_connected_at = CASE WHEN ${patch.connected === true} THEN now() ELSE last_connected_at END,
      last_hint_at = CASE WHEN ${patch.hint === true} THEN now() ELSE last_hint_at END,
      last_error_code = CASE
        WHEN ${patch.error !== undefined} THEN ${errorCode}
        WHEN ${patch.clearError === true} THEN NULL
        ELSE last_error_code
      END,
      last_error_message = CASE
        WHEN ${patch.error !== undefined} THEN ${errorMessage}
        WHEN ${patch.clearError === true} THEN NULL
        ELSE last_error_message
      END,
      last_heartbeat_at = now(),
      updated_at = now()
    WHERE binding_id = ${bindingId}::uuid
      AND generation = ${generation}
  `;
};

export const imapPushPlanFingerprint = (plan: ImapPushBindingPlan): string =>
  sha256Json({
    bindingId: plan.bindingId,
    mailboxId: plan.mailboxId,
    connectionId: plan.connectionId,
    secretRevision: plan.secretRevision,
    imapHost: plan.imapHost.trim().toLowerCase(),
    folderId: plan.folderId,
    folderPath: plan.folderPath,
    uidValidity: plan.uidValidity,
    capabilities: plan.capabilities,
  });

const samePlan = (expected: ImapPushBindingPlan, current: ImapPushBindingPlan | null): current is ImapPushBindingPlan =>
  current !== null && imapPushPlanFingerprint(expected) === imapPushPlanFingerprint(current);

export type CoalescedImapHints = {
  folderChanged: boolean;
  reconcileFromUid: number | null;
  rediscover: boolean;
};

/** Epoch milliseconds of the last completed discovery and full UID reconciliation; `null` means never. */
export type ImapReconnectBudget = {
  lastDiscoveryAt: number | null;
  lastFullReconcileAt: number | null;
  /** A reconciliation walk the folder sync has not finished yet. */
  fullReconcilePending: boolean;
};

const UNSPENT_RECONNECT_BUDGET: ImapReconnectBudget = {
  lastDiscoveryAt: null,
  lastFullReconcileAt: null,
  fullReconcilePending: false,
};

const isUncertainHint = (hint: ConnectorChangeHint): boolean => hint.type === "overflow" || hint.type === "disconnected";

export const hintsCarryUncertainty = (hints: readonly ConnectorChangeHint[]): boolean => hints.some(isUncertainHint);

const elapsed = (since: number | null, now: number): number => (since == null ? Number.POSITIVE_INFINITY : now - since);

export const coalesceImapHints = (
  hints: readonly ConnectorChangeHint[],
  budget: ImapReconnectBudget = UNSPENT_RECONNECT_BUDGET,
  now: number = Date.now(),
): CoalescedImapHints => {
  const uncertain = hintsCarryUncertainty(hints);
  const vanished = hints.flatMap((hint) => (hint.type === "folder_changed" && hint.cause === "vanished" ? [hint.uid] : []));
  // EXPUNGE without QRESYNC carries no UID, so an untargeted deletion still has
  // to reconcile the folder from the start.
  const untargetedVanish = vanished.some((uid) => uid == null);
  const vanishedUids = vanished.filter((uid): uid is number => uid != null);
  // A flapping connection reconnects as often as once per second: its uncertainty
  // only buys a full UID walk or a LIST+ACL rediscovery once per regular cadence.
  // A pending walk already covers the folder: requesting it again only rewinds
  // its cursor to the start.
  const fullReconcileDue = !budget.fullReconcilePending && elapsed(budget.lastFullReconcileAt, now) >= FULL_RECONCILE_INTERVAL_MS;
  const rediscoveryDue = elapsed(budget.lastDiscoveryAt, now) >= DISCOVERY_INTERVAL_MS;
  const smallestVanishedUid = vanishedUids.length > 0 ? Math.min(...vanishedUids) : null;
  return {
    folderChanged: hints.some((hint) => hint.type === "folder_changed" || isUncertainHint(hint)),
    reconcileFromUid: untargetedVanish || (uncertain && fullReconcileDue) ? 1 : smallestVanishedUid,
    rediscover:
      (uncertain && rediscoveryDue) || hints.some((hint) => hint.type === "folder_changed" && hint.cause === "uidvalidity_changed"),
  };
};

export const applyImapPushHints = async (params: {
  expected: ImapPushBindingPlan;
  hints: readonly ConnectorChangeHint[];
  assertLeaseActive(): Promise<void>;
  loadPlan(bindingId: string): Promise<ImapPushBindingPlan | null>;
  enqueueFolder(folderId: string): Promise<void>;
  enqueueReconciliation(folderId: string, fromUid: number): Promise<void>;
  enqueueRediscovery(bindingId: string): Promise<void>;
  loadReconnectBudget(plan: ImapPushBindingPlan): Promise<ImapReconnectBudget>;
}): Promise<"applied" | "stale"> => {
  const uncertain = hintsCarryUncertainty(params.hints);
  const relevant = uncertain || params.hints.some((hint) => hint.type === "folder_changed");
  if (!relevant) return "applied";
  await params.assertLeaseActive();
  const current = await params.loadPlan(params.expected.bindingId);
  if (!samePlan(params.expected, current)) return "stale";
  // Only an uncertain stream (disconnect or overflow) is throttled, so the extra
  // read stays on the reconnect path.
  const batch = coalesceImapHints(params.hints, uncertain ? await params.loadReconnectBudget(current) : UNSPENT_RECONNECT_BUDGET);
  if (!batch.folderChanged && !batch.rediscover) return "applied";
  await params.assertLeaseActive();
  if (batch.reconcileFromUid != null) {
    await params.enqueueReconciliation(current.folderId, batch.reconcileFromUid);
  } else if (batch.folderChanged) {
    await params.enqueueFolder(current.folderId);
  }
  await params.assertLeaseActive();
  if (batch.rediscover) await params.enqueueRediscovery(current.bindingId);
  await params.assertLeaseActive();
  return "applied";
};

const reconciliationHint = (plan: ImapPushBindingPlan): ConnectorChangeHint => ({
  type: "folder_changed",
  cause: "exists",
  folderPath: plan.folderPath,
  uid: null,
  modseq: null,
});

const applyImapReconciliationHint = (params: {
  plan: ImapPushBindingPlan;
  assertLeaseActive(): Promise<void>;
  dependencies: ImapPushRuntimeDependencies;
}): Promise<"applied" | "stale"> =>
  applyImapPushHints({
    expected: params.plan,
    hints: [reconciliationHint(params.plan)],
    assertLeaseActive: params.assertLeaseActive,
    loadPlan: params.dependencies.loadPlan,
    enqueueFolder: params.dependencies.enqueueFolder,
    enqueueReconciliation: params.dependencies.enqueueReconciliation,
    enqueueRediscovery: params.dependencies.enqueueRediscovery,
    loadReconnectBudget: params.dependencies.loadReconnectBudget,
  });

const consumeHints = async (params: {
  listener: ConnectorChangeListener;
  plan: ImapPushBindingPlan;
  generation: number;
  signal: AbortSignal;
  assertLeaseActive(): Promise<void>;
  dependencies: ImapPushRuntimeDependencies;
}): Promise<{ disconnected: boolean }> => {
  let pending: ConnectorChangeHint[] = [];
  let flushTask: Promise<void> | null = null;
  let flushError: unknown = null;
  let fallbackTask: Promise<void> | null = null;
  let disconnected = false;

  const flush = async (): Promise<void> => {
    const hints = pending;
    pending = [];
    if (hints.length === 0) return;
    const applied = await applyImapPushHints({
      expected: params.plan,
      hints,
      assertLeaseActive: params.assertLeaseActive,
      loadPlan: params.dependencies.loadPlan,
      enqueueFolder: params.dependencies.enqueueFolder,
      enqueueReconciliation: params.dependencies.enqueueReconciliation,
      enqueueRediscovery: params.dependencies.enqueueRediscovery,
      loadReconnectBudget: params.dependencies.loadReconnectBudget,
    });
    if (applied === "stale") {
      throw Object.assign(new Error("IMAP push binding changed before a delayed effect"), { code: "IMAP_PUSH_PLAN_CHANGED" });
    }
    await params.dependencies.updateHealth(params.plan.bindingId, params.generation, {
      state: "listening",
      mode: params.listener.mode,
      hint: true,
    });
  };
  const scheduleFlush = (): void => {
    if (flushTask) return;
    flushTask = params.dependencies
      .sleep(HINT_COALESCE_MS, params.signal)
      .then(flush)
      .catch((error) => {
        flushError = error;
        return params.listener.close();
      })
      .finally(() => {
        flushTask = null;
        if (pending.length > 0 && !params.signal.aborted && !flushError) scheduleFlush();
      });
  };

  const fallbackTimer = setInterval(() => {
    if (fallbackTask || params.signal.aborted || flushError) return;
    fallbackTask = applyImapReconciliationHint({
      plan: params.plan,
      assertLeaseActive: params.assertLeaseActive,
      dependencies: params.dependencies,
    })
      .then((applied) => {
        if (applied === "stale") {
          throw Object.assign(new Error("IMAP push binding changed before fallback reconciliation"), {
            code: "IMAP_PUSH_PLAN_CHANGED",
          });
        }
      })
      .catch((error) => {
        flushError = error;
        return params.listener.close();
      })
      .finally(() => {
        fallbackTask = null;
      });
  }, POLL_FALLBACK_MS);

  try {
    for await (const hint of params.listener.hints) {
      if (params.signal.aborted) break;
      if (pending.length >= MAX_PENDING_HINTS) {
        pending = [{ type: "overflow", folderPath: params.plan.folderPath }];
        disconnected = true;
        break;
      }
      pending.push(hint);
      scheduleFlush();
      if (hint.type === "overflow" || hint.type === "disconnected") {
        disconnected = true;
        break;
      }
    }
  } finally {
    clearInterval(fallbackTimer);
    if (fallbackTask) await fallbackTask;
  }
  if (flushTask) await flushTask;
  if (pending.length > 0 && !flushError) await flush();
  if (flushError) throw flushError;
  return { disconnected };
};

const reconnectDelay = (attempt: number): number => Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(Math.max(0, attempt), 6));

export const runImapPushBinding = async (
  initialPlan: ImapPushBindingPlan,
  dependencies: ImapPushRuntimeDependencies,
  signal: AbortSignal,
): Promise<void> => {
  // Start of the last renewal that every lease confirmed. The store set each
  // expiry after this moment, so it is a conservative base for the deadline.
  // A monotonic clock keeps a wall-clock step from moving the deadline.
  let leasesExtendedAt = performance.now();
  const leader = await dependencies.leaderMutex.acquire({ resource: initialPlan.bindingId, ttlMs: LEADER_LEASE_MS });
  if (!leader) return;
  let activeListener: ConnectorChangeListener | null = null;
  let activeMode: ConnectorChangeListenerMode | "none" = "none";
  let activeHealthState: ImapPushHealthState = "starting";
  let activePermit: PermitLease | null = null;
  let generation: number | null = null;
  let failed = false;
  let activeCloseTask: Promise<void> | null = null;
  // Acquiring, extending, and releasing the permit run one at a time: an
  // extension that overlaps a release can make the release fail, and a renewal
  // that overlaps an acquisition would not cover the new permit.
  let permitOperation = Promise.resolve();
  const withPermitOperation = async <T>(operation: () => Promise<T>, abandoned?: AbortSignal): Promise<T> => {
    const previous = permitOperation;
    const next = Promise.withResolvers<void>();
    permitOperation = next.promise;
    // An abandoned extension no longer holds back the release. At worst its
    // late write makes that release fail, and the permit runs out with its TTL.
    abandoned?.addEventListener("abort", () => next.resolve(), { once: true });
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve();
    }
  };
  const acquireActivePermit = (plan: ImapPushBindingPlan): Promise<PermitLease | null> =>
    withPermitOperation(async () => {
      activePermit = await dependencies.permits.acquire(plan);
      return activePermit;
    });
  const extendActivePermit = (abandoned: AbortSignal): Promise<LeaseExtension[]> =>
    withPermitOperation(async () => {
      const permit = activePermit;
      return permit && !abandoned.aborted ? dependencies.permits.extend(permit) : [];
    }, abandoned);
  const releaseActivePermit = (): Promise<void> =>
    withPermitOperation(async () => {
      const permit = activePermit;
      activePermit = null;
      if (permit) await dependencies.permits.release(permit);
    });
  const closeActiveListener = async (): Promise<void> => {
    if (activeCloseTask) return activeCloseTask;
    const listener = activeListener;
    if (!listener) return;
    activeListener = null;
    activeMode = "none";
    activeCloseTask = listener
      .close()
      .catch(() => undefined)
      .finally(() => {
        activeCloseTask = null;
      });
    return activeCloseTask;
  };
  const abortActiveListener = (): void => {
    void closeActiveListener();
  };
  // The health heartbeat runs beside the lease renewal, so a slow Postgres
  // cannot delay an extension; at most one write is in flight.
  let healthWrite: Promise<void> | null = null;
  const recordHeartbeat = (): void => {
    if (healthWrite || generation === null) return;
    healthWrite = dependencies
      .updateHealth(initialPlan.bindingId, generation, { state: activeHealthState, mode: activeMode })
      .catch((error) => {
        log.warn("IMAP push listener health could not be recorded", { bindingId: initialPlan.bindingId, error: errorDetail(error) });
      })
      .finally(() => {
        healthWrite = null;
      });
  };
  // A state change waits for the heartbeat write in flight, which still
  // carries the previous state and must not land after the change.
  const writeHealth = async (patch: ImapPushHealthPatch): Promise<void> => {
    await healthWrite;
    await dependencies.updateHealth(initialPlan.bindingId, generation!, patch);
  };
  const loseLeases = async (lease: string, reason: ImapPushLeaseLoss["reason"], cause?: unknown): Promise<never> => {
    await closeActiveListener();
    const sinceLastExtensionMs = Math.round(performance.now() - leasesExtendedAt);
    throw new ImapPushLeaseLostError({ lease, reason, sinceLastExtensionMs }, cause);
  };
  let pendingLease = "leader";
  const extendLeases = async (abandoned: AbortSignal): Promise<LeaseExtension[]> => {
    pendingLease = "leader";
    const leaderExtension = await extendLock(dependencies.leaderMutex, "leader", leader, LEADER_LEASE_MS);
    if (abandoned.aborted) return [leaderExtension];
    pendingLease = "permit";
    return [leaderExtension, ...(await extendActivePermit(abandoned))];
  };
  /**
   * Extends every lease. A rejection from the store stops the listener at once.
   * A renewal the store did not answer, such as a NATS timeout during a short
   * stall, is retried with backoff until shortly before the last confirmed
   * extension runs out; the listener never runs past that point unconfirmed.
   * Shutdown and settled work stop waiting at once, because the leases are
   * released next.
   */
  const renewLeases = async (workSettled: AbortSignal): Promise<void> => {
    const deadline = leasesExtendedAt + Math.min(LEADER_LEASE_MS, CONNECTION_LEASE_MS) - LEASE_RENEWAL_MARGIN_MS;
    const stopRetrying = AbortSignal.any([signal, workSettled]);
    let unanswered = new Set<string>();
    let failedLease: string | null = null;
    let lastError: unknown;
    for (let attempt = 0; ; attempt += 1) {
      // Shutdown stops the work instead; settled work releases its leases next.
      if (signal.aborted) throw signal.reason;
      if (workSettled.aborted) return;
      const startedAt = performance.now();
      if (startedAt >= deadline) return loseLeases(failedLease ?? "leader", "expired", lastError);
      const extensions = await answerWithin(deadline - startedAt, stopRetrying, extendLeases);
      if (!extensions) {
        if (stopRetrying.aborted) continue;
        return loseLeases(pendingLease, "expired", new Error("The lease store did not answer before the lease ran out"));
      }
      // An extension the store did not answer may still land; a rejection right
      // after it can be that late write, so the lease is reread once before it
      // counts as lost.
      const rejected = extensions.find((extension) => extension.outcome === "rejected" && !unanswered.has(extension.lease));
      if (rejected) return loseLeases(rejected.lease, "rejected", lastError);
      const failed = extensions.filter((extension) => extension.outcome !== "extended");
      if (failed.length === 0) {
        if (failedLease) {
          log.info("IMAP push lease renewal recovered", {
            bindingId: initialPlan.bindingId,
            lease: failedLease,
            attempts: attempt + 1,
            sinceLastExtensionMs: Math.round(startedAt - leasesExtendedAt),
            error: errorDetail(lastError),
          });
        }
        leasesExtendedAt = startedAt;
        recordHeartbeat();
        return;
      }
      unanswered = new Set(failed.filter((extension) => extension.outcome === "failed").map((extension) => extension.lease));
      const first = failed.find((extension) => extension.outcome === "failed") ?? failed[0]!;
      failedLease = first.lease;
      if (first.outcome === "failed") lastError = first.error;
      const delay = Math.min(MAX_RENEWAL_RETRY_DELAY_MS, 500 * 2 ** attempt, Math.max(0, deadline - performance.now()));
      // An aborted wait ends at the stop checks above.
      await sleep(delay, stopRetrying).catch(() => undefined);
    }
  };
  signal.addEventListener("abort", abortActiveListener);
  try {
    generation = await dependencies.claimGeneration(initialPlan);
    await withLeaseHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeat: renewLeases,
      work: async (assertLeaseActive) => {
        let reconnectAttempt = 0;
        while (!signal.aborted) {
          await assertLeaseActive();
          const plan = await dependencies.loadPlan(initialPlan.bindingId);
          if (!samePlan(initialPlan, plan)) return;

          if (!plan.capabilities.idle || !dependencies.listen) {
            activeHealthState = "polling";
            await writeHealth({
              state: "polling",
              mode: "poll",
              reconnectAttempt,
            });
            const applied = await applyImapPushHints({
              expected: plan,
              hints: [{ type: "folder_changed", cause: "exists", folderPath: plan.folderPath, uid: null, modseq: null }],
              assertLeaseActive,
              loadPlan: dependencies.loadPlan,
              enqueueFolder: dependencies.enqueueFolder,
              enqueueReconciliation: dependencies.enqueueReconciliation,
              enqueueRediscovery: dependencies.enqueueRediscovery,
              loadReconnectBudget: dependencies.loadReconnectBudget,
            });
            if (applied === "stale") return;
            await dependencies.sleep(POLL_FALLBACK_MS, signal);
            continue;
          }

          if (!(await acquireActivePermit(plan))) {
            reconnectAttempt += 1;
            activeHealthState = "reconnecting";
            await writeHealth({
              state: "reconnecting",
              mode: "none",
              reconnectAttempt,
            });
            await dependencies.sleep(reconnectDelay(reconnectAttempt), signal);
            continue;
          }

          let connectedAt: number | null = null;
          try {
            const snapshot = await dependencies.loadRuntime(plan.connectionId);
            if (snapshot.secretRevision !== plan.secretRevision) return;
            await assertLeaseActive();
            activeListener = await dependencies.listen(snapshot.runtime, {
              folderPath: plan.folderPath,
              uidValidity: plan.uidValidity,
              highestModseq: plan.capabilities.qresync && plan.capabilities.condstore ? plan.highestModseq : null,
              maxPendingHints: MAX_PENDING_HINTS,
            });
            if (signal.aborted) {
              await closeActiveListener();
              return;
            }
            await dependencies.recordProviderReachable(plan.remoteResourceId);
            activeMode = activeListener.mode;
            await assertLeaseActive();
            if (activeListener.mode === "poll") {
              await closeActiveListener();
              activeHealthState = "polling";
              await writeHealth({
                state: "polling",
                mode: "poll",
                reconnectAttempt,
              });
              const applied = await applyImapPushHints({
                expected: plan,
                hints: [{ type: "folder_changed", cause: "exists", folderPath: plan.folderPath, uid: null, modseq: null }],
                assertLeaseActive,
                loadPlan: dependencies.loadPlan,
                enqueueFolder: dependencies.enqueueFolder,
                enqueueReconciliation: dependencies.enqueueReconciliation,
                enqueueRediscovery: dependencies.enqueueRediscovery,
                loadReconnectBudget: dependencies.loadReconnectBudget,
              });
              if (applied === "stale") return;
              await releaseActivePermit();
              await dependencies.sleep(POLL_FALLBACK_MS, signal);
              continue;
            }
            connectedAt = Date.now();
            activeHealthState = "listening";
            await writeHealth({
              state: "listening",
              mode: activeListener.mode,
              reconnectAttempt,
              connected: true,
              clearError: true,
            });
            const initialReconciliation = await applyImapReconciliationHint({
              plan,
              assertLeaseActive,
              dependencies,
            });
            if (initialReconciliation === "stale") return;
            const completion = await consumeHints({
              listener: activeListener,
              plan,
              generation: generation!,
              signal,
              assertLeaseActive,
              dependencies,
            });
            if (!signal.aborted) {
              throw Object.assign(new Error("IMAP push listener disconnected"), {
                code: "IMAP_PUSH_DISCONNECTED",
                effectsApplied: completion.disconnected,
              });
            }
          } catch (error) {
            if (signal.aborted) return;
            reconnectAttempt = connectedAt !== null && Date.now() - connectedAt >= STABLE_CONNECTION_MS ? 1 : reconnectAttempt + 1;
            activeHealthState = "reconnecting";
            await writeHealth({
              state: "reconnecting",
              mode: activeMode,
              reconnectAttempt,
              error,
            });
            if (!(error && typeof error === "object" && "effectsApplied" in error && error.effectsApplied === true)) {
              const applied = await applyImapPushHints({
                expected: plan,
                hints: [{ type: "disconnected", folderPath: plan.folderPath, reason: "error" }],
                assertLeaseActive,
                loadPlan: dependencies.loadPlan,
                enqueueFolder: dependencies.enqueueFolder,
                enqueueReconciliation: dependencies.enqueueReconciliation,
                enqueueRediscovery: dependencies.enqueueRediscovery,
                loadReconnectBudget: dependencies.loadReconnectBudget,
              });
              if (applied === "stale") return;
            }
          } finally {
            await closeActiveListener();
            await releaseActivePermit();
          }
          await dependencies.sleep(reconnectDelay(reconnectAttempt), signal);
        }
      },
    });
  } catch (error) {
    if (!signal.aborted) {
      failed = true;
      if (generation !== null) {
        await healthWrite;
        // A failing health write must not replace the reason the listener stopped.
        await dependencies
          .updateHealth(initialPlan.bindingId, generation, {
            state: "degraded",
            mode: activeMode,
            error,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", abortActiveListener);
    await closeActiveListener();
    await releaseActivePermit();
    await dependencies.leaderMutex.release(leader).catch(() => undefined);
    await healthWrite;
    if (generation !== null && !failed) {
      await dependencies
        .updateHealth(initialPlan.bindingId, generation, {
          state: "stopped",
          mode: "none",
        })
        .catch(() => undefined);
    }
  }
};

const defaultDependencies: ImapPushRuntimeDependencies = {
  listPlans,
  loadPlan: loadImapPushPlan,
  claimGeneration,
  updateHealth,
  loadRuntime: loadProviderConnectionRuntimeSnapshot,
  listen: imapSmtpConnector.listenForChanges!,
  enqueueFolder: enqueueFolderSync,
  enqueueReconciliation: enqueueFolderReconciliation,
  enqueueRediscovery: enqueueBindingRediscovery,
  loadReconnectBudget,
  recordProviderReachable,
  get leaderMutex() {
    return listenerLeaderMutex();
  },
  get permits() {
    return permits();
  },
  sleep,
};

export const createImapPushRuntime = (
  dependencies: ImapPushRuntimeDependencies = defaultDependencies,
): { start(): Promise<void>; stop(): Promise<void> } => {
  const workers = new Map<string, { controller: AbortController; task: Promise<void>; planFingerprint: string }>();
  let scanTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTask: Promise<void> | null = null;
  let stopping = false;

  const reconcile = async (): Promise<void> => {
    if (reconcileTask) return reconcileTask;
    if (stopping) return;
    reconcileTask = (async () => {
      const plans = await dependencies.listPlans();
      if (stopping) return;
      const current = new Map(plans.map((plan) => [plan.bindingId, plan]));
      for (const [bindingId, worker] of workers) {
        const plan = current.get(bindingId);
        if (plan && worker.planFingerprint === imapPushPlanFingerprint(plan)) continue;
        worker.controller.abort(
          Object.assign(new Error(plan ? "IMAP push binding plan changed" : "IMAP push binding is no longer eligible"), {
            code: plan ? "IMAP_PUSH_PLAN_CHANGED" : "IMAP_PUSH_INELIGIBLE",
          }),
        );
      }
      for (const plan of plans) {
        if (workers.has(plan.bindingId)) continue;
        const controller = new AbortController();
        const task = runImapPushBinding(plan, dependencies, controller.signal)
          .catch((error) => {
            if (!controller.signal.aborted) {
              log.warn("IMAP push listener stopped unexpectedly", {
                bindingId: plan.bindingId,
                ...imapPushFailureFields(error),
              });
            }
          })
          .finally(() => workers.delete(plan.bindingId));
        workers.set(plan.bindingId, { controller, task, planFingerprint: imapPushPlanFingerprint(plan) });
      }
    })().finally(() => {
      reconcileTask = null;
    });
    return reconcileTask;
  };

  const lifecycle = createRuntimeLifecycle({
    start: async () => {
      stopping = false;
      await reconcile();
      scanTimer = setInterval(() => {
        void reconcile().catch((error) => {
          log.warn("IMAP push binding scan failed", { code: providerErrorCode(error, "IMAP_PUSH_SCAN_FAILED") });
        });
      }, SCAN_INTERVAL_MS);
    },
    stop: async () => {
      stopping = true;
      if (scanTimer) clearInterval(scanTimer);
      scanTimer = null;
      if (reconcileTask) await reconcileTask;
      for (const worker of workers.values()) {
        worker.controller.abort(Object.assign(new Error("IMAP push runtime stopped"), { code: "IMAP_PUSH_STOPPED" }));
      }
      await Promise.allSettled([...workers.values()].map((worker) => worker.task));
      workers.clear();
    },
  });
  return { start: lifecycle.start, stop: lifecycle.stop };
};

export const imapPushRuntime = createImapPushRuntime();
