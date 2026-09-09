import type { Lock, Mutex } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { createRuntimeLifecycle, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { parseConnectorCapabilities } from "../contracts";
import { sha256Json } from "./canonical";
import type { ConnectorChangeHint, ConnectorChangeListener, ConnectorChangeListenerMode } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { providerErrorCode, providerErrorMessage } from "./provider-errors";
import { enqueueBindingRediscovery, enqueueFolderReconciliation, enqueueFolderSync } from "./sync-runtime";

const log = logger("mail:imap-push");

const LEADER_LEASE_MS = 60_000;
const CONNECTION_LEASE_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const SCAN_INTERVAL_MS = 15_000;
const HINT_COALESCE_MS = 200;
const POLL_FALLBACK_MS = 30_000;
const MAX_PENDING_HINTS = 128;
const MAX_RECONNECT_DELAY_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;

export type ImapPushBindingPlan = {
  bindingId: string;
  mailboxId: string;
  connectionId: string;
  secretRevision: number;
  oauthTokenRevision: number;
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
  locks: Lock[];
};

type PermitPool = {
  acquire(plan: Pick<ImapPushBindingPlan, "imapHost" | "mailboxId">): Promise<PermitLease | null>;
  extend(lease: PermitLease): Promise<boolean>;
  release(lease: PermitLease): Promise<void>;
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
    const locks: Lock[] = [];
    try {
      const global = await acquireSlot(this.#transport, "global", this.#globalLimit);
      if (!global) return null;
      locks.push(global);
      const hostKey = sha256Json(plan.imapHost.trim().toLowerCase());
      const host = await acquireSlot(this.#transport, `host:${hostKey}`, this.#hostLimit);
      if (!host) return null;
      locks.push(host);
      const mailbox = await acquireSlot(this.#transport, `mailbox:${plan.mailboxId}`, this.#mailboxLimit);
      if (!mailbox) return null;
      locks.push(mailbox);
      return { locks };
    } finally {
      if (locks.length < 3) {
        await Promise.all(locks.map((lock) => this.#transport.release(lock).catch(() => undefined)));
      }
    }
  }

  async extend(lease: PermitLease): Promise<boolean> {
    const extended = await Promise.all(
      lease.locks.map((lock) => this.#transport.extend(lock, { ttlMs: CONNECTION_LEASE_MS }).catch(() => false)),
    );
    return extended.every(Boolean);
  }

  async release(lease: PermitLease): Promise<void> {
    await Promise.all(lease.locks.map((lock) => this.#transport.release(lock).catch(() => undefined)));
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
      connection_id: string;
      secret_revision: number;
      oauth_token_revision: string | number;
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
      connection.id AS connection_id,
      connection.secret_revision,
      connection.oauth_token_revision,
      connection.imap_host,
      binding.capabilities,
      selected_folder.folder_id,
      selected_folder.remote_path,
      selected_folder.uid_validity,
      selected_folder.highest_modseq
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource
      ON resource.id = binding.remote_resource_id
     AND resource.status = 'active'
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
    connectionId: row.connection_id,
    secretRevision: row.secret_revision,
    oauthTokenRevision: Number(row.oauth_token_revision),
    imapHost: row.imap_host,
    folderId: row.folder_id,
    folderPath: row.remote_path,
    uidValidity: String(row.uid_validity),
    highestModseq: row.highest_modseq == null ? null : String(row.highest_modseq),
    capabilities: parseCapabilities(row.capabilities),
  }));
};

const listPlans = async (): Promise<ImapPushBindingPlan[]> => queryPlans(null);

const loadPlan = async (bindingId: string): Promise<ImapPushBindingPlan | null> => (await queryPlans(bindingId))[0] ?? null;

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
    oauthTokenRevision: plan.oauthTokenRevision,
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

export const coalesceImapHints = (hints: readonly ConnectorChangeHint[]): CoalescedImapHints => {
  const uncertain = hints.some((hint) => hint.type === "overflow" || hint.type === "disconnected");
  const vanishedUids = hints.flatMap((hint) =>
    hint.type === "folder_changed" && hint.cause === "vanished" && hint.uid != null ? [hint.uid] : [],
  );
  return {
    folderChanged: hints.some((hint) => hint.type === "folder_changed" || hint.type === "overflow" || hint.type === "disconnected"),
    reconcileFromUid: uncertain ? 1 : vanishedUids.length > 0 ? Math.min(...vanishedUids) : null,
    rediscover: hints.some(
      (hint) =>
        hint.type === "overflow" ||
        hint.type === "disconnected" ||
        (hint.type === "folder_changed" && hint.cause === "uidvalidity_changed"),
    ),
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
}): Promise<"applied" | "stale"> => {
  const batch = coalesceImapHints(params.hints);
  if (!batch.folderChanged && !batch.rediscover) return "applied";
  await params.assertLeaseActive();
  const current = await params.loadPlan(params.expected.bindingId);
  if (!samePlan(params.expected, current)) return "stale";
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
  const leader = await dependencies.leaderMutex.acquire({ resource: initialPlan.bindingId, ttlMs: LEADER_LEASE_MS });
  if (!leader) return;
  let activeListener: ConnectorChangeListener | null = null;
  let activeMode: ConnectorChangeListenerMode | "none" = "none";
  let activeHealthState: ImapPushHealthState = "starting";
  let activePermit: PermitLease | null = null;
  let generation: number | null = null;
  let failed = false;
  let activeCloseTask: Promise<void> | null = null;
  let permitOperation = Promise.resolve();
  const withPermitOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = permitOperation;
    const next = Promise.withResolvers<void>();
    permitOperation = next.promise;
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve();
    }
  };
  const extendActivePermit = (): Promise<boolean> =>
    withPermitOperation(async () => {
      const permit = activePermit;
      return permit ? dependencies.permits.extend(permit) : true;
    });
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
  signal.addEventListener("abort", abortActiveListener);
  try {
    generation = await dependencies.claimGeneration(initialPlan);
    await withLeaseHeartbeat({
      intervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeat: async () => {
        const leaderActive = await dependencies.leaderMutex.extend(leader, { ttlMs: LEADER_LEASE_MS });
        const permitsActive = await extendActivePermit();
        if (!leaderActive || !permitsActive) {
          await closeActiveListener();
          throw Object.assign(new Error("IMAP push listener lease was lost"), { code: "IMAP_PUSH_LEASE_LOST" });
        }
        await dependencies.updateHealth(initialPlan.bindingId, generation!, {
          state: activeHealthState,
          mode: activeMode,
        });
      },
      work: async (assertLeaseActive) => {
        let reconnectAttempt = 0;
        while (!signal.aborted) {
          await assertLeaseActive();
          const plan = await dependencies.loadPlan(initialPlan.bindingId);
          if (!samePlan(initialPlan, plan)) return;

          if (!plan.capabilities.idle || !dependencies.listen) {
            activeHealthState = "polling";
            await dependencies.updateHealth(plan.bindingId, generation!, {
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
            });
            if (applied === "stale") return;
            await dependencies.sleep(POLL_FALLBACK_MS, signal);
            continue;
          }

          activePermit = await dependencies.permits.acquire(plan);
          if (!activePermit) {
            reconnectAttempt += 1;
            activeHealthState = "reconnecting";
            await dependencies.updateHealth(plan.bindingId, generation!, {
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
            if (snapshot.secretRevision !== plan.secretRevision || snapshot.oauthTokenRevision !== plan.oauthTokenRevision) return;
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
            activeMode = activeListener.mode;
            await assertLeaseActive();
            if (activeListener.mode === "poll") {
              await closeActiveListener();
              activeHealthState = "polling";
              await dependencies.updateHealth(plan.bindingId, generation!, {
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
              });
              if (applied === "stale") return;
              await releaseActivePermit();
              await dependencies.sleep(POLL_FALLBACK_MS, signal);
              continue;
            }
            connectedAt = Date.now();
            activeHealthState = "listening";
            await dependencies.updateHealth(plan.bindingId, generation!, {
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
            await dependencies.updateHealth(plan.bindingId, generation!, {
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
      if (generation !== null)
        await dependencies.updateHealth(initialPlan.bindingId, generation, {
          state: "degraded",
          mode: activeMode,
          error,
        });
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", abortActiveListener);
    await closeActiveListener();
    await releaseActivePermit();
    await dependencies.leaderMutex.release(leader).catch(() => undefined);
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
  loadPlan,
  claimGeneration,
  updateHealth,
  loadRuntime: loadProviderConnectionRuntimeSnapshot,
  listen: imapSmtpConnector.listenForChanges!,
  enqueueFolder: enqueueFolderSync,
  enqueueReconciliation: enqueueFolderReconciliation,
  enqueueRediscovery: enqueueBindingRediscovery,
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
                code: providerErrorCode(error, "IMAP_PUSH_FAILED"),
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
