import { encoding } from "@k2b/stdlib";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { createSharedTextActionHistory, type SharedTextInverseRequest } from "./shared-text-history";

/** Application-independent error; adapters retain their own wire codes and messages. */
export type SharedTextProviderError = {
  code: string;
  message: string;
  docId?: string;
  /** Closed/replaced generations require recovery in a fresh editor; resume cannot revive them. */
  reopen?: boolean;
};

export type SharedTextProviderUpdate = {
  payload: string;
  cursor?: string;
  originPeerId?: string | null;
  actionId?: string;
  retainedColumn?: boolean;
  generation?: string;
};

/** Normalized inbound packets. The application adapter validates its wire format and resource IDs. */
export type SharedTextProviderMessage<Event = never, Participant = never> =
  | { type: "error"; payload: SharedTextProviderError }
  | { type: "eventError"; payload: SharedTextProviderError; terminal: boolean }
  | { type: "eventReady"; payload: Record<string, never> }
  | { type: "event"; payload: { event: Event; cursor: string | null; historyIncomplete?: boolean } }
  | { type: "replayReady"; payload: { docId: string; generation: string | null; cursor?: string; peerId?: string } }
  | { type: "presence"; payload: { docId: string; participants: Participant[]; generation?: string } }
  | {
      type: "syncPush" | "awarenessPush";
      payload: {
        docId: string;
        generation?: string;
        historyIncomplete?: boolean;
        snapshot?: boolean;
        updates: SharedTextProviderUpdate[];
      };
    };

/** Normalized outbound packets; encode supplies the application's wire names and fields. */
export type SharedTextProviderRequest =
  | { type: "replayRequest"; payload: { docId: string; fromCursor: string | null; generation: string | null } }
  | { type: "syncPublish"; payload: { docId: string; payload: string; generation: string; baseCursor: string | null } }
  | { type: "awarenessPublish"; payload: { docId: string; payload: string; generation: string | null } }
  | { type: "subscribe"; payload: { fromCursor: string | null } };

/** Wire conversion only: connection, ordering, history and recovery belong to the provider. */
export type SharedTextProviderTransport<Event = never, Participant = never> = {
  /** Absolute ws: or wss: URL. */
  url: string;
  encode: (request: SharedTextProviderRequest) => unknown;
  decode: (packet: unknown) => SharedTextProviderMessage<Event, Participant> | null;
  /** Include application-specific terminal reasons; nonterminal drops reconnect. */
  closeError: (code: number, reason: string) => SharedTextProviderError | null;
};

/** Exact local state for durable offline storage, bound to one document generation. */
export type SharedTextProviderPendingState = {
  docId: string;
  generation: string | null;
  state: Uint8Array;
  text: string;
  pending: { payload: string; baseCursor: string | null }[];
  baseCursor: string | null | undefined;
};

/** A server snapshot only. Transport echoes and replay-ready never report durable coverage. */
export type SharedTextProviderSnapshot = {
  docId: string;
  generation: string;
  state: Uint8Array;
  cursor: string | null;
};

