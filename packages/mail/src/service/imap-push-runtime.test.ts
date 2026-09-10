import { describe, expect, test } from "bun:test";
import type { Lock, Mutex } from "@k2b/sync";
import type { ProviderConnectionInput } from "../contracts";
import type { ConnectorChangeHint, ConnectorChangeListener } from "./connectors";
import {
  applyImapPushHints,
  coalesceImapHints,
  createImapPushRuntime,
  FixedImapConnectionPermitPool,
  type ImapPushBindingPlan,
  imapPushPlanFingerprint,
  runImapPushBinding,
} from "./imap-push-runtime";

class FakeMutex implements Mutex {
  readonly #locks = new Map<string, Lock>();
  #fence = 0n;
  extendAllowed = true;

  async ready(): Promise<void> {}

  async acquire({ resource, ttlMs = 60_000 }: { resource: string; ttlMs?: number; signal?: AbortSignal }): Promise<Lock | null> {
    if (this.#locks.has(resource)) return null;
    const lock = { resource, ownerToken: crypto.randomUUID(), fence: ++this.#fence, expiresAt: new Date(Date.now() + ttlMs) };
    this.#locks.set(resource, lock);
    return lock;
  }

  async release(lock: Lock): Promise<boolean> {
    if (this.#locks.get(lock.resource)?.ownerToken !== lock.ownerToken) return false;
    return this.#locks.delete(lock.resource);
  }

  async extend(lock: Lock, { ttlMs = 60_000 }: { ttlMs?: number } = {}): Promise<boolean> {
    if (!this.extendAllowed || this.#locks.get(lock.resource)?.ownerToken !== lock.ownerToken) return false;
    lock.expiresAt = new Date(Date.now() + ttlMs);
    return true;
  }

  async withLock<T>(input: { resource: string; ttlMs?: number; signal?: AbortSignal }, fn: (lock: Lock) => Promise<T>): Promise<T | null> {
    const lock = await this.acquire(input);
    if (!lock) return null;
    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }
}

const plan: ImapPushBindingPlan = {
  bindingId: "00000000-0000-4000-8000-000000000001",
  mailboxId: "00000000-0000-4000-8000-000000000002",
  connectionId: "00000000-0000-4000-8000-000000000003",
  secretRevision: 3,
  imapHost: "mail.example.test",
  folderId: "00000000-0000-4000-8000-000000000004",
  folderPath: "INBOX",
  uidValidity: "7",
  highestModseq: "42",
  capabilities: { idle: true, condstore: true, qresync: true, notify: false },
};

const runtimeConfig: ProviderConnectionInput = {
  name: "Example",
  email: "mail@example.test",
  username: "mail@example.test",
  imap: { host: "mail.example.test", port: 993, tlsMode: "implicit" },
  smtp: { host: "mail.example.test", port: 465, tlsMode: "implicit" },
  secret: { kind: "password", password: "secret" },
};

describe("IMAP push runtime", () => {
  test("coalesces duplicate hints and escalates uncertain streams to rediscovery", () => {
    const hints: ConnectorChangeHint[] = [
      { type: "folder_changed", cause: "exists", folderPath: "INBOX", uid: null, modseq: null },
      { type: "folder_changed", cause: "flags", folderPath: "INBOX", uid: 2, modseq: "43" },
      { type: "overflow", folderPath: "INBOX" },
    ];
    expect(coalesceImapHints(hints)).toEqual({ folderChanged: true, reconcileFromUid: 1, rediscover: true });
  });

  test("spends the reconcile and rediscovery budget at most once per interval on a flapping connection", () => {
    const hints: ConnectorChangeHint[] = [{ type: "disconnected", folderPath: "INBOX", reason: "closed" }];
    const now = Date.now();
    expect(
      coalesceImapHints(hints, { lastDiscoveryAt: now - 60_000, lastFullReconcileAt: now - 60 * 60_000, fullReconcilePending: false }, now),
    ).toEqual({
      folderChanged: true,
      reconcileFromUid: null,
      rediscover: false,
    });
    expect(
      coalesceImapHints(
        hints,
        { lastDiscoveryAt: now - 16 * 60_000, lastFullReconcileAt: now - 7 * 60 * 60_000, fullReconcilePending: false },
        now,
      ),
    ).toEqual({
      folderChanged: true,
      reconcileFromUid: 1,
      rediscover: true,
    });
    // A walk the folder sync has not finished is not restarted from UID 1.
    expect(coalesceImapHints(hints, { lastDiscoveryAt: now, lastFullReconcileAt: null, fullReconcilePending: true }, now)).toEqual({
      folderChanged: true,
      reconcileFromUid: null,
      rediscover: false,
    });
    // Explicit VANISHED evidence still reconciles from the smallest UID, and a
    // changed UIDVALIDITY still rediscovers, regardless of the budget.
    expect(
      coalesceImapHints(
        [
          ...hints,
          { type: "folder_changed", cause: "vanished", folderPath: "INBOX", uid: 9_100, modseq: null },
          { type: "folder_changed", cause: "vanished", folderPath: "INBOX", uid: 9_004, modseq: null },
          { type: "folder_changed", cause: "uidvalidity_changed", folderPath: "INBOX", uid: null, modseq: null },
        ],
        { lastDiscoveryAt: now, lastFullReconcileAt: now, fullReconcilePending: false },
        now,
      ),
    ).toEqual({ folderChanged: true, reconcileFromUid: 9_004, rediscover: true });
  });

  test("does not rediscover a reconnect within the regular discovery interval", async () => {
    const calls: string[] = [];
    const now = Date.now();
    const applied = await applyImapPushHints({
      expected: plan,
      hints: [{ type: "disconnected", folderPath: "INBOX", reason: "error" }],
      assertLeaseActive: async () => undefined,
      loadPlan: async () => plan,
      enqueueFolder: async (folderId) => {
        calls.push(`folder:${folderId}`);
      },
      enqueueReconciliation: async (_folderId, fromUid) => {
        calls.push(`reconcile:${fromUid}`);
      },
      enqueueRediscovery: async () => {
        calls.push("rediscovery");
      },
      loadReconnectBudget: async () => ({
        lastDiscoveryAt: now - 5 * 60_000,
        lastFullReconcileAt: now - 60_000,
        fullReconcilePending: false,
      }),
    });
    expect(applied).toBe("applied");
    expect(calls).toEqual([`folder:${plan.folderId}`]);
  });

  test("starts targeted UID reconciliation for VANISHED hints", async () => {
    const calls: string[] = [];
    const applied = await applyImapPushHints({
      expected: plan,
      hints: [
        { type: "folder_changed", cause: "vanished", folderPath: "INBOX", uid: 7_501, modseq: "44" },
        { type: "folder_changed", cause: "vanished", folderPath: "INBOX", uid: 6_001, modseq: "45" },
      ],
      assertLeaseActive: async () => {
        calls.push("lease");
      },
      loadPlan: async () => plan,
      enqueueFolder: async () => {
        calls.push("folder");
      },
      enqueueReconciliation: async (_folderId, fromUid) => {
        calls.push(`reconcile:${fromUid}`);
      },
      enqueueRediscovery: async () => {
        calls.push("rediscovery");
      },
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
    });
    expect(applied).toBe("applied");
    expect(calls).toEqual(["lease", "lease", "reconcile:6001", "lease", "lease"]);
  });

  test("fingerprints every listener-relevant plan field", () => {
    const original = imapPushPlanFingerprint(plan);
    expect(imapPushPlanFingerprint({ ...plan, mailboxId: "00000000-0000-4000-8000-000000000099" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, connectionId: "00000000-0000-4000-8000-000000000099" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, secretRevision: 4 })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, imapHost: "other.example.test" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, folderId: "00000000-0000-4000-8000-000000000099" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, folderPath: "Other" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, uidValidity: "8" })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, capabilities: { ...plan.capabilities, idle: false } })).not.toBe(original);
    expect(imapPushPlanFingerprint({ ...plan, highestModseq: "43" })).toBe(original);
  });

  test("rechecks the complete binding plan before delayed effects", async () => {
    const calls: string[] = [];
    const applied = await applyImapPushHints({
      expected: plan,
      hints: [{ type: "folder_changed", cause: "exists", folderPath: "INBOX", uid: null, modseq: null }],
      assertLeaseActive: async () => {
        calls.push("lease");
      },
      loadPlan: async () => ({ ...plan, secretRevision: plan.secretRevision + 1 }),
      enqueueFolder: async () => {
        calls.push("folder");
      },
      enqueueReconciliation: async () => {
        calls.push("reconciliation");
      },
      enqueueRediscovery: async () => {
        calls.push("rediscovery");
      },
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
    });
    expect(applied).toBe("stale");
    expect(calls).toEqual(["lease"]);
  });

  test("bounds distributed global, host, and mailbox connection slots", async () => {
    const transport = new FakeMutex();
    const pool = new FixedImapConnectionPermitPool(transport, { global: 1, host: 1, mailbox: 1 });
    const first = await pool.acquire(plan);
    expect(first).not.toBeNull();
    expect(await pool.acquire({ ...plan, mailboxId: "00000000-0000-4000-8000-000000000099" })).toBeNull();
    await pool.release(first!);
    const afterRelease = await pool.acquire({ ...plan, mailboxId: "00000000-0000-4000-8000-000000000099" });
    expect(afterRelease).not.toBeNull();
    await pool.release(afterRelease!);
  });

  test("fails closed before opening a provider socket when the elected lease is lost", async () => {
    const leader = new FakeMutex();
    leader.extendAllowed = false;
    let listenCalls = 0;
    const health: string[] = [];
    const dependencies = {
      listPlans: async () => [plan],
      loadPlan: async () => plan,
      claimGeneration: async () => 1,
      updateHealth: async (_bindingId: string, _generation: number, patch: { state: string }) => {
        health.push(patch.state);
      },
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: plan.secretRevision,
      }),
      listen: async (): Promise<ConnectorChangeListener> => {
        listenCalls += 1;
        throw new Error("must not connect");
      },
      enqueueFolder: async () => undefined,
      enqueueReconciliation: async () => undefined,
      enqueueRediscovery: async () => undefined,
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: leader,
      permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
      sleep: async () => undefined,
    };
    await expect(runImapPushBinding(plan, dependencies, new AbortController().signal)).rejects.toThrow("IMAP push listener lease was lost");
    expect(listenCalls).toBe(0);
    expect(health).toContain("degraded");
    expect(health.at(-1)).toBe("degraded");
  });

  test("uses bounded polling without allocating a provider connection when IDLE is unavailable", async () => {
    const pollingPlan = { ...plan, capabilities: { ...plan.capabilities, idle: false } };
    const controller = new AbortController();
    let folderEnqueues = 0;
    let permitAcquires = 0;
    const dependencies = {
      listPlans: async () => [pollingPlan],
      loadPlan: async () => pollingPlan,
      claimGeneration: async () => 1,
      updateHealth: async () => undefined,
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: pollingPlan.secretRevision,
      }),
      listen: async () => {
        throw new Error("must not listen");
      },
      enqueueFolder: async () => {
        folderEnqueues += 1;
        controller.abort(new Error("test complete"));
      },
      enqueueReconciliation: async () => undefined,
      enqueueRediscovery: async () => undefined,
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: new FakeMutex(),
      permits: {
        acquire: async () => {
          permitAcquires += 1;
          return null;
        },
        extend: async () => true,
        release: async () => undefined,
      },
      sleep: async (_ms: number, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    await runImapPushBinding(pollingPlan, dependencies, controller.signal);
    expect(folderEnqueues).toBe(1);
    expect(permitAcquires).toBe(0);
  });

  test("turns disconnects into durable sync and rediscovery work before reconnecting", async () => {
    const controller = new AbortController();
    let listenerClosed = 0;
    let folderEnqueues = 0;
    let reconciliationEnqueues = 0;
    let rediscoveryEnqueues = 0;
    const listener: ConnectorChangeListener = {
      mode: "idle",
      hints: {
        async *[Symbol.asyncIterator]() {
          yield { type: "disconnected", folderPath: "INBOX", reason: "closed" } as const;
        },
      },
      close: async () => {
        listenerClosed += 1;
      },
    };
    const dependencies = {
      listPlans: async () => [plan],
      loadPlan: async () => plan,
      claimGeneration: async () => 1,
      updateHealth: async () => undefined,
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: plan.secretRevision,
      }),
      listen: async () => listener,
      enqueueFolder: async () => {
        folderEnqueues += 1;
      },
      enqueueReconciliation: async () => {
        reconciliationEnqueues += 1;
      },
      enqueueRediscovery: async () => {
        rediscoveryEnqueues += 1;
        controller.abort(new Error("test complete"));
      },
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: new FakeMutex(),
      permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
      sleep: async (_ms: number, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
      },
    };
    await runImapPushBinding(plan, dependencies, controller.signal);
    expect(folderEnqueues).toBe(1);
    expect(reconciliationEnqueues).toBe(1);
    expect(rediscoveryEnqueues).toBe(1);
    expect(listenerClosed).toBeGreaterThan(0);
  });

  test("increases reconnect backoff across repeatedly unstable listeners", async () => {
    const controller = new AbortController();
    const reconnectAttempts: number[] = [];
    let listenCalls = 0;
    await runImapPushBinding(
      plan,
      {
        listPlans: async () => [plan],
        loadPlan: async () => plan,
        claimGeneration: async () => 1,
        updateHealth: async (_bindingId, _generation, patch) => {
          if (patch.state === "reconnecting" && patch.reconnectAttempt !== undefined) {
            reconnectAttempts.push(patch.reconnectAttempt);
          }
        },
        loadRuntime: async () => ({
          runtime: runtimeConfig,
          secretRevision: plan.secretRevision,
        }),
        listen: async () => {
          listenCalls += 1;
          if (listenCalls === 3) controller.abort(new Error("test complete"));
          return {
            mode: "idle",
            hints: {
              async *[Symbol.asyncIterator]() {
                yield { type: "disconnected", folderPath: "INBOX", reason: "closed" } as const;
              },
            },
            close: async () => undefined,
          };
        },
        enqueueFolder: async () => undefined,
        enqueueReconciliation: async () => undefined,
        enqueueRediscovery: async () => undefined,
        loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
        leaderMutex: new FakeMutex(),
        permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
        sleep: async (_ms: number, signal: AbortSignal) => {
          if (signal.aborted) throw signal.reason;
        },
      },
      controller.signal,
    );
    expect(reconnectAttempts).toEqual([1, 2]);
  });

  test("can start and stop repeatedly without retaining workers", async () => {
    let scans = 0;
    const runtime = createImapPushRuntime({
      listPlans: async () => {
        scans += 1;
        return [];
      },
      loadPlan: async () => null,
      claimGeneration: async () => 1,
      updateHealth: async () => undefined,
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: plan.secretRevision,
      }),
      listen: async () => {
        throw new Error("must not listen");
      },
      enqueueFolder: async () => undefined,
      enqueueReconciliation: async () => undefined,
      enqueueRediscovery: async () => undefined,
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: new FakeMutex(),
      permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
      sleep: async () => undefined,
    });
    await runtime.start();
    await runtime.stop();
    await runtime.start();
    await runtime.stop();
    expect(scans).toBe(2);
  });

  test("closes a blocked IDLE listener during runtime shutdown", async () => {
    let releaseIterator: ((value: IteratorResult<ConnectorChangeHint>) => void) | null = null;
    let listenerReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      listenerReady = resolve;
    });
    let closeCalls = 0;
    const runtime = createImapPushRuntime({
      listPlans: async () => [plan],
      loadPlan: async () => plan,
      claimGeneration: async () => 1,
      updateHealth: async () => undefined,
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: plan.secretRevision,
      }),
      listen: async () => {
        listenerReady?.();
        return {
          mode: "idle",
          hints: {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise<IteratorResult<ConnectorChangeHint>>((resolve) => {
                    releaseIterator = resolve;
                  }),
              };
            },
          },
          close: async () => {
            closeCalls += 1;
            releaseIterator?.({ done: true, value: undefined });
          },
        };
      },
      enqueueFolder: async () => undefined,
      enqueueReconciliation: async () => undefined,
      enqueueRediscovery: async () => undefined,
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: new FakeMutex(),
      permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
      sleep: async (_ms: number, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
      },
    });

    await runtime.start();
    await ready;
    await runtime.stop();
    expect(closeCalls).toBeGreaterThan(0);
  });

  test("waits for listener shutdown before releasing distributed permits", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let releaseIterator: ((value: IteratorResult<ConnectorChangeHint>) => void) | null = null;
    const closeGate = Promise.withResolvers<void>();
    const listenerReady = Promise.withResolvers<void>();
    const task = runImapPushBinding(
      plan,
      {
        listPlans: async () => [plan],
        loadPlan: async () => plan,
        claimGeneration: async () => 1,
        updateHealth: async () => undefined,
        loadRuntime: async () => ({
          runtime: runtimeConfig,
          secretRevision: plan.secretRevision,
        }),
        listen: async () => {
          listenerReady.resolve();
          return {
            mode: "idle",
            hints: {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    new Promise<IteratorResult<ConnectorChangeHint>>((resolve) => {
                      releaseIterator = resolve;
                    }),
                };
              },
            },
            close: async () => {
              events.push("close-started");
              await closeGate.promise;
              releaseIterator?.({ done: true, value: undefined });
              events.push("close-finished");
            },
          };
        },
        enqueueFolder: async () => undefined,
        enqueueReconciliation: async () => undefined,
        enqueueRediscovery: async () => undefined,
        loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
        leaderMutex: new FakeMutex(),
        permits: {
          acquire: async () => ({ locks: [] }),
          extend: async () => true,
          release: async () => {
            events.push("permit-released");
          },
        },
        sleep: async (_ms: number, signal: AbortSignal) => {
          if (signal.aborted) throw signal.reason;
        },
      },
      controller.signal,
    );
    await listenerReady.promise;
    controller.abort(new Error("test shutdown"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["close-started"]);
    closeGate.resolve();
    await task;
    expect(events).toEqual(["close-started", "close-finished", "permit-released"]);
  });

  test("does not start workers from a scan that finishes after shutdown begins", async () => {
    const plans = Promise.withResolvers<ImapPushBindingPlan[]>();
    let listenCalls = 0;
    const runtime = createImapPushRuntime({
      listPlans: () => plans.promise,
      loadPlan: async () => plan,
      claimGeneration: async () => 1,
      updateHealth: async () => undefined,
      loadRuntime: async () => ({
        runtime: runtimeConfig,
        secretRevision: plan.secretRevision,
      }),
      listen: async () => {
        listenCalls += 1;
        throw new Error("must not listen");
      },
      enqueueFolder: async () => undefined,
      enqueueReconciliation: async () => undefined,
      enqueueRediscovery: async () => undefined,
      loadReconnectBudget: async () => ({ lastDiscoveryAt: null, lastFullReconcileAt: null, fullReconcilePending: false }),
      leaderMutex: new FakeMutex(),
      permits: new FixedImapConnectionPermitPool(new FakeMutex(), { global: 1, host: 1, mailbox: 1 }),
      sleep: async () => undefined,
    });
    const start = runtime.start();
    const stop = runtime.stop();
    plans.resolve([plan]);
    await Promise.all([start, stop]);
    expect(listenCalls).toBe(0);
  });
});
