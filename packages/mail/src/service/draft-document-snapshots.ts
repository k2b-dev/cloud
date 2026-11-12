import { lazySync, sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import {
  type SharedTextSaveInput,
  type SharedTextSnapshotRequest,
  type SharedTextSnapshotStore,
  sharedText,
  sharedTextSnapshotJobConfig,
} from "@k2b/cloud/shared-text";
import * as Y from "yjs";
import { readDraftDocument } from "../lib/draft-document";
import { refreshDraftAdoption } from "./draft-adoption";
import {
  draftDocumentSnapshotWritten,
  lockDraftDocumentCoverage,
  mailDraftDocumentLog,
  withDraftDocumentCommit,
} from "./draft-document-log";
import { queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { enqueueMailInvalidation, mailLive } from "./live";

const log = logger("mail:draft-snapshots");
const job = lazySync((sync) =>
  sync.job<SharedTextSnapshotRequest>(
    sharedTextSnapshotJobConfig({
      id: "cloud:mail:draft-document-snapshots",
      retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 16 * 1024 * 1024 },
    }),
  ),
);
const project = (state: Uint8Array) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return readDraftDocument(doc);
  } finally {
    doc.destroy();
  }
};

/** Accepted input is already authorized. A revoked editor must not prevent its durable projection. */
export const draftDocumentSnapshotStore: SharedTextSnapshotStore = {
  async list({ limit, after, signal }) {
    signal?.throwIfAborted();
    const rows = await sql<{ docId: string; cursor: string | null }[]>`
      SELECT id AS "docId", doc_cursor AS cursor FROM mail.drafts
      WHERE edit_mode = 'shared' AND state = 'draft' AND doc_frozen_cursor IS NULL AND doc_history_complete
        AND doc_state IS NOT NULL ${after ? sql`AND id > ${after}::uuid` : sql``}
      ORDER BY id LIMIT ${limit}`;
    return rows;
  },
  async load(docId, { signal }) {
    signal?.throwIfAborted();
    const [row] = await sql<{ state: Uint8Array; text: string; cursor: string | null; restoreRevision: string }[]>`
      SELECT doc_state AS state, body_markdown AS text, doc_cursor AS cursor, doc_generation::text AS "restoreRevision"
      FROM mail.drafts WHERE id = ${docId}::uuid AND edit_mode = 'shared' AND doc_state IS NOT NULL
        AND state = 'draft' AND doc_frozen_cursor IS NULL AND doc_history_complete`;
    return row ?? null;
  },
  async save(docId, input: SharedTextSaveInput) {
    const content = project(input.state);
    if (content.body !== input.text) throw new Error("Draft snapshot body differs from document");
    await withDraftDocumentCommit(async (db) => {
      await lockDraftDocumentCoverage(db);
      const [row] = await db<
        {
          mailbox_id: string;
          doc_generation: string;
          doc_seq: string | null;
          state: string;
          doc_frozen_cursor: string | null;
          doc_history_complete: boolean;
        }[]
      >`
        SELECT mailbox_id, doc_generation::text, doc_seq::text, state, doc_frozen_cursor, doc_history_complete FROM mail.drafts
        WHERE id = ${docId}::uuid AND edit_mode = 'shared' FOR UPDATE`;
      if (!row || row.state !== "draft" || row.doc_frozen_cursor || !row.doc_history_complete) return;
      const sequence = mailDraftDocumentLog.topic().cursorSequence(input.cursor);
      if (Number(row.doc_seq ?? -1) >= sequence) return;
      if (row.doc_generation !== input.restoreRevision) throw new Error("Draft generation changed during snapshot");
      // Adoption inspects the old SQL base and retained human authorship before advancing its cursor.
      await refreshDraftAdoption({ db, draftId: docId });
      const [sender] = await db<{ id: string }[]>`SELECT id FROM mail.sender_identities
        WHERE short_id = ${content.senderIdentityId} AND mailbox_id = ${row.mailbox_id}::uuid`;
      if (!sender) throw new Error("Draft snapshot sender is unavailable");
      let signature: string | null = null;
      if (content.signatureTemplateId) {
        const [selected] = await db<{ id: string }[]>`SELECT id FROM mail.compose_templates
          WHERE short_id = ${content.signatureTemplateId} AND mailbox_id = ${row.mailbox_id}::uuid AND kind = 'signature'`;
        if (!selected) throw new Error("Draft snapshot signature is unavailable");
        signature = selected.id;
      }
      const editor =
        [...input.contributors].sort((a, b) => b.lastContributedAt.getTime() - a.lastContributedAt.getTime())[0] ?? input.actor;
      const [saved] = await db<{ revision: number }[]>`UPDATE mail.drafts SET
        sender_identity_id = ${sender.id}::uuid, signature_template_id = ${signature}::uuid,
        to_addresses = ${content.to}::jsonb, cc_addresses = ${content.cc}::jsonb, bcc_addresses = ${content.bcc}::jsonb,
        subject = ${content.subject}, body_markdown = ${content.body}, body_format = ${content.format},
        quote_source = ${content.quoteSource !== null}, quote_locale = ${content.quoteSource?.locale ?? "en"},
        quote_time_zone = ${content.quoteSource?.timeZone ?? "UTC"}, priority = ${content.priority},
        request_delivery_receipt = ${content.requestDeliveryReceipt}, request_read_receipt = ${content.requestReadReceipt},
        doc_state = ${Buffer.from(input.state)}, doc_cursor = ${input.cursor}, doc_seq = ${sequence}, revision = revision + 1,
        last_editor_kind = COALESCE(${editor?.kind ?? null}, last_editor_kind),
        last_editor_id = COALESCE(${editor?.id ?? null}::uuid, last_editor_id)
        WHERE id = ${docId}::uuid AND doc_generation = ${input.restoreRevision}::bigint
        RETURNING revision`;
      if (!saved) throw new Error("Draft snapshot was not saved");
      await db`INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
        VALUES (${docId}::uuid, ${input.restoreRevision}::bigint, ${saved.revision}, ${Buffer.from(input.state)}, ${input.cursor})`;
      await queueDraftProjectionInTransaction({ db, draftId: docId });
      await enqueueMailInvalidation(db, { mailboxId: row.mailbox_id });
      draftDocumentSnapshotWritten(db);
    });
    mailLive.wake();
  },
  async recover(docId, _cause, { signal }) {
    await withDraftDocumentCommit(async (db) => {
      await lockDraftDocumentCoverage(db);
      const [row] = await db<
        { doc_state: Uint8Array; doc_cursor: string | null; doc_generation: string; revision: number; mailbox_id: string }[]
      >`
        SELECT doc_state, doc_cursor, doc_generation::text, revision, mailbox_id FROM mail.drafts
        WHERE id = ${docId}::uuid AND edit_mode = 'shared' AND state = 'draft'
          AND doc_frozen_cursor IS NULL AND doc_state IS NOT NULL FOR UPDATE`;
      if (!row) return;
      const head = await mailDraftDocumentLog.topic().head();
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, row.doc_state);
        await mailDraftDocumentLog.recover({ docId, doc, after: row.doc_cursor, until: head, restoreRevision: row.doc_generation, signal });
        signal?.throwIfAborted();
        // The original revision stays available. Encode pending structs/deletes too;
        // incomplete history must never be projected or sent as a complete draft.
        const recovered = Y.encodeStateAsUpdate(doc);
        await db`UPDATE mail.drafts SET doc_state = ${Buffer.from(recovered)}, doc_cursor = ${head},
          doc_seq = ${mailDraftDocumentLog.topic().cursorSequence(head)}, doc_history_complete = false, revision = revision + 1
          WHERE id = ${docId}::uuid`;
        await db`INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
          VALUES (${docId}::uuid, ${row.doc_generation}::bigint, ${Number(row.revision) + 1}, ${Buffer.from(recovered)}, ${head})`;
        await enqueueMailInvalidation(db, { mailboxId: row.mailbox_id });
        draftDocumentSnapshotWritten(db);
      } finally {
        doc.destroy();
      }
    });
    mailLive.wake();
  },
  async advance(docId, input) {
    return withDraftDocumentCommit(async (db) => {
      await lockDraftDocumentCoverage(db);
      const [row] = await db`SELECT id FROM mail.drafts WHERE id = ${docId}::uuid AND doc_cursor = ${input.from}
        AND state = 'draft' AND edit_mode = 'shared' AND doc_frozen_cursor IS NULL AND doc_history_complete FOR UPDATE`;
      if (!row || (await mailDraftDocumentLog.topic().latestCursor({ tenantId: docId })) !== input.latest) return false;
      const sequence = mailDraftDocumentLog.topic().cursorSequence(input.to);
      await db`UPDATE mail.drafts SET doc_cursor = ${input.to}, doc_seq = ${sequence} WHERE id = ${docId}::uuid`;
      draftDocumentSnapshotWritten(db);
      return true;
    });
  },
};
export const draftDocumentSnapshots = sharedText.snapshots({
  log: mailDraftDocumentLog,
  store: draftDocumentSnapshotStore,
  job,
  logger: log,
});
const pending = new Map<string, { cursor: string; first: number; timer: ReturnType<typeof setTimeout> }>();
const tasks = new Set<Promise<void>>();
const track = (promise: Promise<void>) => {
  tasks.add(promise);
  void promise
    .finally(() => tasks.delete(promise))
    .catch((error) => log.error("Draft snapshot scheduling failed; retained input is safe", { error }));
};
/** Three seconds of quiet, at most thirty seconds from the first accepted input. */
export const markDraftDocumentDirty = ({ docId, targetCursor }: { docId: string; targetCursor: string }) => {
  const prior = pending.get(docId);
  if (prior) clearTimeout(prior.timer);
  const first = prior?.first ?? Date.now();
  const timer = setTimeout(
    () => {
      pending.delete(docId);
      track(draftDocumentSnapshots.queue({ docId, targetCursor, reason: "debounce" }));
    },
    Math.max(0, Math.min(3000, first + 30_000 - Date.now())),
  );
  pending.set(docId, { cursor: targetCursor, first, timer });
};
export const flushDraftDocumentSnapshot = async (docId: string) => {
  const entry = pending.get(docId);
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(docId);
  }
  const signal = AbortSignal.timeout(30_000);
  for (let delay = 25; ; delay = Math.min(delay * 2, 250)) {
    signal.throwIfAborted();
    try {
      return await draftDocumentSnapshots.flushNow(docId, { signal });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Shared text snapshot writer is busy; retry the flush") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
};
export const stopDraftDocumentSnapshots = async () => {
  for (const [docId, entry] of pending) {
    clearTimeout(entry.timer);
    track(flushDraftDocumentSnapshot(docId).then(() => {}));
  }
  pending.clear();
  try {
    await Promise.all([...tasks]);
  } finally {
    await draftDocumentSnapshots.stop();
  }
};