export type SharedTextProviderOptions<Event = never, Participant = never> = {
  doc: Y.Doc;
  undoManager?: Y.UndoManager;
  awareness: awarenessProtocol.Awareness;
  docId: string;
  transport: SharedTextProviderTransport<Event, Participant>;
  /** Existing snapshot and cursor must belong to this opaque generation. */
  initialGeneration?: string;
  initialCursor?: string | null;
  /** Hydrate before connecting. A different document or generation is rejected without applying bytes. */
  initialPending?: SharedTextProviderPendingState;
  /** Existing transport's base64 payload limit; pending budget remains twice this limit. */
  maxSyncPayloadLength: number;
  terminalErrorCodes: readonly string[];
  reconnectDelayMs: (failedAttempts: number) => number;
  /** Optional only for transports with ordered generations and retained pre-restore events. */
  isEarlierGeneration?: (incoming: string, current: string) => boolean;
  /** Existing transports only: accept updates without generation metadata. New transports must retain the fence. */
  allowUnversionedUpdates?: boolean;
  /** Application wording for a generation fence; server-supplied messages pass through unchanged. */
  generationMessages?: { changed: string; restored: string };
  onConnectionChange?: (connected: boolean) => void;
  onPresenceChange?: (participants: Participant[]) => void;
  events?: {
    initialCursor?: string | null;
    onEvent: (event: Event, cursor: string | null) => void | Promise<void>;
    onCursorChange?: (cursor: string) => void;
    onError?: (error: SharedTextProviderError) => void;
  };
  onError?: (error: SharedTextProviderError) => void;
  onFatal?: (error: SharedTextProviderError) => void;
  onHistoryIncomplete?: () => void;
  /** Replay reached the live tail, before pending writes and awareness are published. */
  onReady?: () => void;
  /** Coalesced notification of transport pending/history changes, including echoes. */
  onUnsentChange?: () => void;
  onRetainedColumn?: () => void;
  /** Local input only, before publication. Persist this separately from transport acknowledgements. */
  onLocalUpdate?: (pending: SharedTextProviderPendingState) => void;
  /** Validated snapshot bytes, excluding any local input not covered by that server snapshot. */
  onSnapshot?: (snapshot: SharedTextProviderSnapshot) => void;
};

/** Consecutive storage refusals before termination; replay alone does not reset the budget. */
export const MAX_SHARED_TEXT_STORAGE_RETRIES = 5;

