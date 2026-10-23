import { liveConnection } from "@k2b/cloud/browser/live";
import type { Accessor } from "solid-js";
import { batch, createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js";
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
import { readApiError } from "./api-response";
import { mailComposerMessages } from "./mail-composer-messages";
import {
  advanceMailDraftJournalAfterSave,
  type MailDraftJournal,
  readMailDraftJournal,
  serializeMailDraftContent,
} from "./mail-draft-journal";
import { classifyDraftLeaseAnswer, type DraftLeaseResult, recoverDraftLeaseRequest } from "./mail-draft-lease-recovery";
import { isClosedMailDraft, type MailDraftLifecycleTransition, reconcileMailDraftLifecycle } from "./mail-draft-lifecycle";

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

const journalKey = (mailboxId: string, draftId: string): string => `cloud:mail:draft:${mailboxId}:${draftId}`;

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
  const [leaseConflict, setLeaseConflict] = createSignal<MailDraftLeaseConflict | null>(null);
  const [status, setStatus] = createSignal<ComposerStatus>(options.initialSeed ? "local" : "preparing");
  const [statusMessage, setStatusMessage] = createSignal(options.initialSeed ? "" : t().preparingDraft);
  const [lifecycleTransition, setLifecycleTransition] = createSignal<MailDraftLifecycleTransition | null>(null);
  const [initialized, setInitialized] = createSignal(false);
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
  const serializeMutation = createSerializedDraftMutationQueue();

  const serializedContent = () => serializeMailDraftContent(options.content());
  let userStorage: Storage | undefined;
  const draftStorage = () => {
    if (!userStorage) throw new Error(t().draftPrepareFailed);
    return userStorage;
  };
  const draftKey = (draftId: string) => journalKey(options.mailboxId, draftId);
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

  const applyClosedDraft = (currentDraft: MailDraft) => {
    if (options.isDisposed()) return;
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
    if (options.isDisposed()) return;
    setLeaseConflict({ lease: current, reason });
    setStatus("readonly");
    setStatusMessage(current ? t().editingByNamed({ name: current.holder.displayName }) : t().draftOpenAnotherSession);
  };

  const acceptLease = (acquired: AcquiredDraftLease) => {
    setLease(acquired);
    setLeaseConflict(null);
    // Lease work must not clear an in-flight save or its result.
    if (status() === "preparing" || status() === "readonly") {
      setStatus("saved");
      setStatusMessage("");
    }
    startHeartbeat();
  };

  const failLease = async () => {
    await refreshDraftLifecycle().catch(() => undefined);
    if (options.isDisposed() || lifecycleTransition()) return;
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
        if (result.kind === "unavailable") waitForConnection();
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

  const recoverJournal = (key: string, minimumRevision: number): boolean => {
    const journal = readMailDraftJournal(draftStorage(), key);
    if (!journal || journal.revision < minimumRevision) return false;
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
      onState: (next) => {
        if (options.isDisposed()) return;
        batch(() => {
          setSharedState(next);
          setStatus(next.terminal ? "readonly" : next.saving ? "saving" : next.error ? "error" : "saved");
          setStatusMessage(next.message);
        });
      },
      onContent: (next) => {
        if (!options.isDisposed()) batch(() => options.applyDraftContent(next, "shared"));
      },
      onDurable: (next, revision) => {
        lastSavedContent = serializeMailDraftContent(next);
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
    lastSavedContent = serializeMailDraftContent(draftEditableContent(currentDraft));
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
      lastSavedContent = serializeMailDraftContent(draftEditableContent(currentDraft));
      setInitialized(true);
      applyClosedDraft(currentDraft);
      return currentDraft;
    }
    const acquired = await acquireLease(currentDraft, false, LEASE_HEARTBEAT_MS);
    if (options.isDisposed()) return null;
    lastSavedContent = serializeMailDraftContent(draftEditableContent(currentDraft));
    setDraft(currentDraft);
    setInitialized(true);
    if (acquired) {
      const recovered = recoverJournal(draftKey(currentDraft.id), currentDraft.revision);
      setStatus("saved");
      setStatusMessage("");
      if (recovered) options.onRecovered();
    }
    return currentDraft;
  };

  const ensureDraft = (): Promise<MailDraft | null> => {
    if (draft() && (lease() || shared())) return Promise.resolve(draft());
    if (initializePromise) return initializePromise;
    initializePromise = initialize()
      .catch((error: unknown) => {
        if (!options.isDisposed()) {
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

  const persist = async (): Promise<MailDraft | null> => {
    return await serializeMutation(async () => {
      if (isShared()) {
        const current = await ensureDraft();
        const client = shared();
        if (!current || !client) return null;
        try {
          client.edit(untrack(options.content));
          await client.save();
          return draft();
        } catch (error) {
          setStatus("error");
          setStatusMessage(error instanceof Error ? error.message : t().draftSaveFailed);
          return null;
        }
      }
      if (lifecycleTransition()) return null;
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
          setStatus("error");
          setStatusMessage(await readApiError(response, t().draftSaveFailed));
          return null;
        }
        currentDraft = await response.json();
        lastSavedContent = serializeMailDraftContent(draftEditableContent(currentDraft));
        setDraft(currentDraft);
        try {
          options.onMaterialized(currentDraft);
        } catch {
          // URL and local-seed cleanup are best-effort; the durable draft remains authoritative.
        }
        if (options.isDisposed()) return currentDraft;
        if (currentDraft.editMode === "shared") {
          const latestInput = untrack(options.content);
          await initializeShared(currentDraft);
          const client = shared();
          if (!client) return null;
          client.edit(latestInput);
          try {
            await client.save();
            return draft();
          } catch {
            return null;
          }
        }
        // The person keeps typing while the first lease arrives; the journal and the save below keep that text.
        setMaterializedLeasePending(true);
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
      const nextContent = options.content();
      const serialized = serializeMailDraftContent(nextContent);
      if (serialized === lastSavedContent) return currentDraft;
      setStatus("saving");
      setStatusMessage(t().savingDraft);
      const saveDraft = currentDraft;
      const { response, kind } = await recoverDraftLeaseRequest({
        run: async () => {
          const response = await apiClient.mailboxes[":mailboxId"].drafts[":draftId"].$put({
            param: { mailboxId: options.mailboxId, draftId: saveDraft.id },
            json: { expectedRevision: saveDraft.revision, draft: nextContent },
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
        if (lifecycleTransition()) return null;
        if (await isDraftLeaseHeldResponse(response)) {
          stopHeartbeat();
          setLease(null);
          await refreshDraftLifecycle().catch(() => undefined);
          if (options.isDisposed() || lifecycleTransition()) return null;
          await reportLeaseConflict(currentDraft, "lost");
          return null;
        }
        const message = kind === "unavailable" ? t().draftSaveFailed : await readApiError(response, t().draftSaveFailed);
        setStatus("error");
        setStatusMessage(message);
        if (message.includes("recovery copy")) {
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
      advanceMailDraftJournalAfterSave({
        storage: draftStorage(),
        key: draftKey(saved.id),
        revision: saved.revision,
        savedContent: nextContent,
      });
      if (options.isDisposed()) return saved;
      setDraft(saved);
      lastSavedContent = serialized;
      setStatus("saved");
      setStatusMessage("");
      return saved;
    });
  };

  /** `quiet` keeps a read-only composer as it is while the attempt runs. */
  const resumeCurrentLease = async ({ quiet = false }: { quiet?: boolean } = {}): Promise<void> => {
    const currentDraft = draft();
    const currentLease = lease();
    if (options.isDisposed() || !currentDraft) return;
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
            setStatus("error");
            setStatusMessage(error instanceof Error ? error.message : t().draftSaveFailed);
          }
        });
      return;
    }
    if (!initialized() || serialized === lastSavedContent) {
      if (!currentDraft && seedBaseline === serialized) stopScheduledSave();
      return;
    }
    if (!currentDraft) {
      stopScheduledSave();
      saveTimer = setTimeout(() => void persist(), 700);
      return;
    }
    try {
      draftStorage().setItem(
        draftKey(currentDraft.id),
        JSON.stringify({
          revision: currentDraft.revision,
          content: options.content(),
        } satisfies MailDraftJournal),
      );
    } catch {
      setStatus("error");
      setStatusMessage(t().localMessageFailed);
      stopScheduledSave();
      return;
    }
    if (!lease()) return;
    stopScheduledSave();
    saveTimer = setTimeout(() => void persist(), 700);
  });

  onMount(() => {
    if (options.currentActor.kind === "user") {
      try {
        userStorage = openMailUserDraftStorage(localStorage, options.currentActor.id);
      } catch {
        /* Save reports unavailable device storage. */
      }
    }
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    if (!options.hasVerifiedIdentity()) {
      setStatus("readonly");
      setStatusMessage(t().configureVerifiedIdentity);
      return;
    }
    if (options.initialSeed) {
      setInitialized(true);
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

  return {
    draft,
    setDraft,
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
    leaseConflict,
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
    forgetJournal: (draftId: string) => {
      if (isShared()) return;
      try {
        draftStorage().removeItem(draftKey(draftId));
      } catch {
        /* A completed server action must still finish if device cleanup fails. */
      }
    },
    markCurrentContentSaved: () => {
      lastSavedContent = serializedContent();
    },
    hasUnsavedChanges: () =>
      isShared()
        ? (sharedState()?.dirty ?? false)
        : !draft() && options.initialSeed
          ? draftSeedContentChanged(options.initialSeed, options.content())
          : serializedContent() !== lastSavedContent,
  };
};
