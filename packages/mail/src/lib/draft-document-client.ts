import {
  createSharedTextProvider,
  listSharedTextOfflineGenerations,
  openAuthorizedSharedTextOffline,
  type SharedTextInverseRequest,
  type SharedTextOfflineSession,
  type SharedTextProvider,
  type SharedTextProviderError,
} from "@k2b/cloud/browser/shared-text";
import { encoding, i18n } from "@k2b/stdlib";
import type { Change } from "diff";
import { diffChars } from "diff/lib/diff/character.js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { z } from "zod";
import { type DraftEditableContent, draftEditableContentInputSchema, draftSchema, type MailDraft } from "../contracts";
import {
  DRAFT_DOCUMENT_EXPECTED_USER_QUERY,
  draftDocumentSaveSchema,
  draftDocumentSessionSchema,
  draftGenerationSchema,
  MAX_DRAFT_DOCUMENT_PAYLOAD,
} from "../draft-document-contracts";
import { DRAFT_BODY, draftRecipientConfirmation, readDraftDocument, writeLocalDraftHeaders } from "./draft-document";
import { draftRecoveryRequestId } from "./draft-document-client-recovery";
import { decodeMailDraftDocumentMessage, MAIL_DRAFT_DOCUMENT_TERMINAL_CODES } from "./draft-document-protocol";

export const mailSharedDraftMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      connecting: "Connecting…",
      saved: "Saved",
      pending: "Changes awaiting durable storage",
      offline: "Offline · {count} changes on this device",
      storageFailed: "This device could not save your changes. Keep the draft open and retry, or copy your text.",
      notRemembered: "Changes stay in this tab only. Keep it open until saving succeeds.",
      remember: "Remember this device",
      forget: "Do not remember this device",
      retry: "Retry saving",
      copy: "Copy draft",
      recover: "Recover unsent changes",
      frozen: "This draft was closed or replaced. Your unsent text remains here for recovery.",
      permission: "Editing is unavailable. Your unsent text remains here to copy.",
      syncFirst: "Wait for the connection and synchronization, then retry saving.",
      generation: "This draft changed. Keep your text and reopen the draft.",
      bodyEditFailed: "This body change could not be applied safely. Keep your proposed text and try a smaller change.",
      recipientsTitle: "Review changed recipients",
      recipients: "Someone changed the sender or recipients. Check them before sending.",
      confirm: "Send to these recipients",
      tableFailed: "The table action could not be confirmed. Keep the draft open.",
      tablePending: "Waiting for the table change…",
      retainedColumn: "Column kept because others wrote in it",
      tableUnknown: "The table action may have been applied. Waiting for confirmation; do not repeat it.",
      stopWaiting: "Stop waiting",
      restSaved: "Unsent changes were saved in a recovery draft.",
      restUnchanged: "This device has no changes beyond the sent draft.",
      openRest: "Open recovery draft",
      reopen: "Reopen current draft",
      restLabel: "Recovery draft",
      restSource: "Original draft",
    },
    de: {
      connecting: "Verbindung wird hergestellt…",
      saved: "Gespeichert",
      pending: "Änderungen warten auf dauerhafte Speicherung",
      offline: "Offline · {count} Änderungen auf diesem Gerät",
      storageFailed:
        "Dieses Gerät konnte deine Änderungen nicht speichern. Lass den Entwurf geöffnet und versuche es erneut oder kopiere deinen Text.",
      notRemembered: "Änderungen bleiben nur in diesem Tab. Lass ihn geöffnet, bis das Speichern gelingt.",
      remember: "Dieses Gerät merken",
      forget: "Dieses Gerät nicht merken",
      retry: "Speichern erneut versuchen",
      copy: "Entwurf kopieren",
      recover: "Ungesendete Änderungen sichern",
      frozen: "Dieser Entwurf wurde geschlossen oder ersetzt. Dein ungesendeter Text bleibt hier zur Wiederherstellung.",
      permission: "Bearbeiten ist nicht möglich. Dein ungesendeter Text bleibt hier zum Kopieren.",
      syncFirst: "Warte auf die Verbindung und den Abgleich und versuche das Speichern erneut.",
      generation: "Dieser Entwurf hat sich geändert. Behalte deinen Text und öffne ihn erneut.",
      bodyEditFailed:
        "Diese Textänderung konnte nicht sicher übernommen werden. Behalte deinen vorgeschlagenen Text und versuche eine kleinere Änderung.",
      recipientsTitle: "Geänderte Empfänger prüfen",
      recipients: "Jemand hat Absender oder Empfänger geändert. Prüfe sie vor dem Senden.",
      confirm: "An diese Empfänger senden",
      tableFailed: "Die Tabellenaktion konnte nicht bestätigt werden. Lass den Entwurf geöffnet.",
      tablePending: "Tabellenänderung wird abgeglichen…",
      retainedColumn: "Spalte bleibt, weil andere darin geschrieben haben",
      tableUnknown: "Die Tabellenaktion wurde möglicherweise übernommen. Die Bestätigung steht noch aus; bitte nicht wiederholen.",
      stopWaiting: "Warten beenden",
      restSaved: "Ungesendete Änderungen wurden in einem Rest-Entwurf gespeichert.",
      restUnchanged: "Dieses Gerät hat keine Änderungen gegenüber dem gesendeten Entwurf.",
      openRest: "Rest-Entwurf öffnen",
      reopen: "Aktuellen Entwurf öffnen",
      restLabel: "Rest-Entwurf",
      restSource: "Ursprünglicher Entwurf",
    },
  },
});

