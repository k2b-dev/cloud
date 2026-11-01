/**
 * Unified note-reference reindex — links, tags, attachments.
 *
 * Three index tables are kept in sync from `content_md` on every save:
 *   - `note_links`        (cross-note `[link](url)` references)
 *   - `note_tags`         (`#tag` body syntax)
 *   - `note_attachments`  (`attachment://<id>` body URLs)
 *
 * Every save path (save / restoreFromSnapshot / copyToNotebook) calls
 * `reindexNoteRefsSafe`, which fans out to the three primitives. The
 * scheduler (`reindex-scheduler.ts`) calls the same helper periodically
 * across the whole notebook to repair drift.
 *
 * Indexing failures are best-effort: a failure logs and moves on. The
 * next save or the next scheduler tick will reconcile.
 */

import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import type { TransactionSQL } from "bun";
import * as attachments from "./attachments";
import * as links from "./links";
import { repairNoteDataProperties } from "./note-properties";
import * as tags from "./tags";

const log = logger("notebooks:note-refs");

export const reindexNoteRefs = async (
  params: { noteId: string; notebookId: string; contentMd: string | null },
  tx?: typeof sql,
): Promise<void> => {
  // A caller transaction owns all three projections; standalone callers keep
  // their existing independent writes. These tables are disjoint.
  if (tx) {
    // Keep one savepoint's statements sequential so a rejected query cannot
    // leave another projection writing after the rollback.
    await links.reindexLinks(params.noteId, params.contentMd, tx);
    await tags.reindexTags(params, tx);
    await attachments.reindexAttachmentRefs(params, tx);
    return;
  }
  await Promise.all([
    links.reindexLinks(params.noteId, params.contentMd),
    tags.reindexTags(params),
    attachments.reindexAttachmentRefs(params),
  ]);
};

export const reindexNoteRefsSafe = async (
  params: { noteId: string; notebookId: string; contentMd: string | null },
  tx?: TransactionSQL,
): Promise<void> => {
  try {
    // A failed projection must not abort the domain transaction. Roll its
    // statements back to a savepoint before logging the best-effort failure.
    if (tx) await tx.savepoint((savepoint) => reindexNoteRefs(params, savepoint));
    else await reindexNoteRefs(params);
  } catch (error) {
    log.warn("Failed to reindex note refs", {
      noteId: params.noteId,
      notebookId: params.notebookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const reindexBatchQuery = (notebookId: string, after?: string) => sql<{ id: string; content_md: string | null }[]>`
  SELECT id, content_md FROM notebooks.notes
  WHERE notebook_id = ${notebookId}::uuid AND ${after ? sql`id > ${after}::uuid` : sql`true`}
  ORDER BY id LIMIT 100
`;

/**
 * Notebook-wide reindex — used by the scheduled job. Walks every note,
 * applies the reference indexes and rebuildable data projection. Returns counts so the scheduler
 * can log a summary.
 */
export const reindexNotebook = async (params: {
  notebookId: string;
  onProgress?: () => Promise<void>;
}): Promise<{ notes: number; failed: number }> => {
  let after: string | undefined;
  let totalNotes = 0;
  let failed = 0;
  for (;;) {
    const notes = await reindexBatchQuery(params.notebookId, after);
    if (notes.length === 0) break;
    totalNotes += notes.length;
    for (const note of notes) {
      let noteFailed = false;
      try {
        await reindexNoteRefs({ noteId: note.id, notebookId: params.notebookId, contentMd: note.content_md });
      } catch (error) {
        noteFailed = true;
        log.warn("Failed to reindex note during notebook walk", {
          noteId: note.id,
          notebookId: params.notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await repairNoteDataProperties({ noteId: note.id, contentMd: note.content_md });
      } catch (error) {
        noteFailed = true;
        log.warn("Failed to repair note data properties", {
          noteId: note.id,
          notebookId: params.notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (noteFailed) failed += 1;
      await params.onProgress?.();
    }
    after = notes.at(-1)!.id;
  }
  return { notes: totalNotes, failed };
};

/**
 * Full reindex — every notebook. Used as the periodic scheduler job AND
 * as a one-shot backfill at app startup (see `reindex-scheduler.ts`).
 */
export const reindexAll = async (
  params: { onProgress?: () => Promise<void> } = {},
): Promise<{ notebooks: number; notes: number; failed: number }> => {
  let after: string | undefined;
  let totalNotebooks = 0;
  let totalNotes = 0;
  let totalFailed = 0;
  for (;;) {
    const notebooks = await sql<{ id: string }[]>`
      SELECT id FROM notebooks.notebooks WHERE ${after ? sql`id > ${after}::uuid` : sql`true`}
      ORDER BY id LIMIT 100
    `;
    if (notebooks.length === 0) break;
    totalNotebooks += notebooks.length;
    for (const notebook of notebooks) {
      const result = await reindexNotebook({ notebookId: notebook.id, onProgress: params.onProgress });
      totalNotes += result.notes;
      totalFailed += result.failed;
      await params.onProgress?.();
    }
    after = notebooks.at(-1)!.id;
  }
  return { notebooks: totalNotebooks, notes: totalNotes, failed: totalFailed };
};
