import { sql } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { eraseRetiredDraftInTransaction, retireDraftInTransaction } from "./service/draft-retirement";

export const REPLY_DRAFT_MIGRATION_VERSION = 4;
export const REPLY_DRAFT_MIGRATION_NAME = "one_reply_draft";
const log = logger("mail:migrate");
export type ReplyDraftMigrationResult = { deletedDrafts: number; affectedConversations: number; completed: boolean };
const BATCH_SIZE = 100;
const occupied = () => sql`origin = 'user' AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`;
const committedSend = () => sql`(d.state = 'scheduled' OR (d.state = 'sending' AND EXISTS (
  SELECT 1 FROM mail.outbox_submissions o WHERE o.draft_id = d.id AND o.state IN ('undo_window', 'scheduled'))))`;

/** Build a supporting partial index once; subsequent batches group only open user reply drafts. */
const prepareConsolidationIndex = async () => {
  const [index] = await sql<{ valid: boolean; building: boolean }[]>`SELECT
    coalesce((SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('mail.drafts_reply_consolidation_idx')), false) AS valid,
    EXISTS (SELECT 1 FROM pg_stat_progress_create_index WHERE index_relid = to_regclass('mail.drafts_reply_consolidation_idx')) AS building`;
  if (index?.valid) return;
  if (index?.building) throw new Error("Mail consolidation index is being built by another startup; retry startup when it completes");
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_reply_consolidation_idx`.simple();
  await sql`CREATE INDEX CONCURRENTLY drafts_reply_consolidation_idx ON mail.drafts (conversation_id)
    WHERE origin = 'user' AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`.simple();
};

/** Refuse conflicting committed sends and unsafe deliveries before the marker or any deletion. */
const initialize = () =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx`SELECT version FROM mail.schema_migrations WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    if (marker) return;
    const [unsafe] = await tx<{ conversation_id: string; committed_sends: number }[]>`SELECT d.conversation_id,
      count(*) FILTER (WHERE ${committedSend()})::int AS committed_sends
      FROM mail.drafts d WHERE ${occupied()} GROUP BY d.conversation_id HAVING count(*) > 1 AND (
        count(*) FILTER (WHERE ${committedSend()}) > 1 OR bool_or(
          (d.state = 'sending' AND NOT EXISTS (SELECT 1 FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
            WHERE o.draft_id = d.id AND o.state IN ('scheduled', 'undo_window') AND c.state = 'queued'))
          OR EXISTS (SELECT 1 FROM mail.outbox_submissions o JOIN mail.commands c ON c.id = o.command_id
            WHERE o.draft_id = d.id AND (o.state NOT IN ('cancelled', 'failed', 'reconciled_unsent', 'scheduled', 'undo_window')
              OR (o.state IN ('scheduled', 'undo_window') AND c.state <> 'queued')))))
      ORDER BY d.conversation_id LIMIT 1`;
    if (unsafe)
      throw new Error(
        unsafe.committed_sends > 1
          ? `F6 preflight: conversation ${unsafe.conversation_id} has ${unsafe.committed_sends} committed sends. Let them send or cancel them with the previous Mail image, then stop it and retry; no F6 marker or deletions were committed`
          : "F6 preflight: reconcile in-flight or uncertain deliveries in duplicate conversations using the previous Mail image, then stop it and retry; no F6 marker or deletions were committed",
      );
    await tx`INSERT INTO mail.schema_migrations (version, name, details)
      VALUES (${REPLY_DRAFT_MIGRATION_VERSION}, ${REPLY_DRAFT_MIGRATION_NAME},
        '{"deletedDrafts":0,"affectedConversations":0,"completed":false}')`;
  });

