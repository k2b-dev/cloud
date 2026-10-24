import { sql } from "bun";

/** Additive startup migration; rerunning preserves both data and definitions. */
export const migrate = async (): Promise<void> => {
  await sql`
    CREATE SCHEMA IF NOT EXISTS chat;
    CREATE TABLE IF NOT EXISTS chat.conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id text NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      name text CHECK (char_length(name) <= 80),
      icon text CHECK (char_length(icon) <= 80 AND icon ~ '^ti ti-[a-z0-9-]+$'),
      purpose text CHECK (char_length(purpose) <= 300),
      created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'service_account')),
      created_by_id uuid NOT NULL,
      seq_head bigint NOT NULL DEFAULT 0,
      rev bigint NOT NULL DEFAULT 0,
      member_count int NOT NULL DEFAULT 0 CHECK (member_count >= 0),
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_short_id ON chat.conversations(short_id);
    ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS changed_rev bigint NOT NULL DEFAULT 0;
    -- Successful intents live exactly as long as their chat and subject. No expiring retry window.
    CREATE TABLE IF NOT EXISTS chat.create_intents (
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      create_key uuid NOT NULL,
      payload jsonb NOT NULL,
      conversation_id uuid NOT NULL UNIQUE REFERENCES chat.conversations(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, create_key)
    );
    CREATE TABLE IF NOT EXISTS chat.messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id text NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{10}$'),
      conversation_id uuid NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      rev bigint NOT NULL,
      kind text NOT NULL CHECK (kind IN ('text', 'system')),
      author_type text NOT NULL CHECK (author_type IN ('user', 'service_account')),
      author_id uuid NOT NULL,
      author_name text NOT NULL,
      client_id text CHECK (client_id ~ '^[A-Za-z0-9_-]{1,64}$'),
      body_md text CHECK (char_length(body_md) <= 20000),
      system_code text,
      system_params jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (
        (kind = 'text' AND body_md IS NOT NULL AND client_id IS NOT NULL AND system_code IS NULL AND system_params IS NULL)
        OR (kind = 'system' AND system_code IS NOT NULL AND system_params IS NOT NULL AND body_md IS NULL AND client_id IS NULL)
      )
    );
    ALTER TABLE chat.messages ADD COLUMN IF NOT EXISTS refs jsonb NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE chat.messages ADD COLUMN IF NOT EXISTS links text[] NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS idx_chat_messages_refs ON chat.messages(conversation_id, seq DESC) WHERE refs <> '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_links ON chat.messages(conversation_id, seq DESC) WHERE links <> '{}';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_short_id ON chat.messages(short_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_seq ON chat.messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_rev ON chat.messages(conversation_id, rev);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client ON chat.messages(conversation_id, author_type, author_id, client_id);
    CREATE TABLE IF NOT EXISTS chat.message_reactions (
      message_id uuid NOT NULL REFERENCES chat.messages(id) ON DELETE CASCADE,
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      display_name text NOT NULL,
      emoji text NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 32),
      position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
      PRIMARY KEY (message_id, principal_type, principal_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat.message_reactions(message_id, emoji, position);
    CREATE TABLE IF NOT EXISTS chat.threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id text NOT NULL CHECK (short_id ~ '^[0-9A-Za-z]{6}$') UNIQUE,
      conversation_id uuid NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      description text CHECK (char_length(description) <= 80),
      archived_at timestamptz,
      created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'service_account')),
      created_by_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat.thread_create_intents (
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      conversation_id uuid NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
      create_key uuid NOT NULL,
      payload jsonb NOT NULL,
      thread_id uuid NOT NULL UNIQUE REFERENCES chat.threads(id) ON DELETE CASCADE,
      PRIMARY KEY (principal_type, principal_id, create_key)
    );
    ALTER TABLE chat.messages ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES chat.threads(id) ON DELETE CASCADE;
    ALTER TABLE chat.messages ADD COLUMN IF NOT EXISTS reply_to_seq bigint;
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat.messages(conversation_id, thread_id, seq);
    CREATE TABLE IF NOT EXISTS chat.conversation_access (
      conversation_id uuid NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
      access_id uuid NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('member', 'discoverable')),
      added_by_type text NOT NULL CHECK (added_by_type IN ('user', 'service_account')),
      added_by_id uuid NOT NULL,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, access_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_access_id ON chat.conversation_access(access_id);
    CREATE INDEX IF NOT EXISTS idx_chat_access_role ON chat.conversation_access(conversation_id, role);
    -- Rows may belong to deleted accounts; every reader (fan-out, read receipts, counts, notifications) must apply the access condition or join auth.users.
    CREATE TABLE IF NOT EXISTS chat.participants (
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      conversation_id uuid NOT NULL REFERENCES chat.conversations(id) ON DELETE CASCADE,
      origin text NOT NULL CHECK (origin IN ('direct', 'ondemand')),
      joined_seq bigint NOT NULL,
      last_read_seq bigint,
      unread_from_seq bigint,
      notify text NOT NULL DEFAULT 'default' CHECK (notify IN ('default', 'all', 'mentions', 'none')),
      notify_until timestamptz,
      pinned_rank int,
      archived_at timestamptz,
      PRIMARY KEY (principal_type, principal_id, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_participants_conversation ON chat.participants(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_chat_participants_notify_all ON chat.participants(conversation_id) WHERE notify = 'all';
    -- A thread's read state belongs to the participant: whoever leaves and joins again starts like in General.
    CREATE TABLE IF NOT EXISTS chat.thread_reads (
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      thread_id uuid NOT NULL REFERENCES chat.threads(id) ON DELETE CASCADE,
      last_read_seq bigint,
      unread_from_seq bigint,
      PRIMARY KEY (principal_type, principal_id, thread_id),
      FOREIGN KEY (principal_type, principal_id, conversation_id)
        REFERENCES chat.participants(principal_type, principal_id, conversation_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_thread_reads_participant ON chat.thread_reads(principal_type, principal_id, conversation_id);
    CREATE TABLE IF NOT EXISTS chat.account_prefs (
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      enter_sends boolean NOT NULL DEFAULT true,
      collapsed_sections jsonb NOT NULL DEFAULT '[]'::jsonb,
      locale text,
      timezone text,
      muted_principals jsonb NOT NULL DEFAULT '[]'::jsonb,
      voice_hint_seen boolean NOT NULL DEFAULT false,
      PRIMARY KEY (principal_type, principal_id)
    )
  `.simple();
  await sql`
    ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'system'));
    ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS resource_type text;
    ALTER TABLE chat.conversations ADD COLUMN IF NOT EXISTS resource_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_system_resource ON chat.conversations(resource_type, resource_id) WHERE kind = 'system';
    ALTER TABLE chat.threads ADD COLUMN IF NOT EXISTS resource_type text;
    ALTER TABLE chat.threads ADD COLUMN IF NOT EXISTS resource_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_thread_resource ON chat.threads(conversation_id, resource_type, resource_id) WHERE resource_type IS NOT NULL;
    -- Item titles need not be unique. Preserve the manual-thread name constraint.
    DROP INDEX IF EXISTS chat.idx_chat_threads_name;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_manual_name ON chat.threads(conversation_id, lower(name)) WHERE resource_type IS NULL;
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS chat.message_mentions (
      message_id uuid NOT NULL REFERENCES chat.messages(id) ON DELETE CASCADE,
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      start_offset int NOT NULL CHECK (start_offset >= 0),
      end_offset int NOT NULL CHECK (end_offset > start_offset AND end_offset <= 40000),
      created_at timestamptz NOT NULL,
      PRIMARY KEY (message_id, start_offset)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_mentions_subject ON chat.message_mentions(principal_type, principal_id, created_at DESC, message_id DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_author ON chat.messages(author_type, author_id, conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_reply ON chat.messages(conversation_id, reply_to_seq, created_at DESC, id DESC) WHERE reply_to_seq IS NOT NULL;
  `.simple();
  console.log("  ✓ chat schema");
};
