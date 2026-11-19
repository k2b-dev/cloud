import { sql } from "@k2b/cloud";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { SharedTextBoundaryError, type SharedTextRoomFreeze } from "@k2b/cloud/shared-text";
import { isServiceError } from "@k2b/stdlib";
import { ConflictError } from "@k2b/sync";
import type { ActorCommandInput, ComposeSafetyApproval } from "../contracts";
import { requireDraftAccess } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { reviewDraftComposeSafety, validateComposeSafetyEdits, validateDraftComposeSafety } from "./compose-safety";
import { draftDocumentStreamFull, isDraftDocumentStreamFull, withDraftDocumentCommit } from "./draft-document-log";
import { mailDraftRoom } from "./draft-document-room";
import { sameDraftDocumentState } from "./draft-document-state";
import { lockDraftDocumentInTransaction, readDraftDocument } from "./draft-documents";
import { loadSendContent } from "./send-content";

const log = logger("mail:draft-document-send");
/** The same value without `null` members, so two storage forms of one message compare equal. */
const withoutNulls = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNulls)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, entry]) => entry !== null)
            .map(([key, entry]) => [key, withoutNulls(entry)]),
        )
      : value;
const changed = () =>
  Object.assign(new Error("Draft changed before sending; review it again"), { code: "SEND_CONTENT_CHANGED", status: 409 });
type EditedDraftSend = { revision: number; contentHash: string; safetyApproval: ComposeSafetyApproval };
export type FrozenDraftSends = ReadonlyMap<string, SharedTextRoomFreeze & { edited?: EditedDraftSend }>;

