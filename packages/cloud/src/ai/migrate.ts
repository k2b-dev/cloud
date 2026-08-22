import { sql } from "bun";
import { withAiShortId } from "./short-id";

const backfillAiShortIds = async (
  constraint: string,
  rows: { id: string }[],
  update: (id: string, shortId: string) => Promise<unknown>,
): Promise<void> => {
  for (const row of rows) await withAiShortId(constraint, (shortId) => update(row.id, shortId));
};

export const migrateCloudAi = async (): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS ai`.simple();
  console.log("  ✓ ai schema");

  await sql`
    CREATE TABLE IF NOT EXISTS ai.conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      description TEXT NOT NULL DEFAULT '',
      loaded_tools TEXT[] NOT NULL DEFAULT '{}',
      draft_content JSONB NOT NULL DEFAULT '[]'::jsonb,
      draft_revision BIGINT NOT NULL DEFAULT 0,
      draft_updated_at TIMESTAMPTZ,
      created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_at TIMESTAMPTZ
    )
  `.simple();

  // AI chat ownership was unreleased and only backed local test data. Make the
  // product-model cut once, then keep only the global conversation contract.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'conversations' AND column_name = 'app_id'
      ) THEN
        DELETE FROM ai.conversations;
        ALTER TABLE ai.conversations DROP CONSTRAINT IF EXISTS ai_conversations_project_app_fkey;
        DROP INDEX IF EXISTS ai.idx_ai_conversations_app_owner_updated;
        DROP INDEX IF EXISTS ai.idx_ai_conversations_app_owner_pinned;
        ALTER TABLE ai.conversations
          DROP COLUMN app_id,
          DROP COLUMN resource_kind,
          DROP COLUMN resource_app_id,
          DROP COLUMN resource_type,
          DROP COLUMN resource_id;
      END IF;
    END $$
  `.simple();

  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversations_short_id ON ai.conversations(short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_conversations_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.conversations WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.conversations SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.conversations ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`ALTER TABLE ai.conversations DROP COLUMN IF EXISTS icon`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'conversations' AND column_name = 'loaded_capabilities'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'conversations' AND column_name = 'loaded_tools'
      ) THEN
        ALTER TABLE ai.conversations RENAME COLUMN loaded_capabilities TO loaded_tools;
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'conversations' AND column_name = 'loaded_capabilities'
      ) THEN
        UPDATE ai.conversations
        SET loaded_tools = ARRAY(
          SELECT DISTINCT name
          FROM unnest(loaded_tools || loaded_capabilities) AS name
        );
        ALTER TABLE ai.conversations DROP COLUMN loaded_capabilities;
      END IF;
    END $$
  `.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS loaded_tools TEXT[] NOT NULL DEFAULT '{}'`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS draft_content JSONB NOT NULL DEFAULT '[]'::jsonb`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS draft_revision BIGINT NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS draft_updated_at TIMESTAMPTZ`.simple();
  // Enrichment (description/keywords/title upkeep) — dirty = updated_at > enriched_at.
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS keywords TEXT[] NOT NULL DEFAULT '{}'`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS search_summary TEXT NOT NULL DEFAULT ''`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'default'`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS description_source TEXT NOT NULL DEFAULT 'default'`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS enrich_failed_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS enrich_fail_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()`.simple();
  await sql`ALTER TABLE ai.conversations ALTER COLUMN last_viewed_at SET DEFAULT now()`.simple();
  await sql`UPDATE ai.conversations SET last_viewed_at = now() WHERE last_viewed_at IS NULL`.simple();
  await sql`ALTER TABLE ai.conversations ALTER COLUMN last_viewed_at SET NOT NULL`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT ''`.simple();
  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS search_document TSVECTOR NOT NULL DEFAULT ''::tsvector`.simple();
  await sql`
    CREATE OR REPLACE FUNCTION ai.refresh_conversation_search() RETURNS trigger AS $$
    BEGIN
      NEW.search_text := COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.title, '') || ' ' ||
        COALESCE(array_to_string(NEW.keywords, ' '), '') || ' ' || COALESCE(NEW.search_summary, '') || ' ' ||
        COALESCE(NEW.description, '');
      NEW.search_document :=
        setweight(to_tsvector('simple', COALESCE(NEW.title, '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(array_to_string(NEW.keywords, ' '), '')), 'A') ||
        setweight(to_tsvector('simple', COALESCE(NEW.search_summary, '')), 'B') ||
        setweight(to_tsvector('simple', COALESCE(NEW.description, '')), 'C');
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_conversations_search_refresh ON ai.conversations`.simple();
  await sql`
    CREATE TRIGGER ai_conversations_search_refresh
    BEFORE INSERT OR UPDATE OF title, description, keywords, search_summary
    ON ai.conversations FOR EACH ROW EXECUTE FUNCTION ai.refresh_conversation_search()
  `.simple();
  await sql`UPDATE ai.conversations SET search_summary = search_summary`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_search_document
    ON ai.conversations USING GIN(search_document)
  `.simple();

  // Semantics fix: 'auto' is reserved for enrichment-set titles (which always set
  // enriched_at in the same update). First-message snapshot titles are 'default'
  // so enrichment may replace them freely. No-op once the code writes it that way.
  await sql`UPDATE ai.conversations SET title_source = 'default' WHERE title_source = 'auto' AND enriched_at IS NULL`.simple();

  // The AI summary moved into the user-visible description (guarded by
  // description_source, same pattern as title_source). Migrate stored
  // summaries into empty descriptions, then drop the column.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'conversations' AND column_name = 'summary'
      ) THEN
        UPDATE ai.conversations
        SET description = LEFT(summary, 500), description_source = 'auto'
        WHERE description = '' AND summary <> '';
        ALTER TABLE ai.conversations DROP COLUMN summary;
      END IF;
    END $$
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_enrich_dirty
    ON ai.conversations(updated_at ASC)
    WHERE archived_at IS NULL
  `.simple();

  // Per-conversation enrichment history — user-visible in the chat settings.
  await sql`
    CREATE TABLE IF NOT EXISTS ai.enrichment_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'scheduled',
      model_profile_id TEXT,
      mode TEXT,
      duration_ms INTEGER,
      title_updated BOOLEAN NOT NULL DEFAULT FALSE,
      keywords_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_enrichment_runs_status_check CHECK (status IN ('ok', 'failed', 'skipped')),
      CONSTRAINT ai_enrichment_runs_trigger_check CHECK (trigger IN ('scheduled', 'manual'))
    )
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_enrichment_runs_conversation_created
    ON ai.enrichment_runs(conversation_id, created_at DESC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_updated
    ON ai.conversations(created_by_user_id, updated_at DESC)
    WHERE archived_at IS NULL
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner_pinned
    ON ai.conversations(created_by_user_id, pinned_at DESC, updated_at DESC)
    WHERE archived_at IS NULL
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      role TEXT NOT NULL,
      message JSONB NOT NULL,
      model_profile_id TEXT,
      provider_model TEXT,
      usage JSONB,
      stop_reason TEXT,
      loop_id TEXT,
      loop_aggregate JSONB,
      loop_done_reason TEXT,
      compacted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_messages_kind_check CHECK (kind IN ('message', 'summary')),
      CONSTRAINT ai_messages_role_check CHECK (role IN ('user', 'assistant', 'tool_result'))
    )
  `.simple();

  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_messages_conversation_short_id ON ai.messages(conversation_id, short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_messages_conversation_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.messages WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.messages SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.messages ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS loop_id TEXT`.simple();
  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS loop_aggregate JSONB`.simple();
  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS loop_done_reason TEXT`.simple();
  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS meta JSONB`.simple();
  await sql`ALTER TABLE ai.messages ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT ''`.simple();
  await sql`
    ALTER TABLE ai.messages
    ADD COLUMN IF NOT EXISTS search_document tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(search_text, ''))) STORED
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_messages_search_document
    ON ai.messages USING GIN(search_document)
  `.simple();

  // Seq is only unique among active (non-compacted) rows: compaction archives rows
  // in place and the summary takes over the checkpoint seq.
  await sql`ALTER TABLE ai.messages DROP CONSTRAINT IF EXISTS ai_messages_seq_unique`.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_messages_active_seq_unique
    ON ai.messages(conversation_id, seq)
    WHERE compacted_at IS NULL
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_seq
    ON ai.messages(conversation_id, seq ASC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_messages_active_conversation_seq
    ON ai.messages(conversation_id, seq ASC)
    WHERE compacted_at IS NULL
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_messages_active_conversation_loop_seq
    ON ai.messages(conversation_id, loop_id, seq ASC)
    WHERE compacted_at IS NULL AND loop_id IS NOT NULL
  `.simple();

  // Optional pg_textsearch ranking. Native weighted FTS above is always the
  // correctness path; missing extension support must never block startup.
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
          CREATE INDEX IF NOT EXISTS conversations_search_bm25_idx
          ON ai.conversations USING bm25 ((search_text)) WITH (text_config='simple')
        `)
        .simple();
      await sql
        .unsafe(`
          CREATE INDEX IF NOT EXISTS messages_search_bm25_idx
          ON ai.messages USING bm25 ((search_text)) WITH (text_config='simple')
        `)
        .simple();
      console.log("  ✓ ai conversation optional BM25 search indexes");
    }
  } catch (error) {
    console.warn("  ! ai conversation optional BM25 search unavailable; native PostgreSQL FTS remains active", error);
  }

  await sql`
    CREATE TABLE IF NOT EXISTS ai.turns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      model_profile_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      live_blocks JSONB,
      live_seq BIGINT NOT NULL DEFAULT 0,
      deadline TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      error TEXT,
      cancel_requested_at TIMESTAMPTZ,
      cancellation_reason TEXT,
      lease_owner TEXT,
      lease_expires_at TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      run_config JSONB,
      CONSTRAINT ai_turns_status_check CHECK (status IN ('queued', 'running', 'waiting_for_action', 'completed', 'failed', 'aborted'))
    )
  `.simple();

  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_turns_conversation_short_id ON ai.turns(conversation_id, short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_turns_conversation_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.turns WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.turns SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.turns ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS lease_owner TEXT`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS run_config JSONB`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS live_blocks JSONB`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS live_seq BIGINT NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS deadline TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.turns ALTER COLUMN status SET DEFAULT 'queued'`.simple();
  await sql`
    UPDATE ai.turns
    SET run_config = (run_config #>> '{}')::jsonb
    WHERE jsonb_typeof(run_config) = 'string'
  `.simple();
  await sql`
    UPDATE ai.turns
    SET live_blocks = (live_blocks #>> '{}')::jsonb
    WHERE jsonb_typeof(live_blocks) = 'string'
  `.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_turns_one_active_per_conversation
    ON ai.turns(conversation_id)
    WHERE status IN ('queued', 'running', 'waiting_for_action')
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_turns_conversation_created
    ON ai.turns(conversation_id, created_at DESC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_turns_completed_chat
    ON ai.turns(completed_at, id)
    WHERE status = 'completed' AND run_config->>'kind' = 'chat'
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.conversation_resource_refs (
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      title TEXT,
      preview TEXT,
      icon TEXT,
      href TEXT,
      source_turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL,
      source_call_id TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, resource_type, resource_id)
    )
  `.simple();
  await sql`ALTER TABLE ai.conversation_resource_refs DROP COLUMN IF EXISTS occurrences`.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_resource_refs_recent
    ON ai.conversation_resource_refs(conversation_id, last_seen_at DESC, resource_type, resource_id)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_resource_refs_resource
    ON ai.conversation_resource_refs(resource_type, resource_id, conversation_id)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.conversation_sources (
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      title TEXT NOT NULL,
      preview TEXT,
      icon TEXT,
      href TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      source_turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL,
      source_call_id TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, kind, source_key),
      CONSTRAINT ai_conversation_sources_kind_check CHECK (kind IN ('web', 'activity')),
      CONSTRAINT ai_conversation_sources_occurrences_check CHECK (occurrences > 0)
    )
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversation_sources_recent
    ON ai.conversation_sources(conversation_id, last_seen_at DESC, kind, source_key)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.turn_steers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      client_request_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message_id UUID REFERENCES ai.messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at TIMESTAMPTZ,
      CONSTRAINT ai_turn_steers_status_check CHECK (status IN ('pending', 'consumed', 'discarded')),
      CONSTRAINT ai_turn_steers_text_check CHECK (length(btrim(text)) BETWEEN 1 AND 20000)
    )
  `.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_turn_steers_turn_seq
    ON ai.turn_steers(turn_id, seq)
  `.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_turn_steers_request
    ON ai.turn_steers(turn_id, client_request_id)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_turn_steers_pending
    ON ai.turn_steers(conversation_id, turn_id, seq ASC)
    WHERE status = 'pending'
  `.simple();

  // Streaming persistence moved to live_blocks snapshots plus the Redis fanout
  // topic; the per-delta event log is gone.
  await sql`DROP TABLE IF EXISTS ai.turn_events`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.pending_actions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args JSONB NOT NULL,
      message TEXT,
      review JSONB,
      approval_scope TEXT NOT NULL,
      allow_always BOOLEAN NOT NULL DEFAULT FALSE,
      frontend_mode TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_event JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      CONSTRAINT ai_pending_actions_kind_check CHECK (kind IN ('approval', 'custom_approval', 'client_tool')),
      CONSTRAINT ai_pending_actions_status_check CHECK (status IN ('pending', 'resolved', 'aborted'))
    )
  `.simple();

  await sql`ALTER TABLE ai.pending_actions ADD COLUMN IF NOT EXISTS review JSONB`.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_pending_actions_turn_call
    ON ai.pending_actions(turn_id, call_id)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_pending_turn
    ON ai.pending_actions(conversation_id, turn_id, created_at ASC)
    WHERE status = 'pending'
  `.simple();

  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'tool_approval_preferences' AND column_name = 'app_id'
      ) THEN
        DROP TABLE ai.tool_approval_preferences;
      END IF;
    END $$
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.tool_approval_preferences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      approval_scope TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      CONSTRAINT ai_tool_approval_preferences_unique UNIQUE (actor_user_id, tool_name, approval_scope)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.tool_calls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT 'server',
      status TEXT NOT NULL DEFAULT 'pending',
      approval_state TEXT NOT NULL DEFAULT 'not_required',
      input_meta JSONB,
      output_meta JSONB,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      approval_requested_at TIMESTAMPTZ,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      CONSTRAINT ai_tool_calls_status_check CHECK (status IN ('pending', 'running', 'waiting_for_approval', 'waiting_for_frontend', 'completed', 'failed', 'rejected')),
      CONSTRAINT ai_tool_calls_approval_state_check CHECK (approval_state IN ('not_required', 'waiting', 'approved_once', 'approved_always', 'approved_by_preference', 'rejected'))
    )
  `.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_tool_calls_turn_call
    ON ai.tool_calls(turn_id, call_id)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conversation_created
    ON ai.tool_calls(conversation_id, created_at DESC)
  `.simple();

  await sql`ALTER TABLE ai.tool_calls ADD COLUMN IF NOT EXISTS idempotency_key TEXT`.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_tool_calls_idempotency_key
    ON ai.tool_calls(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.inter_chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      source_conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      source_turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      source_call_id TEXT NOT NULL,
      target_conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      actor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      target_turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL,
      target_message_id UUID REFERENCES ai.messages(id) ON DELETE SET NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      delivered_at TIMESTAMPTZ,
      CONSTRAINT ai_inter_chat_messages_short_id_unique UNIQUE (short_id),
      CONSTRAINT ai_inter_chat_messages_status_check CHECK (status IN ('pending', 'delivered', 'failed')),
      CONSTRAINT ai_inter_chat_messages_text_check CHECK (length(btrim(text)) BETWEEN 1 AND 20000),
      CONSTRAINT ai_inter_chat_messages_distinct_chats_check CHECK (source_conversation_id <> target_conversation_id)
    )
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_inter_chat_messages_pending_target
    ON ai.inter_chat_messages(target_conversation_id, created_at ASC, id ASC)
    WHERE status = 'pending'
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.chat_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      sponsor_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      run_at TIMESTAMPTZ,
      cron TEXT,
      timezone TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      revision BIGINT NOT NULL DEFAULT 0,
      last_error TEXT,
      idempotency_key TEXT,
      idempotency_fingerprint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_chat_tasks_short_id_unique UNIQUE (short_id),
      CONSTRAINT ai_chat_tasks_prompt_check CHECK (length(btrim(prompt)) BETWEEN 1 AND 10000),
      CONSTRAINT ai_chat_tasks_schedule_kind_check CHECK (schedule_kind IN ('once', 'cron')),
      CONSTRAINT ai_chat_tasks_schedule_check CHECK (
        (schedule_kind = 'once' AND run_at IS NOT NULL AND cron IS NULL) OR
        (schedule_kind = 'cron' AND run_at IS NULL AND cron IS NOT NULL)
      ),
      CONSTRAINT ai_chat_tasks_state_check CHECK (state IN ('active', 'paused', 'completed', 'needs_attention'))
    )
  `.simple();

  await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT`.simple();
  await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.chat_tasks DROP CONSTRAINT IF EXISTS chat_tasks_idempotency_key_key`.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_chat_tasks_owner_idempotency
    ON ai.chat_tasks(sponsor_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_chat_tasks_owner_created
    ON ai.chat_tasks(sponsor_user_id, created_at DESC, id DESC)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_chat_tasks_due_once
    ON ai.chat_tasks(run_at ASC, id ASC)
    WHERE state = 'active' AND schedule_kind = 'once'
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.chat_task_occurrences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      task_id UUID NOT NULL REFERENCES ai.chat_tasks(id) ON DELETE CASCADE,
      scheduled_for TIMESTAMPTZ NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'scheduled',
      state TEXT NOT NULL DEFAULT 'queued',
      task_revision BIGINT NOT NULL DEFAULT 0,
      request_key TEXT NOT NULL,
      turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      CONSTRAINT ai_chat_task_occurrences_short_id_unique UNIQUE (short_id),
      CONSTRAINT ai_chat_task_occurrences_slot_unique UNIQUE (task_id, scheduled_for),
      CONSTRAINT ai_chat_task_occurrences_trigger_check CHECK (trigger IN ('scheduled', 'manual')),
      CONSTRAINT ai_chat_task_occurrences_state_check CHECK (state IN ('queued', 'running', 'completed', 'failed'))
    )
  `.simple();

  await sql`ALTER TABLE ai.chat_task_occurrences ADD COLUMN IF NOT EXISTS task_revision BIGINT NOT NULL DEFAULT 0`.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_chat_task_occurrences_request_key
    ON ai.chat_task_occurrences(request_key)
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_chat_task_occurrences_queued
    ON ai.chat_task_occurrences(created_at ASC, id ASC)
    WHERE state = 'queued'
  `.simple();

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_chat_task_occurrences_active_task
    ON ai.chat_task_occurrences(task_id)
    WHERE state IN ('queued', 'running')
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_chat_task_occurrences_task_created
    ON ai.chat_task_occurrences(task_id, created_at DESC, id DESC)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.user_prefs (
      user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      memory_learning_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  // Unreleased alpha cut: structured records replace the former free-form
  // memory blob. Deliberately discard it instead of migrating ambiguous lines.
  await sql`ALTER TABLE ai.user_prefs DROP COLUMN IF EXISTS memory`.simple();
  await sql`ALTER TABLE ai.user_prefs DROP COLUMN IF EXISTS instructions`.simple();
  await sql`ALTER TABLE ai.user_prefs ADD COLUMN IF NOT EXISTS memory_learning_enabled BOOLEAN NOT NULL DEFAULT FALSE`.simple();

  // Last model the user actually ran a turn with — preselected for new chats.
  await sql`ALTER TABLE ai.user_prefs ADD COLUMN IF NOT EXISTS last_model_id TEXT NOT NULL DEFAULT ''`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.memories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      source TEXT NOT NULL DEFAULT 'user',
      source_conversation_id UUID REFERENCES ai.conversations(id) ON DELETE SET NULL,
      source_message_id UUID REFERENCES ai.messages(id) ON DELETE SET NULL,
      resource_type TEXT,
      resource_id TEXT,
      superseded_by_id UUID REFERENCES ai.memories(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      search_document TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', COALESCE(content, ''))) STORED,
      CONSTRAINT ai_memories_kind_check CHECK (kind IN ('fact', 'preference', 'workflow')),
      CONSTRAINT ai_memories_priority_check CHECK (priority IN ('normal', 'pinned')),
      CONSTRAINT ai_memories_source_check CHECK (source IN ('user', 'agent', 'background')),
      CONSTRAINT ai_memories_content_check CHECK (char_length(content) BETWEEN 1 AND 500),
      CONSTRAINT ai_memories_resource_value_check CHECK (
        (resource_type IS NULL AND resource_id IS NULL)
        OR (char_length(resource_type) BETWEEN 3 AND 180 AND char_length(resource_id) BETWEEN 1 AND 512)
      ),
      CONSTRAINT ai_memories_workflow_resource_check CHECK (
        (kind = 'workflow' AND resource_type IS NOT NULL AND resource_id IS NOT NULL)
        OR (kind <> 'workflow' AND resource_type IS NULL AND resource_id IS NULL)
      )
    )
  `.simple();

  await sql`ALTER TABLE ai.memories ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`ALTER TABLE ai.memories ADD COLUMN IF NOT EXISTS resource_type TEXT`.simple();
  await sql`ALTER TABLE ai.memories ADD COLUMN IF NOT EXISTS resource_id TEXT`.simple();
  await sql`ALTER TABLE ai.memories DROP CONSTRAINT IF EXISTS ai_memories_resource_value_check`.simple();
  await sql`
    ALTER TABLE ai.memories ADD CONSTRAINT ai_memories_resource_value_check CHECK (
      (resource_type IS NULL AND resource_id IS NULL)
      OR (char_length(resource_type) BETWEEN 3 AND 180 AND char_length(resource_id) BETWEEN 1 AND 512)
    )
  `.simple();
  await sql`ALTER TABLE ai.memories DROP CONSTRAINT IF EXISTS ai_memories_kind_check`.simple();
  await sql`ALTER TABLE ai.memories ADD CONSTRAINT ai_memories_kind_check CHECK (kind IN ('fact', 'preference', 'workflow'))`.simple();
  await sql`ALTER TABLE ai.memories DROP CONSTRAINT IF EXISTS ai_memories_workflow_resource_check`.simple();
  await sql`
    ALTER TABLE ai.memories ADD CONSTRAINT ai_memories_workflow_resource_check CHECK (
      (kind = 'workflow' AND resource_type IS NOT NULL AND resource_id IS NOT NULL)
      OR (kind <> 'workflow' AND resource_type IS NULL AND resource_id IS NULL)
    )
  `.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memories_short_id ON ai.memories(short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_memories_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.memories WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.memories SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.memories ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_memories_user_active
    ON ai.memories(user_id, priority DESC, updated_at DESC, id)
    WHERE deleted_at IS NULL AND superseded_by_id IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_memories_search_document
    ON ai.memories USING GIN(search_document)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memories_user_content_active
    ON ai.memories(user_id, lower(content))
    WHERE deleted_at IS NULL AND superseded_by_id IS NULL
  `.simple();

  // pg_textsearch only improves ranking. Native GIN FTS above remains the
  // correctness baseline and optional setup must never block AI startup.
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
          CREATE INDEX IF NOT EXISTS memories_search_bm25_idx
          ON ai.memories USING bm25 ((content)) WITH (text_config='simple')
        `)
        .simple();
      console.log("  ✓ ai.memories optional BM25 search index");
    }
  } catch (error) {
    console.warn("  ! ai.memories optional BM25 search index unavailable; native PostgreSQL FTS remains active", error);
  }

  // Turn-level learning avoids replaying an entire conversation whenever an
  // Assistant or tool message updates the chat. Existing turns are marked as
  // already considered exactly once when the column is introduced.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'turns' AND column_name = 'memory_learned_at'
      ) THEN
        ALTER TABLE ai.turns ADD COLUMN memory_learned_at TIMESTAMPTZ;
        UPDATE ai.turns SET memory_learned_at = COALESCE(completed_at, created_at)
        WHERE status IN ('completed', 'failed', 'aborted');
      END IF;
    END $$
  `.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS memory_learn_failed_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.turns ADD COLUMN IF NOT EXISTS memory_learn_fail_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_turns_memory_learning_candidates
    ON ai.turns(completed_at, id)
    WHERE status = 'completed' AND memory_learned_at IS NULL
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.memory_workflow_evidence (
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      capability_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      resource_title TEXT,
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      PRIMARY KEY (turn_id, capability_id, resource_type, resource_id),
      CONSTRAINT ai_memory_workflow_evidence_capability_check CHECK (char_length(capability_id) BETWEEN 3 AND 180),
      CONSTRAINT ai_memory_workflow_evidence_resource_check CHECK (
        char_length(resource_type) BETWEEN 3 AND 180 AND char_length(resource_id) BETWEEN 1 AND 512
      )
    )
  `.simple();
  await sql`ALTER TABLE ai.memory_workflow_evidence DROP CONSTRAINT IF EXISTS ai_memory_workflow_evidence_capability_check`.simple();
  await sql`
    ALTER TABLE ai.memory_workflow_evidence ADD CONSTRAINT ai_memory_workflow_evidence_capability_check
    CHECK (char_length(capability_id) BETWEEN 3 AND 180)
  `.simple();
  await sql`ALTER TABLE ai.memory_workflow_evidence DROP CONSTRAINT IF EXISTS ai_memory_workflow_evidence_resource_check`.simple();
  await sql`
    ALTER TABLE ai.memory_workflow_evidence ADD CONSTRAINT ai_memory_workflow_evidence_resource_check
    CHECK (char_length(resource_type) BETWEEN 3 AND 180 AND char_length(resource_id) BETWEEN 1 AND 512)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_memory_workflow_evidence_pending
    ON ai.memory_workflow_evidence(user_id, capability_id, resource_type, resource_id, observed_at)
    WHERE reviewed_at IS NULL
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.memory_learning_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES ai.conversations(id) ON DELETE SET NULL,
      turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL,
      conversation_title TEXT NOT NULL,
      run_kind TEXT NOT NULL DEFAULT 'turn',
      evidence_key TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      model_profile_id TEXT,
      duration_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      accounted_tokens INTEGER NOT NULL DEFAULT 0,
      added_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      merged_count INTEGER NOT NULL DEFAULT 0,
      retired_count INTEGER NOT NULL DEFAULT 0,
      changes JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT ai_memory_learning_runs_status_check CHECK (status IN ('running', 'ok', 'skipped', 'failed')),
      CONSTRAINT ai_memory_learning_runs_kind_check CHECK (run_kind IN ('turn', 'workflow')),
      CONSTRAINT ai_memory_learning_runs_evidence_check CHECK (
        (run_kind = 'turn' AND evidence_key IS NULL)
        OR (run_kind = 'workflow' AND turn_id IS NOT NULL AND evidence_key IS NOT NULL)
      ),
      CONSTRAINT ai_memory_learning_runs_changes_check CHECK (jsonb_typeof(changes) = 'array')
    )
  `.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS turn_id UUID REFERENCES ai.turns(id) ON DELETE SET NULL`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'turn'`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS evidence_key TEXT`.simple();
  await sql`
    UPDATE ai.memory_learning_runs
    SET evidence_key = 'legacy:' || id::text
    WHERE run_kind = 'workflow' AND evidence_key IS NULL
  `.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS input_tokens INTEGER`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS output_tokens INTEGER`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS accounted_tokens INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs ADD COLUMN IF NOT EXISTS retired_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE ai.memory_learning_runs DROP CONSTRAINT IF EXISTS ai_memory_learning_runs_kind_check`.simple();
  await sql`
    ALTER TABLE ai.memory_learning_runs ADD CONSTRAINT ai_memory_learning_runs_kind_check
    CHECK (run_kind IN ('turn', 'workflow'))
  `.simple();
  await sql`ALTER TABLE ai.memory_learning_runs DROP CONSTRAINT IF EXISTS ai_memory_learning_runs_evidence_check`.simple();
  await sql`
    ALTER TABLE ai.memory_learning_runs ADD CONSTRAINT ai_memory_learning_runs_evidence_check CHECK (
      (run_kind = 'turn' AND evidence_key IS NULL)
      OR (run_kind = 'workflow' AND turn_id IS NOT NULL AND evidence_key IS NOT NULL)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_learning_runs_short_id
    ON ai.memory_learning_runs(short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_memory_learning_runs_user_created
    ON ai.memory_learning_runs(user_id, created_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_learning_runs_turn
    ON ai.memory_learning_runs(turn_id)
    WHERE turn_id IS NOT NULL AND run_kind = 'turn'
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_learning_runs_workflow_evidence
    ON ai.memory_learning_runs(evidence_key)
    WHERE evidence_key IS NOT NULL AND run_kind = 'workflow'
  `.simple();

  // ── Conversation file workspace ───────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS ai.files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL,
      origin TEXT NOT NULL DEFAULT 'assistant' CONSTRAINT ai_files_origin_check CHECK (origin IN ('user', 'assistant')),
      version BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_files_path_unique UNIQUE (conversation_id, path)
    )
  `.simple();
  await sql`ALTER TABLE ai.files ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'assistant'`.simple();
  await sql`ALTER TABLE ai.files ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`.simple();
  await sql`UPDATE ai.files SET origin = 'user' WHERE (path = '/input' OR path LIKE '/input/%') AND origin <> 'user'`.simple();
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ai_files_origin_check' AND conrelid = 'ai.files'::regclass
      ) THEN
        ALTER TABLE ai.files ADD CONSTRAINT ai_files_origin_check CHECK (origin IN ('user', 'assistant'));
      END IF;
    END $$
  `.simple();

  // Inline image parts were an alpha transport detail. Move their bytes into
  // the authorized conversation file store and leave only stable references in
  // message history. Re-running is idempotent because the path is derived from
  // the message short id and content position.
  await sql`
    WITH inline_images AS (
      SELECT
        m.id AS message_id,
        m.conversation_id,
        part.ordinality,
        part.value,
        lower(part.value->>'mediaType') AS media_type,
        decode(part.value->>'data', 'base64') AS bytes,
        '/image-' || m.short_id || '-' || part.ordinality ||
          CASE lower(part.value->>'mediaType')
            WHEN 'image/jpeg' THEN '.jpg'
            WHEN 'image/jpg' THEN '.jpg'
            WHEN 'image/png' THEN '.png'
            WHEN 'image/webp' THEN '.webp'
            WHEN 'image/gif' THEN '.gif'
          END AS path
      FROM ai.messages m
      CROSS JOIN LATERAL jsonb_array_elements(
        (CASE WHEN jsonb_typeof(m.message) = 'string' THEN (m.message #>> '{}')::jsonb ELSE m.message END)->'content'
      ) WITH ORDINALITY AS part(value, ordinality)
      WHERE m.role = 'user'
        AND part.value->>'type' = 'file'
        AND lower(part.value->>'mediaType') IN ('image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif')
        AND part.value->>'data' ~ '^[A-Za-z0-9+/]*={0,2}$'
        AND length(part.value->>'data') % 4 = 0
    ), migrated AS (
      INSERT INTO ai.files (conversation_id, path, bytes, media_type, size, origin)
      SELECT conversation_id, path, bytes, media_type, octet_length(bytes), 'user'
      FROM inline_images
      ON CONFLICT (conversation_id, path) DO UPDATE SET updated_at = ai.files.updated_at
      WHERE ai.files.bytes = EXCLUDED.bytes
        AND ai.files.media_type = EXCLUDED.media_type
        AND ai.files.size = EXCLUDED.size
        AND ai.files.origin = 'user'
      RETURNING conversation_id, path
    )
    UPDATE ai.messages m
    SET message = CASE
      WHEN jsonb_typeof(m.message) = 'string' THEN to_jsonb((jsonb_set(
        (m.message #>> '{}')::jsonb,
        '{content}',
        (
          SELECT jsonb_agg(
            CASE
              WHEN image.path IS NULL THEN part.value
              ELSE jsonb_build_object(
                'type', 'text',
                'text', '<attachment path="' || image.path || '" media-type="' || image.media_type || '" size="' || octet_length(image.bytes) || '" />'
              )
            END
            ORDER BY part.ordinality
          )
          FROM jsonb_array_elements((m.message #>> '{}')::jsonb->'content') WITH ORDINALITY AS part(value, ordinality)
          LEFT JOIN inline_images image ON image.message_id = m.id AND image.ordinality = part.ordinality
        )
      ))::text)
      ELSE jsonb_set(
        m.message,
        '{content}',
        (
        SELECT jsonb_agg(
          CASE
            WHEN image.path IS NULL THEN part.value
            ELSE jsonb_build_object(
              'type', 'text',
              'text', '<attachment path="' || image.path || '" media-type="' || image.media_type || '" size="' || octet_length(image.bytes) || '" />'
            )
          END
          ORDER BY part.ordinality
        )
        FROM jsonb_array_elements(m.message->'content') WITH ORDINALITY AS part(value, ordinality)
        LEFT JOIN inline_images image ON image.message_id = m.id AND image.ordinality = part.ordinality
        )
      )
    END
    WHERE EXISTS (SELECT 1 FROM inline_images image WHERE image.message_id = m.id)
      AND NOT EXISTS (
        SELECT 1 FROM inline_images image
        WHERE image.message_id = m.id
          AND NOT EXISTS (
            SELECT 1 FROM migrated
            WHERE migrated.conversation_id = image.conversation_id AND migrated.path = image.path
          )
      )
  `.simple();
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1
        FROM ai.messages m
        CROSS JOIN LATERAL jsonb_array_elements(
          (CASE WHEN jsonb_typeof(m.message) = 'string' THEN (m.message #>> '{}')::jsonb ELSE m.message END)->'content'
        ) AS part(value)
        WHERE m.role = 'user'
          AND part.value->>'type' = 'file'
          AND lower(part.value->>'mediaType') IN ('image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif')
          AND part.value->>'data' IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Could not migrate every historical inline AI image without a file collision';
      END IF;
    END $$
  `.simple();
  await sql`
    WITH referenced_parts AS (
      SELECT m.loop_id::uuid AS turn_id, part.ordinality, part.value
      FROM ai.messages m
      CROSS JOIN LATERAL jsonb_array_elements(
        (CASE WHEN jsonb_typeof(m.message) = 'string' THEN (m.message #>> '{}')::jsonb ELSE m.message END)->'content'
      ) WITH ORDINALITY AS part(value, ordinality)
      WHERE m.role = 'user'
        AND m.loop_id IS NOT NULL
        AND part.value->>'type' = 'text'
        AND part.value->>'text' LIKE '<attachment path=%'
    ), rewritten AS (
      SELECT
        t.id,
        jsonb_set(
          config.value,
          '{input}',
          jsonb_agg(
            CASE WHEN part.value->>'type' = 'file' AND reference.value IS NOT NULL THEN reference.value ELSE part.value END
            ORDER BY part.ordinality
          )
        ) AS value,
        jsonb_typeof(t.run_config) = 'string' AS string_encoded
      FROM ai.turns t
      CROSS JOIN LATERAL (
        SELECT CASE WHEN jsonb_typeof(t.run_config) = 'string' THEN (t.run_config #>> '{}')::jsonb ELSE t.run_config END AS value
      ) AS config
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(config.value->'input') = 'array' THEN config.value->'input' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS part(value, ordinality)
      LEFT JOIN referenced_parts reference ON reference.turn_id = t.id AND reference.ordinality = part.ordinality
      WHERE t.run_config IS NOT NULL
        AND t.status NOT IN ('queued', 'running', 'waiting_for_action')
      GROUP BY t.id, t.run_config, config.value
      HAVING bool_or(part.value->>'type' = 'file' AND reference.value IS NOT NULL)
    )
    UPDATE ai.turns t
    SET run_config = CASE WHEN rewritten.string_encoded THEN to_jsonb(rewritten.value::text) ELSE rewritten.value END
    FROM rewritten
    WHERE rewritten.id = t.id
  `.simple();
  // EXTERNAL keeps bytea un-compressed in TOAST so substring() slices read
  // only the needed chunks — head/tail on big files must not load everything.
  await sql`ALTER TABLE ai.files ALTER COLUMN bytes SET STORAGE EXTERNAL`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS ai.turn_files (
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      origin TEXT NOT NULL CONSTRAINT ai_turn_files_origin_check CHECK (origin IN ('user', 'assistant')),
      updated_at TIMESTAMPTZ NOT NULL,
      version BIGINT NOT NULL,
      PRIMARY KEY (turn_id, path)
    )
  `.simple();
  await sql`ALTER TABLE ai.turn_files ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`.simple();
  await sql`ALTER TABLE ai.turn_files ALTER COLUMN bytes SET STORAGE EXTERNAL`.simple();

  // Skills were previously alpha-only and used personal/workspace ownership.
  // Make the one-time model cut to permission-owned Agent Skills, then keep the
  // new schema intact on later migrations.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'skills' AND column_name IN ('scope', 'owner_user_id')
      ) THEN
        IF to_regclass('ai.skill_access') IS NOT NULL THEN
          DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.skill_access);
        END IF;
        DROP TABLE IF EXISTS ai.skill_seeds CASCADE;
        DROP TABLE IF EXISTS ai.skill_access CASCADE;
        DROP TABLE IF EXISTS ai.skill_user_state CASCADE;
        DROP TABLE IF EXISTS ai.skill_files CASCADE;
        DROP TABLE IF EXISTS ai.skill_events CASCADE;
        DROP TABLE IF EXISTS ai.skills CASCADE;
      END IF;
    END $$
  `.simple();
  await sql`DROP TABLE IF EXISTS ai.skill_user_state CASCADE`.simple();
  await sql`DROP TABLE IF EXISTS ai.skill_files CASCADE`.simple();
  await sql`DROP TABLE IF EXISTS ai.skill_events CASCADE`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.skills (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      extra_frontmatter JSONB NOT NULL DEFAULT '{}'::jsonb,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_skills_name_check CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
      CONSTRAINT ai_skills_description_check CHECK (length(btrim(description)) BETWEEN 1 AND 1024),
      CONSTRAINT ai_skills_instructions_check CHECK (length(btrim(instructions)) BETWEEN 1 AND 100000),
      CONSTRAINT ai_skills_extra_frontmatter_check CHECK (jsonb_typeof(extra_frontmatter) = 'object')
    )
  `.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_skills_short_id ON ai.skills(short_id)`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_skills_name ON ai.skills(name)`.simple();
  await sql`ALTER TABLE ai.skills ADD COLUMN IF NOT EXISTS managed_key TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_skills_managed_key ON ai.skills(managed_key) WHERE managed_key IS NOT NULL`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS ai.skill_seeds (
      key TEXT PRIMARY KEY,
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await backfillAiShortIds(
    "idx_ai_skills_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.skills WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.skills SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.skills ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.skill_access (
      skill_id UUID NOT NULL REFERENCES ai.skills(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      short_id TEXT NOT NULL,
      PRIMARY KEY (skill_id, access_id)
    )
  `.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_skill_access_short_id ON ai.skill_access(skill_id, short_id)`.simple();
  for (const row of await sql<
    { skill_id: string; access_id: string }[]
  >`SELECT skill_id, access_id FROM ai.skill_access WHERE short_id IS NULL`) {
    await withAiShortId(
      "idx_ai_skill_access_short_id",
      (shortId) => sql`
        UPDATE ai.skill_access SET short_id = ${shortId}
        WHERE skill_id = ${row.skill_id}::uuid AND access_id = ${row.access_id}::uuid
      `,
    );
  }
  await sql`ALTER TABLE ai.skill_access ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.skill_user_disabled (
      skill_id UUID NOT NULL REFERENCES ai.skills(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      disabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (skill_id, user_id)
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_skill_user_disabled_user ON ai.skill_user_disabled(user_id)`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.skill_references (
      skill_id UUID NOT NULL REFERENCES ai.skills(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (skill_id, path),
      CONSTRAINT ai_skill_references_path_check CHECK (
        path ~ '^references/[a-z0-9][a-z0-9._-]*\\.md$' AND length(path) <= 200
      ),
      CONSTRAINT ai_skill_references_content_check CHECK (length(content) <= 100000)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.turn_skill_snapshots (
      turn_id UUID NOT NULL REFERENCES ai.turns(id) ON DELETE CASCADE,
      skill_id UUID NOT NULL REFERENCES ai.skills(id) ON DELETE CASCADE,
      skill_name TEXT NOT NULL,
      description TEXT NOT NULL,
      revision INTEGER NOT NULL,
      instructions TEXT NOT NULL,
      files JSONB NOT NULL,
      loaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (turn_id, skill_id),
      UNIQUE (turn_id, skill_name),
      CONSTRAINT ai_turn_skill_snapshots_files_check CHECK (jsonb_typeof(files) = 'array')
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'ti ti-folders',
      instructions TEXT NOT NULL DEFAULT '',
      default_model_profile_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_projects_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
      CONSTRAINT ai_projects_description_check CHECK (length(description) <= 500),
      CONSTRAINT ai_projects_instructions_check CHECK (length(instructions) <= 16000)
    )
  `.simple();

  // Projects were alpha-only while ownership was represented by a user FK.
  // Make the hard cut before normalizing any legacy rows: keep personal chats,
  // discard local alpha Projects, then build only the final access-owned schema.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'projects' AND column_name = 'owner_user_id'
      ) THEN
        IF to_regclass('ai.project_access') IS NOT NULL THEN
          DELETE FROM auth.access
          WHERE id IN (SELECT access_id FROM ai.project_access);
        END IF;
        DELETE FROM ai.projects;
        DROP INDEX IF EXISTS ai.idx_ai_projects_owner_name;
        ALTER TABLE ai.projects DROP COLUMN owner_user_id;
      END IF;
    END $$
  `.simple();

  await sql`ALTER TABLE ai.projects ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'ai.projects'::regclass AND conname = 'ai_projects_id_app_id_key'
      ) THEN
        ALTER TABLE ai.projects DROP CONSTRAINT ai_projects_id_app_id_key;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'projects' AND column_name = 'app_id'
      ) THEN
        ALTER TABLE ai.projects DROP COLUMN app_id;
      END IF;
    END $$
  `.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_projects_short_id ON ai.projects(short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_projects_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.projects WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.projects SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.projects ALTER COLUMN short_id SET NOT NULL`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS ai.project_access (
      project_id UUID NOT NULL REFERENCES ai.projects(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      short_id TEXT NOT NULL,
      PRIMARY KEY (project_id, access_id)
    )
  `.simple();
  await sql`ALTER TABLE ai.project_access ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_project_access_short_id ON ai.project_access(project_id, short_id)`.simple();
  for (const row of await sql<
    { project_id: string; access_id: string }[]
  >`SELECT project_id, access_id FROM ai.project_access WHERE short_id IS NULL`) {
    await withAiShortId(
      "idx_ai_project_access_short_id",
      (shortId) => sql`
        UPDATE ai.project_access SET short_id = ${shortId}
        WHERE project_id = ${row.project_id}::uuid AND access_id = ${row.access_id}::uuid
      `,
    );
  }
  await sql`ALTER TABLE ai.project_access ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.project_knowledge (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      project_id UUID NOT NULL REFERENCES ai.projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      search_document TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', title), 'A') || setweight(to_tsvector('simple', content), 'B')
      ) STORED,
      created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_project_knowledge_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200),
      CONSTRAINT ai_project_knowledge_content_check CHECK (length(btrim(content)) BETWEEN 1 AND 100000)
    )
  `.simple();
  await sql`ALTER TABLE ai.project_knowledge ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_project_knowledge_short_id ON ai.project_knowledge(project_id, short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_project_knowledge_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.project_knowledge WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.project_knowledge SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.project_knowledge ALTER COLUMN short_id SET NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_project_knowledge_search ON ai.project_knowledge USING GIN(search_document)`.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS ai.project_files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      project_id UUID NOT NULL REFERENCES ai.projects(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      bytes BYTEA NOT NULL,
      size INTEGER NOT NULL,
      created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, path),
      CONSTRAINT ai_project_files_size_check CHECK (size BETWEEN 0 AND 10485760)
    )
  `.simple();
  await sql`ALTER TABLE ai.project_files ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_project_files_short_id ON ai.project_files(project_id, short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_project_files_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.project_files WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.project_files SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.project_files ALTER COLUMN short_id SET NOT NULL`.simple();
  await sql`ALTER TABLE ai.project_files ALTER COLUMN bytes SET STORAGE EXTERNAL`.simple();

  await sql`DROP TABLE IF EXISTS ai.project_references CASCADE`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS ai.project_resource_refs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      project_id UUID NOT NULL REFERENCES ai.projects(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (project_id, resource_type, resource_id)
    )
  `.simple();
  await sql`ALTER TABLE ai.project_resource_refs ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_project_resource_refs_short_id ON ai.project_resource_refs(project_id, short_id)`.simple();
  await backfillAiShortIds(
    "idx_ai_project_resource_refs_short_id",
    await sql<{ id: string }[]>`SELECT id FROM ai.project_resource_refs WHERE short_id IS NULL`,
    (id, shortId) => sql`UPDATE ai.project_resource_refs SET short_id = ${shortId} WHERE id = ${id}::uuid`,
  );
  await sql`ALTER TABLE ai.project_resource_refs ALTER COLUMN short_id SET NOT NULL`.simple();

  await sql`ALTER TABLE ai.conversations ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES ai.projects(id) ON DELETE SET NULL`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_conversations_project_owner_updated
    ON ai.conversations(project_id, created_by_user_id, updated_at DESC)
    WHERE project_id IS NOT NULL AND archived_at IS NULL
  `.simple();

  // Durable Realtime UI invalidations. Triggers live at the persistence seam so
  // route, worker, tool, enrichment, and scheduler writes cannot bypass them.
  // The outbox row commits or rolls back with the authoritative domain write;
  // publishing remains an after-commit runtime responsibility.
  await sql`
    CREATE TABLE IF NOT EXISTS ai.live_invalidation_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      change_id UUID NOT NULL,
      audience_user_id UUID NOT NULL,
      conversation_short_id TEXT,
      project_short_id TEXT,
      domains TEXT[] NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_until TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      dead_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ai_live_invalidation_domains_check CHECK (
        cardinality(domains) > 0 AND domains <@ ARRAY[
          'conversation-list', 'conversation-detail', 'conversation-sources', 'conversation-files', 'conversation-tasks',
          'project-list', 'project-detail', 'project-context'
        ]::text[]
      )
    )
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ai' AND table_name = 'live_invalidation_outbox' AND column_name = 'app_id'
      ) THEN
        DELETE FROM ai.live_invalidation_outbox;
        ALTER TABLE ai.live_invalidation_outbox DROP COLUMN app_id;
      END IF;
    END $$
  `.simple();
  // Audience IDs are immutable event-routing data. A foreign key makes an
  // unrelated user-delete cascade invoke Project triggers after the user row
  // has disappeared, aborting the authoritative delete instead of merely
  // leaving a harmless undeliverable invalidation.
  await sql`
    ALTER TABLE ai.live_invalidation_outbox
    DROP CONSTRAINT IF EXISTS live_invalidation_outbox_audience_user_id_fkey
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_live_invalidation_outbox_pending
    ON ai.live_invalidation_outbox(next_attempt_at, created_at, id)
    WHERE delivered_at IS NULL AND dead_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_live_invalidation_outbox_user_order
    ON ai.live_invalidation_outbox(audience_user_id, created_at, id)
    WHERE delivered_at IS NULL AND dead_at IS NULL
  `.simple();

  // Hard cut: the former app-scoped signature is a distinct PostgreSQL
  // overload, so CREATE OR REPLACE cannot remove it for us.
  await sql`
    DROP FUNCTION IF EXISTS ai.enqueue_live_for_user(UUID, TEXT, UUID, TEXT, TEXT, TEXT[])
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.enqueue_live_for_user(
      p_change_id UUID,
      p_user_id UUID,
      p_conversation_short_id TEXT,
      p_project_short_id TEXT,
      p_domains TEXT[]
    ) RETURNS void AS $$
    BEGIN
      IF p_user_id IS NULL OR cardinality(p_domains) = 0 THEN RETURN; END IF;
      INSERT INTO ai.live_invalidation_outbox (
        change_id, audience_user_id, conversation_short_id, project_short_id, domains
      ) VALUES (
        p_change_id, p_user_id, p_conversation_short_id, p_project_short_id,
        ARRAY(SELECT DISTINCT domain FROM unnest(p_domains) domain ORDER BY domain)
      );
    END
    $$ LANGUAGE plpgsql
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.enqueue_live_for_conversation(
      p_conversation_id UUID,
      p_domains TEXT[]
    ) RETURNS void AS $$
    DECLARE
      target RECORD;
    BEGIN
      SELECT conversation.created_by_user_id, conversation.short_id,
             project.short_id AS project_short_id
      INTO target
      FROM ai.conversations conversation
      LEFT JOIN ai.projects project ON project.id = conversation.project_id
      WHERE conversation.id = p_conversation_id;
      IF NOT FOUND THEN RETURN; END IF;
      PERFORM ai.enqueue_live_for_user(
        gen_random_uuid(), target.created_by_user_id, target.short_id, target.project_short_id, p_domains
      );
    END
    $$ LANGUAGE plpgsql
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.enqueue_live_for_project(
      p_project_id UUID,
      p_domains TEXT[]
    ) RETURNS void AS $$
    DECLARE
      change UUID := gen_random_uuid();
      project_short TEXT;
      recipient RECORD;
    BEGIN
      SELECT short_id INTO project_short FROM ai.projects WHERE id = p_project_id;
      IF NOT FOUND THEN RETURN; END IF;

      FOR recipient IN
        WITH RECURSIVE
          access_rows AS (
            SELECT access.*
            FROM ai.project_access project_access
            JOIN auth.access access ON access.id = project_access.access_id
            WHERE project_access.project_id = p_project_id
              AND access.permission <> 'none'
          ),
          root_groups(group_id, group_ids) AS (
            SELECT group_id, ARRAY[group_id]::uuid[]
            FROM access_rows
            WHERE group_id IS NOT NULL
            UNION ALL
            SELECT nested.child_group_id, root.group_ids || nested.child_group_id
            FROM auth.group_groups_v2 nested
            JOIN root_groups root ON root.group_id = nested.parent_group_id
            WHERE NOT nested.child_group_id = ANY(root.group_ids)
          ),
          recipients(user_id) AS (
            SELECT user_id FROM access_rows WHERE user_id IS NOT NULL
            UNION
            SELECT membership.user_id
            FROM root_groups root
            JOIN auth.user_groups_v2 membership ON membership.group_id = root.group_id
            UNION
            SELECT users.id
            FROM auth.users users
            WHERE EXISTS (
              SELECT 1 FROM access_rows
              WHERE authenticated_only OR (
                user_id IS NULL AND group_id IS NULL AND service_account_id IS NULL AND NOT authenticated_only
              )
            )
          )
        SELECT DISTINCT user_id FROM recipients WHERE user_id IS NOT NULL
      LOOP
        PERFORM ai.enqueue_live_for_user(change, recipient.user_id, NULL, project_short, p_domains);
      END LOOP;
    END
    $$ LANGUAGE plpgsql
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.live_conversation_row_changed() RETURNS trigger AS $$
    DECLARE
      row_data RECORD;
      project_short TEXT;
    BEGIN
      IF TG_OP = 'DELETE' THEN row_data := OLD; ELSE row_data := NEW; END IF;
      SELECT short_id INTO project_short FROM ai.projects WHERE id = row_data.project_id;
      PERFORM ai.enqueue_live_for_user(
        gen_random_uuid(), row_data.created_by_user_id, row_data.short_id, project_short,
        ARRAY['conversation-list', 'conversation-detail']::text[]
      );
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_conversations_changed ON ai.conversations`.simple();
  await sql`
    CREATE TRIGGER ai_live_conversations_changed
    AFTER INSERT OR UPDATE OR DELETE ON ai.conversations
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_row_changed()
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.live_conversation_child_changed() RETURNS trigger AS $$
    DECLARE
      row_data RECORD;
      conversation UUID;
    BEGIN
      IF TG_OP = 'DELETE' THEN row_data := OLD; ELSE row_data := NEW; END IF;
      IF TG_TABLE_NAME = 'chat_task_occurrences' THEN
        SELECT conversation_id INTO conversation FROM ai.chat_tasks WHERE id = row_data.task_id;
      ELSE
        conversation := row_data.conversation_id;
      END IF;
      IF conversation IS NOT NULL THEN
        PERFORM ai.enqueue_live_for_conversation(conversation, string_to_array(TG_ARGV[0], ','));
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_conversation_sources_changed ON ai.conversation_sources`.simple();
  await sql`
    CREATE TRIGGER ai_live_conversation_sources_changed AFTER INSERT OR UPDATE OR DELETE ON ai.conversation_sources
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-sources')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_conversation_resources_changed ON ai.conversation_resource_refs`.simple();
  await sql`
    CREATE TRIGGER ai_live_conversation_resources_changed AFTER INSERT OR UPDATE OR DELETE ON ai.conversation_resource_refs
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-sources')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_conversation_files_changed ON ai.files`.simple();
  await sql`
    CREATE TRIGGER ai_live_conversation_files_changed AFTER INSERT OR UPDATE OR DELETE ON ai.files
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-files,conversation-sources')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_turns_changed ON ai.turns`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_turns_status_changed ON ai.turns`.simple();
  await sql`
    CREATE TRIGGER ai_live_turns_changed
    AFTER INSERT OR DELETE ON ai.turns
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-list,conversation-detail')
  `.simple();
  await sql`
    CREATE TRIGGER ai_live_turns_status_changed
    AFTER UPDATE OF status, error, completed_at, cancel_requested_at ON ai.turns
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-list,conversation-detail')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_chat_tasks_changed ON ai.chat_tasks`.simple();
  await sql`
    CREATE TRIGGER ai_live_chat_tasks_changed AFTER INSERT OR UPDATE OR DELETE ON ai.chat_tasks
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-tasks')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_chat_task_occurrences_changed ON ai.chat_task_occurrences`.simple();
  await sql`
    CREATE TRIGGER ai_live_chat_task_occurrences_changed AFTER INSERT OR UPDATE OR DELETE ON ai.chat_task_occurrences
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-tasks')
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.live_project_row_changed() RETURNS trigger AS $$
    DECLARE row_data RECORD;
    BEGIN
      IF TG_OP = 'DELETE' THEN row_data := OLD; ELSE row_data := NEW; END IF;
      PERFORM ai.enqueue_live_for_project(
        row_data.id,
        ARRAY['project-list', 'project-detail', 'project-context', 'conversation-list']::text[]
      );
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_projects_changed ON ai.projects`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_projects_deleted ON ai.projects`.simple();
  await sql`
    CREATE TRIGGER ai_live_projects_changed
    AFTER INSERT OR UPDATE ON ai.projects
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_row_changed()
  `.simple();
  await sql`
    CREATE TRIGGER ai_live_projects_deleted
    BEFORE DELETE ON ai.projects
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_row_changed()
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.live_project_child_changed() RETURNS trigger AS $$
    DECLARE row_data RECORD;
    BEGIN
      IF TG_OP = 'DELETE' THEN row_data := OLD; ELSE row_data := NEW; END IF;
      PERFORM ai.enqueue_live_for_project(row_data.project_id, string_to_array(TG_ARGV[0], ','));
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_knowledge_changed ON ai.project_knowledge`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_knowledge_changed AFTER INSERT OR UPDATE OR DELETE ON ai.project_knowledge
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_child_changed('project-detail,project-context')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_files_changed ON ai.project_files`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_files_changed AFTER INSERT OR UPDATE OR DELETE ON ai.project_files
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_child_changed('project-detail,project-context')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_resource_refs_changed ON ai.project_resource_refs`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_resource_refs_changed AFTER INSERT OR UPDATE OR DELETE ON ai.project_resource_refs
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_child_changed('project-detail,project-context')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_access_added ON ai.project_access`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_access_added AFTER INSERT OR UPDATE ON ai.project_access
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_child_changed('project-list,project-detail,project-context,conversation-list')
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_access_removed ON ai.project_access`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_access_removed BEFORE DELETE ON ai.project_access
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_child_changed('project-list,project-detail,project-context,conversation-list')
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION ai.live_project_access_permission_changed() RETURNS trigger AS $$
    DECLARE
      project UUID;
      changed_access UUID;
    BEGIN
      changed_access := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
      FOR project IN SELECT project_id FROM ai.project_access WHERE access_id = changed_access
      LOOP
        PERFORM ai.enqueue_live_for_project(
          project,
          ARRAY['project-list', 'project-detail', 'project-context', 'conversation-list']::text[]
        );
      END LOOP;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_access_permission_changed ON auth.access`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_access_permission_changing ON auth.access`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_access_permission_changing
    BEFORE UPDATE OF permission ON auth.access
    FOR EACH ROW
    WHEN (OLD.permission IS DISTINCT FROM NEW.permission)
    EXECUTE FUNCTION ai.live_project_access_permission_changed()
  `.simple();
  await sql`
    CREATE TRIGGER ai_live_project_access_permission_changed
    AFTER UPDATE OF permission ON auth.access
    FOR EACH ROW
    WHEN (OLD.permission IS DISTINCT FROM NEW.permission)
    EXECUTE FUNCTION ai.live_project_access_permission_changed()
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_access_deleting ON auth.access`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_access_deleting
    BEFORE DELETE ON auth.access
    FOR EACH ROW
    EXECUTE FUNCTION ai.live_project_access_permission_changed()
  `.simple();

  await sql`
    CREATE OR REPLACE FUNCTION ai.live_project_group_membership_changed() RETURNS trigger AS $$
    DECLARE
      changed_group UUID;
      project UUID;
    BEGIN
      IF TG_TABLE_NAME = 'user_groups_v2' THEN
        changed_group := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
      ELSE
        changed_group := CASE WHEN TG_OP = 'DELETE' THEN OLD.parent_group_id ELSE NEW.parent_group_id END;
      END IF;
      FOR project IN
        WITH RECURSIVE ancestors(group_id, seen) AS (
          SELECT changed_group, ARRAY[changed_group]::uuid[]
          UNION ALL
          SELECT relation.parent_group_id, ancestors.seen || relation.parent_group_id
          FROM auth.group_groups_v2 relation
          JOIN ancestors ON relation.child_group_id = ancestors.group_id
          WHERE NOT relation.parent_group_id = ANY(ancestors.seen)
        )
        SELECT DISTINCT project_access.project_id
        FROM ancestors
        JOIN auth.access access ON access.group_id = ancestors.group_id AND access.permission <> 'none'
        JOIN ai.project_access project_access ON project_access.access_id = access.id
      LOOP
        PERFORM ai.enqueue_live_for_project(
          project,
          ARRAY['project-list', 'project-detail', 'project-context', 'conversation-list']::text[]
        );
      END LOOP;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END
    $$ LANGUAGE plpgsql
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_user_group_added ON auth.user_groups_v2`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_user_group_removed ON auth.user_groups_v2`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_user_group_added AFTER INSERT ON auth.user_groups_v2
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_group_membership_changed()
  `.simple();
  await sql`
    CREATE TRIGGER ai_live_project_user_group_removed BEFORE DELETE ON auth.user_groups_v2
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_group_membership_changed()
  `.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_group_group_added ON auth.group_groups_v2`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_project_group_group_removed ON auth.group_groups_v2`.simple();
  await sql`
    CREATE TRIGGER ai_live_project_group_group_added AFTER INSERT ON auth.group_groups_v2
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_group_membership_changed()
  `.simple();
  await sql`
    CREATE TRIGGER ai_live_project_group_group_removed BEFORE DELETE ON auth.group_groups_v2
    FOR EACH ROW EXECUTE FUNCTION ai.live_project_group_membership_changed()
  `.simple();

  // Provider API keys used to live inside the ai.model_profiles_json setting.
  // A JSON setting is delivered to the admin UI in full, so every key rode
  // along in the page payload; a per-profile row keeps them server-side and
  // lets a deployment hold as many as it has profiles.
  await sql`
    CREATE TABLE IF NOT EXISTS ai.model_credentials (
      profile_id TEXT PRIMARY KEY,
      secret TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();

  // One-time move of keys that were stored inside the profiles setting. Once
  // the blob holds no apiKey the split yields nothing and this is a no-op, so
  // it is safe to re-run. Dynamic imports keep the module free of store deps.
  {
    const { coreSettings } = await import("../services");
    const { setAiCredential, splitAiProfileCredentials } = await import("./credentials");
    const split = splitAiProfileCredentials((await coreSettings.get<string>("ai.model_profiles_json")) ?? "[]");
    if (split && split.credentials.length > 0) {
      for (const { profileId, secret } of split.credentials) await setAiCredential(profileId, secret);
      await coreSettings.set("ai.model_profiles_json", split.profilesJson);
      console.log(`  ✓ moved ${split.credentials.length} AI provider key(s) out of ai.model_profiles_json`);
    }
  }

  console.log("  ✓ ai conversation tables");
};
