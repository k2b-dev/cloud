import {
  listSharedTextOfflineGenerations,
  openAuthorizedSharedTextOffline,
  SharedTextOfflineLoggedOutError,
  type SharedTextOfflineSession,
  type SharedTextProviderPendingState,
} from "@k2b/cloud/browser/shared-text";
import { encoding } from "@k2b/stdlib";
import * as Y from "yjs";
import { apiClient } from "../../../api/client";
import { noteDocumentSessionSchema, noteGenerationSchema } from "../../../lib/document-session";
import { createYjsProvider, type YjsProviderOptions } from "./provider";

export type NotebookDeviceState = {
  pending: boolean;
  saved: boolean;
  failed: boolean;
  recovery: boolean;
};

export type NotebookDocumentClient = {
  provider: ReturnType<typeof createYjsProvider>;
  recovery: boolean;
  pending: boolean;
  refresh(signal: AbortSignal): Promise<void>;
  retry(): Promise<void>;
  discard(): Promise<void>;
  flush(): Promise<boolean>;
  dispose(): void;
};

export class NotebookAuthorizationError extends Error {
  constructor(readonly status: number) {
    super(`Notebook authorization failed (${status})`);
  }
}

/** Device persistence and durable receipts for the actual Notebook wire provider. */
export async function openNotebookDocument(
  options: Omit<YjsProviderOptions, "initialPending" | "initialCursor" | "initialRestoreRevision"> & {
    recoveryOnly?: boolean;
    /** Explicit tab-only editing never opens or reads IndexedDB. */
    memoryOnly?: boolean;
    notebookId: string;
    userId: string;
    signal: AbortSignal;
    onDeviceState: (state: NotebookDeviceState) => void;
  },
): Promise<NotebookDocumentClient> {
  const draftId = `notebooks:${options.noteId}`;
  const generations = options.memoryOnly ? [] : await listSharedTextOfflineGenerations({ userId: options.userId, draftId });
  const previous = generations
    .map((value) => noteGenerationSchema.parse(value))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))[0];
  let generation: string | undefined;
  // The first request discovers the current server generation; it never reads device bytes.
  const read = async (signal: AbortSignal) => {
    const response = await apiClient[":id"].notes[":noteId"].document
      .$get(
        {
          param: { id: options.notebookId, noteId: options.noteId },
          query: { expectedUserId: options.userId, generation },
        },
        { init: { cache: "no-store", signal } },
      )
      .catch((error: unknown) => {
        if (error instanceof TypeError) throw new NotebookAuthorizationError(0);
        throw error;
      });
    if (!response.ok) throw new NotebookAuthorizationError(response.status);
    return noteDocumentSessionSchema.parse(await response.json());
  };
  const current = await read(options.signal);
  const identity = { userId: options.userId, draftId, generation: previous ?? current.generation };
  generation = identity.generation;
  const opened = options.memoryOnly
    ? { authorization: current, session: undefined, state: null, baseCursor: null }
    : await openAuthorizedSharedTextOffline(identity, read, options.signal);
  let offline: SharedTextOfflineSession | undefined = opened.session;
  const authorization = opened.authorization;
  // A pending record can already be covered by the committed row (e.g. the tab closed
  // between snapshot commit and receipt). Clear it before deciding whether recovery is needed.
  let restored = opened.state;
  try {
    if (
      restored &&
      authorization.generation === identity.generation &&
      (await offline?.acknowledgeSnapshot({ identity, state: encoding.fromBase64(authorization.durable.state), durability: "durable" }))
    )
      restored = null;
  } catch (error) {
    offline?.close();
    throw error;
  }
  let restoredText = "";
  if (restored) {
    const pending = new Y.Doc();
    try {
      Y.applyUpdate(pending, restored);
      restoredText = pending.getText("codemirror").toString();
    } finally {
      pending.destroy();
    }
  }
  const state: NotebookDeviceState = {
    pending: restored !== null,
    saved: restored !== null,
    failed: false,
    recovery: !!restored && (options.recoveryOnly || authorization.mode === "recovery" || authorization.locked),
  };
  let disposed = false;
  let queue = Promise.resolve();
  let latest: { bytes: Uint8Array; base: string | null } | null = null;
  let lastInput = restored ? { bytes: restored, base: opened.baseCursor } : null;
  let running = false;
  let version = 0;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const emit = () => {
    if (!disposed) options.onDeviceState({ ...state });
  };
  const fail = () => {
    state.failed = true;
    state.saved = false;
    emit();
  };
  const pump = () => {
    const store = offline;
    if (running || !store || store.signal.aborted) return;
    running = true;
    queue = (async () => {
      while (latest) {
        const input = latest;
        const captured = version;
        // Keep failed input available for retry; a newer full state covers it.
        await store.save(input.bytes, input.base);
        if (captured === version) {
          latest = null;
          state.saved = true;
        }
        state.failed = false;
        emit();
      }
    })()
      .catch(fail)
      .finally(() => {
        running = false;
      });
  };
  const save = (pending: SharedTextProviderPendingState) => {
    if (!offline) return;
    version++;
    state.pending = true;
    state.saved = false;
    latest = { bytes: pending.state, base: pending.baseCursor ?? null };
    lastInput = latest;
    emit();
    pump();
  };
  const acknowledge = async (bytes: Uint8Array) => {
    // Serial ordering prevents a receipt racing ahead of the local write it covers.
    await queue;
    if (!offline || latest || offline.signal.aborted) return;
    const captured = version;
    const covered = await offline?.acknowledgeSnapshot({ identity, state: bytes, durability: "durable" });
    if (covered && captured === version && !latest) {
      state.pending = false;
      state.failed = false;
      emit();
    }
  };
  const scheduleReceipt = () => {
    if (offline && !receiptTimer && !disposed && state.pending && !state.recovery && !offline.signal.aborted)
      receiptTimer = setTimeout(() => {
        receiptTimer = undefined;
        void checkDurable();
      }, 8_000);
  };
  const checkDurable = async () => {
    if (!offline || checking || disposed || !state.pending || state.recovery || offline.signal.aborted) return;
    if (provider?.hasUnsentChanges()) {
      scheduleReceipt();
      return;
    }
    checking = true;
    try {
      const stored = await read(offline.signal);
      if (stored.generation === identity.generation) await acknowledge(encoding.fromBase64(stored.durable.state));
    } catch (error) {
      // A changed account/access must stop publication too, and remain visible.
      stopForAccess(error);
      // The full device state remains pending; network failure is not a storage receipt.
    } finally {
      checking = false;
      // Match the Notebook snapshot cadence; only pending documents poll, never disposed/ended sessions.
      scheduleReceipt();
    }
  };
  let provider: ReturnType<typeof createYjsProvider> | undefined;
  const stopForAccess = (error: unknown) => {
    if (error instanceof NotebookAuthorizationError && (error.status === 403 || error.status === 404)) {
      provider?.dispose();
      state.recovery = state.pending;
      emit();
      options.onFatal?.({ code: error.status === 403 ? "ACCESS_DENIED" : "NOTE_NOT_FOUND", message: error.message });
    }
  };
  const aborted = () => {
    if (disposed) return;
    fail();
    // IDB may close independently of authentication (Safari backgrounding/versionchange).
    // Keep the server path alive; retry opens storage again and saves the latest full state.
    if (offline?.signal.reason instanceof SharedTextOfflineLoggedOutError) {
      provider?.dispose();
      options.onFatal?.({ code: "SESSION_EXPIRED", message: "Device storage signed out" });
    }
  };
  try {
    options.signal.throwIfAborted();
    offline?.signal.throwIfAborted();
    // Never merge a restored generation into old local identities. Keep that exact input visible instead.
    if (!state.recovery) Y.applyUpdate(options.doc, encoding.fromBase64(authorization.durable.state), "remote");
    if (restored) Y.applyUpdate(options.doc, restored, "remote");
    if (identity.generation !== authorization.generation && !restored) {
      offline?.close();
      return openNotebookDocument(options);
    }
    provider = createYjsProvider({
      ...options,
      expectedUserId: options.userId,
      initialRestoreRevision: identity.generation,
      initialCursor: restored ? opened.baseCursor : authorization.durable.cursor,
      initialPending: restored
        ? {
            docId: options.noteId,
            generation: identity.generation,
            state: restored,
            text: restoredText,
            pending: [],
            baseCursor: opened.baseCursor,
          }
        : undefined,
      onLocalUpdate: (pending) => {
        save(pending);
        options.onLocalUpdate?.(pending);
      },
      onSnapshot: (snapshot) => {
        if (snapshot.generation === identity.generation) void acknowledge(snapshot.state).catch(fail);
        options.onSnapshot?.(snapshot);
      },
      onUnsentChange: () => {
        options.onUnsentChange?.();
        scheduleReceipt();
      },
      onReady: () => {
        state.recovery = false;
        emit();
        scheduleReceipt();
        options.onReady?.();
      },
      onFatal: (error) => {
        // Session termination is never a storage acknowledgement. Keep the last full Yjs state.
        // onLocalUpdate ran before publication, including the update that triggered termination.
        // Do not replace that recovery copy with a later remotely changed projection.
        pump();
        state.recovery = state.pending && (error.reopen === true || !["SESSION_EXPIRED", "LOGIN_REQUIRED"].includes(error.code));
        clearTimeout(receiptTimer);
        receiptTimer = undefined;
        emit();
        options.onFatal?.(error);
      },
    });
    offline?.signal.addEventListener("abort", aborted, { once: true });
    emit();
    return {
      provider,
      recovery: state.recovery,
      pending: state.pending,
      refresh: async (signal) => {
        const stored = await read(signal).catch((error: unknown) => {
          if (!state.pending && error instanceof NotebookAuthorizationError && error.status === 404) {
            window.location.reload();
            return null;
          }
          stopForAccess(error);
          throw error;
        });
        if (!stored || disposed || state.recovery) return;
        if (stored.locked && !state.pending) {
          window.location.reload();
          return;
        }
        if (stored.generation !== identity.generation) {
          options.onFatal?.({ code: "RESYNC_REQUIRED", message: "Document generation changed", reopen: true });
          state.recovery = state.pending;
          provider?.dispose();
          emit();
          return;
        }
        Y.applyUpdate(options.doc, encoding.fromBase64(stored.durable.state), "remote");
        if (stored.locked) {
          provider?.dispose();
          options.onFatal?.({ code: "NOTE_LOCKED", message: "Note locked" });
        }
        await acknowledge(encoding.fromBase64(stored.durable.state));
      },
      retry: async () => {
        try {
          if (offline?.signal.aborted) {
            if (offline?.signal.reason instanceof SharedTextOfflineLoggedOutError) return;
            const reopened = await openAuthorizedSharedTextOffline(identity, read, options.signal);
            if (disposed) {
              reopened.session.close();
              return;
            }
            offline = reopened.session;
            state.failed = false;
            state.saved = !state.pending;
            emit();
            offline?.signal.addEventListener("abort", aborted, { once: true });
            if (!latest && state.pending) latest = lastInput;
          }
          pump();
          await queue;
          void checkDurable();
        } catch {
          fail();
        }
      },
      discard: async () => {
        if (!state.recovery) throw new Error("Notebook input is still active");
        await queue;
        await offline?.forget();
        state.pending = false;
        latest = null;
        emit();
      },
      flush: async () => {
        pump();
        await queue;
        return options.memoryOnly ? !provider?.hasUnsentChanges() : !state.pending || (state.saved && !latest);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(receiptTimer);
        provider?.dispose();
        offline?.signal.removeEventListener("abort", aborted);
        // Do not abort an already queued final write during in-app navigation.
        pump();
        void queue.finally(() => offline?.close());
      },
    };
  } catch (error) {
    offline?.close();
    throw error;
  }
}
