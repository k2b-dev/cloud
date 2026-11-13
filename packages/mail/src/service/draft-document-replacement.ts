import { sql } from "@k2b/cloud";
import { SharedTextBoundaryError, sharedTextNodeId } from "@k2b/cloud/shared-text";
import { ConflictError } from "@k2b/sync";
import { mailDraftDocumentLog, withDraftDocumentCommit } from "./draft-document-log";
import { withDraftDocumentTransaction } from "./draft-document-socket-sql";

/** Only actual content replacement changes lineage; admission precedes SQL row locks. */
export const withDraftDocumentReplacement = async <T>(
  draftId: string,
  operation: (db: typeof sql, replace?: (previousGeneration: string) => Promise<string>) => Promise<T>,
): Promise<T> => {
  const [row] = await sql<{ edit_mode: string }[]>`SELECT edit_mode FROM mail.drafts WHERE id = ${draftId}::uuid`;
  if (row?.edit_mode !== "shared") return withDraftDocumentCommit((db) => operation(db));
  return mailDraftDocumentLog.admit(draftId, undefined, async (signal) => {
    const lifecycle = mailDraftDocumentLog.lifecycle!;
    let authority = await lifecycle.get(draftId);
    if (authority?.value.state === "closed") throw new SharedTextBoundaryError("DOCUMENT_CLOSED");
    if (authority?.value.state === "frozen") {
      if (authority.value.expiresAt > Date.now()) throw new SharedTextBoundaryError("DOCUMENT_FROZEN");
      authority = await lifecycle.put(draftId, authority, { state: "open" });
    }
    const topic = mailDraftDocumentLog.topic();
    let pending: { cursor: string; previousGeneration: string } | undefined;
    try {
      return await withDraftDocumentTransaction(signal, (db) =>
        operation(db, async (previousGeneration) => {
          signal.throwIfAborted();
          const target = await topic.latestCursor({ tenantId: draftId });
          const marker = await topic.publish({
            tenantId: draftId,
            expectedAfter: target,
            data: {
              kind: "freeze",
              payload: "",
              restoreRevision: (BigInt(previousGeneration) + 1n).toString(),
              originNodeId: sharedTextNodeId,
              originPeerId: null,
            },
          });
          pending = { cursor: marker.cursor, previousGeneration };
          signal.throwIfAborted();
          if ((await lifecycle.get(draftId))?.revision !== authority?.revision)
            throw new ConflictError("Draft lifecycle changed during replacement");
          return marker.cursor;
        }),
      );
    } catch (error) {
      // Like a platform restore, a rolled-back SQL replacement must put back
      // its old generation marker. Exact CAS cannot undo a later replacement.
      if (pending) {
        const rollback = pending;
        const [current] = await sql<{ generation: string; seeded: boolean }[]>`
          SELECT doc_generation::text AS generation, doc_state IS NOT NULL AS seeded FROM mail.drafts WHERE id = ${draftId}::uuid`;
        if (current?.generation === rollback.previousGeneration) {
          const restored = await topic.publish({
            tenantId: draftId,
            expectedAfter: rollback.cursor,
            data: {
              kind: "freeze",
              payload: "",
              restoreRevision: current.generation,
              originNodeId: sharedTextNodeId,
              originPeerId: null,
            },
          });
          // The failed replacement marker lies between the old SQL cursor and
          // this compensation. Cover both with the unchanged durable state so
          // snapshot replay never mistakes that abandoned lineage for a restore.
          // An unseeded draft has no acknowledged snapshot. Leave its SQL
          // baseline untouched; its first seed replays these inert markers.
          if (current.seeded)
            await withDraftDocumentCommit(async (db) => {
              const [row] = await db<{ revision: number; doc_state: Uint8Array }[]>`
              UPDATE mail.drafts SET doc_cursor = ${restored.cursor}, doc_seq = ${topic.cursorSequence(restored.cursor)},
                revision = revision + 1
              WHERE id = ${draftId}::uuid AND doc_generation = ${rollback.previousGeneration}::bigint
              RETURNING revision, doc_state`;
              if (!row) throw new ConflictError("Draft generation changed during replacement rollback");
              await db`INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
              VALUES (${draftId}::uuid, ${rollback.previousGeneration}::bigint, ${row.revision}, ${row.doc_state}, ${restored.cursor})`;
            });
        }
      }
      throw error;
    }
  });
};
