import { lazySync } from "@k2b/cloud";
import { type SharedTextActor, type SharedTextSnapshotStore, sharedText, sharedTextSnapshotJobConfig } from "@k2b/cloud/shared-text";
import { sql } from "bun";

export const log = sharedText.define({
  id: "drafts.text",
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 1024 ** 3 },
  deadLetterRetention: { maxBytes: 16 * 1024 * 1024 },
  maxPayloadBytes: 8_104_096,
});

type Saved = { status: "saved" | "overtaken" | "notFound" };

export const draftText = log.withStore<Saved, undefined>({
  load: async (draftId) => {
    const [row] = await sql<{ text_state: Uint8Array | null; text_cursor: string | null; restore_revision: string; body: string | null }[]>`
      SELECT text_state, text_cursor, restore_revision::text, body FROM drafts.drafts WHERE id = ${draftId}::uuid
    `;
    return row ? { state: row.text_state, cursor: row.text_cursor, restoreRevision: row.restore_revision, text: row.body } : null;
  },
  save: async (draftId, input) => {
    const seq = log.topic().cursorSequence(input.cursor);
    const result = await sql`
      UPDATE drafts.drafts
      SET text_state = ${Buffer.from(input.state)}, text_cursor = ${input.cursor}, text_seq = ${seq}, body = ${input.text}
      WHERE id = ${draftId}::uuid
        AND restore_revision = ${input.restoreRevision}::bigint
        AND (text_seq IS NULL OR text_seq < ${seq})
    `;
    if (result.count > 0) return { status: "saved" };
    const [row] = await sql`SELECT 1 FROM drafts.drafts WHERE id = ${draftId}::uuid`;
    return { status: row ? "overtaken" : "notFound" };
  },
});

export const addSummary = async (draftId: string, actor: SharedTextActor): Promise<boolean> => {
  const result = await draftText.edit(draftId, { actor }, ({ text }) => `${text}\n\nSummary added by the assistant.\n`);
  // The edit is in the log and in the snapshot.
  return result.status === "edited" && result.saved.status === "saved";
};

export const currentDraftText = async (draftId: string): Promise<string | null> => {
  const current = await draftText.read(draftId);
  return current?.text ?? null;
};

const snapshotConfig = sharedTextSnapshotJobConfig({
  id: "drafts.text.snapshots",
  // Jobs carry a document ID and a cursor; a small budget is enough.
  retention: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxBytes: 64 * 1024 * 1024 },
});

export const draftSnapshots = (store: SharedTextSnapshotStore) =>
  sharedText.snapshots({
    log,
    job: lazySync((sync) => sync.job(snapshotConfig)),
    store,
  });
