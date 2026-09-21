import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { migrate } from "./migrate";

const suite = suiteFor("database", "nats");

/**
 * Mail's schema is a single baseline (`src/schema.sql`). These checks cover the
 * runner contract — one recorded version, a no-op rerun, a refusal for foreign
 * versions — plus the invariants of the installed schema that are easy to lose
 * when the baseline is regenerated.
 */
suite("mail baseline schema", () => {
  test("records exactly one baseline version and reruns as a no-op", async () => {
    await migrate();
    const [first] = await sql<{ version: number; name: string; applied_at: Date }[]>`
      SELECT version, name, applied_at FROM mail.schema_migrations
    `;
    expect(first?.version).toBe(1);
    expect(first?.name).toBe("baseline");

    await migrate();
    const rerun = await sql<{ version: number; name: string; applied_at: Date }[]>`
      SELECT version, name, applied_at FROM mail.schema_migrations
    `;
    expect(rerun).toHaveLength(1);
    expect(rerun[0]?.applied_at).toEqual(first!.applied_at);
  });

  test("refuses a database left behind by the removed migration chain", async () => {
    await migrate();
    await sql`INSERT INTO mail.schema_migrations (version, name) VALUES (126, 'drop_legacy_automation_authority')`;
    try {
      await expect(migrate()).rejects.toThrow(/DROP SCHEMA mail CASCADE/);
    } finally {
      await sql`DELETE FROM mail.schema_migrations WHERE version = 126`;
    }
    await migrate();
  });

  test("seeds the singleton rows a fresh installation needs", async () => {
    await migrate();
    const [security] = await sql<{ singleton: boolean; trusted: string[] }[]>`
      SELECT singleton, trusted_authserv_ids AS trusted FROM mail.security_settings
    `;
    expect(security).toEqual({ singleton: true, trusted: [] });
  });

  test("installs the extensions, functions and triggers the schema depends on", async () => {
    await migrate();
    const [shape] = await sql<{ extensions: number; functions: number; triggers: number; workflow_ai_table: boolean }[]>`
      SELECT
        (SELECT count(*)::int FROM pg_extension WHERE extname IN ('pgcrypto', 'pg_trgm', 'btree_gin')) AS extensions,
        (
          SELECT count(*)::int FROM pg_proc
          JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
          WHERE pg_namespace.nspname = 'mail'
            AND pg_proc.proname IN (
              'enforce_provider_binding_mailbox', 'normalize_provider_binding_account_evidence',
              'protect_conversation_reference_allocation', 'guard_outbox_requested_at',
              'enqueue_live_invalidation', 'enqueue_activity_live_invalidation',
              'search_reference_matches', 'touch_updated_at'
            )
        ) AS functions,
        (
          SELECT count(*)::int FROM pg_trigger
          JOIN pg_class ON pg_class.oid = pg_trigger.tgrelid
          JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = 'mail' AND NOT pg_trigger.tgisinternal
        ) AS triggers,
        to_regclass('ai.workflow_task') IS NOT NULL AS workflow_ai_table
    `;
    expect(shape).toEqual({ extensions: 3, functions: 8, triggers: 29, workflow_ai_table: true });
  });

  test("gives every public resource a stable short ID next to its UUID key", async () => {
    await migrate();
    const [shape] = await sql<
      { tables: number; short_id_columns: number; nullable_columns: number; unique_indexes: number; uuid_primary_keys: number }[]
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
        (SELECT count(*)::int FROM resource_tables) AS tables,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail' AND column_shape.column_name = 'short_id'
            AND column_shape.is_nullable = 'NO'
        ) AS short_id_columns,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail' AND column_shape.column_name = 'short_id'
            AND column_shape.is_nullable <> 'NO'
        ) AS nullable_columns,
        (
          SELECT count(*)::int FROM pg_index
          JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
          JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
          JOIN pg_namespace ON pg_namespace.oid = table_class.relnamespace
          JOIN resource_tables resource ON resource.table_name = table_class.relname
          WHERE pg_namespace.nspname = 'mail' AND pg_index.indisunique
            AND index_class.relname LIKE '%short_id%'
        ) AS unique_indexes,
        (
          SELECT count(*)::int FROM information_schema.columns column_shape
          JOIN resource_tables resource USING (table_name)
          WHERE column_shape.table_schema = 'mail' AND column_shape.column_name = 'id'
            AND column_shape.data_type = 'uuid'
        ) AS uuid_primary_keys
    `;
    expect(shape).toEqual({
      tables: 16,
      short_id_columns: 16,
      nullable_columns: 0,
      unique_indexes: 16,
      uuid_primary_keys: 16,
    });
  });

  test("does not carry over the tables and columns the alpha model retired", async () => {
    await migrate();
    const [shape] = await sql<{ retired_tables: number; retired_columns: number }[]>`
      SELECT
        (
          SELECT count(*)::int FROM information_schema.tables
          WHERE table_schema = 'mail'
            AND table_name IN (
              'conversation_space_links', 'conversation_followers', 'conversation_comment_mentions',
              'reference_schemes', 'mail_rules', 'sender_rules', 'workflow_automations',
              'ai_automations', 'automation_steps'
            )
        ) AS retired_tables,
        (
          SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'mail'
            AND (
              (table_name = 'incoming_automations' AND column_name IN (
                'integration_credential_id', 'encrypted_integration_token', 'authority_migration_attempted_at'
              ))
              OR (table_name = 'conversations' AND column_name IN ('state', 'archived_at', 'follower_count'))
              OR (table_name = 'conversation_comments' AND column_name = 'reply_to_comment_id')
            )
        ) AS retired_columns
    `;
    expect(shape).toEqual({ retired_tables: 0, retired_columns: 0 });
  });

  test("keeps the invariants the runtime relies on", async () => {
    await migrate();
    const [shape] = await sql<
      {
        mailbox_owned_connections: boolean;
        reference_configuration_singleton: boolean;
        live_invalidation_outbox: boolean;
        attachment_extractions: boolean;
        search_chunk_sources: number;
        workflow_profile: boolean;
      }[]
    >`
      SELECT
        to_regclass('mail.provider_connections_mailbox_active_idx') IS NOT NULL AS mailbox_owned_connections,
        EXISTS (
          SELECT 1 FROM pg_index
          JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
          JOIN pg_class table_class ON table_class.oid = pg_index.indrelid
          JOIN pg_namespace ON pg_namespace.oid = table_class.relnamespace
          WHERE pg_namespace.nspname = 'mail'
            AND table_class.relname = 'reference_number_configurations'
            AND pg_index.indisunique
        ) AS reference_configuration_singleton,
        to_regclass('mail.live_invalidation_outbox') IS NOT NULL AS live_invalidation_outbox,
        to_regclass('mail.attachment_extractions') IS NOT NULL AS attachment_extractions,
        (
          SELECT count(*)::int FROM information_schema.columns
          WHERE table_schema = 'mail' AND table_name = 'message_search_chunks'
            AND column_name IN ('source_kind', 'attachment_id', 'blob_id', 'extractor_version')
        ) AS search_chunk_sources,
        to_regclass('mail.workflow_profile') IS NOT NULL AS workflow_profile
    `;
    expect(shape).toEqual({
      mailbox_owned_connections: true,
      reference_configuration_singleton: true,
      live_invalidation_outbox: true,
      attachment_extractions: true,
      search_chunk_sources: 4,
      workflow_profile: true,
    });
  });
});
