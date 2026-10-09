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
