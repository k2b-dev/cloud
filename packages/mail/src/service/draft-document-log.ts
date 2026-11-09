import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { type SharedTextSyncEvent, sharedText } from "@k2b/cloud/shared-text";
import { fail } from "@k2b/stdlib";
import { RetentionGapError, StoreFullError, type TopicEvent } from "@k2b/sync";
import { mailDraftDocumentMessages } from "../lib/draft-document-protocol";

export const MAX_LOG_ENVELOPE_BYTES = 8_100_000 + 4096;
export const mailDraftDocumentLog = sharedText.define({
  id: "cloud:mail:draft-documents",
  whenFull: "reject",
  retention: { maxBytes: 1024 ** 3 },
  // Preserve the previous effective DLQ age when removing the event-log age.
  deadLetterRetention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 16 * 1024 * 1024 },
  maxPayloadBytes: MAX_LOG_ENVELOPE_BYTES,
});
const log = logger("mail:draft-document-log");
// One application-wide lock, distinct from per-mailbox and per-draft locks.
export const DRAFT_DOCUMENT_COVERAGE_LOCK = 7_104_071;
export const lockDraftDocumentCoverage = async (db: typeof sql): Promise<void> => {
  await db`SELECT pg_advisory_xact_lock_shared(${DRAFT_DOCUMENT_COVERAGE_LOCK})`;
};
export const isDraftDocumentStreamFull = (error: unknown): boolean => error instanceof StoreFullError;
export const draftDocumentStreamFull = (db?: typeof sql) => {
  if (db) fullTransactions.add(db);
  else requestDraftDocumentPrune();
  return fail({ code: "DRAFT_DOCUMENT_STREAM_FULL", status: 409 as const, message: mailDraftDocumentMessages.resolve([]).t.streamFull });
};

type Candidate = { id: string; doc_seq: string | null; doc_generation: string; coverage: string };
// Same order as the coverage index. Pages share the existing 200-item Mail list budget.
const PAGE_SIZE = 200;
export const pruneDraftDocumentLog = async (): Promise<{ through: number; purged: number } | null> =>
  sql.begin(async (db) => {
    const [lock] = await db<{ acquired: boolean }[]>`SELECT pg_try_advisory_xact_lock(${DRAFT_DOCUMENT_COVERAGE_LOCK}) AS acquired`;
    if (!lock?.acquired) return null;
    const topic = mailDraftDocumentLog.topic();
    const head = topic.cursorSequence(await topic.head());
    let through = head;
    let last: { coverage: string; id: string } | undefined;
    // For every replayable D, the pruned prefix contains no event of tenant D
    // with sequence > D.doc_seq (null = 0). Idle proofs cover only absent events.
    scan: for (;;) {
      const rows = await db<Candidate[]>`
        SELECT id, doc_seq, doc_generation,
          GREATEST(COALESCE(doc_seq, 0), COALESCE(doc_idle_through, 0)) AS coverage
        FROM mail.drafts
        WHERE state NOT IN ('sent', 'discarded') AND (doc_state IS NOT NULL OR edit_mode = 'shared')
          AND GREATEST(COALESCE(doc_seq, 0), COALESCE(doc_idle_through, 0)) < ${head}
          ${last ? db`AND (GREATEST(COALESCE(doc_seq, 0), COALESCE(doc_idle_through, 0)), id) > (${last.coverage}::bigint, ${last.id}::uuid)` : db``}
        ORDER BY GREATEST(COALESCE(doc_seq, 0), COALESCE(doc_idle_through, 0)), id LIMIT ${PAGE_SIZE}
      `;
      for (const row of rows) {
        const coverage = Number(row.coverage);
        const latest = await topic.latestCursor({ tenantId: row.id });
        if (latest && topic.cursorSequence(latest) > coverage) {
          through = coverage;
          break scan;
        }
        // Never wait on a writer holding a row while it waits for our coverage
        // lock. A skipped proof is merely recomputed by a later prune run.
        await db`
          UPDATE mail.drafts SET doc_idle_through = ${head}
          WHERE id IN (SELECT id FROM mail.drafts WHERE id = ${row.id}::uuid FOR UPDATE SKIP LOCKED)
            AND doc_seq IS NOT DISTINCT FROM ${row.doc_seq}::bigint AND doc_generation = ${row.doc_generation}::bigint
        `;
      }
      if (rows.length < PAGE_SIZE) break;
      last = rows.at(-1);
    }
    if (through <= 0) return { through, purged: 0 };
    return { through, ...(await topic.prune({ through: topic.cursorAt(through) })) };
  });

let pending: Promise<void> | undefined;
let requested = false;
let enabled = false;
export const enableDraftDocumentPruning = (): void => {
  enabled = true;
};
export const requestDraftDocumentPrune = (): void => {
  if (!enabled) return;
  requested = true;
  pending ??= (async () => {
    do {
      requested = false;
      try {
        await pruneDraftDocumentLog();
      } catch (error) {
        log.error("Draft document pruning failed; accepted events remain retained", { error });
      }
    } while (requested);
  })().finally(() => {
    pending = undefined;
    if (requested) requestDraftDocumentPrune();
  });
};
export const drainDraftDocumentPruning = async (): Promise<void> => {
  while (pending) await pending;
};
export const stopDraftDocumentPruning = async (): Promise<void> => {
  enabled = false;
  await pending;
};
const snapshots = new WeakSet<typeof sql>();
const fullTransactions = new WeakSet<typeof sql>();
export const draftDocumentSnapshotWritten = (db: typeof sql): void => {
  snapshots.add(db);
};
/** Call only around the outer transaction: publication alone never schedules a prune. */
export const afterDraftDocumentCommit = async <T>(transaction: (observe: (db: typeof sql) => void) => Promise<T>): Promise<T> => {
  let db: typeof sql | undefined;
  let committed = false;
  try {
    const result = await transaction((value) => {
      db = value;
    });
    committed = true;
    return result;
  } finally {
    if (db) {
      const wrote = snapshots.delete(db);
      const full = fullTransactions.delete(db);
      if ((committed && wrote) || full) requestDraftDocumentPrune();
    }
  }
};
export const withDraftDocumentCommit = <T>(operation: (db: typeof sql) => Promise<T>): Promise<T> =>
  afterDraftDocumentCommit((observe) =>
    sql.begin((db) => {
      observe(db);
      return operation(db);
    }),
  );

/** The SQL row and history flag must come from the same snapshot as the replay base. */
export async function* replayDraftDocument(input: {
  draftId: string;
  after: string | null;
  docSeq: string | number | null;
  historyComplete: boolean;
  until: string;
  signal?: AbortSignal;
}): AsyncGenerator<TopicEvent<SharedTextSyncEvent>> {
  const topic = mailDraftDocumentLog.topic();
  let after = input.after ?? topic.cursorAt(0);
  const safe = input.historyComplete && topic.cursorSequence(after) >= Number(input.docSeq ?? 0);
  while (topic.cursorSequence(after) < topic.cursorSequence(input.until)) {
    try {
      for await (const event of topic.replay({ tenantId: input.draftId, after, until: input.until, signal: input.signal })) {
        after = event.cursor;
        yield event;
      }
      return;
    } catch (error) {
      if (
        !safe ||
        !(error instanceof RetentionGapError) ||
        !error.resumeAfter ||
        topic.cursorSequence(error.resumeAfter) <= topic.cursorSequence(after)
      )
        throw error;
      after = error.resumeAfter;
    }
  }
}