/** Freeze after committing approval edits and before the send transaction takes SQL locks. */
export const withFrozenDraftSends = async <T>(
  params: {
    context: MailRequestContext | null;
    mailboxId: string;
    inputs: readonly ActorCommandInput[];
  },
  operation: (frozen: FrozenDraftSends) => Promise<T>,
): Promise<T> => {
  const frozen = new Map<string, SharedTextRoomFreeze & { edited?: EditedDraftSend }>();
  try {
    const deadline = Date.now() + REQUEST_IDLE_TIMEOUT_SECONDS * 1000;
    for (const input of params.inputs) {
      if (input.kind !== "send" || frozen.has(input.draftId)) continue;
      // Undo restores an editable draft, but retrying its old command must not
      // freeze/flush the document again. The transaction still validates the key.
      const [existing] = await sql`SELECT id FROM mail.commands
        WHERE mailbox_id = ${params.mailboxId}::uuid AND idempotency_key = ${input.idempotencyKey.trim()}`;
      if (existing) continue;
      const [row] = await sql<{ edit_mode: string; state: string; revision: number }[]>`SELECT edit_mode, state, revision FROM mail.drafts
        WHERE id = ${input.draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid`;
      // Existing commands retain their ordinary idempotent response, including after send.
      if (!row || row.edit_mode !== "shared" || row.state !== "draft") continue;
      if (!params.context) throw changed();
      const access = await requireDraftAccess(params.context, params.mailboxId, input.draftId, "write");
      if (!access.ok) throw access.error;
      const initialized = await readDraftDocument({ context: params.context, mailboxId: params.mailboxId, draftId: input.draftId });
      if (!initialized.ok) throw initialized.error;
      const context = params.context;
      const edited =
        input.subject === undefined && input.body === undefined
          ? undefined
          : await withDraftDocumentCommit(async (db) => {
              // This transaction ends before the room freeze, whose flush takes SQL locks.
              const locked = await lockDraftDocumentInTransaction({ db, context, mailboxId: params.mailboxId, draftId: input.draftId });
              if (!locked.ok) throw locked.error;
              const projected = await locked.data.project();
              if (!projected.ok) throw projected.error;
              if (projected.data.revision !== input.expectedDraftRevision) throw changed();
              const base = await loadSendContent({
                db,
                context,
                mailboxId: params.mailboxId,
                draftId: input.draftId,
                expectedRevision: input.expectedDraftRevision,
                senderIdentityId: input.senderIdentityId,
                actor: actorRefFromRequest(context),
                lock: true,
                edits: { subject: input.subject, body: input.body },
              });
              if (!base.ok) throw base.error;
              if (base.data.contentHash !== input.expectedContentHash) throw changed();
              const safety = await validateDraftComposeSafety({
                db,
                mailboxId: params.mailboxId,
                draftId: input.draftId,
                expectedRevision: input.expectedDraftRevision,
                subject: input.subject,
                body: input.body,
                approval: input.safetyApproval,
              });
              if (!safety.ok) throw safety.error;
              const current = await locked.data.read();
              if (!current.ok) throw current.error;
              const saved = await locked.data.writeRevision({
                expectedRevision: input.expectedDraftRevision,
                generation: locked.data.generation,
                content: { ...current.data.durable.content, subject: base.data.snapshot.subject, body: base.data.snapshot.body },
                deadline,
              });
              if (!saved.ok) throw saved.error;
              if (saved.data.status !== "accepted") throw changed();
              // The published edit remains saved if a later freeze/send fails. Never send
              // peer changes merged during the write unless they were also reviewed.
              // The shared document stores addresses in its own canonical form (an absent name becomes null), so
              // compare what is sent, not how it is stored, and bind the send to the saved revision's own hash.
              const after = await loadSendContent({
                db,
                context,
                mailboxId: params.mailboxId,
                draftId: input.draftId,
                expectedRevision: saved.data.revision,
                senderIdentityId: input.senderIdentityId,
                actor: actorRefFromRequest(context),
              });
              if (!after.ok) throw after.error;
              if (
                sha256Json(withoutNulls({ ...base.data.snapshot, revision: 0 })) !==
                sha256Json(withoutNulls({ ...after.data.snapshot, revision: 0 }))
              )
                throw changed();
              const contentHash = after.data.contentHash;
              const reviewed = await reviewDraftComposeSafety({
                db,
                context,
                mailboxId: params.mailboxId,
                draftId: input.draftId,
                expectedRevision: saved.data.revision,
              });
              if (!reviewed.ok) throw reviewed.error;
              if (reviewed.data.contentHash !== contentHash) throw changed();
              // Mailbox safety settings can change independently of the locked draft.
              const stillApproved = validateComposeSafetyEdits(safety.data, reviewed.data, {
                revision: safety.data.revision,
                fingerprint: safety.data.fingerprint,
                warningIds: safety.data.warnings.map((warning) => warning.id),
              });
              if (!stillApproved.ok) throw stillApproved.error;
              return {
                revision: saved.data.revision,
                contentHash,
                safetyApproval: {
                  revision: reviewed.data.revision,
                  fingerprint: reviewed.data.fingerprint,
                  warningIds: reviewed.data.warnings.map((warning) => warning.id),
                },
              };
            });
      const state = await mailDraftRoom.freeze(input.draftId).catch((error: unknown) => {
        // A typed rejection may itself have a low-level cause (e.g. StoreFullError).
        // Classify it before inspecting an app snapshot rejection wrapped as cause.
        for (const rejection of [error, error instanceof Error ? error.cause : undefined]) {
          if (isDraftDocumentStreamFull(rejection) || isServiceError(rejection)) throw rejection;
          if (rejection instanceof SharedTextBoundaryError)
            throw Object.assign(
              new Error(
                rejection.code === "DOCUMENT_FROZEN"
                  ? "The draft is temporarily locked. Nothing was queued. Reopen and review it after the current send preparation finishes or its lease expires within a minute."
                  : changed().message,
              ),
              { code: rejection.code, status: 409 },
            );
          if (rejection instanceof ConflictError) throw Object.assign(rejection, { code: "CONFLICT", status: 409 });
        }
        log.error("Shared draft preparation failed before command creation", {
          draftId: input.draftId,
          error: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
          errors:
            error instanceof AggregateError
              ? error.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause)))
              : undefined,
        });
        throw Object.assign(
          new Error(
            "The draft could not be prepared for sending. Nothing was queued. Editing may remain locked for up to a minute. Reopen and review the current draft before trying again.",
          ),
          {
            code: "DRAFT_DOCUMENT_UNAVAILABLE",
            status: 503,
          },
        );
      });
      if (!state) throw changed();
      frozen.set(input.draftId, { ...state, edited });
      const [reviewed] = await sql<{ revision: number }[]>`SELECT revision FROM mail.drafts WHERE id = ${input.draftId}::uuid`;
      if (edited && Number(reviewed?.revision) !== edited.revision) throw changed();
      if (
        !edited &&
        (!reviewed || (Number(row.revision) === input.expectedDraftRevision && Number(reviewed.revision) !== input.expectedDraftRevision))
      )
        throw changed();
    }
    return await operation(frozen);
  } catch (error) {
    if (isDraftDocumentStreamFull(error)) {
      const rejected = draftDocumentStreamFull();
      if (!rejected.ok) throw rejected.error;
    }
    throw error;
  } finally {
    // Neither an undo window nor SMTP holds a 60-second platform token.
    for (const [draftId, state] of frozen) {
      await mailDraftRoom.thaw(draftId, { freezeCursor: state.cursor }).catch((error) => {
        log.error("Draft send freeze release failed; its bounded lease remains", { draftId, error });
      });
    }
  }
};