/** Classify legacy source copies once, before people can change modes after the upgrade. */
const backfillSourceAttachments = async () => {
  let cursor = { conversationId: "00000000-0000-0000-0000-000000000000", id: "00000000-0000-0000-0000-000000000000" };
  for (;;) {
    const rows = await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
      const [marker] = await tx<{ completed: boolean }[]>`SELECT (details->>'completed')::boolean AS completed
        FROM mail.schema_migrations WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
      if (marker?.completed) return [];
      const drafts = await tx<{ id: string; conversation_id: string }[]>`SELECT id, conversation_id FROM mail.drafts
        WHERE ${occupied()}
          AND (conversation_id, id) > (${cursor.conversationId}::uuid, ${cursor.id}::uuid)
        ORDER BY conversation_id, id LIMIT ${BATCH_SIZE} FOR UPDATE`;
      if (drafts.length)
        await tx`UPDATE mail.draft_attachments a SET copied_source_message_id = d.source_message_id,
          forwarded_source_message_id = CASE WHEN d.intent = 'forward' THEN d.source_message_id ELSE a.forwarded_source_message_id END
          FROM mail.drafts d WHERE d.id = ANY(${sql.array(
            drafts.map((draft) => draft.id),
            "UUID",
          )})
            AND a.draft_id = d.id AND a.created_at = d.created_at
            AND a.forwarded_source_message_id IS NULL AND a.removed_at IS NULL
            AND EXISTS (SELECT 1 FROM mail.attachments source
              WHERE source.message_id = d.source_message_id AND source.blob_id = a.blob_id)`;
      return drafts;
    });
    const last = rows.at(-1);
    if (!last) return;
    cursor = { conversationId: last.conversation_id, id: last.id };
  }
};

/** Each batch groups once, then processes several conversations within the 100-deletion budget. */
const batch = () =>
  sql.begin(async (tx): Promise<ReplyDraftMigrationResult> => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx<{ details: ReplyDraftMigrationResult }[]>`SELECT details FROM mail.schema_migrations
      WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION} FOR UPDATE`;
    if (!marker) throw new Error("Reply draft migration marker is missing");
    const [countConstraint] = await tx<{ validated: boolean }[]>`SELECT convalidated AS validated FROM pg_constraint
      WHERE conrelid = 'mail.drafts'::regclass AND conname = 'drafts_consolidated_count_check'`;
    // VALIDATE uses SHARE UPDATE EXCLUSIVE after the metadata-only transaction committed; writes continue.
    if (countConstraint && !countConstraint.validated)
      await tx`ALTER TABLE mail.drafts VALIDATE CONSTRAINT drafts_consolidated_count_check`.simple();
    if (marker.details.completed) return marker.details;
    const conversations = await tx<{ conversation_id: string; mailbox_id: string }[]>`SELECT conversation_id,
      min(mailbox_id::text)::uuid AS mailbox_id FROM mail.drafts WHERE ${occupied()}
      GROUP BY conversation_id HAVING count(*) > 1 ORDER BY min(mailbox_id::text), conversation_id LIMIT ${BATCH_SIZE}`;
    let deleted = 0;
    let affected = 0;
    for (const conversation of conversations) {
      if (deleted === BATCH_SIZE) break;
      // Match send/cancellation's mailbox -> draft lock order. Mailboxes are visited in ID order.
      await tx`SELECT id FROM mail.mailboxes WHERE id = ${conversation.mailbox_id}::uuid FOR UPDATE`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:reply-draft:${conversation.conversation_id}`}, 0))`;
      const rows = await tx<{ id: string; consolidated_count: number }[]>`SELECT d.id, d.consolidated_count FROM mail.drafts d
        CROSS JOIN LATERAL (SELECT coalesce(greatest(d.content_edited_at,
          (SELECT max(r.created_at) FROM mail.draft_document_revisions r WHERE r.draft_id = d.id AND r.revision > 1)),
          (SELECT max(s.created_at) FROM mail.draft_provider_snapshots s
            WHERE s.draft_id = d.id AND s.direction = 'export' AND s.cloud_revision > 1)) AS edited_at) edits
        WHERE d.conversation_id = ${conversation.conversation_id}::uuid AND ${occupied()}
        ORDER BY ${committedSend()} DESC,
          (d.author_kind <> 'service_account' OR d.adopted_at IS NOT NULL) DESC,
          (edits.edited_at IS NOT NULL OR (d.edit_mode = 'lock' AND (d.revision > 1
            OR btrim(d.body_markdown) <> '' OR btrim(d.subject) <> ''
            OR jsonb_array_length(d.to_addresses) > 0 OR jsonb_array_length(d.cc_addresses) > 0
            OR jsonb_array_length(d.bcc_addresses) > 0))) DESC,
          edits.edited_at DESC NULLS LAST, d.created_at DESC, d.id DESC
        LIMIT ${BATCH_SIZE - deleted + 1} FOR UPDATE OF d`;
      const [survivor, ...losers] = rows;
      if (!survivor || !losers.length) continue;
      for (const loser of losers) {
        const [active] = await tx`SELECT id FROM mail.outbox_submissions WHERE draft_id = ${loser.id}::uuid
          AND state NOT IN ('cancelled', 'failed', 'reconciled_unsent') LIMIT 1 FOR UPDATE`;
        if (active)
          throw new Error("F6 cannot erase a reply draft with an active submission; let it send or cancel it with the previous Mail image");
        // Terminal outbox submissions and command history are immutable migration evidence.
        await tx`INSERT INTO mail.reply_draft_retirements (draft_id) VALUES (${loser.id}::uuid) ON CONFLICT DO NOTHING`;
        await retireDraftInTransaction(tx, loser.id);
        await eraseRetiredDraftInTransaction(tx, loser.id);
        await tx`INSERT INTO mail.activity_events (mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata)
          VALUES (${conversation.mailbox_id}::uuid, ${conversation.conversation_id}::uuid, 'system', 'draft.discarded', 'confirmed', 'draft',
            ${loser.id}::uuid, ${{ reason: "reply_draft_consolidation", count: 1, survivingDraftId: survivor.id }}::jsonb)`;
      }
      const previousCount = rows.reduce((sum, row) => sum + row.consolidated_count, 0);
      await tx`UPDATE mail.drafts SET consolidated_count = ${previousCount + losers.length} WHERE id = ${survivor.id}::uuid`;
      await tx`SELECT mail.enqueue_live_invalidation(${conversation.mailbox_id}::uuid, ${conversation.conversation_id}::uuid)`;
      deleted += losers.length;
      affected += previousCount === 0 ? 1 : 0;
    }
    const result = {
      deletedDrafts: marker.details.deletedDrafts + deleted,
      affectedConversations: marker.details.affectedConversations + affected,
      completed: false,
    };
    await tx`UPDATE mail.schema_migrations SET details = ${result}::jsonb WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    return result;
  });

