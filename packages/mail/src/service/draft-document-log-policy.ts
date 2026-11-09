import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import {
  DRAFT_DOCUMENT_COVERAGE_LOCK,
  enableDraftDocumentPruning,
  mailDraftDocumentLog,
  requestDraftDocumentPrune,
  stopDraftDocumentPruning,
} from "./draft-document-log";

const log = logger("mail:draft-document-log-policy");
const RETRY_MS = { first: 1_000, max: 30_000 };
let migrated = false;
let running: { stop: AbortController; done: Promise<void> } | undefined;

const checkpointed = async (db: typeof sql): Promise<boolean> =>
  (await db`SELECT 1 FROM mail.draft_document_log_policy WHERE log_id = ${mailDraftDocumentLog.id}`).length > 0;

/**
 * Marks every draft that may have lost events to the old age limit, then
 * records the checkpoint. Returns false while another transaction holds the
 * coverage lock: this step never queues for the exclusive lock, so it cannot
 * stand between two shared holders.
 */
const recoverExpiredPrefix = async (): Promise<boolean> =>
  sql.begin(async (db) => {
    const [lock] = await db<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${DRAFT_DOCUMENT_COVERAGE_LOCK}) AS acquired`;
    if (!lock?.acquired) return false;
    if (await checkpointed(db)) return true;
    const first = await mailDraftDocumentLog.firstSequence();
    // A snapshot older than the retained window may miss events the old
    // policy expired. No retained event proves nothing: all may have expired.
    await db`
      UPDATE mail.drafts SET doc_history_complete = false
      WHERE state NOT IN ('sent', 'discarded') AND doc_state IS NOT NULL AND doc_history_complete
        AND COALESCE(doc_seq, 0) + 1 < ${first}
    `;
    // A draft without a snapshot was never acknowledged to anyone, but its
    // seed replays from zero: retained events behind an expired prefix need recovery.
    const unseeded = await db<{ id: string }[]>`
      SELECT id FROM mail.drafts
      WHERE state NOT IN ('sent', 'discarded') AND doc_state IS NULL AND edit_mode = 'shared' AND doc_history_complete
    `;
    const topic = mailDraftDocumentLog.topic();
    for (const row of first > 1 ? unseeded : [])
      if (await topic.latestCursor({ tenantId: row.id }))
        await db`UPDATE mail.drafts SET doc_history_complete = false WHERE id = ${row.id}::uuid`;
    await db`INSERT INTO mail.draft_document_log_policy (log_id) VALUES (${mailDraftDocumentLog.id})`;
    return true;
  });

/**
 * Explicit step after Mail has started, before it prunes the draft log.
 *
 * On first use, the platform changes an old log (discard oldest, seven-day
 * age) in place to keep every event, so stored cursors stay valid. Events the
 * old age limit already removed stay removed, so drafts whose snapshot is
 * older than the retained window go to recovery instead of the gap tolerance
 * that pruning relies on. This runs once per database, before any process
 * prunes; a process that stops earlier repeats it. Runs after startup so that
 * a log the platform cannot prepare never blocks ordinary Mail.
 */
export const migrateDraftDocumentLogPolicy = async (signal?: AbortSignal): Promise<boolean> => {
  migrated = false;
  await stopDraftDocumentPruning();
  try {
    await mailDraftDocumentLog.topic().ready();
    for (let delay = RETRY_MS.first; !(await checkpointed(sql)); delay = Math.min(delay * 2, RETRY_MS.max)) {
      if (await recoverExpiredPrefix()) break;
      signal?.throwIfAborted();
      await Bun.sleep(delay);
      signal?.throwIfAborted();
    }
    migrated = true;
    enableDraftDocumentPruning();
    requestDraftDocumentPrune();
    return true;
  } catch (error) {
    if (!signal?.aborted) log.error("Shared drafts remain unsupported: the draft document log could not be prepared", { error });
    return false;
  }
};

/** Starts the step in the background; Mail serves lock-mode drafts meanwhile. */
export const startDraftDocumentLogPolicy = (): void => {
  const stop = new AbortController();
  running = { stop, done: migrateDraftDocumentLogPolicy(stop.signal).then(() => undefined) };
};

export const stopDraftDocumentLogPolicy = async (): Promise<void> => {
  running?.stop.abort();
  await running?.done;
  running = undefined;
};

/** True once this process prepared a log that keeps every event until Mail prunes it. */
export const sharedDraftsSupported = async (): Promise<boolean> => migrated;
