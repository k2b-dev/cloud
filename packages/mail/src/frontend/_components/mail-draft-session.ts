import { liveConnection } from "@k2b/cloud/browser/live";
import { crypto as cryptoUtils } from "@k2b/stdlib";
import type { Accessor } from "solid-js";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { apiClient } from "../../api/client";
import {
  type AcquiredDraftLease,
  DRAFT_LEASE_ERROR_CODES,
  type DraftEditableContent,
  type DraftLease,
  type DraftLeaseHolder,
  type MailDraft,
  type MailDraftSeed,
} from "../../contracts";
import { type MailDraftDocumentClient, type MailSharedDraftState, openMailDraftDocumentClient } from "../../lib/draft-document-client";
import { parseMailLiveEvent } from "../../live-event";
import { readApiError, readApiFailure } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";
import {
  advanceMailDraftJournalAfterSave,
  type MailDraftJournal,
  mailDraftJournalKey,
  readMailDraftJournal,
  serializeMailDraftContent,
  serializeMailDraftJournal,
} from "./mail-draft-journal";
import { classifyDraftLeaseAnswer, type DraftLeaseResult, recoverDraftLeaseRequest } from "./mail-draft-lease-recovery";
import { isClosedMailDraft, type MailDraftLifecycleTransition, reconcileMailDraftLifecycle } from "./mail-draft-lifecycle";
import { storeMailDraftSeed } from "./mail-draft-seed-store";

import { MailUserDraftStorageEndedError, openMailUserDraftStorage } from "./mail-user-draft-storage";

type ComposerStatus = "local" | "preparing" | "saved" | "saving" | "error" | "readonly";
type RegainLeaseResult = AcquiredDraftLease | null | "cancelled";

export type MailDraftLeaseConflict = {
  lease: DraftLease | null;
  reason: "occupied" | "lost";
};

export const createSerializedDraftMutationQueue = () => {
  let queue: Promise<void> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
};

/** How often an open composer renews its lease, and how often it tries again after Mail stopped answering. */
const LEASE_HEARTBEAT_MS = 10_000;

/** Reports the exclusive-lease rejection the API raises when another session owns the draft. */
export const isDraftLeaseHeldResponse = async (response: { status: number; clone(): Pick<Response, "json"> }): Promise<boolean> => {
  if (response.status !== 409) return false;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && "code" in body && body.code === DRAFT_LEASE_ERROR_CODES.HELD;
  } catch {
    return false;
  }
};
const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

const draftEditableContent = (draft: MailDraft): DraftEditableContent => ({
  senderIdentityId: draft.senderIdentityId,
  signatureTemplateId: draft.signatureTemplateId,
  to: draft.to,
  cc: draft.cc,
  bcc: draft.bcc,
  subject: draft.subject,
  body: draft.body,
  format: draft.format,
  priority: draft.priority,
  requestDeliveryReceipt: draft.requestDeliveryReceipt,
  requestReadReceipt: draft.requestReadReceipt,
});

export const draftSeedContentChanged = (seed: MailDraftSeed, content: DraftEditableContent): boolean =>
  serializeMailDraftContent(content) !== serializeMailDraftContent(seed.content);

export const reconcileDraftSessionAfterLiveInvalidation = async (operations: {
  refreshLifecycle: () => Promise<void>;
  hasLifecycleTransition: () => boolean;
  resumeLease: () => Promise<void>;
}): Promise<void> => {
  await operations.refreshLifecycle();
  if (!operations.hasLifecycleTransition()) await operations.resumeLease();
};

