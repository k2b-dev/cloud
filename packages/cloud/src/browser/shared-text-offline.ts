import * as Y from "yjs";
import { compareStreamCursor, parseStreamCursor } from "../shared-text/cursor";

/** Opaque IDs from the authenticated server, never a locally inferred generation. */
export interface SharedTextOfflineIdentity {
  readonly userId: string;
  readonly draftId: string;
  readonly generation: string;
}

export interface SharedTextDurableSnapshot {
  readonly identity: SharedTextOfflineIdentity;
  /** Complete Yjs V1 state read from the application's committed durable store. */
  readonly state: Uint8Array;
  /** Caller attestation: a transport echo or a replay-only read is not durable. */
  readonly durability: "durable";
}

export interface SharedTextOfflineSession {
  /** Aborts on logout, close, or a lost database/channel. Observe it to stop the editor. */
  readonly signal: AbortSignal;
  load(): Promise<Uint8Array | null>;
  /** State and its oldest unconfirmed input base, read in one transaction. */
  loadPending(): Promise<{ state: Uint8Array; baseCursor: string | null } | null>;
  /** Save Y.encodeStateAsUpdate(doc), including unconfirmed edits. Returns the merged tab state. */
  save(state: Uint8Array, baseCursor?: string | null): Promise<Uint8Array>;
  /** True when no saved state remains. Deletes only when the snapshot covers all saved structs AND deletes. */
  acknowledgeSnapshot(snapshot: SharedTextDurableSnapshot): Promise<boolean>;
  /** Explicit discard of this draft generation. Does not revoke other handles; retire the generation server-side. */
  forget(): Promise<void>;
  /** Idempotent; aborts pending operations and releases the database and channel. */
  close(): void;
}

export class SharedTextOfflineLoggedOutError extends Error {
  constructor() {
    super("The shared text offline session was logged out.");
    this.name = "SharedTextOfflineLoggedOutError";
  }
}

const databaseName = "cloud-shared-text-offline";
const channelName = "cloud-shared-text-offline-logout";
const stores = ["users", "drafts"];

const abort = (tx: IDBTransaction) => {
  try {
    tx.abort();
  } catch (error) {
    // An aborted transaction can still be awaiting its abort event.
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
  }
};

const openDatabase = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("users");
      db.createObjectStore("drafts", { keyPath: ["userId", "draftId", "generation"] }).createIndex("userId", "userId");
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Shared text offline database upgrade is blocked. Close older tabs and retry."));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });

/** Discover pending generations from the same store that owns their bytes, never a separate browser marker. */
export const listSharedTextOfflineGenerations = async (
  identity: Pick<SharedTextOfflineIdentity, "userId" | "draftId">,
): Promise<string[]> => {
  const db = await openDatabase();
  try {
    return await transact<string[]>(db, "readonly", (tx, result, read) => {
      const { userId, draftId } = identity;
      // Array-key bounds include every string generation for this exact draft.
      read(tx.objectStore("drafts").getAllKeys(IDBKeyRange.bound([userId, draftId], [userId, draftId, []])), (keys) => {
        result(
          keys.map((key) => {
            if (!Array.isArray(key) || key.length !== 3 || key[0] !== userId || key[1] !== draftId || typeof key[2] !== "string")
              throw new Error("Invalid shared text offline identity.");
            return key[2];
          }),
        );
      });
    });
  } finally {
    db.close();
  }
};

/** All callbacks stay in IDB request events; no asynchronous gap inside a live transaction. */
const transact = <T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction, result: (value: T) => void, read: <V>(request: IDBRequest<V>, next: (value: V) => void) => void) => void,
  active?: Set<IDBTransaction>,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
    active?.add(tx);
    let result: { value: T } | undefined;
    let failure: { error: unknown } | undefined;
    const fail = (error: unknown) => {
      failure = { error };
      abort(tx);
    };
    tx.oncomplete = () => {
      active?.delete(tx);
      if (result) resolve(result.value);
      else reject(new Error("Shared text offline transaction completed without a result."));
    };
    tx.onabort = () => {
      active?.delete(tx);
      reject(failure ? failure.error : (tx.error ?? new DOMException("Shared text offline transaction aborted.", "AbortError")));
    };
    const read = <V>(request: IDBRequest<V>, next: (value: V) => void) => {
      request.onsuccess = () => {
        try {
          next(request.result);
        } catch (error) {
          fail(error);
        }
      };
    };
    try {
      body(
        tx,
        (value) => {
          result = { value };
        },
        read,
      );
    } catch (error) {
      fail(error);
    }
  });

const readEpoch = (value: unknown): number => {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid shared text offline user epoch.");
  return value;
};

const readState = (value: unknown): Uint8Array | null => {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || !("state" in value) || !(value.state instanceof Uint8Array)) {
    throw new Error("Invalid shared text offline draft record.");
  }
  // Do not mistake corrupt storage for an absent draft.
  Y.decodeUpdate(value.state);
  return value.state;
};

const inputBase = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 256 || !parseStreamCursor(value))
    throw new Error("Invalid shared text offline input base.");
  return value;
};
const recordBase = (value: unknown): string | null =>
  inputBase(typeof value === "object" && value !== null && "baseCursor" in value ? value.baseCursor : null);

/**
 * Open only after authentication, with the server's current generation. To avoid
 * remembering this device, the consumer keeps its Y.Doc in memory and never opens
 * this store (and explicitly forgets any earlier persisted state if switching).
 * Storage failures reject; this API never falls back to memory.
 */
