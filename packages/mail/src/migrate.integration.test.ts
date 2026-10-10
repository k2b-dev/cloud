import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { newShortId } from "./lib/short-id";
import { buildOptionalSearchIndex, migrate } from "./migrate";

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

  test("serializes concurrent runs behind a transaction-scoped guard", async () => {
    await Promise.all([migrate(), migrate(), migrate()]);
    const rows = await sql<{ version: number }[]>`SELECT version FROM mail.schema_migrations`;
    expect(rows).toHaveLength(1);
    // pg_locks spans the whole server; other databases on it may hold advisory locks of their own.
    const [locks] = await sql<{ held: number }[]>`
      SELECT count(*)::int AS held
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    `;
    expect(locks?.held).toBe(0);
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

  test("adds tables and indexes created after the baseline to a database installed before them", async () => {
    await migrate();
    await sql`DROP TABLE mail.personal_mailbox_preferences`;
    await sql`DROP INDEX mail.message_contents_hydration_claim_idx`;
    await sql`ALTER TABLE mail.outbox_submissions DROP COLUMN sent_copy_pending`;
    await migrate();
    const [shape] = await sql<
      {
        table_exists: boolean;
        claim_index_exists: boolean;
        sent_copy_index_exists: boolean;
        sent_copy_pending: string | null;
        versions: number;
      }[]
    >`
      SELECT
        to_regclass('mail.personal_mailbox_preferences') IS NOT NULL AS table_exists,
        to_regclass('mail.message_contents_hydration_claim_idx') IS NOT NULL AS claim_index_exists,
        to_regclass('mail.outbox_sent_copy_pending_idx') IS NOT NULL AS sent_copy_index_exists,
        (
          SELECT pg_get_expr(d.adbin, d.adrelid)
          FROM pg_attribute a
          JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'mail.outbox_submissions'::regclass AND a.attname = 'sent_copy_pending' AND a.attnotnull
        ) AS sent_copy_pending,
        (SELECT count(*)::int FROM mail.schema_migrations) AS versions
    `;
    // No version is recorded, so an older Mail image still starts on the upgraded database.
    expect(shape).toEqual({
      table_exists: true,
      claim_index_exists: true,
      sent_copy_index_exists: true,
      sent_copy_pending: "false",
      versions: 1,
    });
  });

  test("backfills assignees once when upgrading an older database and preserves later changes", async () => {
    await migrate();
    const suffix = crypto.randomUUID();
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile) VALUES (${`assignee-migration-${suffix}`}, 'local', 'user') RETURNING id`;
    const [mailbox] = await sql<
      { id: string }[]
    >`INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Assignee migration') RETURNING id`;
    if (!user || !mailbox) throw new Error("Migration fixture missing");
    const [conversation] = await sql<{ id: string; updated_at: Date }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, latest_message_at, assignee_user_id)
      VALUES (${newShortId()}, ${mailbox.id}::uuid, now(), ${user.id}::uuid) RETURNING id, updated_at
    `;
    if (!conversation) throw new Error("Migration conversation missing");
    try {
      await sql`DROP TABLE mail.conversation_assignees`;
      await migrate();
      const rows = await sql<
        { user_id: string; assigned_at: Date }[]
      >`SELECT user_id, assigned_at FROM mail.conversation_assignees WHERE conversation_id = ${conversation.id}::uuid`;
      expect(rows).toEqual([{ user_id: user.id, assigned_at: conversation.updated_at }]);
      await sql`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${conversation.id}::uuid`;
      await migrate();
      expect(await sql`SELECT 1 FROM mail.conversation_assignees WHERE conversation_id = ${conversation.id}::uuid`).toHaveLength(0);
    } finally {
      await migrate();
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${user.id}::uuid`;
    }
  });

  test("reruns without waiting for the lock a concurrent index build holds on messages", async () => {
    await migrate();
    const build = await sql.reserve();
    try {
      // CREATE INDEX CONCURRENTLY holds this lock for as long as the build runs.
      await build`BEGIN`.simple();
      await build`LOCK TABLE mail.message_contents IN SHARE UPDATE EXCLUSIVE MODE`.simple();
      const startedAt = performance.now();
      await migrate();
      expect(performance.now() - startedAt).toBeLessThan(5_000);
    } finally {
      await build`ROLLBACK`.simple();
      build.release();
    }
  });

  test("leaves the optional BM25 index to installations with pg_textsearch", async () => {
    const [extension] = await sql<{ installed: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed
    `;
    const outcome = await buildOptionalSearchIndex();
    const [index] = await sql<{ present: boolean }[]>`
      SELECT to_regclass('mail.message_contents_bm25_idx') IS NOT NULL AS present
    `;
    if (extension?.installed) {
      expect(["built", "ready"]).toContain(outcome);
      expect(index?.present).toBe(true);
    } else {
      expect(outcome).toBe("unavailable");
      expect(index?.present).toBe(false);
    }
  });

  test("builds the BM25 index once at a time without session locks, and replaces a broken one", async () => {
    const [extension] = await sql<{ installed: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed
    `;
    // The extension is optional and CI databases run without it; run this file against one that has it.
    if (!extension?.installed) return;
    const index = async () => {
      const [row] = await sql<{ method: string | null; valid: boolean | null }[]>`
        SELECT
          (SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid = c.relam WHERE c.oid = to_regclass('mail.message_contents_bm25_idx')) AS method,
          (SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('mail.message_contents_bm25_idx')) AS valid
      `;
      return row;
    };
    const buildRuns = async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await sql<{ pid: number }[]>`
          SELECT pid FROM pg_stat_progress_create_index WHERE index_relid = to_regclass('mail.message_contents_bm25_idx')
        `;
        if (row) return row.pid;
        await Bun.sleep(25);
      }
      throw new Error("The index build did not start");
    };
    const advisoryLocks = async () => {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM pg_locks
        WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      return row?.count;
    };
    // An open write keeps a concurrent build waiting, so each check sees the build while it runs.
    const writer = await sql.reserve();
    const other = await sql.reserve();
    try {
      // An index of another kind under the name is replaced.
      await sql`DROP INDEX IF EXISTS mail.message_contents_bm25_idx`;
      await sql`CREATE INDEX message_contents_bm25_idx ON mail.message_contents (id)`;
      expect(await buildOptionalSearchIndex()).toBe("built");
      expect(await index()).toEqual({ method: "bm25", valid: true });

      // While one start builds, another one leaves the build alone, and neither holds a session lock.
      await sql`DROP INDEX mail.message_contents_bm25_idx`;
      await writer`BEGIN`.simple();
      await writer`LOCK TABLE mail.message_contents IN ROW EXCLUSIVE MODE`.simple();
      const build = buildOptionalSearchIndex();
      await buildRuns();
      expect(await buildOptionalSearchIndex()).toBe("busy");
      expect(await advisoryLocks()).toBe(0);
      await writer`COMMIT`.simple();
      expect(await build).toBe("built");
      expect(await index()).toEqual({ method: "bm25", valid: true });
      expect(await buildOptionalSearchIndex()).toBe("ready");

      // A build that another process still runs is left alone.
      await sql`DROP INDEX mail.message_contents_bm25_idx`;
      await writer`BEGIN`.simple();
      await writer`LOCK TABLE mail.message_contents IN ROW EXCLUSIVE MODE`.simple();
      const running = other`
        CREATE INDEX CONCURRENTLY message_contents_bm25_idx ON mail.message_contents USING bm25 (plain_text) WITH (text_config = 'simple')
      `
        .simple()
        .then(
          () => "built",
          () => "interrupted",
        );
      const pid = await buildRuns();
      expect(await buildOptionalSearchIndex()).toBe("busy");

      // An interrupted build leaves an invalid index, which the next start replaces.
      await sql`SELECT pg_cancel_backend(${pid}::int)`;
      expect(await running).toBe("interrupted");
      await writer`COMMIT`.simple();
      expect(await index()).toEqual({ method: "bm25", valid: false });
      expect(await buildOptionalSearchIndex()).toBe("built");
      expect(await index()).toEqual({ method: "bm25", valid: true });
    } finally {
      await writer`ROLLBACK`.simple();
      writer.release();
      other.release();
    }
  });

  test("turns each folder's sidebar switch into its display once, and keeps the switch for an older image", async () => {
    await migrate();
    const [mailbox] = await sql<{ id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Folder display migration') RETURNING id
    `;
    try {
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${mailbox!.id}::uuid, '{}'::jsonb, '{}'::jsonb, ${"d".repeat(64)}, 'active')
        RETURNING id
      `;
      // An older Mail image writes only the sidebar switch.
      const folder = async (name: string, showInSidebar: boolean) => {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, show_in_sidebar)
          VALUES (${newShortId()}, ${resource!.id}::uuid, ${name}, ${name}, ${showInSidebar})
          RETURNING id
        `;
        return row!.id;
      };
      const displays = async () =>
        Object.fromEntries(
          (
            await sql<{ id: string; display: string }[]>`
              SELECT id, display FROM mail.folders WHERE remote_resource_id = ${resource!.id}::uuid
            `
          ).map((row) => [row.id, row.display]),
        );

      // The database before this update has no display yet.
      await sql`ALTER TABLE mail.folders DROP COLUMN display`;
      const shown = await folder("Shown", true);
      const hidden = await folder("Hidden", false);
      await migrate();
      expect(await displays()).toEqual({ [shown]: "everywhere", [hidden]: "hidden" });

      // Later starts keep every display, also one the switch cannot express.
      await sql`UPDATE mail.folders SET display = 'folder_only' WHERE id = ${shown}::uuid`;
      await migrate();
      expect(await displays()).toEqual({ [shown]: "folder_only", [hidden]: "hidden" });

      // An older image still reads and writes its switch, and its new folders show their mail everywhere.
      const [switches] = await sql<{ show_in_sidebar: boolean }[]>`SELECT show_in_sidebar FROM mail.folders WHERE id = ${hidden}::uuid`;
      expect(switches).toEqual({ show_in_sidebar: false });
      const older = await folder("Older", true);
      expect((await displays())[older]).toBe("everywhere");

      const [shape] = await sql<{ versions: number }[]>`SELECT count(*)::int AS versions FROM mail.schema_migrations`;
      expect(shape).toEqual({ versions: 1 });
      const invalid = await sql`UPDATE mail.folders SET display = 'sidebar' WHERE id = ${shown}::uuid`.then(
        () => null,
        (error: unknown) => error,
      );
      expect(invalid).toMatchObject({ constraint: "folders_display_check" });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox!.id}::uuid`;
    }
  });

  test("numbers new commands in lock order and keeps the commands stored before without rewriting them", async () => {
    await migrate();
    await sql`ALTER TABLE mail.commands DROP COLUMN queue_position`;
    const [mailbox] = await sql<{ id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Queue position')
      RETURNING id
    `;
    const addCommand = async (key: string) => {
      const [command] = await sql<{ id: string }[]>`
        INSERT INTO mail.commands (mailbox_id, kind, actor_kind, idempotency_key, request_hash, target, payload, access_subject_kind)
        VALUES (${mailbox!.id}::uuid, 'sync_mailbox', 'system', ${key}, ${"0".repeat(64)}, '{}'::jsonb, '{}'::jsonb, 'system')
        RETURNING id
      `;
      return command!.id;
    };
    try {
      const stored = await addCommand("stored-before");
      const storage = async () =>
        (await sql<{ file: number }[]>`SELECT relfilenode::int AS file FROM pg_class WHERE oid = 'mail.commands'::regclass`)[0]!.file;
      const before = await storage();
      await migrate();
      await migrate();
      const first = await addCommand("accepted-first");
      const second = await addCommand("accepted-second");
      const positions = await sql<{ id: string; queue_position: string }[]>`
        SELECT id, queue_position::text FROM mail.commands WHERE mailbox_id = ${mailbox!.id}::uuid
      `;
      const position = (id: string) => BigInt(positions.find((row) => row.id === id)!.queue_position);
      expect(position(stored)).toBe(0n);
      expect(position(first)).toBeGreaterThan(0n);
      expect(position(second)).toBeGreaterThan(position(first));
      const [sequence] = await sql<{ cache_size: string }[]>`
        SELECT cache_size::text FROM pg_sequences WHERE schemaname = 'mail' AND sequencename = 'commands_queue_position_seq'
      `;
      expect({ cacheSize: sequence?.cache_size, rewritten: (await storage()) !== before }).toEqual({ cacheSize: "1", rewritten: false });
    } finally {
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox!.id}::uuid`;
    }
  });

  test("moves the live updates of a database installed before into the platform outbox", async () => {
    await migrate();
    // The database before this update: Mail's own table, and the function that wrote to it.
    await sql`CREATE TABLE mail.live_invalidation_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`;
    await sql`
      CREATE OR REPLACE FUNCTION mail.enqueue_live_invalidation(target_mailbox_id uuid, target_conversation_id uuid DEFAULT NULL)
      RETURNS uuid LANGUAGE sql AS $$ INSERT INTO mail.live_invalidation_outbox DEFAULT VALUES RETURNING id $$
    `.simple();
    const [mailbox] = await sql<{ id: string }[]>`
      INSERT INTO mail.mailboxes (short_id, name) VALUES (${newShortId()}, 'Live update migration') RETURNING id
    `;
    try {
      await migrate();
      await migrate();
      const [table] = await sql<{ exists: boolean }[]>`SELECT to_regclass('mail.live_invalidation_outbox') IS NOT NULL AS exists`;
      expect(table).toEqual({ exists: false });
      // An older replica still calls the function with its old signature, and its result is a uuid column.
      const [called] = await sql<{ id: string | null }[]>`SELECT mail.enqueue_live_invalidation(${mailbox!.id}::uuid)::text AS id`;
      expect(called).toEqual({ id: null });
      const pending = await sql<{ payload: unknown }[]>`
        SELECT payload FROM events.outbox WHERE app_id = 'mail' AND ordering_key = ${mailbox!.id}
      `;
      expect(pending).toEqual([{ payload: { v: 1, k: mailbox!.id, d: { conversationId: null } } }]);
    } finally {
      await sql`DELETE FROM events.outbox WHERE app_id = 'mail' AND ordering_key = ${mailbox!.id}`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailbox!.id}::uuid`;
    }
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
              'search_reference_matches', 'touch_updated_at', 'carry_conversation_keep'
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
    expect(shape).toEqual({ extensions: 3, functions: 9, triggers: 30, workflow_ai_table: true });
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
      attachment_extractions: true,
      search_chunk_sources: 4,
      workflow_profile: true,
    });
  });
});
