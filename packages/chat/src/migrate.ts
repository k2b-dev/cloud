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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_short_id ON chat.messages(short_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_seq ON chat.messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_rev ON chat.messages(conversation_id, rev);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_client ON chat.messages(conversation_id, author_type, author_id, client_id);
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_threads_name ON chat.threads(conversation_id, lower(name));
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
    CREATE TABLE IF NOT EXISTS chat.thread_reads (
      principal_type text NOT NULL CHECK (principal_type IN ('user', 'service_account')),
      principal_id uuid NOT NULL,
      thread_id uuid NOT NULL REFERENCES chat.threads(id) ON DELETE CASCADE,
      last_read_seq bigint,
      unread_from_seq bigint,
      PRIMARY KEY (principal_type, principal_id, thread_id)
    );
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
  console.log("  ✓ chat schema");
};
