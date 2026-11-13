import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import type { SharedTextRoomFreeze } from "@k2b/cloud/shared-text";
import { ConflictError } from "@k2b/sync";
import type { ActorCommandInput } from "../contracts";
import { requireDraftAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { mailDraftRoom } from "./draft-document-room";
import { sameDraftDocumentState } from "./draft-document-state";
import { readDraftDocument } from "./draft-documents";

const log = logger("mail:draft-document-send");
const changed = () =>
  Object.assign(new Error("Draft changed before sending; review it again"), { code: "SEND_CONTENT_CHANGED", status: 409 });
export type FrozenDraftSends = ReadonlyMap<string, SharedTextRoomFreeze>;

/** Freeze before acquiring SQL row locks: flushNow itself commits a snapshot. */
export const withFrozenDraftSends = async <T>(
  params: {
    context: MailRequestContext | null;
    mailboxId: string;
    inputs: readonly ActorCommandInput[];
  },
  operation: (frozen: FrozenDraftSends) => Promise<T>,
): Promise<T> => {
  const frozen = new Map<string, SharedTextRoomFreeze>();
  try {
    for (const input of params.inputs) {
      if (input.kind !== "send" || frozen.has(input.draftId)) continue;
      const [row] = await sql<{ edit_mode: string; state: string; revision: number }[]>`SELECT edit_mode, state, revision FROM mail.drafts
        WHERE id = ${input.draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid`;
      // Existing commands retain their ordinary idempotent response, including after send.
      if (!row || row.edit_mode !== "shared" || row.state !== "draft") continue;
      if (!params.context) throw changed();
      const access = await requireDraftAccess(params.context, params.mailboxId, input.draftId, "write");
      if (!access.ok) throw access.error;
      const initialized = await readDraftDocument({ context: params.context, mailboxId: params.mailboxId, draftId: input.draftId });
      if (!initialized.ok) throw initialized.error;
      const state = await mailDraftRoom.freeze(input.draftId);
      if (!state) throw changed();
      frozen.set(input.draftId, state);
      const [reviewed] = await sql<{ revision: number }[]>`SELECT revision FROM mail.drafts WHERE id = ${input.draftId}::uuid`;
      if (!reviewed || (Number(row.revision) === input.expectedDraftRevision && Number(reviewed.revision) !== input.expectedDraftRevision))
        throw changed();
    }
    return await operation(frozen);
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
  // Recovery of unsent local input still uses the exact historical send receipt.
  await db`INSERT INTO mail.draft_document_freezes (draft_id, generation, revision, cursor, state)
    VALUES (${draftId}::uuid, ${frozen.restoreRevision}::bigint, ${row.revision}, ${frozen.cursor}, ${Buffer.from(frozen.state)})
    ON CONFLICT (draft_id, generation) DO NOTHING`;
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
  const frozen = await mailDraftRoom.freeze(saved.draft_id, { signal });
  try {
    verify(saved, frozen);
  } finally {
    if (frozen) await mailDraftRoom.thaw(saved.draft_id, { freezeCursor: frozen.cursor, signal });
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
  const frozen = await mailDraftRoom.freeze(saved.draft_id, { signal });
  try {
    verify(saved, frozen);
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