export const saveDraftSendBoundary = async (db: typeof sql, commandId: string, draftId: string, frozen: SharedTextRoomFreeze) => {
  if (Date.now() >= frozen.expiresAt) throw changed();
  const [row] = await db<{ revision: number; doc_state: Uint8Array; doc_generation: string }[]>`
    SELECT revision, doc_state, doc_generation::text FROM mail.drafts WHERE id = ${draftId}::uuid FOR UPDATE`;
  if (!row || row.doc_generation !== frozen.restoreRevision || !sameDraftDocumentState(row.doc_state, frozen.state)) throw changed();
  await db`INSERT INTO mail.draft_document_sends (command_id, draft_id, generation, state)
    VALUES (${commandId}::uuid, ${draftId}::uuid, ${frozen.restoreRevision}::bigint, ${Buffer.from(frozen.state)})`;
  // Undo continues this lineage. Recovery must compare with its latest send,
  // while each command retains its own immutable snapshot above.
  await db`INSERT INTO mail.draft_document_freezes (draft_id, generation, revision, cursor, state)
    VALUES (${draftId}::uuid, ${frozen.restoreRevision}::bigint, ${row.revision}, ${frozen.cursor}, ${Buffer.from(frozen.state)})
    ON CONFLICT (draft_id, generation) DO UPDATE SET revision = EXCLUDED.revision, cursor = EXCLUDED.cursor, state = EXCLUDED.state`;
};

type SendBoundary = { draft_id: string; generation: string; state: Uint8Array; close_pending: boolean; close_freeze_cursor: string | null };
const boundary = async (commandId: string) => {
  const [row] = await sql<SendBoundary[]>`SELECT draft_id, generation::text, state, close_pending, close_freeze_cursor
    FROM mail.draft_document_sends WHERE command_id = ${commandId}::uuid`;
  return row;
};
const verify = (saved: SendBoundary, frozen: SharedTextRoomFreeze | null): SharedTextRoomFreeze => {
  if (!frozen || frozen.restoreRevision !== saved.generation || !sameDraftDocumentState(saved.state, frozen.state)) throw changed();
  return frozen;
};

/** At actual dispatch time, even days later. Never hold the freeze across SMTP. */
export const verifyDraftSendBeforeDispatch = async (commandId: string, signal?: AbortSignal): Promise<void> => {
  const saved = await boundary(commandId);
  if (!saved) return; // Lock-mode sends retain their existing path.
  try {
    const frozen = await mailDraftRoom.freeze(saved.draft_id, { signal });
    try {
      verify(saved, frozen);
    } finally {
      if (frozen) await mailDraftRoom.thaw(saved.draft_id, { freezeCursor: frozen.cursor, signal });
    }
  } catch (error) {
    // The platform wraps definite app snapshot rejections after releasing its fence.
    const rejection = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    const code = rejection && typeof rejection === "object" && "code" in rejection ? rejection.code : undefined;
    if (code === "SEND_CONTENT_CHANGED") throw rejection;
    // No SMTP effect has started. Lifecycle contention and broker/flush failures
    // use the existing bounded outbox retry instead of discarding a scheduled send.
    throw Object.assign(new Error("Shared draft room temporarily unavailable before dispatch", { cause: error }), {
      code: "DRAFT_ROOM_UNAVAILABLE",
    });
  }
};