/** Browser Yjs lifecycle for one document and generation, with an application-owned wire adapter. */
export function createSharedTextProvider<Event = never, Participant = never>(opts: SharedTextProviderOptions<Event, Participant>) {
  const { doc, awareness } = opts;
  if (!opts.docId) throw new TypeError("docId is required");
  if (opts.initialCursor && opts.initialGeneration === undefined) throw new TypeError("initialCursor requires initialGeneration");
  if (opts.initialGeneration !== undefined && !opts.initialGeneration) throw new TypeError("Invalid initialGeneration");
  if (doc.store.clients.size > 0 && opts.initialGeneration === undefined)
    throw new TypeError("An initial document requires initialGeneration");
  if (!Number.isSafeInteger(opts.maxSyncPayloadLength) || opts.maxSyncPayloadLength <= 0)
    throw new TypeError("maxSyncPayloadLength must be a positive safe integer");
  if (opts.initialPending) {
    if (opts.initialPending.docId !== opts.docId || opts.initialPending.generation !== opts.initialGeneration)
      throw new TypeError("Pending input belongs to another document or generation");
    // Validate everything before mutating the host document or attaching listeners.
    Y.decodeUpdate(opts.initialPending.state);
    for (const entry of opts.initialPending.pending) Y.decodeUpdate(encoding.fromBase64(entry.payload));
  }
  const activeDocId = opts.docId;
  const terminalErrorCodes = new Set(opts.terminalErrorCodes);
  let ws: WebSocket | null = null;
  let isDisposed = false;
  let isTerminated = false;
  let needsReopen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let failedConnects = 0;
  let storageFailures = 0;
  let lastCursor = opts.initialCursor ?? null;
  let lastEventCursor = opts.events?.initialCursor ?? null;
  let eventStreamEventQueue = Promise.resolve();
  let eventStreamGeneration = 0;
  let replayReady = false;
  let awarenessPeerId: string | null = null;
  let generation: string | null = opts.initialGeneration ?? null;
  let localStateSent = false;
  let needsFullResync = false;
  const unconfirmed = new Map<string, string | null>();
  let unconfirmedBytes = 0;
  const forgetPending = (payload: string) => {
    if (unconfirmed.delete(payload)) unconfirmedBytes -= payload.length;
  };
  let unsentBase: string | null | undefined;
  let recoveryText: string | undefined;
  if (opts.initialPending) {
    Y.applyUpdate(doc, opts.initialPending.state, "remote");
    for (const entry of opts.initialPending.pending) {
      Y.applyUpdate(doc, encoding.fromBase64(entry.payload), "remote");
      if (!unconfirmed.has(entry.payload)) unconfirmedBytes += entry.payload.length;
      unconfirmed.set(entry.payload, entry.baseCursor);
    }
    unsentBase =
      opts.initialPending.baseCursor === undefined ? (opts.initialPending.pending[0]?.baseCursor ?? null) : opts.initialPending.baseCursor;
    recoveryText = opts.initialPending.text;
    // Even echoed input retained in offline storage must be reconciled again.
    needsFullResync = true;
  }
  const pendingState = (): SharedTextProviderPendingState => ({
    docId: activeDocId,
    generation,
    state: Y.encodeStateAsUpdate(doc),
    text: recoveryText ?? doc.getText("codemirror").toString(),
    pending: [...unconfirmed].map(([payload, baseCursor]) => ({ payload, baseCursor })),
    baseCursor: unsentBase,
  });
  // Current resend groups reference original pending bytes. Rebuilding a
  // generation releases old groups; only an echo releases the covered input.
  const covering = new Map<string, string[]>();
  let notifyingPending = false;
  const pendingChanged = () => {
    if (notifyingPending || isDisposed) return;
    notifyingPending = true;
    queueMicrotask(() => {
      notifyingPending = false;
      if (!isDisposed) opts.onUnsentChange?.();
    });
  };
  const actionHistory = opts.undoManager
    ? createSharedTextActionHistory(doc, opts.undoManager, pendingChanged, opts.onRetainedColumn)
    : null;

  const send = (request: SharedTextProviderRequest): boolean => {
    if (isDisposed || isTerminated) return false;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(opts.transport.encode(request)));
      return true;
    }
    return false;
  };

  const sendSyncPublish = (
    data: Uint8Array,
    baseCursor = unsentBase === undefined ? (unconfirmed.size ? unconfirmed.values().next().value! : lastCursor) : unsentBase,
  ): boolean => {
    if (generation === null) return false;
    const payload = encoding.toBase64(data);
    if (payload.length > opts.maxSyncPayloadLength) {
      // The exact unsent state remains in recoveryInput().state; sending an
      // oversized update would only loop on the server's existing limit.
      unsentBase = baseCursor;
      needsFullResync = true;
      needsReopen = true;
      pendingChanged();
      // Stop collecting immediately; notify/reconfigure the host only after
      // the native edit which exceeded the budget has left EditorView.update.
      replayReady = false;
      queueMicrotask(() => {
        if (!isDisposed) terminate({ code: "BACKPRESSURE", message: "Websocket backpressure", docId: activeDocId });
      });
      return false;
    }
    // Budget for an original transport envelope plus its covering reconnect
    // envelope. Preserve the triggering update too, then stop through existing
    // recovery. Echo delays cannot grow an unbounded original-payload queue.
    if (!unconfirmed.has(payload) && unconfirmedBytes + payload.length > 2 * opts.maxSyncPayloadLength) {
      unconfirmed.set(payload, baseCursor);
      unconfirmedBytes += payload.length;
      unsentBase = baseCursor;
      needsFullResync = true;
      needsReopen = true;
      pendingChanged();
      // Stop collecting immediately; notify/reconfigure the host only after
      // the native edit which exceeded the budget has left EditorView.update.
      replayReady = false;
      queueMicrotask(() => {
        if (!isDisposed) terminate({ code: "BACKPRESSURE", message: "Websocket backpressure", docId: activeDocId });
      });
      return false;
    }
    if (!send({ type: "syncPublish", payload: { docId: activeDocId, payload, generation, baseCursor } })) return false;
    if (!unconfirmed.has(payload)) unconfirmedBytes += payload.length;
    unconfirmed.set(payload, baseCursor);
    pendingChanged();
    return true;
  };

  const sendAwarenessPublish = (data: Uint8Array): boolean =>
    send({ type: "awarenessPublish", payload: { docId: activeDocId, payload: encoding.toBase64(data), generation } });

  const sendReplayRequest = (fromCursor: string | null): boolean =>
    send({ type: "replayRequest", payload: { docId: activeDocId, fromCursor, generation } });

  const sendEventSubscribe = (): boolean => {
    if (!opts.events) return false;
    return send({ type: "subscribe", payload: { fromCursor: lastEventCursor } });
  };

  const sendLocalStateIfNeeded = () => {
    if (!replayReady || localStateSent) return;
    if (needsFullResync) {
      // The full state keeps its original base; replay must never relabel stale
      // unconfirmed input with the server's newly delivered cursor.
      const localState = Y.encodeStateAsUpdate(doc);
      if (localState.length > 0 && !sendSyncPublish(localState)) return;
      covering.clear();
      covering.set(encoding.toBase64(localState), [...unconfirmed.keys()]);
    } else {
      // Preserve the existing payload-sized resend batches and original bytes.
      const groups: { payloads: string[]; size: number; baseCursor: string | null }[] = [];
      for (const [payload, baseCursor] of unconfirmed) {
        if (!groups.length || groups.at(-1)!.size + payload.length > opts.maxSyncPayloadLength)
          groups.push({ payloads: [], size: 0, baseCursor });
        const group = groups.at(-1)!;
        group.payloads.push(payload);
        group.size += payload.length;
      }
      covering.clear();
      for (const group of groups) {
        const payload =
          group.payloads.length === 1 ? group.payloads[0]! : encoding.toBase64(Y.mergeUpdates(group.payloads.map(encoding.fromBase64)));
        covering.set(payload, group.payloads);
        if (
          generation === null ||
          !send({ type: "syncPublish", payload: { docId: activeDocId, payload, generation, baseCursor: group.baseCursor } })
        )
          return;
      }
    }
    localStateSent = true;
    if (needsFullResync) {
      needsFullResync = false;
      pendingChanged();
    }
  };

  const terminate = (error: SharedTextProviderError) => {
    if (isTerminated) return;
    if (error.reopen) needsReopen = true;
    isTerminated = true;
    actionHistory?.cancelPending(new Error(error.message));
    replayReady = false;
    localStateSent = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        // Ignore close failures. Terminal flow is already enforced via isTerminated.
      }
    }
    opts.onFatal?.(error);
  };

  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (isDisposed) return;
    if (origin === "remote" || actionHistory?.isRemoteOrigin(origin)) return;
    recoveryText = doc.getText("codemirror").toString();
    if (opts.onLocalUpdate) {
      const baseCursor = unsentBase === undefined ? (unconfirmed.size ? unconfirmed.values().next().value! : lastCursor) : unsentBase;
      opts.onLocalUpdate({ ...pendingState(), baseCursor });
    }
    if (isTerminated || !replayReady) {
      if (unsentBase === undefined) unsentBase = unconfirmed.size ? unconfirmed.values().next().value : lastCursor;
      needsFullResync = true;
      pendingChanged();
      return;
    }
    if (!sendSyncPublish(update)) {
      if (unsentBase === undefined) unsentBase = unconfirmed.size ? unconfirmed.values().next().value : lastCursor;
      needsFullResync = true;
      pendingChanged();
    }
  };

  const onAwarenessUpdate = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (isDisposed || isTerminated) return;
    if (origin === "remote") return;
    if (!replayReady) return;
    if (!added.includes(doc.clientID) && !updated.includes(doc.clientID) && !removed.includes(doc.clientID)) return;
    sendAwarenessPublish(awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
  };

  const parseJsonMessage = (raw: string): SharedTextProviderMessage<Event, Participant> | null => {
    try {
      return opts.transport.decode(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const handleProviderErrorMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "error") return false;
    const error = msg.payload;
    opts.onError?.(error);
    if (error.reopen === true) {
      needsReopen = true;
      terminate(error);
      return true;
    }
    if (error.code === "STORAGE_EXHAUSTED") {
      storageFailures += 1;
      if (storageFailures >= MAX_SHARED_TEXT_STORAGE_RETRIES) terminate(error);
      return true;
    }
    if (error.code === "RESYNC_REQUIRED") {
      lastCursor = null;
      replayReady = false;
    }
    if (terminalErrorCodes.has(error.code)) {
      terminate(error);
    }
    return true;
  };

  const handleEventErrorMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "eventError") return false;
    const error = msg.payload;
    if (error.code === "RESYNC_REQUIRED") lastEventCursor = null;
    opts.events?.onError?.(error);
    if (msg.terminal) terminate(error);
    else ws?.close();
    return true;
  };

  const handleEventReadyMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => msg.type === "eventReady";

  const handleEventMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "event") return false;
    if (!opts.events) return true;
    const { event, cursor } = msg.payload;
    if (msg.payload.historyIncomplete) opts.onHistoryIncomplete?.();
    const connection = eventStreamGeneration;
    eventStreamEventQueue = eventStreamEventQueue
      .then(async () => {
        if (connection !== eventStreamGeneration || isDisposed || isTerminated) return;
        if (!opts.events?.onEvent) throw new Error("Workspace event handler missing");
        await opts.events.onEvent(event, cursor);
        if (connection === eventStreamGeneration && cursor) {
          lastEventCursor = cursor;
          opts.events.onCursorChange?.(cursor);
        }
      })
      .catch(() => {
        if (connection !== eventStreamGeneration || isDisposed || isTerminated) return;
        ws?.close();
      });
    return true;
  };

  const handleReplayReadyMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "replayReady") return false;
    const payload = msg.payload;
    // A socket can still deliver queued messages after a terminal error; the editor must stay stopped.
    if (payload.docId !== activeDocId || isTerminated) return true;
    if (typeof payload.generation !== "string" || !payload.generation || (generation !== null && generation !== payload.generation)) {
      needsReopen = true;
      terminate({
        code: "RESYNC_REQUIRED",
        message: opts.generationMessages?.changed ?? "The document changed. Copy unsent text before reopening it",
        docId: activeDocId,
      });
      return true;
    }
    generation = payload.generation;
    awarenessPeerId = typeof payload.peerId === "string" ? payload.peerId : null;
    replayReady = true;
    if (typeof payload.cursor === "string") lastCursor = payload.cursor;
    // Reading works again, but with edits still unsent only their echo proves that storage accepts writes,
    // so backoff and storage budget keep counting until then.
    if (!needsFullResync && unconfirmed.size === 0) {
      failedConnects = 0;
      storageFailures = 0;
    }
    opts.onReady?.();
    sendLocalStateIfNeeded();
    sendAwarenessPublish(awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID]));
    return true;
  };

  const handlePresenceMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "presence") return false;
    if (isTerminated || msg.payload.docId !== activeDocId) return true;
    if (msg.payload.generation !== undefined && msg.payload.generation !== generation) return true;
    opts.onPresenceChange?.(msg.payload.participants);
    return true;
  };

  const handlePushMessage = (msg: SharedTextProviderMessage<Event, Participant>): boolean => {
    if (msg.type !== "syncPush" && msg.type !== "awarenessPush") return false;

    const payload = msg.payload;

    if (isTerminated || payload.docId !== activeDocId || !Array.isArray(payload.updates)) return true;
    if (typeof payload.generation === "string") {
      if ((!opts.allowUnversionedUpdates && !payload.generation) || (generation !== null && generation !== payload.generation)) {
        needsReopen = true;
        terminate({
          code: "RESYNC_REQUIRED",
          message: opts.generationMessages?.restored ?? "The document was restored. Copy unsent text before reopening it",
          docId: activeDocId,
        });
        return true;
      }
      if (payload.snapshot === true || generation === null) generation = payload.generation;
    }
    if (msg.type === "syncPush" && payload.historyIncomplete === true) opts.onHistoryIncomplete?.();
    const snapshotUpdates: Uint8Array[] = [];
    let snapshotCursor: string | null = null;
    for (const update of payload.updates) {
      if (typeof update.payload !== "string") continue;
      try {
        if (
          (!opts.allowUnversionedUpdates && !(update.generation ?? payload.generation)) ||
          (generation !== null && typeof update.generation === "string" && update.generation !== generation)
        ) {
          if (generation !== null && update.generation !== undefined && opts.isEarlierGeneration?.(update.generation, generation)) {
            // A server action from before a restore must never touch its replacement.
            if (msg.type === "syncPush" && typeof update.cursor === "string") lastCursor = update.cursor;
            continue;
          }
          needsReopen = true;
          terminate({
            code: "RESYNC_REQUIRED",
            message: opts.generationMessages?.restored ?? "The document was restored. Copy unsent text before reopening it",
            docId: activeDocId,
          });
          return true;
        }
        if (msg.type === "syncPush") {
          if (payload.snapshot === true && actionHistory?.hasPending())
            throw new Error("The table action could not be confirmed before reloading its history");
          const bytes = encoding.fromBase64(update.payload);
          // New adapters may put the lineage on each ordered update. Bind only
          // after validating the first payload, before a later ready can label it.
          if (generation === null && update.generation) {
            Y.decodeUpdate(bytes);
            generation = update.generation;
          }
          if (actionHistory)
            actionHistory.apply(
              bytes,
              typeof update.actionId === "string" ? update.actionId : undefined,
              typeof update.cursor === "string" ? update.cursor : undefined,
              update.retainedColumn === true,
            );
          else {
            Y.decodeUpdate(bytes);
            Y.applyUpdate(doc, bytes, "remote");
          }
          if (payload.snapshot === true && opts.onSnapshot) {
            snapshotUpdates.push(bytes);
            if (typeof update.cursor === "string") snapshotCursor = update.cursor;
          }
          const covered = covering.get(update.payload);
          const echoed = unconfirmed.has(update.payload) || covered !== undefined;
          if (covered) {
            for (const payload of covered) forgetPending(payload);
            covering.delete(update.payload);
          } else forgetPending(update.payload);
          if (echoed) {
            if (!unconfirmed.size) covering.clear();
            failedConnects = 0;
            storageFailures = 0;
            if (!unconfirmed.size && !needsFullResync) {
              unsentBase = undefined;
              recoveryText = undefined;
            }
            pendingChanged();
          }
        } else {
          if (awarenessPeerId !== null && update.originPeerId === awarenessPeerId) continue;
          awarenessProtocol.applyAwarenessUpdate(awareness, encoding.fromBase64(update.payload), "remote");
        }
      } catch {
        if (msg.type === "syncPush") {
          const error = {
            code: "INVALID_PAYLOAD",
            message: "Shared editing stopped because an update could not be applied",
            docId: activeDocId,
          };
          opts.onError?.(error);
          terminate(error);
          return true;
        }
        // Awareness does not advance document history.
      }

      if (msg.type === "syncPush" && typeof update.cursor === "string") {
        lastCursor = update.cursor;
      }
    }

    if (msg.type === "syncPush" && payload.snapshot === true && snapshotUpdates.length && generation !== null) {
      opts.onSnapshot?.({ docId: activeDocId, generation, state: Y.mergeUpdates(snapshotUpdates), cursor: snapshotCursor });
    }

    return true;
  };

  const handleJsonMessage = (raw: string) => {
    const msg = parseJsonMessage(raw);
    if (!msg) return;

    if (handleProviderErrorMessage(msg)) return;
    if (handleEventErrorMessage(msg)) return;
    if (handleEventReadyMessage(msg)) return;
    if (handleEventMessage(msg)) return;
    if (handleReplayReadyMessage(msg)) return;
    if (handlePresenceMessage(msg)) return;
    handlePushMessage(msg);
  };

  const connect = () => {
    if (isDisposed || isTerminated) return;

    eventStreamGeneration += 1;
    eventStreamEventQueue = Promise.resolve();
    const socket = new WebSocket(opts.transport.url);
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      opts.onConnectionChange?.(true);
      replayReady = false;
      localStateSent = false;
      sendEventSubscribe();
      sendReplayRequest(lastCursor);
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      if (typeof event.data === "string") handleJsonMessage(event.data);
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      opts.onConnectionChange?.(false);
      replayReady = false;
      localStateSent = false;

      const closeError = opts.transport.closeError(event.code, event.reason ?? "");
      if (closeError) {
        opts.onError?.(closeError);
        terminate(closeError);
        return;
      }

      // `STREAM_FAILED` and plain drops keep `lastCursor`: the next replay
      // resumes after it instead of resending the stored snapshot. Only
      // `RESYNC_REQUIRED` cleared the cursor above.
      if (!isDisposed && !isTerminated) {
        reconnectTimer = setTimeout(connect, opts.reconnectDelayMs(failedConnects));
        failedConnects += 1;
      }
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      socket.close();
    };
  };

  doc.on("update", onDocUpdate);
  awareness.on("update", onAwarenessUpdate);

  return {
    connect,
    /** Retry a dropped connection immediately, without reviving terminal sessions. */
    reconnectNow: (): void => {
      if (isDisposed || isTerminated || (ws && ws.readyState <= WebSocket.OPEN)) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      failedConnects = 0;
      connect();
    },
    undo: () => {
      if (actionHistory?.nextStructural("undo") && (isDisposed || isTerminated || !replayReady || needsFullResync || unconfirmed.size))
        return Promise.reject(new Error("The editor must finish synchronizing before changing the table structure"));
      return actionHistory?.undo() ?? Promise.resolve(null);
    },
    redo: () => {
      if (actionHistory?.nextStructural("redo") && (isDisposed || isTerminated || !replayReady || needsFullResync || unconfirmed.size))
        return Promise.reject(new Error("The editor must finish synchronizing before changing the table structure"));
      return actionHistory?.redo() ?? Promise.resolve(null);
    },
    canUndo: () => actionHistory?.canUndo() ?? false,
    canRedo: () => actionHistory?.canRedo() ?? false,
    setInverseHandler: (handler: (request: SharedTextInverseRequest) => Promise<void>) => actionHistory?.setInverseHandler(handler),
    /** Exporting state does not acknowledge durable storage, even when hasUnsentChanges() is false. */
    pendingState,
    recoveryInput: () => ({
      state: Y.encodeStateAsUpdate(doc),
      text: recoveryText ?? doc.getText("codemirror").toString(),
      pending: [...unconfirmed].map(([payload, baseCursor]) => ({ payload, baseCursor })),
      baseCursor: unsentBase,
    }),
    /** Server actions wait for replay coverage and all local updates to be echoed. */
    canStructure: (): boolean =>
      !isDisposed &&
      !isTerminated &&
      replayReady &&
      generation !== null &&
      !needsFullResync &&
      unconfirmed.size === 0 &&
      !!actionHistory &&
      !actionHistory.hasPending(),
    generation: (): string | null => generation,
    beginAction: (actionId: string) => {
      if (isDisposed || isTerminated || !replayReady || generation === null || needsFullResync || unconfirmed.size || !actionHistory)
        throw new Error("The editor must finish synchronizing before changing the table structure");
      return actionHistory.begin(actionId);
    },
    /** Local edits the server has not echoed yet. */
    hasUnsentChanges: (): boolean => needsFullResync || unconfirmed.size > 0,
    /** Reconnect after a terminal error, used after the person signs in again. */
    resume: (): void => {
      if (!isTerminated || isDisposed || needsReopen) return;
      isTerminated = false;
      failedConnects = 0;
      connect();
    },
    dispose: () => {
      isDisposed = true;
      actionHistory?.dispose();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "disconnect");
      doc.off("update", onDocUpdate);
      awareness.off("update", onAwarenessUpdate);
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}

/** Provider handle: transport controls, own history, generation and exact pending recovery state. */
export type SharedTextProvider = ReturnType<typeof createSharedTextProvider>;