/** Startup waits for the unique index. Concurrent DDL keeps ordinary table writes available. */
export const migrateReplyDrafts = async (): Promise<ReplyDraftMigrationResult> => {
  const [previous] = await sql<{ details: ReplyDraftMigrationResult }[]>`SELECT details FROM mail.schema_migrations
    WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
  if (!previous?.details.completed) await prepareConsolidationIndex();
  await initialize();
  if (!previous?.details.completed) await backfillSourceAttachments();
  let result = await batch();
  if (result.completed) return result;
  for (;;) {
    const next = await batch();
    if (next.completed) return next;
    if (next.deletedDrafts === result.deletedDrafts) {
      result = next;
      break;
    }
    result = next;
  }
  const [index] = await sql<{ valid: boolean; building: boolean }[]>`SELECT
    coalesce((SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('mail.drafts_one_open_reply_idx')), false) AS valid,
    EXISTS (SELECT 1 FROM pg_stat_progress_create_index
      WHERE index_relid = to_regclass('mail.drafts_one_open_reply_idx')) AS building`;
  if (!index?.valid) {
    if (index?.building) throw new Error("Mail draft index is being built by another startup; retry startup when it completes");
    await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_one_open_reply_idx`.simple();
    await sql`CREATE UNIQUE INDEX CONCURRENTLY drafts_one_open_reply_idx ON mail.drafts (conversation_id)
      WHERE origin = 'user' AND intent <> 'new' AND state IN ('draft', 'scheduled', 'sending')`.simple();
  }
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_reply_consolidation_idx`.simple();
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_untouched_suggestion_author_idx`.simple();
  await sql`DROP INDEX CONCURRENTLY IF EXISTS mail.drafts_untouched_suggestion_idx`.simple();
  return sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cloud.mail.migrations', 0))`;
    const [marker] = await tx<{ details: ReplyDraftMigrationResult }[]>`SELECT details FROM mail.schema_migrations
      WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION} FOR UPDATE`;
    if (!marker) throw new Error("F6 marker disappeared");
    const completed = { ...marker.details, completed: true };
    await tx`UPDATE mail.schema_migrations SET details = ${completed}::jsonb WHERE version = ${REPLY_DRAFT_MIGRATION_VERSION}`;
    if (!marker.details.completed) log.info("Mail F6 reply draft consolidation completed", completed);
    return completed;
  });
};
