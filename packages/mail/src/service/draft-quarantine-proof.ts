import type { sql } from "@k2b/cloud";
import { applySharedTextEvent, fromBase64, MalformedSharedTextEventError } from "@k2b/cloud/shared-text";
import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import * as Y from "yjs";
import { readDraftDocument } from "../lib/draft-document";
import { mailDraftDocumentLog } from "./draft-document-log";

/** Current coverage cannot prove completeness before an older recovery rewrote its cursor. */
export const proveQuarantinedDraftHistory = async (params: {
  db: typeof sql;
  draftId: string;
  generation: string;
  state: Uint8Array;
  signal?: AbortSignal;
}): Promise<{ state: Uint8Array; latest: string | null } | null> => {
  // Revision one of generation one precedes accepted collaborative edits. Later
  // revisions may themselves be 0.78 recovery snapshots with an unknown gap.
  if (params.generation !== "1") return null;
  const [seed] = await params.db<{ state: Uint8Array; cursor: string | null }[]>`
    SELECT state, cursor FROM mail.draft_document_revisions
    WHERE draft_id = ${params.draftId}::uuid AND generation = 1 AND revision = 1`;
  if (!seed?.cursor) return null;
  const topic = mailDraftDocumentLog.topic();
  const first = await mailDraftDocumentLog.firstSequence();
  // Old seed formats did not record a writer/version receipt. Without the
  // entire prefix, even a retained seed cannot certify pre-seed input.
  if (first > 1) return null;
  const latest = await topic.latestCursor({ tenantId: params.draftId });
  const head = await topic.head();
  const doc = new Y.Doc();
  try {
    try {
      Y.applyUpdate(doc, seed.state);
    } catch {
      return null;
    }
    for await (const event of topic.replay({
      tenantId: params.draftId,
      after: topic.cursorAt(0),
      until: seed.cursor,
      signal: params.signal,
    })) {
      if (event.data.kind === "sync" && (event.data.restoreRevision === undefined || event.data.restoreRevision === params.generation)) {
        try {
          if (!Y.snapshotContainsUpdate(Y.snapshot(doc), fromBase64(event.data.payload))) return null;
        } catch {
          return null;
        }
      }
    }
    // Intentionally use strict replay, never the idle-gap tolerant reader.
    for await (const event of topic.replay({ tenantId: params.draftId, after: seed.cursor, until: head, signal: params.signal }))
      applySharedTextEvent(doc, event, params.draftId, params.generation);
    params.signal?.throwIfAborted();
    try {
      readDraftDocument(doc);
      if (!Y.snapshotContainsUpdate(Y.snapshot(doc), params.state)) return null;
    } catch {
      return null;
    }
    // An editor that bypassed admission must still fail the replacement CAS.
    return { state: Y.encodeStateAsUpdate(doc), latest };
  } catch (error) {
    if (error instanceof RetentionGapError || error instanceof CursorMismatchError || error instanceof MalformedSharedTextEventError)
      return null;
    throw error;
  } finally {
    doc.destroy();
  }
};
