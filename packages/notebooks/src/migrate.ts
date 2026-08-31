import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { deriveNoteTitle } from "./lib/note-title";
import { backfillShortIds, type ShortIdTable } from "./lib/short-id";

export const migrate = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS notebooks`.simple();
  console.log("  ✓ notebooks schema");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.notebooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      default_note_title_template TEXT NOT NULL DEFAULT 'New Document',
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  // `short_id`: 6-character readable ID used in URLs and markdown link
  // schemes (`note://`, `attach://`). Nullable to allow the migration
  // path on existing rows; the startup backfill below fills any NULLs
  // and `service/notebooks.ts` always sets it on INSERT going forward.
  await sql`ALTER TABLE notebooks.notebooks ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_short_id ON notebooks.notebooks(short_id)`.simple();
  // Per-notebook opt-in for the JS scripting feature (`\`\`\`script`
  // blocks evaluate in the editor). Off by default — admins flip it
  // in the notebook settings panel after acknowledging the warning.
  // Without this gate the scripting engine renders the source as an
  // inert code-fence so legacy notebooks can't execute anything new.
  await sql`ALTER TABLE notebooks.notebooks ADD COLUMN IF NOT EXISTS scripts_enabled BOOLEAN NOT NULL DEFAULT FALSE`.simple();
  await sql`
    ALTER TABLE notebooks.notebooks
    ADD COLUMN IF NOT EXISTS default_note_title_template TEXT NOT NULL DEFAULT 'New Document'
  `.simple();
  console.log("  ✓ notebooks.notebooks table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.notebook_access (
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (notebook_id, access_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notebook_access_access
    ON notebooks.notebook_access(access_id)
  `.simple();
  console.log("  ✓ notebooks.notebook_access table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.notes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      title_projection_version SMALLINT NOT NULL DEFAULT 1,
      position INT NOT NULL DEFAULT 0,
      yjs_snapshot BYTEA,
      yjs_stream_ms BIGINT,
      yjs_stream_seq BIGINT,
      yjs_snapshot_at TIMESTAMPTZ,
      content_md TEXT,
      data_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      locked_at TIMESTAMPTZ DEFAULT NULL
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notes_notebook
    ON notebooks.notes(notebook_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notes_parent
    ON notebooks.notes(parent_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notes_notebook_parent_position
    ON notebooks.notes(notebook_id, parent_id, position)
  `.simple();
  await sql`ALTER TABLE notebooks.notes ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`
    ALTER TABLE notebooks.notes
    ADD COLUMN IF NOT EXISTS title_projection_version SMALLINT NOT NULL DEFAULT 0
  `.simple();
  await sql`
    ALTER TABLE notebooks.notes
    ADD COLUMN IF NOT EXISTS data_properties JSONB NOT NULL DEFAULT '{}'::jsonb
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notes_data_properties_object_chk'
          AND conrelid = 'notebooks.notes'::regclass
      ) THEN
        ALTER TABLE notebooks.notes
        ADD CONSTRAINT notes_data_properties_object_chk
        CHECK (jsonb_typeof(data_properties) = 'object');
      END IF;
    END $$
  `.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_short_id ON notebooks.notes(short_id)`.simple();

  // Canonical search projection. `simple` keeps mixed-language notebooks
  // predictable; title lexemes rank above body lexemes. This native GIN path
  // is always available and remains the correctness baseline even when an
  // optional BM25 ranker is installed.
  await sql`
    ALTER TABLE notebooks.notes
    ADD COLUMN IF NOT EXISTS search_document tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', COALESCE(title, '')), 'A') ||
      setweight(to_tsvector('simple', COALESCE(content_md, '')), 'B')
    ) STORED
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notes_search_document
    ON notebooks.notes USING GIN(search_document)
  `.simple();

  // pg_textsearch is an optional ranking accelerator. Production operators
  // install and preload the extension; dev and older PostgreSQL versions use
  // the native GIN index above. Failure to prepare this optional index must
  // never prevent Notebooks from starting.
  try {
    const [extension] = await sql<{ available: boolean; installed: boolean; server_version: number }[]>`
      SELECT
        EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_textsearch') AS available,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed,
        current_setting('server_version_num')::int AS server_version
    `;
    let installed = extension?.installed ?? false;
    if (!installed && extension?.available && extension.server_version >= 170000) {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_textsearch`.simple();
      installed = true;
    }
    if (installed) {
      await sql
        .unsafe(`
          CREATE INDEX IF NOT EXISTS notes_search_bm25_idx
          ON notebooks.notes USING bm25 (
            (COALESCE(title, '') || ' ' || COALESCE(title, '') || ' ' || COALESCE(content_md, ''))
          ) WITH (text_config='simple')
        `)
        .simple();
      console.log("  ✓ notebooks optional BM25 search index");
    }
  } catch (error) {
    console.warn("  ! notebooks optional BM25 search index unavailable; native PostgreSQL FTS remains active", error);
  }
  console.log("  ✓ notebooks.notes table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL UNIQUE,
      note_id UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      author_display_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_comments_note_created
    ON notebooks.note_comments(note_id, created_at DESC, id DESC)
  `.simple();
  console.log("  ✓ notebooks.note_comments table");

  await sql`ALTER TABLE notebooks.notebooks ADD COLUMN IF NOT EXISTS homepage_note_id UUID`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_notebooks_homepage_note'
      ) THEN
        ALTER TABLE notebooks.notebooks
        ADD CONSTRAINT fk_notebooks_homepage_note
        FOREIGN KEY (homepage_note_id)
        REFERENCES notebooks.notes(id)
        ON DELETE SET NULL;
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notebooks_homepage_note
    ON notebooks.notebooks(homepage_note_id)
  `.simple();
  console.log("  ✓ notebooks homepage note column");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_versions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      note_id UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      yjs_snapshot BYTEA NOT NULL,
      content_md TEXT,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`ALTER TABLE notebooks.note_versions DROP COLUMN IF EXISTS title`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_versions_note
    ON notebooks.note_versions(note_id, created_at DESC)
  `.simple();
  console.log("  ✓ notebooks.note_versions table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.activity_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      note_id UUID REFERENCES notebooks.notes(id) ON DELETE SET NULL,
      note_version_id UUID REFERENCES notebooks.note_versions(id) ON DELETE SET NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account', 'system')),
      actor_id UUID,
      action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 200),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      bucket_started_at TIMESTAMPTZ,
      occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT activity_events_actor_shape CHECK (
        (actor_kind = 'system' AND actor_id IS NULL)
        OR (actor_kind <> 'system' AND actor_id IS NOT NULL)
      )
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notebooks_activity_notebook
    ON notebooks.activity_events(notebook_id, last_occurred_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_notebooks_activity_note
    ON notebooks.activity_events(note_id, last_occurred_at DESC, id DESC)
    WHERE note_id IS NOT NULL
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_activity_bucket
    ON notebooks.activity_events(note_id, actor_kind, actor_id, action, bucket_started_at)
    WHERE bucket_started_at IS NOT NULL
  `.simple();
  console.log("  ✓ notebooks.activity_events table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_version_contributors (
      version_id UUID NOT NULL REFERENCES notebooks.note_versions(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      PRIMARY KEY (version_id, actor_kind, actor_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_version_contributors_actor
    ON notebooks.note_version_contributors(actor_kind, actor_id, version_id)
  `.simple();
  console.log("  ✓ notebooks.note_version_contributors table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_links (
      source_note_id UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      target_note_id UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      PRIMARY KEY (source_note_id, target_note_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_links_target
    ON notebooks.note_links(target_note_id)
  `.simple();
  console.log("  ✓ notebooks.note_links table");

  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
      content BYTEA NOT NULL,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_attachments_notebook
    ON notebooks.attachments(notebook_id)
  `.simple();
  await sql`ALTER TABLE notebooks.attachments ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_short_id ON notebooks.attachments(short_id)`.simple();
  console.log("  ✓ notebooks.attachments table");

  // Index table for `#tag` references inside note bodies. Reindexed on
  // every note save (and periodically by the scheduler — see
  // `service/reindex-scheduler.ts`). Notebook id denormalised so
  // notebook-scoped aggregations don't need a JOIN through `notes`.
  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_tags (
      note_id     UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      tag         TEXT NOT NULL,
      PRIMARY KEY (note_id, tag)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_tags_nb_tag
    ON notebooks.note_tags(notebook_id, tag)
  `.simple();
  // text_pattern_ops makes prefix LIKE 'pre%' fast (byte compare instead
  // of locale collation) — used by tag-picker autocomplete.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_tags_nb_prefix
    ON notebooks.note_tags(notebook_id, tag text_pattern_ops)
  `.simple();
  console.log("  ✓ notebooks.note_tags table");

  // Per-user starred notes. Favorites are intentionally user-scoped
  // instead of notebook-global so collaborators do not fight over one
  // shared navigation preference.
  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_favorites (
      user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      notebook_id UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      note_id     UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, note_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_favorites_user_notebook
    ON notebooks.note_favorites(user_id, notebook_id, created_at DESC)
  `.simple();
  console.log("  ✓ notebooks.note_favorites table");

  // One S3-compatible snapshot configuration per notebook. Credentials
  // are encrypted at rest in the service layer and never returned
  // through the API after save. The previous account/target tables were
  // never released; drop them to keep the model intentionally small.
  await sql`DROP TABLE IF EXISTS notebooks.backup_targets`.simple();
  await sql`DROP TABLE IF EXISTS notebooks.backup_accounts`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.s3_snapshot_configs (
      notebook_id UUID PRIMARY KEY REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      endpoint TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT 'us-east-1',
      bucket TEXT NOT NULL DEFAULT '',
      access_key_id TEXT NOT NULL DEFAULT '',
      secret_access_key TEXT NOT NULL DEFAULT '',
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_s3_snapshot_configs_enabled ON notebooks.s3_snapshot_configs(enabled)`.simple();
  console.log("  ✓ notebooks.s3_snapshot_configs table");

  // Index table for `attach://<shortId>` references inside note bodies.
  // Replaces the previous `LIKE '%attach://...'` scan in
  // `attachment.usageCount` with an O(log N) lookup.
  await sql`
    CREATE TABLE IF NOT EXISTS notebooks.note_attachments (
      note_id       UUID NOT NULL REFERENCES notebooks.notes(id) ON DELETE CASCADE,
      notebook_id   UUID NOT NULL REFERENCES notebooks.notebooks(id) ON DELETE CASCADE,
      attachment_id UUID NOT NULL REFERENCES notebooks.attachments(id) ON DELETE CASCADE,
      PRIMARY KEY (note_id, attachment_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_attachments_attachment
    ON notebooks.note_attachments(attachment_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_note_attachments_nb
    ON notebooks.note_attachments(notebook_id, attachment_id)
  `.simple();
  console.log("  ✓ notebooks.note_attachments table");

  // Short-id backfill — fills `short_id` for any rows created before
  // the column existed (or before the new code path was deployed).
  // Idempotent: each call is just a `WHERE short_id IS NULL` SELECT.
  // The UNIQUE index above guarantees we never write duplicates.
  // Keep at the END of `migrate()` so the columns + indexes exist
  // before we try to populate them.
  const tables: ShortIdTable[] = ["notebook", "note", "attachment", "comment"];
  for (const table of tables) {
    const filled = await backfillShortIds(table);
    if (filled > 0) console.log(`  ✓ short_id backfill: ${filled} ${table}(s)`);
  }

  let projectedTitles = 0;
  while (true) {
    const rows = await sql<{ id: string; content_md: string | null }[]>`
      SELECT id, content_md
      FROM notebooks.notes
      WHERE title_projection_version < 1
      ORDER BY id
      LIMIT 500
    `;
    if (rows.length === 0) break;

    const ids = toPgUuidArray(rows.map((row) => row.id));
    const titles = toPgTextArray(rows.map((row) => deriveNoteTitle(row.content_md)));
    await sql`
      UPDATE notebooks.notes AS note
      SET title = projected.title,
          title_projection_version = 1
      FROM unnest(${ids}::uuid[], ${titles}::text[]) AS projected(id, title)
      WHERE note.id = projected.id
    `;
    projectedTitles += rows.length;
  }
  await sql`ALTER TABLE notebooks.notes ALTER COLUMN title_projection_version SET DEFAULT 1`.simple();
  if (projectedTitles > 0) console.log(`  ✓ derived title backfill: ${projectedTitles} note(s)`);
};