export const openSharedTextOffline = async (identity: SharedTextOfflineIdentity): Promise<SharedTextOfflineSession> => {
  const { userId, draftId, generation } = identity;
  const key = [userId, draftId, generation];
  const db = await openDatabase();
  const controller = new AbortController();
  const active = new Set<IDBTransaction>();
  let channel: BroadcastChannel | undefined;
  let epoch: number | undefined;
  let observedLogout = 0;

  const close = (reason: Error) => {
    if (controller.signal.aborted) return;
    for (const tx of active) abort(tx);
    db.close();
    channel?.close();
    controller.abort(reason);
  };
  db.onversionchange = () => close(new Error("Shared text offline database version changed. Reopen the session."));
  db.onclose = () => close(new Error("Shared text offline database connection closed unexpectedly."));

  try {
    channel = new BroadcastChannel(channelName);
    channel.onmessageerror = () => close(new Error("Shared text offline logout notification could not be read."));
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const message = event.data;
      if (
        typeof message === "object" &&
        message !== null &&
        "userId" in message &&
        message.userId === userId &&
        "epoch" in message &&
        typeof message.epoch === "number" &&
        Number.isSafeInteger(message.epoch)
      ) {
        observedLogout = Math.max(observedLogout, message.epoch);
        if (epoch !== undefined && observedLogout > epoch) close(new SharedTextOfflineLoggedOutError());
      }
    };
    epoch = await transact<number>(
      db,
      "readonly",
      (tx, result, read) => {
        read(tx.objectStore("users").get(userId), (value: unknown) => result(readEpoch(value)));
      },
      active,
    );
    if (observedLogout > epoch) throw new SharedTextOfflineLoggedOutError();
    controller.signal.throwIfAborted();
  } catch (error) {
    close(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  const run = async <T>(
    mode: IDBTransactionMode,
    action: (drafts: IDBObjectStore, state: Uint8Array | null, baseCursor: string | null) => T,
    discard = false,
  ): Promise<T> => {
    controller.signal.throwIfAborted();
    try {
      return await transact<T>(
        db,
        mode,
        (tx, result, read) => {
          read(tx.objectStore("users").get(userId), (value: unknown) => {
            // The epoch check and the draft access share one transaction. A delayed
            // save cannot recreate data after logout, even without a broadcast.
            if (readEpoch(value) !== epoch) throw new SharedTextOfflineLoggedOutError();
            const drafts = tx.objectStore("drafts");
            if (discard) result(action(drafts, null, null));
            else read(drafts.get(key), (record: unknown) => result(action(drafts, readState(record), recordBase(record))));
          });
        },
        active,
      );
    } catch (error) {
      if (error instanceof SharedTextOfflineLoggedOutError) close(error);
      throw error;
    }
  };

  return {
    signal: controller.signal,
    load: () => run("readonly", (_drafts, state) => state),
    loadPending: () => run("readonly", (_drafts, state, baseCursor) => (state ? { state, baseCursor } : null)),
    save: async (state, baseCursor = null) => {
      const base = inputBase(baseCursor);
      const input = state.slice();
      Y.decodeUpdate(input);
      return run("readwrite", (drafts, saved, oldBase) => {
        const merged = saved ? Y.mergeUpdates([saved, input]) : input;
        // Preserve the earliest source position across tabs. A newly read server
        // head must never masquerade as the base of older offline input.
        const mergedBase = !saved
          ? base
          : oldBase === null || base === null
            ? null
            : compareStreamCursor(oldBase, base) <= 0
              ? oldBase
              : base;
        drafts.put({ userId, draftId, generation, state: merged, baseCursor: mergedBase });
        return merged;
      });
    },
    acknowledgeSnapshot: async (snapshot) => {
      if (
        snapshot.durability !== "durable" ||
        snapshot.identity.userId !== userId ||
        snapshot.identity.draftId !== draftId ||
        snapshot.identity.generation !== generation
      )
        throw new Error("A durable snapshot for this exact shared text identity is required.");
      const doc = new Y.Doc();
      try {
        const state = snapshot.state.slice();
        Y.applyUpdate(doc, state);
        const coverage = Y.snapshot(doc);
        if (!Y.snapshotContainsUpdate(coverage, state)) throw new Error("The durable snapshot must be complete Yjs state.");
        return await run("readwrite", (drafts, saved) => {
          if (saved && !Y.snapshotContainsUpdate(coverage, saved)) return false;
          drafts.delete(key);
          return true;
        });
      } finally {
        doc.destroy();
      }
    },
    forget: () =>
      run(
        "readwrite",
        (drafts) => {
          drafts.delete(key);
        },
        true,
      ),
    close: () => close(new Error("Shared text offline session is closed.")),
  };
};

/**
 * Erase every draft/generation for this user and fence existing handles in one
 * transaction. Keep the epoch tombstone: deleting it would revalidate old tabs.
 * The consumer must finish logout before opening a freshly authenticated session.
 */
export const logoutSharedTextOffline = async (userId: string): Promise<void> => {
  const db = await openDatabase();
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(channelName);
    const epoch = await transact<number>(db, "readwrite", (tx, result, read) => {
      read(tx.objectStore("users").get(userId), (value: unknown) => {
        const next = readEpoch(value) + 1;
        if (!Number.isSafeInteger(next)) throw new Error("Shared text offline user epoch exhausted.");
        tx.objectStore("users").put(next, userId);
        read(tx.objectStore("drafts").index("userId").openCursor(IDBKeyRange.only(userId)), (cursor) => {
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else result(next);
        });
      });
    });
    channel.postMessage({ userId, epoch });
  } finally {
    channel?.close();
    db.close();
  }
};