const durableSchema = draftDocumentSaveSchema;
const restSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), durableSourceState: z.string() }),
  z.object({ status: z.literal("recovered"), draft: draftSchema, durableSourceState: z.string() }),
]);

/** Includes delete sets: state vectors alone cannot prove that a deletion was stored. */
export const draftSnapshotCovers = (snapshot: Uint8Array, state: Uint8Array): boolean => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot);
    return !doc.store.pendingStructs && !doc.store.pendingDs && Y.snapshotContainsUpdate(Y.snapshot(doc), state);
  } finally {
    doc.destroy();
  }
};

// External edits run synchronously with the existing composer API. Spend at most
// one 60 Hz frame on the diff search (checked between search iterations).
// Tokenization is linear in Mail's 2 Mi UTF-16 schema bound. Never replace a broad span on timeout.
const compileDraftTextChanges = (before: string, next: string): Change[] => {
  draftEditableContentInputSchema.shape.body.parse(before);
  draftEditableContentInputSchema.shape.body.parse(next);
  if (before === next) return [];
  const changes = diffChars(before, next, { timeout: 1000 / 60 });
  if (!changes) throw new Error("External draft body change exceeded its editing budget");
  return changes;
};

const applyDraftTextChanges = (text: Y.Text, changes: Change[]): void => {
  let offset = 0;
  for (let index = 0; index < changes.length; ) {
    const part = changes[index]!;
    if (!part.added && !part.removed) {
      offset += part.value.length;
      index++;
      continue;
    }
    let removed = 0;
    let inserted = "";
    while (index < changes.length && (changes[index]!.added || changes[index]!.removed)) {
      const change = changes[index++]!;
      if (change.removed) removed += change.value.length;
      else inserted += change.value;
    }
    // Preserve every unchanged run and retain each replacement's right-edge anchor.
    // jsdiff compares code points; Y.Text positions use UTF-16 lengths.
    if (inserted) text.insert(offset, inserted);
    if (removed) text.delete(offset + inserted.length, removed);
    offset += inserted.length;
  }
};

/** Local external body edits (templates/signatures); remote updates always go through yCollab. */
export const spliceDraftText = (text: Y.Text, next: string): void =>
  applyDraftTextChanges(text, compileDraftTextChanges(text.toString(), next));

export type MailSharedDraftState = {
  connected: boolean;
  ready: boolean;
  terminal: boolean;
  changes: number;
  dirty: boolean;
  remembering: boolean;
  locallySaved: boolean;
  saving: boolean;
  message: string;
  error: boolean;
  structuring: boolean;
  recipientsChanged: boolean;
  recoveryDraft: MailDraft | null;
  restUnchanged: boolean;
};

