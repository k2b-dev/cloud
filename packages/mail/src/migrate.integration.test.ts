import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";
import { commitManagedOAuthRefresh } from "./service/provider-oauth-tokens";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("mail migrations", () => {
  test("installs versioned attachment extraction and source-aware search chunks", async () => {
    await migrate();
    await migrate();

    const [shape] = await sql<
      {
        applied_count: number;
        extraction_table_present: boolean;
        source_columns: number;
        body_unique_index_present: boolean;
        attachment_unique_index_present: boolean;
        recovery_index_present: boolean;
      }[]
    >`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM mail.schema_migrations
          WHERE version = 119 AND name = 'attachment_document_extraction'
        ) AS applied_count,
        to_regclass('mail.attachment_extractions') IS NOT NULL AS extraction_table_present,
        (
          SELECT COUNT(*)::int
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'message_search_chunks'
            AND column_name IN ('source_kind', 'attachment_id', 'blob_id', 'extractor_version')
        ) AS source_columns,
        to_regclass('mail.message_search_chunks_body_source_idx') IS NOT NULL AS body_unique_index_present,
        to_regclass('mail.message_search_chunks_attachment_source_idx') IS NOT NULL AS attachment_unique_index_present,
        to_regclass('mail.attachment_extractions_recovery_idx') IS NOT NULL AS recovery_index_present
    `;

    expect(shape).toEqual({
      applied_count: 1,
      extraction_table_present: true,
      source_columns: 4,
      body_unique_index_present: true,
      attachment_unique_index_present: true,
      recovery_index_present: true,
    });
  });

  test("removes comment reply relationships", async () => {
    await migrate();
    await migrate();

    const [shape] = await sql<{ applied_count: number; parent_column_present: boolean; stale_metadata: number }[]>`
      SELECT
        (
          SELECT count(*)::int
          FROM mail.schema_migrations
          WHERE version = 118 AND name = 'flat_conversation_comments'
        ) AS applied_count,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'conversation_comments'
            AND column_name = 'parent_comment_id'
        ) AS parent_column_present,
        (
          SELECT count(*)::int
          FROM mail.activity_events
          WHERE metadata ? 'parentCommentId'
        ) AS stale_metadata
    `;

    expect(shape).toEqual({ applied_count: 1, parent_column_present: false, stale_metadata: 0 });
  });

  test("finalizes public short IDs without changing internal UUID keys", async () => {
    await migrate();
    await migrate();

    const [shape] = await sql<
      {
        applied_count: number;
        short_id_columns: number;
        nullable_columns: number;
        unique_indexes: number;
        format_constraints: number;
        uuid_primary_keys: number;
        snapshot_columns_ready: boolean;
      }[]
    >`
      WITH resource_tables(table_name) AS (
        SELECT unnest(ARRAY[
          'mailboxes', 'folders', 'message_contents', 'attachments', 'conversations', 'sender_identities',
          'drafts', 'outbox_submissions', 'draft_attachments', 'conversation_comments',
          'conversation_reminders', 'saved_conversation_views', 'local_tags', 'compose_templates',
          'automatic_reply_configurations', 'incoming_automations'
        ]::text[])
      )
      SELECT
        (SELECT count(*)::int FROM mail.schema_migrations WHERE version = 117 AND name = 'public_short_ids')
          AS applied_count,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail' AND column_shape.column_name = 'short_id'
        ) AS short_id_columns,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail'
            AND column_shape.column_name = 'short_id'
            AND column_shape.is_nullable <> 'NO'
        ) AS nullable_columns,
        (
          SELECT count(*)::int FROM pg_indexes index_shape
          JOIN resource_tables resource ON index_shape.indexname = resource.table_name || '_short_id_idx'
          WHERE index_shape.schemaname = 'mail' AND index_shape.indexdef LIKE 'CREATE UNIQUE INDEX%'
        ) AS unique_indexes,
        (
          SELECT count(*)::int FROM pg_constraint constraint_shape
          JOIN resource_tables resource ON constraint_shape.conname = resource.table_name || '_short_id_format'
          WHERE constraint_shape.connamespace = 'mail'::regnamespace AND constraint_shape.contype = 'c'
        ) AS format_constraints,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail'
            AND column_shape.column_name = 'id'
            AND column_shape.data_type = 'uuid'
        ) AS uuid_primary_keys,
        (
          SELECT count(*) = 3
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND (
              (table_name = 'live_invalidation_outbox' AND column_name = 'mailbox_short_id' AND is_nullable = 'NO')
              OR (table_name = 'collaboration_notification_deliveries' AND column_name = 'source_short_id' AND is_nullable = 'NO')
              OR (table_name = 'live_invalidation_outbox' AND column_name = 'conversation_short_id' AND is_nullable = 'YES')
            )
        ) AS snapshot_columns_ready
    `;

    expect(shape).toEqual({
      applied_count: 1,
      short_id_columns: 16,
      nullable_columns: 0,
      unique_indexes: 16,
      format_constraints: 16,
      uuid_primary_keys: 16,
      snapshot_columns_ready: true,
    });

    const mailbox = { id: crypto.randomUUID(), shortId: newShortId() };
    const conversation = { id: crypto.randomUUID(), shortId: newShortId() };
    try {
      await sql`
        INSERT INTO mail.mailboxes (id, short_id, name)
        VALUES (${mailbox.id}::uuid, ${mailbox.shortId}, 'Short-ID enqueue migration test')
      `;
      await sql`
        INSERT INTO mail.conversations (id, short_id, mailbox_id, latest_message_at)
        VALUES (${conversation.id}::uuid, ${conversation.shortId}, ${mailbox.id}::uuid, now())
      `;
      await sql`
        INSERT INTO mail.activity_events (
          mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${mailbox.id}::uuid, ${conversation.id}::uuid, 'system', 'message.received', 'confirmed',
          'conversation', ${conversation.id}::uuid, '{}'::jsonb
        )
      `;

      const [snapshot] = await sql<{ mailbox_short_id: string; conversation_short_id: string | null }[]>`
        SELECT mailbox_short_id, conversation_short_id
        FROM mail.live_invalidation_outbox
        WHERE mailbox_id = ${mailbox.id}::uuid AND conversation_id = ${conversation.id}::uuid
      `;
      expect(snapshot).toEqual({
        mailbox_short_id: mailbox.shortId,
        conversation_short_id: conversation.shortId,
      });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
    }
  });

  test("installs unified incoming automations and removes split alpha tables", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        applied_count: number;
        compound_model_applied_count: number;
        workflow_aligned_model_applied_count: number;
        text_sources_applied_count: number;
        summaries_applied_count: number;
        live_invalidation_applied_count: number;
        integration_credentials_applied_count: number;
        integration_credential_columns_present: boolean;
        mandates_applied_count: number;
        mandate_column_present: boolean;
        summary_columns_present: boolean;
        live_invalidation_table_present: boolean;
        live_invalidation_trigger_present: boolean;
        live_invalidation_conversation_fk_absent: boolean;
        table_present: boolean;
        active_name_index_present: boolean;
        touch_trigger_present: boolean;
        workflow_profile_fk_present: boolean;
        managed_owner_present: boolean;
        split_tables_absent: boolean;
      }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 109 AND name = 'unified_incoming_automations') AS applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 110 AND name = 'compound_incoming_automation_steps') AS compound_model_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 111 AND name = 'workflow_aligned_incoming_automation_steps') AS workflow_aligned_model_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 112 AND name = 'mail_automation_text_sources') AS text_sources_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 114 AND name = 'conversation_summaries') AS summaries_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 115 AND name = 'live_invalidation_outbox') AS live_invalidation_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 120 AND name = 'incoming_automation_integration_credentials') AS integration_credentials_applied_count,
        (SELECT COUNT(*)::int FROM mail.schema_migrations WHERE version = 121 AND name = 'incoming_automation_mandates') AS mandates_applied_count,
        (
          SELECT COUNT(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'incoming_automations'
            AND column_name IN ('integration_credential_id', 'encrypted_integration_token')
        ) AS integration_credential_columns_present,
        (
          SELECT COUNT(*) = 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'incoming_automations'
            AND column_name = 'mandate_id'
        ) AS mandate_column_present,
        (
          SELECT COUNT(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'conversations'
            AND column_name IN ('summary', 'summary_revision')
        ) AS summary_columns_present,
        to_regclass('mail.live_invalidation_outbox') IS NOT NULL AS live_invalidation_table_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'mail.activity_events'::regclass
            AND tgname = 'activity_events_enqueue_live_invalidation'
            AND NOT tgisinternal
        ) AS live_invalidation_trigger_present,
        NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'mail.live_invalidation_outbox'::regclass
            AND conname = 'live_invalidation_outbox_conversation_id_fkey'
        ) AS live_invalidation_conversation_fk_absent,
        to_regclass('mail.incoming_automations') IS NOT NULL AS table_present,
        to_regclass('mail.incoming_automations_mailbox_name_idx') IS NOT NULL AS active_name_index_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'mail.incoming_automations'::regclass
            AND tgname = 'incoming_automations_touch_updated_at'
            AND NOT tgisinternal
        ) AS touch_trigger_present,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'mail.incoming_automations'::regclass
            AND contype = 'f'
            AND confrelid = 'mail.workflow_profile'::regclass
        ) AS workflow_profile_fk_present,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'mail.workflow_profile'::regclass
            AND conname = 'workflow_profile_managed_by_check'
            AND pg_get_constraintdef(oid) LIKE '%incoming_automation%'
            AND pg_get_constraintdef(oid) NOT LIKE '%mail_rule%'
            AND pg_get_constraintdef(oid) NOT LIKE '%ai_automation%'
        ) AS managed_owner_present,
        to_regclass('mail.mail_rules') IS NULL AND to_regclass('mail.ai_automations') IS NULL AS split_tables_absent
    `;
    expect(shape).toEqual({
      applied_count: 1,
      compound_model_applied_count: 1,
      workflow_aligned_model_applied_count: 1,
      text_sources_applied_count: 1,
      summaries_applied_count: 1,
      live_invalidation_applied_count: 1,
      integration_credentials_applied_count: 1,
      integration_credential_columns_present: true,
      mandates_applied_count: 1,
      mandate_column_present: true,
      summary_columns_present: true,
      live_invalidation_table_present: true,
      live_invalidation_trigger_present: true,
      live_invalidation_conversation_fk_absent: true,
      table_present: true,
      active_name_index_present: true,
      touch_trigger_present: true,
      workflow_profile_fk_present: true,
      managed_owner_present: true,
      split_tables_absent: true,
    });
  });

  test("installs composer safety and idempotent message reuse once", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        safety_migration_count: string | number;
        idempotency_migration_count: string | number;
        mailbox_config_present: boolean;
        outbox_review_present: boolean;
        derivation_columns_present: boolean;
        derivation_index_present: boolean;
        materialization_migration_count: number;
        materialization_columns_present: boolean;
        materialization_index_present: boolean;
      }[]
    >`
      SELECT
        (
          SELECT count(*) FROM mail.schema_migrations
          WHERE version = 89 AND name = 'composer_safety_message_reuse'
        ) AS safety_migration_count,
        (
          SELECT count(*) FROM mail.schema_migrations
          WHERE version = 90 AND name = 'draft_derivation_idempotency'
        ) AS idempotency_migration_count,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mail' AND table_name = 'mailboxes' AND column_name = 'compose_safety'
        ) AS mailbox_config_present,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mail' AND table_name = 'outbox_submissions' AND column_name = 'safety_review'
        ) AS outbox_review_present,
        (
          SELECT count(*) = 4
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'drafts'
            AND column_name IN (
              'derived_from_message_id',
              'derivation_kind',
              'derivation_key',
              'derivation_request_hash'
            )
        ) AS derivation_columns_present,
        to_regclass('mail.drafts_derivation_idempotency_idx') IS NOT NULL AS derivation_index_present,
        (
          SELECT count(*) FROM mail.schema_migrations
          WHERE version = 101 AND name = 'draft_materialization_idempotency'
        ) AS materialization_migration_count,
        (
          SELECT count(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'drafts'
            AND column_name IN ('materialization_key', 'materialization_request_hash')
        ) AS materialization_columns_present,
        to_regclass('mail.drafts_materialization_idempotency_idx') IS NOT NULL AS materialization_index_present
    `;
    expect({
      ...shape,
      safety_migration_count: Number(shape?.safety_migration_count),
      idempotency_migration_count: Number(shape?.idempotency_migration_count),
      materialization_migration_count: Number(shape?.materialization_migration_count),
    }).toEqual({
      safety_migration_count: 1,
      idempotency_migration_count: 1,
      mailbox_config_present: true,
      outbox_review_present: true,
      derivation_columns_present: true,
      derivation_index_present: true,
      materialization_migration_count: 1,
      materialization_columns_present: true,
      materialization_index_present: true,
    });
  });

  test("installs identity delivery options and custom transport fencing once", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        applied_count: string | number;
        transport_table_present: boolean;
        receipt_table_present: boolean;
        outbox_fence_present: boolean;
        draft_options_present: boolean;
        identity_options_present: boolean;
      }[]
    >`
      SELECT
        (
          SELECT count(*)
          FROM mail.schema_migrations
          WHERE version = 88 AND name = 'identity_delivery_options'
        ) AS applied_count,
        to_regclass('mail.sender_identity_transports') IS NOT NULL AS transport_table_present,
        to_regclass('mail.message_receipt_reports') IS NOT NULL AS receipt_table_present,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'outbox_submissions'
            AND column_name = 'selected_identity_transport_revision'
        ) AS outbox_fence_present,
        (
          SELECT count(*) = 3
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'drafts'
            AND column_name IN ('priority', 'request_delivery_receipt', 'request_read_receipt')
        ) AS draft_options_present,
        (
          SELECT count(*) = 6
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'sender_identities'
            AND column_name IN (
              'default_bcc',
              'default_format',
              'default_priority',
              'default_delivery_receipt',
              'default_read_receipt',
              'vcard'
            )
        ) AS identity_options_present
    `;
    expect({ ...shape, applied_count: Number(shape?.applied_count) }).toEqual({
      applied_count: 1,
      transport_table_present: true,
      receipt_table_present: true,
      outbox_fence_present: true,
      draft_options_present: true,
      identity_options_present: true,
    });
  });

  test("installs privacy-safe remote image metadata and personal rules once", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        applied_count: string | number;
        image_table_present: boolean;
        rules_table_present: boolean;
        image_index_present: boolean;
        principal_index_present: boolean;
      }[]
    >`
      SELECT
        (
          SELECT count(*)
          FROM mail.schema_migrations
          WHERE version = 87 AND name = 'privacy_safe_remote_content'
        ) AS applied_count,
        to_regclass('mail.message_remote_images') IS NOT NULL AS image_table_present,
        to_regclass('mail.remote_content_rules') IS NOT NULL AS rules_table_present,
        to_regclass('mail.message_remote_images_message_idx') IS NOT NULL AS image_index_present,
        to_regclass('mail.remote_content_rules_principal_idx') IS NOT NULL AS principal_index_present
    `;
    expect({ ...shape, applied_count: Number(shape?.applied_count) }).toEqual({
      applied_count: 1,
      image_table_present: true,
      rules_table_present: true,
      image_index_present: true,
      principal_index_present: true,
    });
  });

  test("hard-migrates the alpha conversation state model without retaining the removed column", async () => {
    await migrate();
    const mailboxId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO mail.mailboxes (short_id, id, name) VALUES (${newShortId()}, ${mailboxId}::uuid, 'Work-state migration test')`;
      await tx`
        INSERT INTO mail.conversations (short_id, id, mailbox_id, subject, participant_summary, latest_message_at)
        VALUES (${newShortId()}, ${conversationId}::uuid, ${mailboxId}::uuid, 'Migration fixture', 'Customer', now())
      `;
      await tx`
        INSERT INTO mail.activity_events (
          mailbox_id, conversation_id, actor_kind, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${mailboxId}::uuid,
          ${conversationId}::uuid,
          'system',
          'conversation.collaboration_updated',
          'confirmed',
          'conversation',
          ${conversationId}::uuid,
          ${{
            before: { workStatus: "open", responseNeeded: false },
            after: { workStatus: "open", responseNeeded: true },
          }}::jsonb
        )
      `;
      await tx`ALTER TABLE mail.conversations DROP CONSTRAINT conversations_work_status_check`;
      await tx`ALTER TABLE mail.conversations ADD COLUMN response_needed BOOLEAN NOT NULL DEFAULT false`;
      await tx`UPDATE mail.conversations SET work_status = 'open', response_needed = true WHERE id = ${conversationId}::uuid`;
      await tx`DELETE FROM mail.schema_migrations WHERE version = 79`;
    });

    try {
      await migrate();
      const [shape] = await sql<
        {
          applied: boolean;
          status: string;
          removed_column_absent: boolean;
          due_index_present: boolean;
          metadata: Record<string, unknown> | string;
        }[]
      >`
        SELECT
          EXISTS (
            SELECT 1 FROM mail.schema_migrations
            WHERE version = 79 AND name = 'unified_conversation_work_states'
          ) AS applied,
          conversation.work_status AS status,
          NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'mail' AND table_name = 'conversations' AND column_name = 'response_needed'
          ) AS removed_column_absent,
          to_regclass('mail.conversations_due_snooze_idx') IS NOT NULL AS due_index_present,
          activity.metadata
        FROM mail.conversations conversation
        JOIN mail.activity_events activity ON activity.conversation_id = conversation.id
        WHERE conversation.id = ${conversationId}::uuid
      `;
      expect(shape).toMatchObject({
        applied: true,
        status: "needs_action",
        removed_column_absent: true,
        due_index_present: true,
        metadata: {
          before: { workStatus: "needs_action" },
          after: { workStatus: "needs_action" },
        },
      });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
  }, 30_000);

  test("removes conversation followers and comment mentions without retaining legacy tables", async () => {
    await migrate();
    await sql`DELETE FROM mail.schema_migrations WHERE version = 78`;
    await migrate();
    const [shape] = await sql<
      {
        applied: boolean;
        follower_table_absent: boolean;
        mention_table_absent: boolean;
        delivery_constraint: string;
        mention_definition_inactive: boolean;
        legacy_activity_absent: boolean;
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM mail.schema_migrations
          WHERE version = 78 AND name = 'remove_conversation_followers_and_mentions'
        ) AS applied,
        to_regclass('mail.conversation_watchers') IS NULL AS follower_table_absent,
        to_regclass('mail.conversation_comment_mentions') IS NULL AS mention_table_absent,
        (
          SELECT pg_get_constraintdef(oid)
          FROM pg_constraint
          WHERE conrelid = 'mail.collaboration_notification_deliveries'::regclass
            AND conname = 'collaboration_notification_deliveries_kind_check'
        ) AS delivery_constraint,
        NOT EXISTS (
          SELECT 1
          FROM notifications.definitions
          WHERE id = 'mail.commentMention' AND active
        ) AS mention_definition_inactive,
        NOT EXISTS (
          SELECT 1
          FROM mail.activity_events
          WHERE action IN ('conversation.watcher_added', 'conversation.watcher_removed')
            OR metadata ? 'mentionUserIds'
        ) AS legacy_activity_absent
    `;

    expect(shape).toMatchObject({
      applied: true,
      follower_table_absent: true,
      mention_table_absent: true,
      mention_definition_inactive: true,
      legacy_activity_absent: true,
    });
    expect(shape?.delivery_constraint).toContain("kind = 'reminder'");
    expect(shape?.delivery_constraint).not.toContain("mention");
  });

  test("installs the complete public-link storage schema once with detachable blobs", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        applied_count: string | number;
        all_tables_present: boolean;
        blob_nullable: boolean;
        blob_on_delete_set_null: boolean;
        grant_claim_present: boolean;
      }[]
    >`
      SELECT
        (
          SELECT count(*)
          FROM mail.schema_migrations
          WHERE version = 64 AND name = 'public_attachment_links_storage_snapshots'
        ) AS applied_count,
        to_regclass('mail.attachment_links') IS NOT NULL
          AND to_regclass('mail.attachment_link_grants') IS NOT NULL
          AND to_regclass('mail.storage_usage_snapshots') IS NOT NULL
          AND to_regclass('mail.storage_system_snapshot') IS NOT NULL AS all_tables_present,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'attachment_links'
            AND column_name = 'blob_id'
            AND is_nullable = 'YES'
        ) AS blob_nullable,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mail.attachment_links'::regclass
            AND conname = 'attachment_links_blob_id_fkey'
            AND confdeltype = 'n'
        ) AS blob_on_delete_set_null,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'attachment_link_grants'
            AND column_name = 'download_claimed_at'
        ) AS grant_claim_present
    `;

    expect(Number(shape?.applied_count)).toBe(1);
    expect(shape).toMatchObject({
      all_tables_present: true,
      blob_nullable: true,
      blob_on_delete_set_null: true,
      grant_claim_present: true,
    });
  });

  test("appends the operator command contract after existing Mail migrations", async () => {
    await migrate();
    const [shape] = await sql<{ applied: boolean; attention_index_present: boolean; constraint: string }[]>`
      SELECT
        EXISTS (SELECT 1 FROM mail.schema_migrations WHERE version = 67 AND name = 'operator_maintenance_commands') AS applied,
        to_regclass('mail.commands_mailbox_attention_idx') IS NOT NULL AS attention_index_present,
        pg_get_constraintdef(oid) AS constraint
      FROM pg_constraint
      WHERE conrelid = 'mail.commands'::regclass AND conname = 'commands_kind_check'
    `;

    expect(shape?.applied).toBe(true);
    expect(shape?.attention_index_present).toBe(true);
    expect(shape?.constraint).toContain("rebuild_search");
    expect(shape?.constraint).toContain("reconcile_effect");
    expect(shape?.constraint).toContain("cancel_command");
  });

  test("installs compose templates, signature defaults, and mailbox styles", async () => {
    await migrate();
    const [shape] = await sql<
      {
        templates_present: boolean;
        defaults_present: boolean;
        styles_present: boolean;
        template_indexes_present: boolean;
        default_indexes_present: boolean;
        mailbox_reference_constraints_present: boolean;
        scheduled_send_ordering_present: boolean;
        scheduled_send_guard_present: boolean;
        automatic_reply_invariants_present: boolean;
        sender_automation_default: boolean;
        inline_response_timing_present: boolean;
        imap_push_health_present: boolean;
        canonical_saved_view_search_present: boolean;
        canonical_saved_view_search_strict: boolean;
        draft_remote_observations_supported: boolean;
        draft_recovery_attachments_present: boolean;
      }[]
    >`
      SELECT
        to_regclass('mail.compose_templates') IS NOT NULL AS templates_present,
        to_regclass('mail.compose_signature_defaults') IS NOT NULL AS defaults_present,
        to_regclass('mail.compose_styles') IS NOT NULL AS styles_present,
        to_regclass('mail.compose_templates_mailbox_shortcut_idx') IS NOT NULL
          AND to_regclass('mail.compose_templates_private_shortcut_idx') IS NOT NULL AS template_indexes_present,
        to_regclass('mail.compose_signature_defaults_mailbox_idx') IS NOT NULL
          AND to_regclass('mail.compose_signature_defaults_user_idx') IS NOT NULL AS default_indexes_present,
        (
          SELECT count(*) = 2
          FROM pg_constraint
          WHERE conrelid = 'mail.compose_signature_defaults'::regclass
            AND conname IN ('compose_signature_defaults_sender_fk', 'compose_signature_defaults_template_fk')
        ) AS mailbox_reference_constraints_present,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'outbox_submissions'
            AND column_name = 'requested_at'
            AND is_nullable = 'NO'
        ) AND to_regclass('mail.outbox_scheduled_view_idx') IS NOT NULL AS scheduled_send_ordering_present,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'mail.outbox_submissions'::regclass
            AND tgname = 'outbox_requested_at_guard'
            AND NOT tgisinternal
        ) AS scheduled_send_guard_present,
        to_regclass('mail.automatic_reply_configurations_one_active_idx') IS NOT NULL
          AND to_regclass('mail.automatic_reply_rate_idx') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'mail'
              AND table_name = 'automatic_reply_effects'
              AND column_name = 'confirmed_at'
          )
          AND EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conrelid = 'mail.automatic_reply_effects'::regclass
              AND conname = 'automatic_reply_effects_confirmed_at_check'
              AND convalidated
          ) AS automatic_reply_invariants_present,
        (
          SELECT column_default = '''mailbox''::text'
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'sender_identities'
            AND column_name = 'automation_policy'
        ) AS sender_automation_default,
        to_regclass('mail.response_schedules') IS NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'mail'
              AND table_name = 'automatic_reply_configurations'
              AND column_name = 'schedule_definition'
              AND is_nullable = 'NO'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'mail'
              AND (
                (table_name = 'automatic_reply_configurations' AND column_name = 'response_schedule_id')
                OR (table_name = 'automatic_reply_effects' AND column_name IN ('response_schedule_id', 'response_schedule_revision'))
              )
          ) AS inline_response_timing_present,
        to_regclass('mail.imap_push_listener_health') IS NOT NULL
          AND to_regclass('mail.imap_push_listener_health_state_idx') IS NOT NULL AS imap_push_health_present,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mail.saved_conversation_views'::regclass
            AND conname = 'saved_conversation_views_canonical_search_check'
            AND convalidated
        )
        AND (
          SELECT column_default IS NULL
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'saved_conversation_views'
            AND column_name = 'filter'
        ) AS canonical_saved_view_search_present,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mail.saved_conversation_views'::regclass
            AND conname = 'saved_conversation_views_canonical_search_check'
            AND pg_get_constraintdef(oid) LIKE '%filter ? ''expression''%'
            AND pg_get_constraintdef(oid) LIKE '%filter ? ''sort''%'
            AND pg_get_constraintdef(oid) LIKE '%IS TRUE%'
        ) AS canonical_saved_view_search_strict,
        EXISTS (
          SELECT 1
          FROM pg_index
          WHERE indexrelid = 'mail.draft_provider_snapshots_remote_identity_idx'::regclass
            AND indisunique = false
        ) AS draft_remote_observations_supported,
        to_regclass('mail.draft_recovery_attachments') IS NOT NULL
          AND to_regclass('mail.draft_recovery_attachments_blob_idx') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'mail'
              AND table_name = 'draft_recovery_copies'
              AND column_name = 'has_attachment_snapshot'
              AND is_nullable = 'NO'
          ) AS draft_recovery_attachments_present
    `;
    expect(shape).toEqual({
      templates_present: true,
      defaults_present: true,
      styles_present: true,
      template_indexes_present: true,
      default_indexes_present: true,
      mailbox_reference_constraints_present: true,
      scheduled_send_ordering_present: true,
      scheduled_send_guard_present: true,
      automatic_reply_invariants_present: true,
      sender_automation_default: true,
      inline_response_timing_present: true,
      imap_push_health_present: true,
      canonical_saved_view_search_present: true,
      canonical_saved_view_search_strict: true,
      draft_remote_observations_supported: true,
      draft_recovery_attachments_present: true,
    });
  });

  test("installs provider limits and deterministic outbound preflight evidence", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        limit_snapshot_present: boolean;
        mime_date_required: boolean;
        preflight_columns_present: boolean;
        migrations_applied: boolean;
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'provider_connections'
            AND column_name = 'limit_snapshot'
            AND is_nullable = 'NO'
        ) AS limit_snapshot_present,
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'outbox_submissions'
            AND column_name = 'mime_date'
            AND is_nullable = 'NO'
        ) AS mime_date_required,
        (
          SELECT count(*) = 3
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'outbox_submissions'
            AND column_name IN (
              'preflight_byte_length',
              'preflight_smtp_limit_bytes',
              'preflight_checked_at'
            )
        ) AS preflight_columns_present,
        (
          SELECT count(*) = 2
          FROM mail.schema_migrations
          WHERE (version, name) IN (
            (85, 'provider_limit_snapshots'),
            (86, 'outbound_message_preflight')
          )
        ) AS migrations_applied
    `;
    expect(shape).toEqual({
      limit_snapshot_present: true,
      mime_date_required: true,
      preflight_columns_present: true,
      migrations_applied: true,
    });
  });

  test("repairs an accidentally unique remote draft observation index in place", async () => {
    await migrate();
    await sql`DELETE FROM mail.schema_migrations WHERE version = 61`;
    await sql`DROP INDEX mail.draft_provider_snapshots_remote_identity_idx`;
    await sql`
      CREATE UNIQUE INDEX draft_provider_snapshots_remote_identity_idx
      ON mail.draft_provider_snapshots (id)
    `;

    await migrate();

    const [index] = await sql<{ unique: boolean; definition: string }[]>`
      SELECT index_state.indisunique AS unique, pg_get_indexdef(index_state.indexrelid) AS definition
      FROM pg_index index_state
      WHERE index_state.indexrelid = 'mail.draft_provider_snapshots_remote_identity_idx'::regclass
    `;
    expect(index?.unique).toBe(false);
    expect(index?.definition).toContain("(folder_id, uid_validity, uid, created_at DESC)");
    expect(index?.definition).toContain("WHERE ((folder_id IS NOT NULL)");
  });

  test("adds mailbox-consistent local tags and a safe reference-search bridge", async () => {
    await migrate();
    const [shape] = await sql<
      {
        tags_present: boolean;
        assignments_present: boolean;
        reference_request_ledger_present: boolean;
        reference_configuration_present: boolean;
        legacy_reference_schemes_absent: boolean;
        reference_without_table: boolean;
      }[]
    >`
      SELECT
        to_regclass('mail.local_tags') IS NOT NULL AS tags_present,
        to_regclass('mail.conversation_local_tags') IS NOT NULL AS assignments_present,
        to_regclass('mail.conversation_reference_requests') IS NOT NULL AS reference_request_ledger_present,
        to_regclass('mail.reference_number_configurations') IS NOT NULL AS reference_configuration_present,
        to_regclass('mail.reference_schemes') IS NULL AS legacy_reference_schemes_absent,
        mail.search_reference_matches(gen_random_uuid(), 'SUP-42', 'exact') = false AS reference_without_table
    `;
    expect(shape).toEqual({
      tags_present: true,
      assignments_present: true,
      reference_request_ledger_present: true,
      reference_configuration_present: true,
      legacy_reference_schemes_absent: true,
      reference_without_table: true,
    });
  });

  test("enforces mailbox-owned current provider connections and bindings", async () => {
    await migrate();
    const [shape] = await sql<
      {
        legacy_columns_absent: boolean;
        current_indexes_present: boolean;
        mailbox_guard_present: boolean;
        account_evidence_guard_present: boolean;
      }[]
    >`
      SELECT
        NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND (
              (table_name = 'mailboxes' AND column_name = 'connection_policy')
              OR (table_name = 'provider_connections' AND column_name IN ('owner_user_id', 'owner_service_account_id'))
              OR (table_name = 'sender_identities' AND column_name = 'interactive_policy')
            )
        ) AS legacy_columns_absent,
        to_regclass('mail.provider_connections_mailbox_active_idx') IS NOT NULL
          AND to_regclass('mail.provider_bindings_resource_current_idx') IS NOT NULL
          AND to_regclass('mail.provider_bindings_connection_current_idx') IS NOT NULL AS current_indexes_present,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'mail.provider_bindings'::regclass
            AND tgname = 'provider_bindings_mailbox_guard'
            AND NOT tgisinternal
        ) AS mailbox_guard_present,
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'mail.provider_bindings'::regclass
            AND tgname = 'provider_bindings_account_evidence_guard'
            AND NOT tgisinternal
        )
        AND EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mail.provider_bindings'::regclass
            AND conname = 'provider_bindings_account_evidence_matches'
            AND convalidated
        )
        AND NOT EXISTS (
          SELECT 1
          FROM mail.provider_bindings
          WHERE NULLIF(remote_locator ->> 'accountId', '') IS NOT NULL
            AND verification_evidence ->> 'accountId' IS DISTINCT FROM remote_locator ->> 'accountId'
        ) AS account_evidence_guard_present
    `;
    expect(shape).toEqual({
      legacy_columns_absent: true,
      current_indexes_present: true,
      mailbox_guard_present: true,
      account_evidence_guard_present: true,
    });

    const mailboxId = crypto.randomUUID();
    const otherMailboxId = crypto.randomUUID();
    try {
      await sql`
        INSERT INTO mail.mailboxes (short_id, id, name)
        VALUES
          (${newShortId()}, ${mailboxId}, 'Provider invariant test'),
          (${newShortId()}, ${otherMailboxId}, 'Other provider invariant test')
      `;
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint)
        VALUES (${mailboxId}, '{}'::jsonb, '{}'::jsonb, ${"a".repeat(64)})
        RETURNING id
      `;
      const [revokedConnection] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_connections (
          owner_mailbox_id, name, email, username,
          imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode,
          secret_kind, encrypted_secret, status
        ) VALUES (
          ${mailboxId}, 'Historical', 'history@example.com', 'history@example.com',
          'imap.example.com', 993, 'implicit', 'smtp.example.com', 465, 'implicit',
          'password', NULL, 'revoked'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
        VALUES (${resource!.id}, ${revokedConnection!.id}, 'revoked', '{}'::jsonb)
      `;
      const accountId = "b".repeat(64);
      const [normalizedEvidence] = await sql<{ account_id: string | null }[]>`
        UPDATE mail.provider_bindings
        SET remote_locator = ${{ accountId }}::jsonb, verification_evidence = '{}'::jsonb
        WHERE connection_id = ${revokedConnection!.id}::uuid
        RETURNING verification_evidence ->> 'accountId' AS account_id
      `;
      expect(normalizedEvidence?.account_id).toBe(accountId);
      let mismatchedEvidenceError: unknown;
      try {
        await sql`
          UPDATE mail.provider_bindings
          SET verification_evidence = ${{ accountId: "c".repeat(64) }}::jsonb
          WHERE connection_id = ${revokedConnection!.id}::uuid
        `;
      } catch (error) {
        mismatchedEvidenceError = error;
      }
      expect(mismatchedEvidenceError).toMatchObject({ errno: "23514" });
      const [currentConnection] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_connections (
          owner_mailbox_id, name, email, username,
          imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode,
          secret_kind, encrypted_secret, status
        ) VALUES (
          ${mailboxId}, 'Current', 'current@example.com', 'current@example.com',
          'imap.example.com', 993, 'implicit', 'smtp.example.com', 465, 'implicit',
          'password', 'encrypted-fixture', 'active'
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
        VALUES (${resource!.id}, ${currentConnection!.id}, 'active', '{}'::jsonb)
      `;

      let duplicateCurrentError: unknown;
      try {
        await sql`
          INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
          VALUES (${resource!.id}, ${currentConnection!.id}, 'pending', '{}'::jsonb)
        `;
      } catch (error) {
        duplicateCurrentError = error;
      }
      expect(duplicateCurrentError).toMatchObject({ errno: "23505" });

      const [otherConnection] = await sql<{ id: string }[]>`
        INSERT INTO mail.provider_connections (
          owner_mailbox_id, name, email, username,
          imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode,
          secret_kind, encrypted_secret, status
        ) VALUES (
          ${otherMailboxId}, 'Other', 'other@example.com', 'other@example.com',
          'imap.example.com', 993, 'implicit', 'smtp.example.com', 465, 'implicit',
          'password', 'encrypted-fixture', 'active'
        )
        RETURNING id
      `;
      let crossMailboxError: unknown;
      try {
        await sql`
          INSERT INTO mail.provider_bindings (remote_resource_id, connection_id, state, remote_locator)
          VALUES (${resource!.id}, ${otherConnection!.id}, 'active', '{}'::jsonb)
        `;
      } catch (error) {
        crossMailboxError = error;
      }
      expect(crossMailboxError).toMatchObject({ errno: "23514" });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id IN (${mailboxId}, ${otherMailboxId})`;
    }
  });

  test("installs durable single-use provider OAuth state and token revision fencing", async () => {
    await migrate();
    const [shape] = await sql<
      {
        flow_table_present: boolean;
        connection_columns_present: boolean;
        flow_columns_present: boolean;
        cleanup_index_present: boolean;
      }[]
    >`
      SELECT
        to_regclass('mail.provider_oauth_flows') IS NOT NULL AS flow_table_present,
        (
          SELECT count(*) = 3
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'provider_connections'
            AND column_name IN ('oauth_provider_id', 'oauth_token_revision', 'oauth_expires_at')
        ) AS connection_columns_present,
        (
          SELECT count(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'provider_oauth_flows'
            AND column_name IN ('create_sender', 'saves_sent_automatically')
        ) AS flow_columns_present,
        to_regclass('mail.provider_oauth_flows_cleanup_idx') IS NOT NULL AS cleanup_index_present
    `;
    expect(shape).toEqual({
      flow_table_present: true,
      connection_columns_present: true,
      flow_columns_present: true,
      cleanup_index_present: true,
    });

    const userId = crypto.randomUUID();
    const mailboxId = crypto.randomUUID();
    const flowId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO auth.users (id, uid, provider, profile)
          VALUES (${userId}::uuid, ${`oauth-migration-${userId}`}, 'local', 'user')
        `;
        await tx`INSERT INTO mail.mailboxes (short_id, id, name) VALUES (${newShortId()}, ${mailboxId}::uuid, 'OAuth migration test')`;
        await tx`
          INSERT INTO mail.provider_oauth_flows (
            id, state_hash, browser_nonce_hash, mailbox_id, user_id, provider_id, operation,
            connection_input, create_sender, saves_sent_automatically, encrypted_code_verifier, expires_at
          ) VALUES (
            ${flowId}::uuid, ${"a".repeat(64)}, ${"b".repeat(64)}, ${mailboxId}::uuid, ${userId}::uuid,
            'google', 'create', '{}'::jsonb, true, true, 'encrypted-verifier', now() + interval '10 minutes'
          )
        `;
      });
      const [flowOptions] = await sql<{ create_sender: boolean; saves_sent_automatically: boolean }[]>`
        SELECT create_sender, saves_sent_automatically
        FROM mail.provider_oauth_flows
        WHERE id = ${flowId}::uuid
      `;
      expect(flowOptions).toEqual({ create_sender: true, saves_sent_automatically: true });
      const claim = () => sql<{ id: string }[]>`
        UPDATE mail.provider_oauth_flows
        SET status = 'exchanging', consumed_at = now()
        WHERE id = ${flowId}::uuid AND status = 'pending' AND consumed_at IS NULL AND expires_at > now()
        RETURNING id
      `;
      const claims = await Promise.all([claim(), claim()]);
      expect(claims.map((rows) => rows.length).sort()).toEqual([0, 1]);

      await sql`
        INSERT INTO mail.provider_connections (
          id, owner_mailbox_id, name, email, username,
          imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode,
          secret_kind, encrypted_secret, status, oauth_provider_id, oauth_expires_at
        ) VALUES (
          ${connectionId}::uuid, ${mailboxId}::uuid, 'Managed OAuth', 'oauth@example.com', 'oauth@example.com',
          'imap.example.com', 993, 'implicit', 'smtp.example.com', 465, 'implicit',
          'oauth2', 'encrypted-original', 'active', 'google', now() - interval '1 minute'
        )
      `;
      const commit = (encryptedSecret: string) =>
        commitManagedOAuthRefresh({
          connectionId,
          expectedSecretRevision: 1,
          expectedOAuthTokenRevision: 0,
          encryptedSecret,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      const refreshes = await Promise.all([commit("encrypted-refresh-a"), commit("encrypted-refresh-b")]);
      expect(refreshes.sort()).toEqual([false, true]);
      const [refreshed] = await sql<{ encrypted_secret: string; secret_revision: number; oauth_token_revision: string | number }[]>`
        SELECT encrypted_secret, secret_revision, oauth_token_revision
        FROM mail.provider_connections
        WHERE id = ${connectionId}::uuid
      `;
      expect(refreshed?.encrypted_secret).toMatch(/^encrypted-refresh-[ab]$/);
      expect(refreshed?.secret_revision).toBe(1);
      expect(Number(refreshed?.oauth_token_revision)).toBe(1);

      await sql`
        UPDATE mail.provider_connections
        SET status = 'revoked', encrypted_secret = NULL, oauth_provider_id = NULL, oauth_expires_at = NULL
        WHERE id = ${connectionId}::uuid
      `;
      expect(
        await commitManagedOAuthRefresh({
          connectionId,
          expectedSecretRevision: 1,
          expectedOAuthTokenRevision: 1,
          encryptedSecret: "encrypted-after-revoke",
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      ).toBe(false);
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("installs only the shared workflow storage while preserving the rest of the Mail schema", async () => {
    await migrate();
    await migrate();

    const [state] = await sql<
      {
        migration_applied: boolean;
        legacy_tables_absent: boolean;
        kernel_tables_present: boolean;
        command_generation_fence_present: boolean;
        workflow_manager_present: boolean;
        kernel_foreign_keys_present: boolean;
        profile_index_present: boolean;
        profile_touch_trigger_present: boolean;
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1 FROM mail.schema_migrations
          WHERE version = 17
        ) AS migration_applied,
        NOT EXISTS (
          SELECT 1
          FROM (VALUES
            ('workflows'),
            ('workflow_versions'),
            ('workflow_activations'),
            ('workflow_trigger_events'),
            ('workflow_runs'),
            ('workflow_run_targets'),
            ('workflow_step_runs')
          ) expected(table_name)
          WHERE to_regclass('mail.' || expected.table_name) IS NOT NULL
        ) AS legacy_tables_absent,
        NOT EXISTS (
          SELECT 1
          FROM (VALUES
            ('workflow_profile'),
            ('workflow_run_state'),
            ('automatic_reply_effects')
          ) expected(table_name)
          WHERE to_regclass('mail.' || expected.table_name) IS NULL
        ) AS kernel_tables_present,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'commands'
            AND column_name = 'workflow_execution_generation'
            AND data_type = 'bigint'
        ) AS command_generation_fence_present,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'workflow_profile'
            AND column_name = 'managed_by'
            AND data_type = 'text'
        ) AS workflow_manager_present,
        NOT EXISTS (
          SELECT 1
          FROM (VALUES
            ('mail.workflow_profile', 'workflows.workflow'),
            ('mail.workflow_run_state', 'workflows.run'),
            ('mail.automatic_reply_configurations', 'mail.workflow_profile'),
            ('mail.incoming_automations', 'mail.workflow_profile'),
            ('mail.automatic_reply_effects', 'workflows.version'),
            ('mail.automatic_reply_effects', 'workflows.run')
          ) expected(source_table, target_table)
          WHERE NOT EXISTS (
            SELECT 1
            FROM pg_constraint constraint_info
            WHERE constraint_info.contype = 'f'
              AND constraint_info.conrelid = expected.source_table::regclass
              AND constraint_info.confrelid = expected.target_table::regclass
          )
        ) AS kernel_foreign_keys_present,
        to_regclass('mail.workflow_profile_mailbox_priority_idx') IS NOT NULL AS profile_index_present,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'mail.workflow_profile'::regclass
            AND tgname = 'workflow_profile_touch_updated_at'
            AND NOT tgisinternal
        ) AS profile_touch_trigger_present
    `;
    expect(state).toEqual({
      migration_applied: true,
      legacy_tables_absent: true,
      kernel_tables_present: true,
      command_generation_fence_present: true,
      workflow_manager_present: true,
      kernel_foreign_keys_present: true,
      profile_index_present: true,
      profile_touch_trigger_present: true,
    });
  }, 30_000);

  test("installs tenant-scoped search and runtime recovery indexes", async () => {
    await migrate();
    const indexes = await sql<{ name: string }[]>`
      SELECT indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'mail'
        AND indexname IN (
          'message_placements_folder_unread_idx',
          'message_search_chunks_mailbox_document_idx',
          'sync_runs_terminal_retention_idx'
        )
      ORDER BY indexname
    `;
    expect(indexes.map((row) => row.name)).toEqual([
      "message_placements_folder_unread_idx",
      "message_search_chunks_mailbox_document_idx",
      "sync_runs_terminal_retention_idx",
    ]);

    const [mailboxColumn] = await sql<{ nullable: string }[]>`
      SELECT is_nullable AS nullable
      FROM information_schema.columns
      WHERE table_schema = 'mail'
        AND table_name = 'message_search_chunks'
        AND column_name = 'mailbox_id'
    `;
    expect(mailboxColumn).toEqual({ nullable: "NO" });

    const [savedViewShape] = await sql<
      {
        migration_applied: boolean;
        quarantine_columns: boolean;
        private_index: string;
        mailbox_index: string;
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1 FROM mail.schema_migrations
          WHERE version = 75 AND name = 'saved_view_quarantine'
        ) AS migration_applied,
        (
          SELECT COUNT(*) = 3
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'saved_conversation_views'
            AND column_name IN ('invalid_filter', 'disabled_at', 'migration_error')
        ) AS quarantine_columns,
        pg_get_indexdef('mail.saved_conversation_views_private_name_idx'::regclass) AS private_index,
        pg_get_indexdef('mail.saved_conversation_views_mailbox_name_idx'::regclass) AS mailbox_index
    `;
    expect(savedViewShape?.migration_applied).toBe(true);
    expect(savedViewShape?.quarantine_columns).toBe(true);
    expect(savedViewShape?.private_index).toContain("disabled_at IS NULL");
    expect(savedViewShape?.mailbox_index).toContain("disabled_at IS NULL");
  });

  test("installs exact message source and canonical protocol facts once", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        applied_count: number;
        columns_present: boolean;
        source_blob_restricted: boolean;
        source_index_present: boolean;
        invalid_protocol_facts: number;
        legacy_machine_headers: number;
      }[]
    >`
      SELECT
        (
          SELECT count(*)::int
          FROM mail.schema_migrations
          WHERE version = 83 AND name = 'message_protocol_foundations'
        ) AS applied_count,
        (
          SELECT count(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'message_contents'
            AND column_name IN ('source_blob_id', 'protocol_facts')
        ) AS columns_present,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'mail.message_contents'::regclass
            AND conname = 'message_contents_source_blob_id_fkey'
            AND confdeltype = 'r'
        ) AS source_blob_restricted,
        to_regclass('mail.message_contents_source_blob_idx') IS NOT NULL AS source_index_present,
        (
          SELECT count(*)::int
          FROM mail.message_contents
          WHERE jsonb_typeof(protocol_facts) <> 'object'
            OR protocol_facts ->> 'version' <> '1'
            OR jsonb_typeof(protocol_facts -> 'list') <> 'object'
            OR jsonb_typeof(protocol_facts -> 'priority') <> 'object'
            OR jsonb_typeof(protocol_facts -> 'receipts') <> 'object'
            OR jsonb_typeof(protocol_facts -> 'spam') <> 'object'
        ) AS invalid_protocol_facts,
        (
          SELECT count(*)::int
          FROM mail.message_contents
          WHERE selected_headers ?| ARRAY[
            'returnPath',
            'autoSubmitted',
            'listId',
            'autoResponseSuppress',
            'contentType',
            'deliveryStatus'
          ]::text[]
        ) AS legacy_machine_headers
    `;

    expect(shape).toEqual({
      applied_count: 1,
      columns_present: true,
      source_blob_restricted: true,
      source_index_present: true,
      invalid_protocol_facts: 0,
      legacy_machine_headers: 0,
    });
  });

  test("installs durable Mail security operations once", async () => {
    await migrate();
    await migrate();
    const [shape] = await sql<
      {
        operations_applied: number;
        hardening_applied: number;
        policies_present: boolean;
        reports_present: boolean;
        report_sources_present: boolean;
        sender_snapshot_columns: boolean;
        read_cache_absent: boolean;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM mail.schema_migrations WHERE version = 106 AND name = 'mail_security_operations')
          AS operations_applied,
        (SELECT count(*)::int FROM mail.schema_migrations WHERE version = 107 AND name = 'mail_security_operations_hardening')
          AS hardening_applied,
        to_regclass('mail.security_policies') IS NOT NULL AS policies_present,
        to_regclass('mail.security_reports') IS NOT NULL AS reports_present,
        to_regclass('mail.security_report_sources') IS NOT NULL AS report_sources_present,
        (
          SELECT count(*) = 2
          FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND table_name = 'security_reports'
            AND column_name IN ('sender_address', 'sender_domain')
        ) AS sender_snapshot_columns,
        to_regclass('mail.message_security_assessments') IS NULL AS read_cache_absent
    `;

    expect(shape).toEqual({
      operations_applied: 1,
      hardening_applied: 1,
      policies_present: true,
      reports_present: true,
      report_sources_present: true,
      sender_snapshot_columns: true,
      read_cache_absent: true,
    });
  });
});