/** Commit beside the SMTP outcome. Only outcomes that keep the draft noneditable close it. */
export const recordDraftSendCloseIntent = async (db: typeof sql, commandId: string): Promise<void> => {
  await db`UPDATE mail.draft_document_sends SET close_pending = true WHERE command_id = ${commandId}::uuid AND close_cursor IS NULL`;
};

export const finishDraftSendClose = async (commandId: string, signal?: AbortSignal): Promise<void> => {
  const saved = await boundary(commandId);
  if (!saved?.close_pending) return;
  const token = saved.close_freeze_cursor;
  if (token) {
    try {
      const cursor = await mailDraftRoom.closeDocument(saved.draft_id, { freezeCursor: token, signal });
      if (!cursor) throw changed();
      await sql`UPDATE mail.draft_document_sends SET close_pending = false, close_cursor = ${cursor}, last_error = NULL
        WHERE command_id = ${commandId}::uuid`;
      return;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const [draft] = await sql<{ state: string }[]>`SELECT state FROM mail.drafts WHERE id = ${saved.draft_id}::uuid`;
      if (!draft || draft.state === "sent" || draft.state === "discarded") {
        // The committed domain tombstone is authoritative after an expired token
        // was invalidated. Never close a newer freeze or reopen an already sent draft.
        await sql`UPDATE mail.draft_document_sends SET close_pending = false, last_error = NULL
          WHERE command_id = ${commandId}::uuid`;
        return;
      }
      // Expired admission invalidates an old token. Obtain and verify a new boundary.
      await sql`UPDATE mail.draft_document_sends SET close_freeze_cursor = NULL
        WHERE command_id = ${commandId}::uuid AND close_freeze_cursor = ${token}`;
    }
  }
  const [draft] = await sql<{ state: string }[]>`SELECT state FROM mail.drafts WHERE id = ${saved.draft_id}::uuid`;
  const retired = !draft || draft.state === "sent" || draft.state === "discarded";
  const frozen = await mailDraftRoom.freeze(saved.draft_id, { signal });
  try {
    // After an accepted/unknown outcome the immutable command was already sent.
    // Late admitted edits cannot invalidate the authoritative domain tombstone.
    if (!retired) verify(saved, frozen);
  } catch (error) {
    if (frozen) await mailDraftRoom.thaw(saved.draft_id, { freezeCursor: frozen.cursor, signal });
    throw error;
  }
  if (!frozen) throw changed();
  // Record BEFORE close, so an uncertain close can be retried idempotently after a crash.
  await sql`UPDATE mail.draft_document_sends SET close_freeze_cursor = ${frozen.cursor}
    WHERE command_id = ${commandId}::uuid AND close_pending`;
  const cursor = await mailDraftRoom.closeDocument(saved.draft_id, { freezeCursor: frozen.cursor, signal });
  if (!cursor) throw changed();
  await sql`UPDATE mail.draft_document_sends SET close_pending = false, close_cursor = ${cursor}, last_error = NULL
    WHERE command_id = ${commandId}::uuid`;
};

/** Failure remains durable and visible; startup and the existing reconciliation job retry it. */
export const retryDraftSendClose = async (commandId: string, signal?: AbortSignal): Promise<void> => {
  try {
    await finishDraftSendClose(commandId, signal);
  } catch (error) {
    await sql`UPDATE mail.draft_document_sends SET last_error = ${error instanceof Error ? error.message : "Shared draft close failed"}
      WHERE command_id = ${commandId}::uuid AND close_pending`;
    log.error("Committed send document close awaits retry", { commandId, error });
  }
};
export const retryPendingDraftSendCloses = async (signal?: AbortSignal): Promise<void> => {
  const rows = await sql<{ command_id: string }[]>`SELECT command_id FROM mail.draft_document_sends
    WHERE close_pending ORDER BY command_id LIMIT 200`;
  for (const row of rows) {
    signal?.throwIfAborted();
    await retryDraftSendClose(row.command_id, signal);
  }
};