export type MailDraftDocumentClient = {
  doc: Y.Doc;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  provider: SharedTextProvider;
  generation: string;
  edit: (content: DraftEditableContent) => void;
  save: () => Promise<z.infer<typeof durableSchema>>;
  recover: () => Promise<z.infer<typeof restSchema>>;
  refresh: () => Promise<void>;
  retry: () => Promise<void | z.infer<typeof durableSchema> | z.infer<typeof restSchema>>;
  postAction: (body: unknown, signal: AbortSignal) => Promise<Response>;
  freeze: () => void;
  content: () => DraftEditableContent;
  state: () => MailSharedDraftState;
  recipientsConfirmed: () => void;
  setRemembering: (value: boolean) => Promise<void>;
  flushLocal: () => Promise<boolean>;
  discardLocal: () => Promise<void>;
  dispose: () => void;
};

export async function openMailDraftDocumentClient(options: {
  mailboxId: string;
  draft: MailDraft;
  userId: string;
  locale: () => string;
  signal: AbortSignal;
  rememberDevice?: boolean;
  onState: (state: MailSharedDraftState) => void;
  onContent: (content: DraftEditableContent) => void;
  onDurable: (content: DraftEditableContent, revision: number) => void;
  onFrozen: () => void;
  onAuthenticationRequired: () => void;
}): Promise<MailDraftDocumentClient> {
  const t = () => mailSharedDraftMessages.resolve([options.locale()]).t;
  let deviceStorage: Storage | null;
  try {
    deviceStorage = localStorage;
    deviceStorage.getItem("cloud:mail:shared:probe");
  } catch (error) {
    // Explicit memory-only editing must also work when the browser blocks device storage entirely.
    if (options.rememberDevice !== false) throw error;
    deviceStorage = null;
  }
  const pendingGenerationPrefix = `cloud:mail:shared:pending:${options.userId}:${options.draft.id}:`;
  // IndexedDB keys share the saved bytes' transaction boundary. A localStorage hint
  // can disappear while another tab's save commits, so it cannot discover pending input.
  const pendingGenerations =
    typeof indexedDB === "undefined"
      ? [] // No offline database API exists in this browser; explicit tab-only editing remains available.
      : await listSharedTextOfflineGenerations({ userId: options.userId, draftId: options.draft.id });
  const previousGeneration = pendingGenerations
    .map((value) => draftGenerationSchema.safeParse(value))
    .flatMap((result) => (result.success ? [result.data] : []))
    .sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0))[0];
  const generation = previousGeneration ?? options.draft.generation;
  const pendingGenerationKey = `${pendingGenerationPrefix}${generation}`;
  if (!generation) throw new Error(t().generation);
  const path = `/api/mail/mailboxes/${encodeURIComponent(options.mailboxId)}/drafts/${encodeURIComponent(options.draft.id)}/document`;
  const accountQuery = new URLSearchParams({ [DRAFT_DOCUMENT_EXPECTED_USER_QUERY]: options.userId }).toString();
  const identity = { userId: options.userId, draftId: options.draft.id, generation };
  const storageKey = `cloud:mail:shared:${identity.userId}:${identity.draftId}:${generation}`;
  // Only metadata lives in localStorage; text is in the logout-fenced IndexedDB store.
  let remembering = options.rememberDevice ?? deviceStorage?.getItem(`${storageKey}:remember`) !== "no";
  if (!remembering && previousGeneration !== undefined) throw new Error(t().storageFailed);
  if (options.rememberDevice !== undefined) deviceStorage?.setItem(`${storageKey}:remember`, remembering ? "yes" : "no");
  const request = async (suffix: string, body?: unknown, signal: AbortSignal = options.signal): Promise<unknown> => {
    const response = await fetch(`${path}${suffix}?${accountQuery}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      if (response.status === 401) options.onAuthenticationRequired();
      const result: unknown = await response.json().catch(() => null);
      const message =
        result && typeof result === "object" && "message" in result && typeof result.message === "string" ? result.message : t().pending;
      throw new Error(message);
    }
    return response.json();
  };
  const authorize = async (signal: AbortSignal) => draftDocumentSessionSchema.parse(await request("", undefined, signal));
  let offline: SharedTextOfflineSession | undefined;
  let local: Uint8Array | null = null;
  let originalBaseCursor: string | null = null;
  let authorization: z.infer<typeof draftDocumentSessionSchema>;
  // Capture logout epoch before authorization, then check the live generation before any bytes leave storage.
  if (remembering) {
    const opened = await openAuthorizedSharedTextOffline(
      identity,
      async (signal) => {
        const current = await authorize(signal);
        // A closed generation may be read only to recover its original input; it never starts a provider.
        return current;
      },
      options.signal,
    );
    offline = opened.session;
    authorization = opened.authorization;
    local = opened.state;
    originalBaseCursor = local ? opened.baseCursor : authorization.fresh.cursor;
  } else {
    authorization = await authorize(options.signal);
    originalBaseCursor = authorization.fresh.cursor;
  }
  const doc = new Y.Doc();
  let cleanupAwareness: Awareness | undefined;
  let cleanupManager: Y.UndoManager | undefined;
  let cleanupProvider: SharedTextProvider | undefined;
  try {
    options.signal.throwIfAborted();
    offline?.signal.throwIfAborted();
    if (!authorization.historyComplete) throw new Error(t().generation);
    const outdated = authorization.generation !== generation;
    // Never apply a new generation's base to old pending identities.
    if (!outdated) Y.applyUpdate(doc, encoding.fromBase64(authorization.fresh.state), "remote");
    if (local) Y.applyUpdate(doc, local, "remote");
    if (outdated && !local) {
      offline?.close();
      doc.destroy();
      if (deviceStorage?.getItem(pendingGenerationKey) === generation) deviceStorage?.removeItem(pendingGenerationKey);
      return openMailDraftDocumentClient({ ...options, draft: { ...options.draft, generation: authorization.generation } });
    }
    let recipientBaseline: DraftEditableContent = options.draft;
    if (local && !outdated) {
      const previous = new Y.Doc();
      try {
        Y.applyUpdate(previous, local);
        recipientBaseline = readDraftDocument(previous);
      } finally {
        previous.destroy();
      }
    }
    let projection = readDraftDocument(doc);
    const awareness = new Awareness(doc);
    cleanupAwareness = awareness;
    const undoManager = new Y.UndoManager(doc.getText(DRAFT_BODY), { trackedOrigins: new Set([null, "mail-headers"]) });
    cleanupManager = undoManager;
    const closed = outdated || authorization.frozen !== null || authorization.lifecycle !== "draft";
    const state: MailSharedDraftState = {
      connected: false,
      ready: false,
      terminal: closed,
      changes: local ? 1 : 0,
      dirty: !draftSnapshotCovers(encoding.fromBase64(authorization.durable.state), Y.encodeStateAsUpdate(doc)),
      remembering,
      locallySaved: Boolean(local),
      saving: false,
      message: closed ? t().frozen : t().connecting,
      error: false,
      structuring: false,
      recipientsChanged: draftRecipientConfirmation(projection) !== draftRecipientConfirmation(recipientBaseline),
      recoveryDraft: null,
      restUnchanged: false,
    };
    let disposed = false;
    let storageQueue: Promise<void> = Promise.resolve();
    let storageFailure: Error | null = null;
    let metadataFailure = false;
    let storageVersion = 0;
    let durableState = encoding.fromBase64(authorization.durable.state);
    const waiters = new Set<() => void>();
    let structuralPending = 0;
    const emit = () => {
      // The action stays pending across a network drop; losing readiness is not a receipt.
      state.structuring = structuralPending > 0;
      if (!disposed) options.onState({ ...state });
      for (const wake of waiters) wake();
    };
    const fail = (error: unknown) => {
      state.error = true;
      state.message = error instanceof Error ? error.message : t().pending;
      emit();
    };
    let pendingLocal: { bytes: Uint8Array; baseCursor: string | null; version: number } | null = null;
    let pendingSnapshot: Uint8Array | null = null;
    let storageRunning = false;
    const pumpStorage = () => {
      if (storageRunning || !offline || offline.signal.aborted || !remembering) return;
      storageRunning = true;
      const store = offline;
      storageQueue = (async () => {
        // Coalesce full states while IndexedDB is busy. At most one next input and snapshot stay in memory.
        while (offline === store && !store.signal.aborted && remembering && (pendingLocal || pendingSnapshot)) {
          if (pendingLocal) {
            const input = pendingLocal;
            pendingLocal = null;
            await store.save(input.bytes, input.baseCursor);
            store.signal.throwIfAborted();
            storageFailure = null;
            state.locallySaved = input.version === storageVersion && !metadataFailure;
            emit();
          } else if (pendingSnapshot) {
            const bytes = pendingSnapshot,
              version = storageVersion;
            pendingSnapshot = null;
            const covered = await store.acknowledgeSnapshot({ identity, state: bytes, durability: "durable" });
            store.signal.throwIfAborted();
            if (covered && version === storageVersion && !pendingLocal && deviceStorage?.getItem(pendingGenerationKey) === generation) {
              deviceStorage?.removeItem(pendingGenerationKey);
            }
          }
        }
      })()
        .catch((error: unknown) => {
          storageFailure = error instanceof Error ? error : new Error(t().storageFailed);
          state.locallySaved = false;
          state.error = true;
          state.message = t().storageFailed;
          emit();
        })
        .finally(() => {
          storageRunning = false;
          if (!storageFailure && (pendingLocal || pendingSnapshot)) pumpStorage();
        });
    };
    const flushStorage = async () => {
      while (storageRunning) await storageQueue;
    };
    const persistLocal = (bytes: Uint8Array, baseCursor?: string | null) => {
      state.locallySaved = false;
      if (!remembering || !offline) return;
      try {
        deviceStorage?.setItem(pendingGenerationKey, generation);
        metadataFailure = false;
      } catch (error) {
        metadataFailure = true;
        storageFailure = error instanceof Error ? error : new Error(t().storageFailed);
        state.error = true;
        state.message = t().storageFailed;
      }
      pendingLocal = { bytes, baseCursor: baseCursor === undefined ? originalBaseCursor : baseCursor, version: ++storageVersion };
      pumpStorage();
    };
    const acknowledge = (bytes: Uint8Array) => {
      durableState = bytes;
      pendingSnapshot = bytes;
      pumpStorage();
      if (draftSnapshotCovers(bytes, Y.encodeStateAsUpdate(doc))) {
        state.dirty = false;
        state.changes = 0;
        if (!state.terminal) {
          state.message = t().saved;
          state.error = false;
        }
      }
      emit();
    };
    const project = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      try {
        const next = readDraftDocument(doc);
        if (!transaction.local && draftRecipientConfirmation(next) !== draftRecipientConfirmation(projection))
          state.recipientsChanged = true;
        projection = next;
        if (!transaction.local && !draftSnapshotCovers(durableState, Y.encodeStateAsUpdate(doc))) {
          state.dirty = true;
          persistLocal(Y.encodeStateAsUpdate(doc));
          if (!state.error && !state.terminal) state.message = t().pending;
        }
        options.onContent(next);
        emit();
      } catch (error) {
        state.terminal = true;
        fail(error);
      }
    };
    doc.on("update", project);
    const socketUrl = new URL(`${path}/socket?${accountQuery}`, window.location.href);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const fatal = (error: SharedTextProviderError) => {
      if (error.code === "SESSION_EXPIRED") options.onAuthenticationRequired();
      state.terminal = true;
      state.ready = false;
      state.connected = false;
      state.message = error.message || t().permission;
      state.error = true;
      emit();
      if (error.reopen) {
        options.onFrozen();
        void recover().catch(fail);
      }
    };
    const provider: SharedTextProvider = createSharedTextProvider({
      doc,
      awareness,
      undoManager,
      docId: options.draft.id,
      initialGeneration: generation,
      initialCursor: outdated ? null : authorization.fresh.cursor,
      initialPending:
        local && !closed
          ? {
              docId: options.draft.id,
              generation,
              state: local,
              text: projection.body,
              pending: [],
              baseCursor: originalBaseCursor,
            }
          : undefined,
      maxSyncPayloadLength: MAX_DRAFT_DOCUMENT_PAYLOAD,
      terminalErrorCodes: MAIL_DRAFT_DOCUMENT_TERMINAL_CODES,
      transport: {
        url: socketUrl.href,
        encode: (packet) => packet,
        decode: (packet) => decodeMailDraftDocumentMessage(packet, options.draft.id),
        closeError: (code, reason) =>
          [1008, 1009, 1013, 4401, 4403].includes(code) ? { code: "ACCESS_DENIED", message: reason || t().permission } : null,
      },
      reconnectDelayMs: (attempt) => Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000),
      generationMessages: { changed: t().generation, restored: t().frozen },
      onConnectionChange: (connected) => {
        state.connected = connected;
        if (!connected) state.ready = false;
        emit();
      },
      onReady: () => {
        state.ready = true;
        if (!state.dirty && !state.error) state.message = t().saved;
        emit();
      },
      onUnsentChange: emit,
      onRetainedColumn: () => {
        state.message = t().retainedColumn;
        emit();
      },
      onLocalUpdate: ({ state: bytes, baseCursor, pending }) => {
        originalBaseCursor = baseCursor === undefined ? (pending[0]?.baseCursor ?? originalBaseCursor) : baseCursor;
        state.dirty = true;
        state.changes++;
        state.message = t().pending;
        state.error = false;
        persistLocal(bytes, originalBaseCursor);
        emit();
      },
      onSnapshot: (snapshot) => {
        if (snapshot.generation === generation) acknowledge(snapshot.state);
      },
      onError: (error) => {
        state.error = true;
        state.message = error.message;
        emit();
      },
      onFatal: fatal,
      onHistoryIncomplete: () => fatal({ code: "HISTORY_INCOMPLETE", message: t().generation }),
    });
    cleanupProvider = provider;
    const trackStructure = (applied: Promise<void>) => {
      structuralPending++;
      emit();
      const settled = () => {
        structuralPending--;
        emit();
      };
      void applied.then(settled, settled);
    };
    const publicProvider: SharedTextProvider = {
      ...provider,
      beginAction: (actionId) => {
        const pending = provider.beginAction(actionId);
        trackStructure(pending.applied);
        return pending;
      },
      setInverseHandler: (handler: (request: SharedTextInverseRequest) => Promise<void>) =>
        provider.setInverseHandler((request) => {
          trackStructure(request.applied);
          return handler(request);
        }),
    };
    let providerClosed = false;
    let rejectedExternalEdit = false;
    const storeAborted = () => {
      if (disposed) return;
      storageFailure = new Error(t().storageFailed);
      state.locallySaved = false;
      provider.dispose();
      providerClosed = true;
      state.terminal = true;
      state.ready = false;
      state.connected = false;
      state.error = true;
      state.message = t().storageFailed;
      emit();
    };
    offline?.signal.addEventListener("abort", storeAborted, { once: true });
    const edit = (next: DraftEditableContent) => {
      if (disposed || state.terminal) return;
      if (JSON.stringify(next) === JSON.stringify(projection)) {
        rejectedExternalEdit = false;
        return;
      }
      // Read once; transactions synchronously project composer signals and must not overwrite the submitted body.
      const before = projection;
      draftEditableContentInputSchema.parse(next);
      let bodyChanges: Change[];
      try {
        // Compile before changing ANY header or body field. Failure leaves the proposal available in the composer.
        bodyChanges = compileDraftTextChanges(before.body, next.body);
      } catch {
        rejectedExternalEdit = true;
        const error = new Error(t().bodyEditFailed);
        fail(error);
        throw error;
      }
      doc.transact(() => {
        writeLocalDraftHeaders(doc, before, next);
        applyDraftTextChanges(doc.getText(DRAFT_BODY), bodyChanges);
      }, "mail-headers");
      rejectedExternalEdit = false;
    };
    const awaitSynchronized = async () => {
      if (!state.connected || !state.ready || state.terminal) throw new Error(state.message || t().syncFirst);
      if (provider.canStructure()) return;
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          waiters.delete(check);
          options.signal.removeEventListener("abort", check);
        };
        const check = () => {
          if (disposed || options.signal.aborted || state.terminal || !state.connected) {
            stop();
            reject(new Error(state.message || t().syncFirst));
          } else if (provider.canStructure()) {
            stop();
            resolve();
          }
        };
        waiters.add(check);
        options.signal.addEventListener("abort", check, { once: true });
        check();
      });
    };
    const runSave = async () => {
      state.saving = true;
      emit();
      try {
        if (rejectedExternalEdit) throw new Error(t().bodyEditFailed);
        await awaitSynchronized();
        const saved = durableSchema.parse(await request("/snapshot", { generation }));
        if (saved.generation !== generation) throw new Error(t().generation);
        Y.applyUpdate(doc, encoding.fromBase64(saved.durable.state), "remote");
        acknowledge(encoding.fromBase64(saved.durable.state));
        options.onDurable(saved.durable.content, saved.revision);
        if (state.dirty || provider.hasUnsentChanges()) throw new Error(t().pending);
        return saved;
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        state.saving = false;
        emit();
      }
    };
    let savingPromise: Promise<z.infer<typeof durableSchema>> | null = null;
    const save = () => {
      if (!savingPromise)
        savingPromise = runSave().finally(() => {
          savingPromise = null;
        });
      return savingPromise;
    };
    let switchingDevice = false;
    let recovering: Promise<z.infer<typeof restSchema>> | null = null;
    const recover = () => {
      if (recovering) return recovering;
      recovering = (async () => {
        if (rejectedExternalEdit) throw new Error(t().bodyEditFailed);
        // Re-authorize before requesting recovery; permission failure leaves local bytes untouched.
        const current = await authorize(options.signal);
        if (current.lifecycle === "draft" && !current.frozen && current.generation === generation) throw new Error(t().generation);
        const sourceState = encoding.toBase64(Y.encodeStateAsUpdate(doc));
        const requestId = await draftRecoveryRequestId(identity, sourceState);
        const result = restSchema.parse(await request("/rest", { generation, clientId: requestId, state: sourceState }));
        if (result.status === "recovered") {
          state.recoveryDraft = result.draft;
          state.message = t().restSaved;
          // Parent returns exact source_state committed alongside the recovery draft.
          acknowledge(encoding.fromBase64(result.durableSourceState));
        } else {
          state.restUnchanged = true;
          state.message = t().restUnchanged;
          acknowledge(encoding.fromBase64(result.durableSourceState));
        }
        state.error = false;
        emit();
        return result;
      })().finally(() => {
        recovering = null;
      });
      return recovering;
    };
    options.onContent(projection);
    emit();
    if (!closed) provider.connect();
    else {
      options.onFrozen();
      queueMicrotask(() => void recover().catch(fail));
    }
    const onOnline = () => provider.reconnectNow();
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (rejectedExternalEdit || state.structuring || (state.dirty && (!remembering || !state.locallySaved || storageFailure))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("beforeunload", onBeforeUnload);
    return {
      doc,
      awareness,
      undoManager,
      provider: publicProvider,
      generation,
      edit,
      save,
      recover,
      postAction: async (body: unknown, signal: AbortSignal) => {
        const response = await fetch(`${path}/table-action?${accountQuery}`, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (response.status === 401) options.onAuthenticationRequired();
        const result: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        if (result && typeof result === "object" && "persisted" in result && result.persisted === false) {
          state.dirty = true;
          state.message = t().pending;
          state.error = true;
          emit();
        }
        return response;
      },
      freeze: () => {
        if (state.terminal) return;
        provider.dispose();
        providerClosed = true;
        state.terminal = true;
        state.ready = false;
        state.connected = false;
        state.message = t().frozen;
        emit();
        options.onFrozen();
        void recover().catch(fail);
      },
      content: () => readDraftDocument(doc),
      state: () => ({ ...state }),
      recipientsConfirmed: () => {
        state.recipientsChanged = false;
        emit();
      },
      refresh: async () => {
        const current = await authorize(options.signal);
        if (current.generation !== generation || current.frozen || current.lifecycle !== "draft") throw new Error(t().generation);
        Y.applyUpdate(doc, encoding.fromBase64(current.fresh.state), "remote");
        acknowledge(encoding.fromBase64(current.durable.state));
        options.onDurable(current.durable.content, current.revision);
      },
      retry: async () => {
        if (state.terminal || !state.connected) {
          const current = await authorize(options.signal);
          options.signal.throwIfAborted();
          if (disposed) return;
          if (current.generation !== generation || current.frozen || current.lifecycle !== "draft") return recover();
          if (providerClosed) throw new Error(t().generation);
          if (state.terminal) {
            state.terminal = false;
            state.error = false;
            state.message = t().connecting;
            emit();
            provider.resume();
            return;
          }
        }
        if (remembering) persistLocal(Y.encodeStateAsUpdate(doc));
        provider.reconnectNow();
        return save();
      },
      setRemembering: async (next: boolean) => {
        if (next === remembering || switchingDevice) return;
        switchingDevice = true;
        try {
          await flushStorage();
          if (!next) {
            if (offline) await offline.forget();
            if (deviceStorage?.getItem(pendingGenerationKey) === generation) deviceStorage?.removeItem(pendingGenerationKey);
            remembering = false;
            deviceStorage?.setItem(`${storageKey}:remember`, "no");
            offline?.signal.removeEventListener("abort", storeAborted);
            offline?.close();
            offline = undefined;
            pendingLocal = null;
            pendingSnapshot = null;
            state.locallySaved = false;
          } else {
            const opened = await openAuthorizedSharedTextOffline(
              identity,
              async (signal) => {
                const current = await authorize(signal);
                if (current.generation !== generation || current.lifecycle !== "draft" || current.frozen) throw new Error(t().generation);
                return current;
              },
              options.signal,
            );
            offline = opened.session;
            offline.signal.addEventListener("abort", storeAborted, { once: true });
            remembering = true;
            deviceStorage?.removeItem(`${storageKey}:remember`);
            if (opened.state) {
              originalBaseCursor = opened.baseCursor;
              Y.applyUpdate(doc, opened.state, "remote");
            }
            persistLocal(Y.encodeStateAsUpdate(doc));
          }
          state.remembering = remembering;
          emit();
        } finally {
          switchingDevice = false;
        }
      },
      flushLocal: async () => {
        await flushStorage();
        return (
          !rejectedExternalEdit &&
          (!state.dirty || (remembering && offline !== undefined && !offline.signal.aborted && state.locallySaved && !storageFailure))
        );
      },
      discardLocal: async () => {
        // Called only after the person confirmed discard and the server committed it.
        provider.dispose();
        providerClosed = true;
        state.terminal = true;
        await flushStorage();
        if (offline) await offline.forget();
        deviceStorage?.removeItem(pendingGenerationKey);
        pendingLocal = null;
        pendingSnapshot = null;
        state.dirty = false;
        state.changes = 0;
        emit();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        provider.dispose();
        for (const wake of waiters) wake();
        window.removeEventListener("online", onOnline);
        window.removeEventListener("beforeunload", onBeforeUnload);
        doc.off("update", project);
        offline?.signal.removeEventListener("abort", storeAborted);
        // Closing IDB immediately aborts queued writes. Drain full state first, even on owner cleanup.
        void flushStorage().finally(() => {
          offline?.close();
          awareness.destroy();
          undoManager.destroy();
          doc.destroy();
        });
      },
    };
  } catch (error) {
    cleanupProvider?.dispose();
    cleanupAwareness?.destroy();
    cleanupManager?.destroy();
    offline?.close();
    doc.destroy();
    throw error;
  }
}
