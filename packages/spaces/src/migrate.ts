import { sql } from "bun";
import { backfillShortIds, type ShortIdTable } from "./lib/short-id";

export const migrate = async (): Promise<void> => {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.simple();
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`.simple();

  await sql`CREATE SCHEMA IF NOT EXISTS spaces`.simple();
  console.log("  ✓ spaces schema");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.spaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      color TEXT DEFAULT '#3b82f6',
      ical_token TEXT UNIQUE DEFAULT encode(gen_random_bytes(24), 'hex'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_spaces_ical_token
    ON spaces.spaces(ical_token) WHERE ical_token IS NOT NULL
  `.simple();
  await sql`ALTER TABLE spaces.spaces ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_short_id ON spaces.spaces(short_id)`.simple();
  console.log("  ✓ spaces.spaces table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.space_access (
      space_id UUID NOT NULL REFERENCES spaces.spaces(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (space_id, access_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_space_access_access
    ON spaces.space_access(access_id)
  `.simple();
  console.log("  ✓ spaces.space_access table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.columns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id UUID NOT NULL REFERENCES spaces.spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT,
      position INT NOT NULL DEFAULT 0,
      rank BIGINT NOT NULL DEFAULT 1024,
      is_done BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_columns_space_position
    ON spaces.columns(space_id, position)
  `.simple();
  await sql`ALTER TABLE spaces.columns ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_columns_short_id ON spaces.columns(short_id)`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_columns_space_rank
    ON spaces.columns(space_id, rank)
  `.simple();
  console.log("  ✓ spaces.columns table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.wormholes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_space_id UUID NOT NULL REFERENCES spaces.spaces(id) ON DELETE CASCADE,
      target_column_id UUID NOT NULL REFERENCES spaces.columns(id) ON DELETE CASCADE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      rank BIGINT NOT NULL DEFAULT 1024,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT wormholes_source_target_key UNIQUE (source_space_id, target_column_id),
      CONSTRAINT wormholes_color_check CHECK (color ~ '^#[0-9a-fA-F]{6}$')
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_wormholes_source_rank
    ON spaces.wormholes(source_space_id, rank, id)
  `.simple();
  await sql`ALTER TABLE spaces.wormholes ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_wormholes_short_id ON spaces.wormholes(short_id)`.simple();
  console.log("  ✓ spaces.wormholes table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.tags (
      id UUID DEFAULT gen_random_uuid() CONSTRAINT labels_pkey PRIMARY KEY,
      space_id UUID NOT NULL CONSTRAINT labels_space_id_fkey REFERENCES spaces.spaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6b7280',
      CONSTRAINT labels_space_id_name_key UNIQUE (space_id, name)
    )
  `.simple();
  await sql`ALTER TABLE spaces.tags ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_short_id ON spaces.tags(short_id)`.simple();
  console.log("  ✓ spaces.tags table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      space_id UUID NOT NULL REFERENCES spaces.spaces(id) ON DELETE CASCADE,
      column_id UUID NOT NULL REFERENCES spaces.columns(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      url TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      all_day BOOLEAN NOT NULL DEFAULT false,
      deadline TIMESTAMPTZ,
      estimated_duration_minutes INTEGER,
      priority TEXT CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
      recurrence_rrule TEXT,
      recurrence_dtstart TIMESTAMPTZ,
      recurrence_exdate TIMESTAMPTZ[],
      recurring_event_id UUID REFERENCES spaces.items(id) ON DELETE CASCADE,
      recurrence_id TIMESTAMPTZ,
      position INT NOT NULL DEFAULT 0,
      rank BIGINT NOT NULL DEFAULT 1024,
      completed_at TIMESTAMPTZ,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT item_time_range CHECK (
        (starts_at IS NULL AND ends_at IS NULL) OR
        (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at > starts_at)
      ),
      CONSTRAINT items_estimated_duration_check CHECK (
        estimated_duration_minutes IS NULL OR (
          estimated_duration_minutes > 0
          AND starts_at IS NULL
          AND ends_at IS NULL
        )
      )
    )
  `.simple();
  await sql`ALTER TABLE spaces.items DROP COLUMN IF EXISTS email_thread_id`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS spaces.item_resource_refs (
      item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, resource_type, resource_id),
      CONSTRAINT item_resource_refs_type_check CHECK (
        length(resource_type) BETWEEN 3 AND 128
        AND resource_type ~ '^[a-z][a-z0-9-]*(\\.[a-z][a-z0-9-]*)+$'
      ),
      CONSTRAINT item_resource_refs_id_check CHECK (length(resource_id) BETWEEN 1 AND 512),
      CONSTRAINT item_resource_refs_label_check CHECK (length(btrim(label)) BETWEEN 1 AND 500)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_item_resource_refs_resource
    ON spaces.item_resource_refs(resource_type, resource_id, item_id)
  `.simple();
  console.log("  ✓ spaces.item_resource_refs table");
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS all_day BOOLEAN NOT NULL DEFAULT false
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'items_estimated_duration_check'
          AND conrelid = 'spaces.items'::regclass
      ) THEN
        ALTER TABLE spaces.items
        ADD CONSTRAINT items_estimated_duration_check CHECK (
          estimated_duration_minutes IS NULL OR (
            estimated_duration_minutes > 0
            AND starts_at IS NULL
            AND ends_at IS NULL
          )
        );
      END IF;
    END $$
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS location TEXT
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS url TEXT
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS recurrence_rrule TEXT
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS recurrence_dtstart TIMESTAMPTZ
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS recurrence_exdate TIMESTAMPTZ[]
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS recurring_event_id UUID REFERENCES spaces.items(id) ON DELETE CASCADE
  `.simple();
  await sql`
    ALTER TABLE spaces.items
    ADD COLUMN IF NOT EXISTS recurrence_id TIMESTAMPTZ
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_items_recurring_override_unique
    ON spaces.items(recurring_event_id, recurrence_id)
    WHERE recurring_event_id IS NOT NULL AND recurrence_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_recurring_series
    ON spaces.items(space_id)
    WHERE recurrence_rrule IS NOT NULL AND completed_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_space
    ON spaces.items(space_id)
  `.simple();
  await sql`ALTER TABLE spaces.items ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_short_id ON spaces.items(short_id)`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_column
    ON spaces.items(column_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_space_column_position
    ON spaces.items(space_id, column_id, position)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_space_column_rank
    ON spaces.items(space_id, column_id, rank)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_column_rank
    ON spaces.items(column_id, rank)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_calendar
    ON spaces.items(space_id, starts_at, ends_at)
    WHERE completed_at IS NULL AND (starts_at IS NOT NULL OR deadline IS NOT NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_items_time_range
    ON spaces.items USING GIST (tstzrange(starts_at, ends_at, '[]'))
    WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND completed_at IS NULL
  `.simple();
  console.log("  ✓ spaces.items table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.item_dependencies (
      item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      blocker_item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, blocker_item_id),
      CONSTRAINT item_dependencies_no_self CHECK (item_id <> blocker_item_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_item_dependencies_blocker
    ON spaces.item_dependencies(blocker_item_id, item_id)
  `.simple();
  console.log("  ✓ spaces.item_dependencies table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.calendar_invitation_sources (
      item_id UUID PRIMARY KEY REFERENCES spaces.items(id) ON DELETE CASCADE,
      mailbox_id TEXT NOT NULL CONSTRAINT calendar_invitation_sources_mailbox_id_short_check CHECK (mailbox_id ~ '^[0-9A-Za-z]{6}$'),
      message_id TEXT CONSTRAINT calendar_invitation_sources_message_id_short_check CHECK (message_id ~ '^[0-9A-Za-z]{6}$'),
      calendar_uid TEXT NOT NULL CHECK (char_length(calendar_uid) BETWEEN 1 AND 1024),
      sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
      method TEXT NOT NULL CHECK (method IN ('request', 'cancel', 'reply', 'publish', 'unknown')),
      organizer JSONB,
      attendees JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attendees) = 'array'),
      last_response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, calendar_uid)
    )
  `.simple();
  await sql`
    ALTER TABLE spaces.calendar_invitation_sources
    ALTER COLUMN mailbox_id TYPE TEXT USING mailbox_id::text,
    ALTER COLUMN message_id TYPE TEXT USING message_id::text
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_sources_mailbox_id_short_check'
          AND conrelid = 'spaces.calendar_invitation_sources'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_sources
        ADD CONSTRAINT calendar_invitation_sources_mailbox_id_short_check CHECK (mailbox_id ~ '^[0-9A-Za-z]{6}$');
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_sources_message_id_short_check'
          AND conrelid = 'spaces.calendar_invitation_sources'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_sources
        ADD CONSTRAINT calendar_invitation_sources_message_id_short_check CHECK (message_id ~ '^[0-9A-Za-z]{6}$');
      END IF;
    END $$
  `.simple();
  await sql`
    ALTER TABLE spaces.calendar_invitation_sources
    ALTER COLUMN message_id DROP NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_invitation_sources_message
    ON spaces.calendar_invitation_sources(mailbox_id, message_id)
  `.simple();
  console.log("  ✓ spaces.calendar_invitation_sources table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.calendar_invitation_deliveries (
      idempotency_key UUID PRIMARY KEY,
      item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      mailbox_id TEXT NOT NULL CONSTRAINT calendar_invitation_deliveries_mailbox_id_short_check CHECK (mailbox_id ~ '^[0-9A-Za-z]{6}$'),
      sender_identity_id TEXT NOT NULL CONSTRAINT calendar_invitation_deliveries_sender_identity_id_short_check CHECK (sender_identity_id ~ '^[0-9A-Za-z]{6}$'),
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      method TEXT NOT NULL CHECK (method IN ('request', 'cancel')),
      state TEXT NOT NULL CHECK (state IN ('preparing', 'drafted', 'failed')),
      draft_id TEXT CONSTRAINT calendar_invitation_deliveries_draft_id_short_check CHECK (draft_id ~ '^[0-9A-Za-z]{6}$'),
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    ALTER TABLE spaces.calendar_invitation_deliveries
    ADD COLUMN IF NOT EXISTS sender_identity_id TEXT
  `.simple();
  await sql`
    ALTER TABLE spaces.calendar_invitation_deliveries
    ALTER COLUMN mailbox_id TYPE TEXT USING mailbox_id::text,
    ALTER COLUMN sender_identity_id TYPE TEXT USING sender_identity_id::text,
    ALTER COLUMN draft_id TYPE TEXT USING draft_id::text
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_deliveries_mailbox_id_short_check'
          AND conrelid = 'spaces.calendar_invitation_deliveries'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_deliveries
        ADD CONSTRAINT calendar_invitation_deliveries_mailbox_id_short_check CHECK (mailbox_id ~ '^[0-9A-Za-z]{6}$');
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_deliveries_sender_identity_id_short_check'
          AND conrelid = 'spaces.calendar_invitation_deliveries'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_deliveries
        ADD CONSTRAINT calendar_invitation_deliveries_sender_identity_id_short_check CHECK (sender_identity_id ~ '^[0-9A-Za-z]{6}$');
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_deliveries_draft_id_short_check'
          AND conrelid = 'spaces.calendar_invitation_deliveries'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_deliveries
        ADD CONSTRAINT calendar_invitation_deliveries_draft_id_short_check CHECK (draft_id ~ '^[0-9A-Za-z]{6}$');
      END IF;
    END $$
  `.simple();
  await sql`
    ALTER TABLE spaces.calendar_invitation_deliveries
    ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
    ADD COLUMN IF NOT EXISTS calendar_payload TEXT,
    ADD COLUMN IF NOT EXISTS attachment_filename TEXT
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_deliveries_state_check'
          AND conrelid = 'spaces.calendar_invitation_deliveries'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_deliveries
        DROP CONSTRAINT calendar_invitation_deliveries_state_check;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'calendar_invitation_deliveries_state_v2_check'
          AND conrelid = 'spaces.calendar_invitation_deliveries'::regclass
      ) THEN
        ALTER TABLE spaces.calendar_invitation_deliveries
        ADD CONSTRAINT calendar_invitation_deliveries_state_v2_check
        CHECK (state IN ('preparing', 'prepared', 'drafted', 'failed'));
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_calendar_invitation_deliveries_item
    ON spaces.calendar_invitation_deliveries(item_id, created_at DESC)
  `.simple();
  console.log("  ✓ spaces.calendar_invitation_deliveries table");

  await sql`DROP TABLE IF EXISTS spaces.mailbox_calendar_defaults`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.item_assignees (
      item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      PRIMARY KEY (item_id, user_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_item_assignees_user
    ON spaces.item_assignees(user_id)
  `.simple();
  console.log("  ✓ spaces.item_assignees table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.item_tags (
      item_id UUID NOT NULL CONSTRAINT item_labels_item_id_fkey REFERENCES spaces.items(id) ON DELETE CASCADE,
      tag_id UUID NOT NULL CONSTRAINT item_labels_label_id_fkey REFERENCES spaces.tags(id) ON DELETE CASCADE,
      CONSTRAINT item_labels_pkey PRIMARY KEY (item_id, tag_id)
    )
  `.simple();
  console.log("  ✓ spaces.item_tags table");

  await sql`
    CREATE TABLE IF NOT EXISTS spaces.comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id UUID NOT NULL REFERENCES spaces.items(id) ON DELETE CASCADE,
      recurrence_id TIMESTAMPTZ,
      user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    ALTER TABLE spaces.comments
    ADD COLUMN IF NOT EXISTS recurrence_id TIMESTAMPTZ
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_comments_item_scope
    ON spaces.comments(item_id, recurrence_id, created_at)
  `.simple();
  await sql`ALTER TABLE spaces.comments ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_short_id ON spaces.comments(short_id)`.simple();
  await sql`DROP INDEX IF EXISTS spaces.idx_comments_item`.simple();
  console.log("  ✓ spaces.comments table");

  await sql`
    CREATE OR REPLACE FUNCTION spaces.check_overlap(
      p_start TIMESTAMPTZ,
      p_end TIMESTAMPTZ,
      p_exclude_item_id UUID DEFAULT NULL
    ) RETURNS TABLE(
      item_id UUID,
      space_id UUID,
      space_name TEXT,
      title TEXT,
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ
    ) AS $$
    BEGIN
      RETURN QUERY
      SELECT i.id, s.id, s.name, i.title, i.starts_at, i.ends_at
      FROM spaces.items i
      JOIN spaces.spaces s ON i.space_id = s.id
      WHERE
        i.starts_at IS NOT NULL AND i.ends_at IS NOT NULL
        AND i.completed_at IS NULL
        AND tstzrange(i.starts_at, i.ends_at, '[]') && tstzrange(p_start, p_end, '[]')
        AND (p_exclude_item_id IS NULL OR i.id != p_exclude_item_id);
    END;
    $$ LANGUAGE plpgsql STABLE
  `.simple();
  console.log("  ✓ spaces.check_overlap function");

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.spaces.short-id-backfill'))`;
    const shortIdTables: ShortIdTable[] = ["space", "column", "item", "comment", "tag", "wormhole"];
    for (const table of shortIdTables) {
      const filled = await backfillShortIds(table, tx);
      if (filled > 0) console.log(`  ✓ spaces short_id backfill: ${filled} ${table}(s)`);
    }
  });

  await sql`
    ALTER TABLE spaces.spaces ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.spaces DROP CONSTRAINT IF EXISTS spaces_short_id_format;
    ALTER TABLE spaces.spaces ADD CONSTRAINT spaces_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
    ALTER TABLE spaces.columns ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.columns DROP CONSTRAINT IF EXISTS columns_short_id_format;
    ALTER TABLE spaces.columns ADD CONSTRAINT columns_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
    ALTER TABLE spaces.items ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.items DROP CONSTRAINT IF EXISTS items_short_id_format;
    ALTER TABLE spaces.items ADD CONSTRAINT items_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
    ALTER TABLE spaces.comments ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.comments DROP CONSTRAINT IF EXISTS comments_short_id_format;
    ALTER TABLE spaces.comments ADD CONSTRAINT comments_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
    ALTER TABLE spaces.tags ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.tags DROP CONSTRAINT IF EXISTS tags_short_id_format;
    ALTER TABLE spaces.tags ADD CONSTRAINT tags_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$');
    ALTER TABLE spaces.wormholes ALTER COLUMN short_id SET NOT NULL;
    ALTER TABLE spaces.wormholes DROP CONSTRAINT IF EXISTS wormholes_short_id_format;
    ALTER TABLE spaces.wormholes ADD CONSTRAINT wormholes_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
  `.simple();
};