export const createMailDraftSession = (options: {
  mailboxId: string;
  currentActor: Pick<DraftLeaseHolder, "kind" | "id">;
  initialDraft?: MailDraft;
  initialSeed?: MailDraftSeed;
  hasVerifiedIdentity: () => boolean;
  content: () => DraftEditableContent;
  applyDraftContent: (content: DraftEditableContent, source?: "shared") => void;
  isDisposed: () => boolean;
  onRecovered: () => void;
  onMaterialized: (draft: MailDraft) => void;
  locale: Accessor<string>;
}) => {
  const t = () => mailComposerMessages.resolve([options.locale()]).t;
  const [draft, setDraft] = createSignal<MailDraft | null>(options.initialDraft ?? null);
  const [shared, setShared] = createSignal<MailDraftDocumentClient | null>(null);
  const [sharedState, setSharedState] = createSignal<MailSharedDraftState | null>(null);
  const sharedController = new AbortController();
  const isShared = () => draft()?.editMode === "shared";
  const [lease, setLease] = createSignal<AcquiredDraftLease | null>(null);
  const [authenticationRequired, setAuthenticationRequired] = createSignal(false);
  const [leaseConflict, setLeaseConflict] = createSignal<MailDraftLeaseConflict | null>(null);
  const [status, setStatus] = createSignal<ComposerStatus>(options.initialSeed ? "local" : "preparing");
  const [statusMessage, setStatusMessage] = createSignal(options.initialSeed ? "" : t().preparingDraft);
  const [lifecycleTransition, setLifecycleTransition] = createSignal<MailDraftLifecycleTransition | null>(null);
  const [initialized, setInitialized] = createSignal(false);
  const [revisionConflict, setRevisionConflict] = createSignal(false);
  let pendingSave: { revision: number; content: DraftEditableContent; reconciled?: boolean } | null = null;
  let conflictBaseRevision: number | null = null;
  const [journalVersion, setJournalVersion] = createSignal(0);
  const [materializedLeasePending, setMaterializedLeasePending] = createSignal(false);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatController: AbortController | null = null;
  let heartbeatGeneration = 0;
  let initializePromise: Promise<MailDraft | null> | null = null;
  let regainPromise: Promise<RegainLeaseResult> | null = null;
  // A retried acquire whose answer was lost gets this instance's lease back instead of reading it as another tab.
  const editorId = crypto.randomUUID();
  const seedBaseline = options.initialSeed ? serializeMailDraftContent(options.initialSeed.content) : null;
  let lastSavedContent = seedBaseline ?? "";
  let confirmedDigest: { content: string; digest: string } | null = null;
  const [localCopyFailed, setLocalCopyFailed] = createSignal(false);
  const markSaved = (content: DraftEditableContent) => {
    lastSavedContent = serializeMailDraftContent(content);
  };
  const serializeMutation = createSerializedDraftMutationQueue();

  const serializedContent = () => serializeMailDraftContent(options.content());
  let userStorage: ReturnType<typeof openMailUserDraftStorage> | undefined;
  let navigationAllowed = false;
  const draftStorage = () => {
    if (!userStorage) throw new Error(t().draftPrepareFailed);
    return userStorage;
  };
  const draftKey = (draftId: string) => mailDraftJournalKey(options.mailboxId, draftId);
  const backupKey = (draftId: string) => `${draftKey(draftId)}:editor:${editorId}`;
  const journalPointerKey = (draftId: string) => `cloud:user:${options.currentActor.id}:mail:journal:${options.mailboxId}:${draftId}`;
  const writeJournal = (draftId: string, journal: MailDraftJournal) => {
    const raw = serializeMailDraftJournal({
      ...journal,
      // A conflict's server snapshot is not this input's confirmed base.
      // Never turn it into evidence for an automatic rebase on the next reload.
      confirmedDigest: !revisionConflict() && confirmedDigest?.content === lastSavedContent ? confirmedDigest.digest : undefined,
      pendingSave: revisionConflict() ? undefined : (pendingSave ?? undefined),
    } satisfies MailDraftJournal);
    // Each open editor retains its own input even if another tab writes the
    // shared handoff journal. The pointer contains no text and survives reload.
    draftStorage().setItem(backupKey(draftId), raw);
    try {
      window.sessionStorage.setItem(journalPointerKey(draftId), backupKey(draftId));
    } catch {
      /* Other device copies remain available. */
    }
    try {
      draftStorage().setItem(draftKey(draftId), raw);
    } catch (error) {
      if (error instanceof MailUserDraftStorageEndedError) throw error;
      // The per-editor copy already protects this tab; handoff is best-effort.
    }
    setLocalCopyFailed(false);
  };
  const tryWriteJournal = (draftId: string, journal: MailDraftJournal) => {
    try {
      writeJournal(draftId, journal);
    } catch (error) {
      if (error instanceof MailUserDraftStorageEndedError) throw error;
      setLocalCopyFailed(true);
    }
  };
  const localRecoveryCopies = createMemo(() => {
    journalVersion();
    const currentDraft = draft();
    if (!currentDraft || !lease() || isShared()) return [];
    if (!userStorage) return [];
    const storage = userStorage;
    const prefix = `${draftKey(currentDraft.id)}:editor:`;
    const copies: Array<{ id: string; revision: number; content: DraftEditableContent }> = [];
    const seen = new Set([untrack(serializedContent), lastSavedContent]);
    try {
      for (const key of storage.keys()) {
        if (!key.startsWith(prefix) || key === backupKey(currentDraft.id)) continue;
        const journal = readMailDraftJournal(storage, key);
        if (!journal) continue;
        const serialized = serializeMailDraftContent(journal.content);
        if (seen.has(serialized)) continue;
        seen.add(serialized);
        copies.push({ id: key, ...journal });
      }
    } catch {
      return [];
    }
    return copies;
  });
  const stopHeartbeat = () => {
    heartbeatGeneration += 1;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatController?.abort();
    heartbeatController = null;
  };
  const stopScheduledSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
  };

  const waitForSignIn = () => {
    stopScheduledSave();
    stopHeartbeat();
    setAuthenticationRequired(true);
    setLease(null);
    setLeaseConflict(null);
    setStatus("readonly");
    setStatusMessage(t().signInExpired);
  };

  const applyClosedDraft = (currentDraft: MailDraft) => {
    if (options.isDisposed() || authenticationRequired()) return;
    const transition = reconcileMailDraftLifecycle(lifecycleTransition(), currentDraft, serializedContent() !== lastSavedContent);
    if (!transition || !isClosedMailDraft(currentDraft)) return;
    stopScheduledSave();
    stopHeartbeat();
    if (isShared()) shared()?.freeze();
    setLease(null);
    setLeaseConflict(null);
    setDraft(currentDraft);
    setLifecycleTransition(transition);
    setStatus("readonly");
    const name = currentDraft.lastEditedByDisplayName;
    setStatusMessage(
      currentDraft.state === "scheduled"
        ? t().lifecycleScheduled({ name })
        : currentDraft.state === "sending"
          ? t().lifecycleSending({ name })
          : currentDraft.state === "sent"
            ? t().lifecycleSent({ name })
            : t().lifecycleDiscarded({ name }),
    );
  };

  const refreshDraftLifecycle = async (): Promise<void> => {
    const currentDraft = draft();
    if (!currentDraft) return;
    const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({
      param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
    });
    if (response.status === 401) return waitForSignIn();
    if (!response.ok) throw new Error(await readApiError(response, t().draftStatusRefreshFailed));
    applyClosedDraft(await response.json());
  };

  const releaseLeaseOnExit = (): Promise<void> => {
    const currentDraft = draft();
    const currentLease = lease();
    if (!currentDraft || !currentLease) return Promise.resolve();
    return fetch(`/api/mail/mailboxes/${options.mailboxId}/drafts/${currentDraft.id}/lease`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentLease.token }),
      credentials: "same-origin",
      keepalive: true,
    })
      .then(() => undefined)
      .catch(() => undefined);
  };

  const releaseLease = async (currentDraft: MailDraft): Promise<void> => {
    const currentLease = lease();
    if (!currentLease) return;
    stopHeartbeat();
    try {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease.$delete({
        param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
        json: { token: currentLease.token },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().draftEditingTransferFailed));
      setLease(null);
    } catch (error) {
      startHeartbeat();
      throw error;
    }
  };

  const leaseAnswer = async (response: {
    status: number;
    json(): Promise<unknown>;
  }): Promise<Exclude<DraftLeaseResult, { kind: "ok" }>> => {
    const kind = classifyDraftLeaseAnswer(response.status, await response.json().catch(() => null));
    return { kind: kind === "ok" ? "failed" : kind };
  };

  const heartbeatLease = async (
    currentDraft: MailDraft,
    currentLease: AcquiredDraftLease,
    signal?: AbortSignal,
  ): Promise<DraftLeaseResult> => {
    try {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease.$put(
        {
          param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
          json: { token: currentLease.token },
        },
        { init: { signal } },
      );
      return response.ok ? { kind: "ok", lease: await response.json() } : leaseAnswer(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: "unavailable" };
    }
  };

  const readCurrentLease = async (currentDraft: MailDraft): Promise<DraftLease | null> => {
    try {
      const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease.$get({
        param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const reportLeaseConflict = async (
    currentDraft: MailDraft,
    reason: MailDraftLeaseConflict["reason"],
    knownLease?: DraftLease | null,
  ): Promise<void> => {
    const current = knownLease ?? (await readCurrentLease(currentDraft));
    if (options.isDisposed() || authenticationRequired()) return;
    setLeaseConflict({ lease: current, reason });
    setStatus("readonly");
    setStatusMessage(current ? t().editingByNamed({ name: current.holder.displayName }) : t().draftOpenAnotherSession);
  };

  const acceptLease = (acquired: AcquiredDraftLease) => {
    setLease(acquired);
    setLeaseConflict(null);
    // Lease work must not clear an in-flight save or its result.
    if (revisionConflict()) {
      setStatus("error");
      setStatusMessage(t().draftRevisionConflict);
    } else if (status() === "preparing" || status() === "readonly") {
      setStatus("saved");
      setStatusMessage("");
    }
    startHeartbeat();
  };

  const failLease = async () => {
    await refreshDraftLifecycle().catch(() => undefined);
    if (options.isDisposed() || lifecycleTransition() || authenticationRequired()) return;
    stopHeartbeat();
    setLease(null);
    setLeaseConflict(null);
    setStatus("error");
    setStatusMessage(t().editingStartFailed);
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    heartbeatTimer = setTimeout(() => void resumeCurrentLease({ quiet: true }), LEASE_HEARTBEAT_MS);
  };

  const waitForConnection = () => {
    stopHeartbeat();
    setLeaseConflict(null);
    setStatus("readonly");
    setStatusMessage(t().connectionLost);
    heartbeatTimer = setTimeout(() => void resumeCurrentLease({ quiet: true }), LEASE_HEARTBEAT_MS);
  };

  // No draft snapshot is adopted here: local text and expectedRevision survive a silent re-acquire.
  const runRegainLease = async (
    currentDraft: MailDraft,
    reason: MailDraftLeaseConflict["reason"],
    { sameHolderGraceMs = 0, takeover = false }: { sameHolderGraceMs?: number; takeover?: boolean } = {},
  ): Promise<RegainLeaseResult> => {
    if (options.isDisposed()) return "cancelled";
    if (lifecycleTransition() || isClosedMailDraft(currentDraft)) return null;
    stopHeartbeat();
    const generation = heartbeatGeneration;
    const controller = new AbortController();
    heartbeatController = controller;
    const startedAt = Date.now();
    const deadline = startedAt + sameHolderGraceMs;
    let delayMs = 250;
    try {
      while (!controller.signal.aborted && !options.isDisposed()) {
        const result = await recoverDraftLeaseRequest({
          run: async (): Promise<DraftLeaseResult> => {
            try {
              const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease.$post({
                param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
                json: { takeover, editorId },
              });
              if (!response.ok) return leaseAnswer(response);
              const grantedLease = await response.json();
              if (controller.signal.aborted || options.isDisposed() || generation !== heartbeatGeneration) {
                await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease
                  .$delete({
                    param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
                    json: { token: grantedLease.token },
                  })
                  .catch(() => undefined);
                return { kind: "failed" };
              }
              return { kind: "ok", lease: grantedLease };
            } catch (error) {
              if (controller.signal.aborted) throw error;
              return { kind: "unavailable" };
            }
          },
          signal: controller.signal,
        });
        if (options.isDisposed() || controller.signal.aborted || generation !== heartbeatGeneration) {
          if (result.kind === "ok")
            await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].lease
              .$delete({
                param: { mailboxId: options.mailboxId, draftId: currentDraft.id },
                json: { token: result.lease.token },
              })
              .catch(() => undefined);
          return "cancelled";
        }
        if (result.kind === "ok") {
          acceptLease(result.lease);
          return result.lease;
        }
        if (result.kind === "held") {
          const current = await readCurrentLease(currentDraft);
          if (options.isDisposed() || controller.signal.aborted || generation !== heartbeatGeneration) return "cancelled";
          const sameActor = current?.holder.kind === options.currentActor.kind && current.holder.id === options.currentActor.id;
          if (!current || (sameActor && Date.now() < deadline)) {
            // An unreadable/released lease is not proof of another editor. Bound retries to one heartbeat.
            const remaining = (current ? deadline : startedAt + LEASE_HEARTBEAT_MS) - Date.now();
            if (remaining <= 0) {
              waitForConnection();
              return null;
            }
            await new Promise<void>((resolve) => {
              const finish = () => {
                controller.signal.removeEventListener("abort", finish);
                resolve();
              };
              controller.signal.addEventListener("abort", finish, { once: true });
              heartbeatTimer = setTimeout(finish, Math.min(delayMs, remaining));
            });
            delayMs *= 2;
            continue;
          }
          setLease(null);
          stopHeartbeat();
          await refreshDraftLifecycle().catch(() => undefined);
          if (!options.isDisposed() && !lifecycleTransition()) await reportLeaseConflict(currentDraft, reason, current);
          return null;
        }
        if (result.kind === "unauthorized") waitForSignIn();
        else if (result.kind === "unavailable") waitForConnection();
        else await failLease();
        return null;
      }
    } catch (error) {
      if (!options.isDisposed() && !controller.signal.aborted && generation === heartbeatGeneration && !isAbortError(error)) {
        waitForConnection();
        return null;
      }
    } finally {
      if (heartbeatController === controller) heartbeatController = null;
    }
    return "cancelled";
  };

  /**
   * One acquire at a time. A live echo or a heartbeat that cancelled an acquire in flight could leave a lease the
   * server granted to this tab without its token, and the next acquire would read it as another tab.
   */
  const regainLease = (
    currentDraft: MailDraft,
    reason: MailDraftLeaseConflict["reason"],
    options: { sameHolderGraceMs?: number; takeover?: boolean } = {},
  ): Promise<RegainLeaseResult> => {
    if (regainPromise && !options.takeover) return regainPromise;
    // A takeover cancels the acquire in flight and starts once it settled, so that acquire cannot release the new lease.
    const previous = regainPromise;
    if (previous) stopHeartbeat();
    const work = (previous ?? Promise.resolve(null))
      .then(() => runRegainLease(currentDraft, reason, options))
      .finally(() => {
        if (regainPromise === work) regainPromise = null;
      });
    regainPromise = work;
    return work;
  };

  const acquireLease = async (currentDraft: MailDraft, takeover = false, sameHolderGraceMs = 0): Promise<AcquiredDraftLease | null> => {
    if (currentDraft.editMode === "shared") return null;
    const result = await regainLease(currentDraft, "occupied", { takeover, sameHolderGraceMs });
    return result === "cancelled" ? null : result;
  };

  const recoverJournal = async (key: string, minimumRevision: number, allowHandoff = true): Promise<boolean> => {
    const draftId = draft()?.id ?? options.initialSeed?.id;
    let previous: string | null = null;
    try {
      previous = draftId ? window.sessionStorage.getItem(journalPointerKey(draftId)) : null;
    } catch {
      /* Use the handoff journal. */
    }
    const ownJournal = previous?.startsWith(`${key}:editor:`) ? readMailDraftJournal(draftStorage(), previous) : null;
    const journal = ownJournal ?? (allowHandoff ? readMailDraftJournal(draftStorage(), key) : null);
    if (!journal) return false;
    if (ownJournal && previous && draftId && previous !== backupKey(draftId)) {
      // Move this tab's predecessor only after the new backup and pointer exist.
      try {
        draftStorage().setItem(backupKey(draftId), JSON.stringify(journal));
        window.sessionStorage.setItem(journalPointerKey(draftId), backupKey(draftId));
        draftStorage().removeItem(previous);
      } catch (error) {
        if (error instanceof MailUserDraftStorageEndedError) throw error;
        setLocalCopyFailed(true);
        /* The predecessor remains available if the pointer cannot be moved. */
      }
    }
    // An older revision can contain input typed AFTER a save whose answer was
    // lost. Keep it visible, but never overwrite a newer server draft silently.
    if (journal.revision < minimumRevision && serializeMailDraftContent(journal.content) !== lastSavedContent) {
      const confirmed = journal.confirmedContent && serializeMailDraftContent(journal.confirmedContent);
      const submitted = journal.pendingSave && serializeMailDraftContent(journal.pendingSave.content);
      if (
        confirmed !== lastSavedContent &&
        submitted !== lastSavedContent &&
        journal.confirmedDigest !== (await cryptoUtils.common.hash(lastSavedContent))
      ) {
        conflictBaseRevision = journal.revision;
        setRevisionConflict(true);
      }
    }
    if (!revisionConflict() && journal.pendingSave && serializeMailDraftContent(journal.pendingSave.content) !== lastSavedContent) {
      // Reload can happen while the old request is still committing. Resolve
      // that exact write before sending the newer journal input as another PUT.
      pendingSave = journal.pendingSave;
    }
    if (options.isDisposed()) return false;
    options.applyDraftContent(journal.content);
    return true;
  };

  let rememberDevice: boolean | undefined;
  const initializeShared = async (currentDraft: MailDraft) => {
    if (shared()) return currentDraft;
    if (options.currentActor.kind !== "user") throw new Error(t().editingStartFailed);
    const client = await openMailDraftDocumentClient({
      mailboxId: options.mailboxId,
      draft: currentDraft,
      userId: options.currentActor.id,
      locale: options.locale,
      signal: sharedController.signal,
      rememberDevice,
      onAuthenticationRequired: () => {
        if (!options.isDisposed()) waitForSignIn();
      },
      onState: (next) => {
        if (options.isDisposed()) return;
        batch(() => {
          setSharedState(next);
          if (authenticationRequired()) return;
          setStatus(next.terminal ? "readonly" : next.saving ? "saving" : next.error ? "error" : "saved");
          setStatusMessage(next.message);
        });
      },
      onContent: (next) => {
        if (!options.isDisposed()) batch(() => options.applyDraftContent(next, "shared"));
      },
      onDurable: (next, revision) => {
        markSaved(next);
        if (!options.isDisposed()) setDraft((current) => (current ? { ...current, ...next, revision } : current));
      },
      onFrozen: () => {
        void refreshDraftLifecycle().catch(() => undefined);
      },
    });
    if (options.isDisposed()) {
      client.dispose();
      return null;
    }
    markSaved(draftEditableContent(currentDraft));
    setShared(client);
    if (!client.state().terminal && currentDraft.generation !== client.generation) {
      setDraft((current) => (current ? { ...current, generation: client.generation } : current));
    }
    setInitialized(true);
    return currentDraft;
  };

  const initialize = async (): Promise<MailDraft | null> => {
    if (!options.hasVerifiedIdentity()) {
      setStatus("readonly");
      setStatusMessage(t().configureVerifiedIdentity);
      return null;
    }
    const currentDraft = draft();
    if (!currentDraft) return null;
    if (options.isDisposed()) return null;
    if (currentDraft.editMode === "shared") return initializeShared(currentDraft);
    if (isClosedMailDraft(currentDraft)) {
      markSaved(draftEditableContent(currentDraft));
      try {
        // A peer can send while this tab is offline. Its own unsent typing
        // must survive reload without importing another tab's handoff copy.
        if (await recoverJournal(draftKey(currentDraft.id), currentDraft.revision, false)) options.onRecovered();
      } catch (error) {
        if (error instanceof MailUserDraftStorageEndedError) throw error;
        setLocalCopyFailed(true);
      }
      if (options.isDisposed()) return null;
      setInitialized(true);
      applyClosedDraft(currentDraft);
      return currentDraft;
    }
    const acquired = await acquireLease(currentDraft, false, LEASE_HEARTBEAT_MS);
    if (options.isDisposed()) return null;
    markSaved(draftEditableContent(currentDraft));
    setDraft(currentDraft);
    setInitialized(true);
    if (acquired) setStatus("preparing");
    let recovered = false;
    try {
      recovered = await recoverJournal(draftKey(currentDraft.id), currentDraft.revision, Boolean(acquired));
    } catch (error) {
      if (error instanceof MailUserDraftStorageEndedError) throw error;
      setLocalCopyFailed(true);
    }
    if (recovered) options.onRecovered();
    try {
      const storage = draftStorage();
      for (const key of storage.keys()) {
        if (!key.startsWith(`${draftKey(currentDraft.id)}:editor:`)) continue;
        const journal = readMailDraftJournal(storage, key);
        if (journal && !journal.pendingSave && serializeMailDraftContent(journal.content) === lastSavedContent) storage.removeItem(key);
      }
    } catch (error) {
      if (error instanceof MailUserDraftStorageEndedError) throw error;
      setLocalCopyFailed(true);
    }
    if (acquired) {
      setStatus("saved");
      setStatusMessage("");
      if (revisionConflict()) {
        setStatus("error");
        setStatusMessage(t().draftRevisionConflict);
      }
    }
    return currentDraft;
  };

  const ensureDraft = (): Promise<MailDraft | null> => {
    if (authenticationRequired()) return Promise.resolve(null);
    if (draft() && (lease() || shared())) return Promise.resolve(draft());
    if (initializePromise) return initializePromise;
    initializePromise = initialize()
      .catch((error: unknown) => {
        if (!options.isDisposed() && !authenticationRequired()) {
          setStatus("error");
          setStatusMessage(
            error instanceof MailUserDraftStorageEndedError
              ? t().deviceSessionEnded
              : error instanceof Error
                ? error.message
                : t().draftPrepareFailed,
          );
        }
        return null;
      })
      .finally(() => {
        initializePromise = null;
      });
    return initializePromise;
  };

  const runPersist = async (): Promise<MailDraft | null> => {
    return await serializeMutation(async () => {
      if (lifecycleTransition() || authenticationRequired() || revisionConflict()) return null;
      if (isShared()) {
        const current = await ensureDraft();
        const client = shared();
        if (!current || !client) return null;
        try {
          client.edit(untrack(options.content));
          await client.save();
          return authenticationRequired() ? null : draft();
        } catch (error) {
          if (authenticationRequired()) return null;
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : t().draftSaveFailed);
          return null;
        }
      }
      let currentDraft = draft();
      if (!currentDraft && options.initialSeed) {
        const nextContent = options.content();
        setStatus("saving");
        setStatusMessage(t().savingDraft);
        const response = await apiClient.mailboxes[":mailboxId"]["draft-seeds"].materialize.$post({
          param: { mailboxId: options.mailboxId },
          json: {
            idempotencyKey: options.initialSeed.id,
            origin: options.initialSeed.origin,
            draft: nextContent,
          },
        });
        if (!response.ok) {
          if (options.isDisposed()) return null;
          if (response.status === 401) {
            waitForSignIn();
            return null;
          }
          setStatus("error");
          setStatusMessage(await readApiError(response, t().draftSaveFailed));
          return null;
        }
        currentDraft = await response.json();
        markSaved(draftEditableContent(currentDraft));
        batch(() => {
          setMaterializedLeasePending(true);
          setDraft(currentDraft);
        });
        try {
          options.onMaterialized(currentDraft);
          draftStorage().removeItem(draftKey(options.initialSeed.id));
          draftStorage().removeItem(backupKey(options.initialSeed.id));
        } catch {
          // URL and local-seed cleanup are best-effort; the durable draft remains authoritative.
        }
        if (options.isDisposed()) return currentDraft;
        if (currentDraft.editMode === "shared") {
          const latestInput = untrack(options.content);
          try {
            await initializeShared(currentDraft);
            const client = shared();
            if (!client) return null;
            client.edit(latestInput);
            await client.save();
            return authenticationRequired() ? null : draft();
          } catch (error) {
            if (!options.isDisposed() && !authenticationRequired()) {
              setStatus("error");
              setStatusMessage(error instanceof Error ? error.message : t().draftSaveFailed);
            }
            return null;
          } finally {
            setMaterializedLeasePending(false);
          }
        }
        // The person keeps typing while the first lease arrives; the journal and the save below keep that text.
        const acquired = await acquireLease(currentDraft, false, LEASE_HEARTBEAT_MS).finally(() => setMaterializedLeasePending(false));
        // A retried materialization returns the draft its first request stored, which can predate the
        // editor's current content; the save below brings the draft up to date before anyone uses it.
        if (!acquired) return serializedContent() === lastSavedContent ? currentDraft : null;
        if (serializedContent() === lastSavedContent) {
          setStatus("saved");
          setStatusMessage("");
          return currentDraft;
        }
      }
      if (!currentDraft || !lease()) {
        currentDraft = await ensureDraft();
      }
      if (!currentDraft || !lease()) return null;
      // Resolve the exact uncertain PUT before saving newer typing. Reusing
      // its input lets the server confirm a committed save without overwriting.
      const nextContent = pendingSave?.content ?? options.content();
      const serialized = serializeMailDraftContent(nextContent);
      if (!pendingSave && serialized === lastSavedContent) return currentDraft;
      setStatus("saving");
      setStatusMessage(t().savingDraft);
      const saveDraft = currentDraft;
      // SHA-256 is an equality proof for recovery, never a weak hash that could rebase over peer text.
      if (confirmedDigest?.content !== lastSavedContent)
        confirmedDigest = { content: lastSavedContent, digest: await cryptoUtils.common.hash(lastSavedContent) };
      const savedDigest = await cryptoUtils.common.hash(serialized);
      pendingSave ??= { revision: saveDraft.revision, content: nextContent };
      const saveRevision = pendingSave.revision;
      tryWriteJournal(saveDraft.id, { revision: saveRevision, content: options.content() });
      const { response, kind } = await recoverDraftLeaseRequest({
        run: async () => {
          const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$put({
            param: { mailboxId: options.mailboxId, draftId: saveDraft.id },
            json: { expectedRevision: saveRevision, draft: nextContent },
          });
          const body: unknown =
            response.status === 409
              ? await response
                  .clone()
                  .json()
                  .catch(() => null)
              : null;
          const busy = typeof body === "object" && body !== null && "code" in body && body.code === DRAFT_LEASE_ERROR_CODES.BUSY;
          return { response, kind: busy ? "unavailable" : "done" };
        },
        signal: new AbortController().signal,
      });
      if (!response.ok) {
        if (options.isDisposed()) return null;
        if (lifecycleTransition() || authenticationRequired()) return null;
        if (response.status === 401) {
          waitForSignIn();
          return null;
        }
        if (await isDraftLeaseHeldResponse(response)) {
          stopHeartbeat();
          setLease(null);
          await refreshDraftLifecycle().catch(() => undefined);
          if (options.isDisposed() || lifecycleTransition()) return null;
          await reportLeaseConflict(currentDraft, "lost");
          return null;
        }
        const failure = await readApiFailure(response, t().draftSaveFailed);
        let conflictRefreshed = false;
        if (failure.code === "CONFLICT") {
          // An attachment/calendar write may have committed without an answer.
          // Advance only when all editable fields still match our confirmed base;
          // a peer's text must never be overwritten by a blind revision refresh.
          const latestResponse = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$get({
            param: { mailboxId: options.mailboxId, draftId: saveDraft.id },
          });
          if (latestResponse.status === 401) {
            waitForSignIn();
            return null;
          }
          const latest = latestResponse.ok ? await latestResponse.json() : null;
          if (latest) {
            conflictRefreshed = true;
            if (latest.state !== "draft") {
              applyClosedDraft(latest);
              return null;
            }
            if (
              !pendingSave?.reconciled &&
              latest.revision > saveRevision &&
              serializeMailDraftContent(draftEditableContent(latest)) === lastSavedContent
            ) {
              pendingSave = { revision: latest.revision, content: nextContent, reconciled: true };
              setDraft(latest);
              return latest;
            }
          }
          if (latest) {
            if (latest.revision > saveRevision || serializeMailDraftContent(draftEditableContent(latest)) !== lastSavedContent) {
              conflictBaseRevision = saveRevision;
              setRevisionConflict(true);
              setDraft(latest);
            }
          }
          if (latest && !revisionConflict()) setDraft(latest);
          pendingSave = null;
        } else if (response.status < 500 && kind !== "unavailable") pendingSave = null;
        const message = revisionConflict() ? t().draftRevisionConflict : kind === "unavailable" ? t().draftSaveFailed : failure.message;
        setStatus("error");
        setStatusMessage(message);
        if (failure.code === "CONFLICT" && !conflictRefreshed) {
          setDraft((current) =>
            current
              ? {
                  ...current,
                  recoveryCopyCount: current.recoveryCopyCount + 1,
                }
              : current,
          );
        }
        return null;
      }
      const saved = await response.json();
      pendingSave = null;
      // A committed server revision must be accepted before best-effort device cleanup.
      batch(() => {
        markSaved(nextContent);
        confirmedDigest = { content: serialized, digest: savedDigest };
        if (!options.isDisposed()) setDraft(saved);
      });
      try {
        const storage = draftStorage();
        const own = storage.getItem(backupKey(saved.id));
        if (!own || storage.getItem(draftKey(saved.id)) === own)
          advanceMailDraftJournalAfterSave({
            storage,
            key: draftKey(saved.id),
            revision: saved.revision,
            savedContent: nextContent,
            confirmedDigest: savedDigest,
          });
        advanceMailDraftJournalAfterSave({
          storage,
          key: backupKey(saved.id),
          revision: saved.revision,
          savedContent: nextContent,
          confirmedDigest: savedDigest,
        });
        for (const key of storage.keys()) {
          if (!key.startsWith(`${draftKey(saved.id)}:editor:`)) continue;
          const journal = readMailDraftJournal(storage, key);
          if (journal && serializeMailDraftContent(journal.content) === serialized) storage.removeItem(key);
        }
        setJournalVersion((version) => version + 1);
      } catch (error) {
        if (error instanceof MailUserDraftStorageEndedError) throw error;
        setLocalCopyFailed(true);
      }
      if (options.isDisposed()) return saved;
      if (authenticationRequired()) return null;
      setStatus(revisionConflict() ? "error" : "saved");
      setStatusMessage(revisionConflict() ? t().draftRevisionConflict : "");
      return saved;
    })
      .then(async (saved) => {
        if (
          saved &&
          !options.isDisposed() &&
          !authenticationRequired() &&
          !revisionConflict() &&
          !isShared() &&
          (pendingSave || serializedContent() !== lastSavedContent)
        )
          return runPersist();
        return saved;
      })
      .catch((error: unknown) => {
        if (!options.isDisposed() && !authenticationRequired()) {
          setStatus("error");
          setStatusMessage(error instanceof TypeError ? t().draftSaveFailed : error instanceof Error ? error.message : t().draftSaveFailed);
        }
        return null;
      });
  };

  let persistPromise: Promise<MailDraft | null> | null = null;
  const persist = (): Promise<MailDraft | null> => {
    persistPromise ??= runPersist().finally(() => {
      persistPromise = null;
    });
    return persistPromise;
  };

  /** `quiet` keeps a read-only composer as it is while the attempt runs. */
  const resumeCurrentLease = async ({ quiet = false }: { quiet?: boolean } = {}): Promise<void> => {
    const currentDraft = draft();
    const currentLease = lease();
    if (options.isDisposed() || !currentDraft || authenticationRequired()) return;
    if (isShared()) {
      shared()?.provider.reconnectNow();
      return;
    }
    // A live echo during the initial grace must not cancel that acquire and turn it into a takeover warning.
    if (initializePromise) return void (await initializePromise);
    if (regainPromise) {
      const result = await regainPromise;
      if (result === "cancelled" && !options.isDisposed()) await resumeCurrentLease({ quiet });
      return;
    }
    if (!currentLease) return void (await ensureDraft());
    stopHeartbeat();
    const generation = heartbeatGeneration;
    if (!quiet && status() === "readonly") setStatus("preparing");
    const controller = new AbortController();
    heartbeatController = controller;
    let heartbeat: DraftLeaseResult;
    try {
      heartbeat = await recoverDraftLeaseRequest({
        run: () => heartbeatLease(currentDraft, currentLease, controller.signal),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.isDisposed() || generation !== heartbeatGeneration || isAbortError(error)) return;
      heartbeat = { kind: "unavailable" };
    } finally {
      if (heartbeatController === controller) heartbeatController = null;
    }
    if (options.isDisposed() || generation !== heartbeatGeneration) return;
    if (heartbeat.kind === "ok") return acceptLease(heartbeat.lease);
    if (heartbeat.kind === "unauthorized") return waitForSignIn();
    if (heartbeat.kind === "unavailable") return waitForConnection();
    if (heartbeat.kind === "not-owned" || heartbeat.kind === "held") {
      await regainLease(currentDraft, "lost");
      return;
    }
    await failLease();
  };

  const onPageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      if (!draft() || !lease()) return;
      stopHeartbeat();
      setStatus("preparing");
      return;
    }
    void releaseLeaseOnExit();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void resumeCurrentLease();
  };

  createEffect(() => {
    const serialized = serializedContent();
    const currentDraft = draft();
    if (currentDraft?.editMode === "shared") {
      const client = shared();
      if (client)
        untrack(() => {
          try {
            client.edit(options.content());
          } catch (error) {
            if (authenticationRequired()) return;
            setStatus("error");
            setStatusMessage(error instanceof Error ? error.message : t().draftSaveFailed);
          }
        });
      return;
    }
    if (!initialized() || (serialized === lastSavedContent && !pendingSave)) {
      if (!currentDraft && seedBaseline === serialized) stopScheduledSave();
      return;
    }
    const journalId = currentDraft?.id ?? options.initialSeed?.id;
    if (!journalId) return;
    try {
      tryWriteJournal(journalId, {
        revision: conflictBaseRevision ?? currentDraft?.revision ?? 0,
        content: options.content(),
      });
    } catch {
      setStatus("error");
      setStatusMessage(t().deviceSessionEnded);
      stopScheduledSave();
      return;
    }
    if ((currentDraft && !lease()) || revisionConflict() || saveTimer) return;
    // Coalesce the latest input without postponing autosave forever during
    // continuous typing. The shared promise keeps at most one save in flight.
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, 700);
  });

  onMount(() => {
    if (options.currentActor.kind === "user") {
      try {
        userStorage = openMailUserDraftStorage(localStorage, options.currentActor.id);
      } catch {
        /* Save reports unavailable device storage. */
      }
    }
    const guardUnsaved = (event: BeforeUnloadEvent) => {
      if (navigationAllowed) {
        navigationAllowed = false;
        return;
      }
      if (!isShared() && serializedContent() !== lastSavedContent) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const refreshJournals = () => setJournalVersion((version) => version + 1);
    window.addEventListener("beforeunload", guardUnsaved);
    window.addEventListener("storage", refreshJournals);
    onCleanup(() => {
      window.removeEventListener("beforeunload", guardUnsaved);
      window.removeEventListener("storage", refreshJournals);
    });
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    if (!options.hasVerifiedIdentity()) {
      setStatus("readonly");
      setStatusMessage(t().configureVerifiedIdentity);
      return;
    }
    if (options.initialSeed) {
      void recoverJournal(draftKey(options.initialSeed.id), 0)
        .then((recovered) => {
          setInitialized(true);
          if (recovered) options.onRecovered();
        })
        .catch((error: unknown) => {
          if (error instanceof MailUserDraftStorageEndedError) {
            setStatus("error");
            setStatusMessage(t().deviceSessionEnded);
          } else {
            setLocalCopyFailed(true);
            setInitialized(true);
          }
        });
      return;
    }
    // A send, a discard, or another person's lease on this draft arrives as a change of its conversation or
    // mailbox. The lease heartbeat keeps the draft safe without live updates and resumes the lease after an
    // outage, so a subscription that ends leaves the composer as it is.
    const reconcile = () =>
      reconcileDraftSessionAfterLiveInvalidation({
        refreshLifecycle: refreshDraftLifecycle,
        hasLifecycleTransition: () => Boolean(lifecycleTransition()),
        resumeLease: () => resumeCurrentLease({ quiet: true }),
      });
    const live = liveConnection("/api/mail/live").subscribe(
      "mailbox",
      { mailbox: options.mailboxId },
      {
        cursor: null,
        parse: (data) => parseMailLiveEvent(data),
        apply: async (events) => {
          const conversationId = draft()?.conversationId ?? null;
          if (events.some(({ data }) => data.conversationId === null || data.conversationId === conversationId)) await reconcile();
        },
        resync: reconcile,
        unavailable: () => undefined,
      },
    );
    onCleanup(() => live.close());
    void ensureDraft();
  });

  onCleanup(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    }
    stopScheduledSave();
    stopHeartbeat();
    sharedController.abort();
    shared()?.dispose();
    void releaseLeaseOnExit();
  });

  const keepCurrentRecoveryCopy = () => {
    const currentDraft = draft();
    if (!currentDraft || isShared()) return;
    const current = options.content();
    const copies = [{ revision: conflictBaseRevision ?? currentDraft.revision, content: current }];
    const server = draftEditableContent(currentDraft);
    // Explicit restoration can replace either version. Keep both the editor
    // input and the loaded server version before applying the selected copy.
    if (serializeMailDraftContent(server) !== serializeMailDraftContent(current))
      copies.push({ revision: currentDraft.revision, content: server });
    const storage = draftStorage();
    const prefix = `${draftKey(currentDraft.id)}:editor:recovery:`;
    const retained = new Set(
      storage
        .keys()
        .filter((key) => key.startsWith(prefix))
        .map((key) => readMailDraftJournal(storage, key))
        .filter((journal) => journal !== null)
        .map((journal) => serializeMailDraftContent(journal.content)),
    );
    for (const copy of copies) {
      const serialized = serializeMailDraftContent(copy.content);
      if (retained.has(serialized)) continue;
      storage.setItem(`${prefix}${crypto.randomUUID()}`, JSON.stringify(copy satisfies MailDraftJournal));
      retained.add(serialized);
    }
    setJournalVersion((version) => version + 1);
  };

  const restoreRecoveryContent = (content: DraftEditableContent): boolean => {
    try {
      keepCurrentRecoveryCopy();
    } catch {
      setStatus("error");
      setStatusMessage(t().localMessageFailed);
      return false;
    }
    const currentDraft = draft();
    if (!currentDraft) return false;
    // Selecting a copy is an explicit replacement, at the loaded server
    // revision. A later peer edit still fails CAS; both replaced texts are backed up.
    batch(() => {
      conflictBaseRevision = null;
      pendingSave = null;
      markSaved(draftEditableContent(currentDraft));
      setRevisionConflict(false);
      options.applyDraftContent(content);
      setStatus("saved");
      setStatusMessage("");
    });
    return true;
  };

  return {
    draft,
    setDraft,
    acceptMutationDraft: (latest: MailDraft) => {
      if (isClosedMailDraft(latest)) return applyClosedDraft(latest);
      if (!isShared() && serializeMailDraftContent(draftEditableContent(latest)) !== lastSavedContent) {
        if (!pendingSave && !revisionConflict() && serializedContent() === lastSavedContent) {
          batch(() => {
            markSaved(draftEditableContent(latest));
            setDraft(latest);
            options.applyDraftContent(latest);
          });
          return;
        }
        conflictBaseRevision ??= draft()?.revision ?? latest.revision;
        pendingSave = null;
        setRevisionConflict(true);
        setStatus("error");
        setStatusMessage(t().draftRevisionConflict);
      }
      setDraft(latest);
    },
    keepCurrentRecoveryCopy,
    allowNavigation: () => {
      navigationAllowed = true;
    },
    acceptRestoredContent: () => {
      conflictBaseRevision = null;
      pendingSave = null;
      setRevisionConflict(false);
      markSaved(options.content());
    },
    shared,
    sharedState,
    isShared,
    retryShared: (remember?: boolean) => {
      rememberDevice = remember ?? true;
      return ensureDraft();
    },
    lease,
    setLease,
    materializedLeasePending,
    authenticationRequired,
    // Let a pending save advance the journal revision before navigation. A storage failure leaves the editor open.
    prepareSignIn: () =>
      serializeMutation(async () => {
        const currentDraft = draft();
        if (currentDraft?.editMode === "shared") {
          const client = shared();
          if (client) {
            client.edit(untrack(options.content));
            if (
              !(await client.flushLocal()) ||
              client.state().structuring ||
              serializeMailDraftContent(client.content()) !== serializedContent()
            )
              throw new Error(t().draftSaveFailed);
          } else if (serializedContent() !== serializeMailDraftContent(draftEditableContent(currentDraft))) {
            throw new Error(t().draftSaveFailed);
          }
          return;
        }
        const seed = options.initialSeed;
        if (!currentDraft && seed) storeMailDraftSeed(draftStorage(), { ...seed, createdAt: new Date().toISOString() });
        if (currentDraft || seed) {
          writeJournal(currentDraft?.id ?? seed!.id, {
            revision: conflictBaseRevision ?? currentDraft?.revision ?? 0,
            content: options.content(),
          });
        }
      }),
    leaseConflict,
    revisionConflict,
    localCopyFailed,
    localRecoveryCopies,
    restoreCurrentInput: () => restoreRecoveryContent(options.content()),
    restoreLocalRecoveryCopy: (id: string) => {
      const selected = localRecoveryCopies().find((copy) => copy.id === id);
      return selected ? restoreRecoveryContent(selected.content) : false;
    },
    lifecycleTransition,
    status,
    setStatus,
    statusMessage,
    setStatusMessage,
    ensureDraft,
    persist,
    serializeMutation,
    stopScheduledSave,
    stopHeartbeat,
    acquireLease,
    releaseLease,
    resumeCurrentLease,
    releaseLeaseOnExit,
    forgetJournal: (draftId: string, { closed = false }: { closed?: boolean } = {}) => {
      if (isShared()) return;
      try {
        const storage = draftStorage();
        if (closed || storage.getItem(draftKey(draftId)) === storage.getItem(backupKey(draftId))) storage.removeItem(draftKey(draftId));
        for (const key of storage.keys()) {
          if (!key.startsWith(`${draftKey(draftId)}:editor:`)) continue;
          const journal = readMailDraftJournal(storage, key);
          // Terminal cleanup removes archives, never a different live tab's
          // unsent typing. That tab can recover it even after the draft closes.
          if (
            (closed && key.startsWith(`${draftKey(draftId)}:editor:recovery:`)) ||
            key === backupKey(draftId) ||
            (journal && serializeMailDraftContent(journal.content) === serializedContent())
          )
            storage.removeItem(key);
        }
        setJournalVersion((version) => version + 1);
      } catch {
        /* A completed server action must still finish if device cleanup fails. */
      }
    },
    hasUnsavedChanges: () =>
      isShared()
        ? (sharedState()?.dirty ?? false)
        : !draft() && options.initialSeed
          ? draftSeedContentChanged(options.initialSeed, options.content())
          : serializedContent() !== lastSavedContent,
  };
};
