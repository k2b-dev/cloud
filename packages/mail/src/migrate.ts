import { migrateWorkflowAi } from "@valentinkolb/cloud/workflows/ai";
import { sql } from "bun";
import { canonicalizeSavedViewFilter } from "./saved-view-search-migration";
import { SEARCH_CHUNK_CHARACTERS, SEARCH_CHUNK_OVERLAP_CHARACTERS } from "./service/search-chunks";

type SqlClient = typeof sql;

const enforceMailboxOwnedProviderBindings = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE OR REPLACE FUNCTION mail.enforce_provider_binding_mailbox()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      connection_mailbox UUID;
      resource_mailbox UUID;
    BEGIN
      SELECT owner_mailbox_id INTO connection_mailbox
      FROM mail.provider_connections
      WHERE id = NEW.connection_id;

      SELECT mailbox_id INTO resource_mailbox
      FROM mail.remote_resources
      WHERE id = NEW.remote_resource_id;

      IF connection_mailbox IS NULL OR resource_mailbox IS NULL OR connection_mailbox <> resource_mailbox THEN
        RAISE EXCEPTION 'Provider connection and remote resource must belong to the same mailbox'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$
  `;
  await db`DROP TRIGGER IF EXISTS provider_bindings_mailbox_guard ON mail.provider_bindings`;
  await db`
    CREATE TRIGGER provider_bindings_mailbox_guard
    BEFORE INSERT OR UPDATE OF remote_resource_id, connection_id ON mail.provider_bindings
    FOR EACH ROW EXECUTE FUNCTION mail.enforce_provider_binding_mailbox()
  `;
};

const createInitialSchema = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.mailboxes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT mailboxes_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
      description TEXT CHECK (description IS NULL OR char_length(description) <= 2000),
      health TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (health IN (
          'disconnected', 'verifying', 'bootstrapping', 'active', 'auth_required',
          'degraded', 'reconnecting', 'connection_required', 'paused'
        )),
      health_reason TEXT CHECK (health_reason IS NULL OR char_length(health_reason) <= 1000),
      sync_enabled BOOLEAN NOT NULL DEFAULT true,
      search_backend TEXT NOT NULL DEFAULT 'native' CHECK (search_backend IN ('native', 'pg_textsearch')),
      created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_by_service_account_id UUID REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    CREATE INDEX mailboxes_active_created_idx
    ON mail.mailboxes (created_at DESC, id DESC)
    WHERE deleted_at IS NULL
  `;

  await db`
    CREATE TABLE mail.mailbox_access (
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (mailbox_id, access_id)
    )
  `;
  await db`CREATE INDEX mailbox_access_access_idx ON mail.mailbox_access (access_id, mailbox_id)`;

  await db`
    CREATE TABLE mail.provider_connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
      username TEXT NOT NULL CHECK (char_length(username) BETWEEN 1 AND 320),
      connector_kind TEXT NOT NULL DEFAULT 'imap_smtp' CHECK (connector_kind = 'imap_smtp'),
      imap_host TEXT NOT NULL CHECK (char_length(imap_host) BETWEEN 1 AND 253),
      imap_port INTEGER NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
      imap_tls_mode TEXT NOT NULL CHECK (imap_tls_mode IN ('implicit', 'starttls')),
      smtp_host TEXT NOT NULL CHECK (char_length(smtp_host) BETWEEN 1 AND 253),
      smtp_port INTEGER NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
      smtp_tls_mode TEXT NOT NULL CHECK (smtp_tls_mode IN ('implicit', 'starttls')),
      secret_kind TEXT NOT NULL CHECK (secret_kind IN ('password', 'oauth2')),
      encrypted_secret TEXT CHECK (encrypted_secret IS NULL OR char_length(encrypted_secret) > 0),
      secret_revision INTEGER NOT NULL DEFAULT 1 CHECK (secret_revision > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'revoked')),
      authenticated_principal TEXT,
      capabilities JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
      server_identity JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(server_identity) = 'object'),
      last_verified_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT provider_connections_secret_lifecycle CHECK (
        (status = 'revoked' AND encrypted_secret IS NULL) OR
        (status <> 'revoked' AND encrypted_secret IS NOT NULL)
      )
    )
  `;
  await db`
    CREATE UNIQUE INDEX provider_connections_mailbox_active_idx
    ON mail.provider_connections (owner_mailbox_id)
    WHERE status <> 'revoked'
  `;

  await db`
    CREATE TABLE mail.remote_resources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL UNIQUE REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      connector_kind TEXT NOT NULL DEFAULT 'imap_smtp' CHECK (connector_kind = 'imap_smtp'),
      remote_locator JSONB NOT NULL CHECK (jsonb_typeof(remote_locator) = 'object'),
      server_identity JSONB NOT NULL CHECK (jsonb_typeof(server_identity) = 'object'),
      scope_fingerprint TEXT NOT NULL CHECK (char_length(scope_fingerprint) = 64),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'degraded', 'connection_required', 'paused')),
      sync_generation BIGINT NOT NULL DEFAULT 1 CHECK (sync_generation > 0),
      current_fence_token BIGINT NOT NULL DEFAULT 0 CHECK (current_fence_token >= 0),
      discovery_generation BIGINT NOT NULL DEFAULT 0 CHECK (discovery_generation >= 0),
      last_sync_at TIMESTAMPTZ,
      last_discovery_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX remote_resources_status_idx ON mail.remote_resources (status, last_sync_at)`;

  await db`
    CREATE TABLE mail.provider_bindings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      remote_resource_id UUID NOT NULL REFERENCES mail.remote_resources(id) ON DELETE CASCADE,
      connection_id UUID NOT NULL REFERENCES mail.provider_connections(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'verifying', 'active', 'degraded', 'revoked')),
      authenticated_principal TEXT,
      remote_locator JSONB NOT NULL CHECK (jsonb_typeof(remote_locator) = 'object'),
      capabilities JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
      rights JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rights) = 'object'),
      verification_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verification_evidence) = 'object'),
      verified_scope_fingerprint TEXT CHECK (verified_scope_fingerprint IS NULL OR char_length(verified_scope_fingerprint) = 64),
      last_verified_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    CREATE UNIQUE INDEX provider_bindings_resource_current_idx
    ON mail.provider_bindings (remote_resource_id)
    WHERE state <> 'revoked'
  `;
  await db`
    CREATE UNIQUE INDEX provider_bindings_connection_current_idx
    ON mail.provider_bindings (connection_id)
    WHERE state <> 'revoked'
  `;
  await db`CREATE INDEX provider_bindings_resource_state_idx ON mail.provider_bindings (remote_resource_id, state, last_verified_at DESC)`;
  await db`CREATE INDEX provider_bindings_connection_idx ON mail.provider_bindings (connection_id, state)`;
  await enforceMailboxOwnedProviderBindings(db);

  await db`
    CREATE TABLE mail.remote_namespaces (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      binding_id UUID NOT NULL REFERENCES mail.provider_bindings(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('personal', 'other_users', 'shared')),
      prefix TEXT NOT NULL,
      delimiter TEXT,
      discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (binding_id, kind, prefix)
    )
  `;

  await db`
    CREATE TABLE mail.folders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT folders_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      remote_resource_id UUID NOT NULL REFERENCES mail.remote_resources(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES mail.folders(id) ON DELETE SET NULL,
      stable_key TEXT NOT NULL CHECK (char_length(stable_key) BETWEEN 1 AND 1000),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 1000),
      role TEXT NOT NULL DEFAULT 'other'
        CHECK (role IN ('inbox', 'sent', 'drafts', 'trash', 'archive', 'junk', 'all', 'other')),
      selectable BOOLEAN NOT NULL DEFAULT true,
      selected_for_sync BOOLEAN NOT NULL DEFAULT true,
      show_in_sidebar BOOLEAN NOT NULL DEFAULT true,
      discovery_generation BIGINT NOT NULL DEFAULT 0 CHECK (discovery_generation >= 0),
      sync_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (sync_status IN ('pending', 'syncing', 'current', 'degraded', 'rebuilding', 'excluded')),
      envelope_cursor JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(envelope_cursor) = 'object'),
      body_cursor JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(body_cursor) = 'object'),
      attachment_cursor JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attachment_cursor) = 'object'),
      last_reconciled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (remote_resource_id, stable_key)
    )
  `;
  await db`CREATE INDEX folders_resource_parent_idx ON mail.folders (remote_resource_id, parent_id, name)`;
  await db`CREATE INDEX folders_sync_idx ON mail.folders (remote_resource_id, sync_status, role) WHERE selected_for_sync`;

  await db`
    CREATE TABLE mail.binding_folder_refs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      binding_id UUID NOT NULL REFERENCES mail.provider_bindings(id) ON DELETE CASCADE,
      folder_id UUID NOT NULL REFERENCES mail.folders(id) ON DELETE CASCADE,
      remote_path TEXT NOT NULL CHECK (char_length(remote_path) BETWEEN 1 AND 4000),
      delimiter TEXT,
      namespace_kind TEXT CHECK (namespace_kind IS NULL OR namespace_kind IN ('personal', 'other_users', 'shared')),
      uid_validity NUMERIC(20, 0) CHECK (uid_validity IS NULL OR uid_validity >= 0),
      highest_modseq NUMERIC(20, 0) CHECK (highest_modseq IS NULL OR highest_modseq >= 0),
      uid_next NUMERIC(20, 0) CHECK (uid_next IS NULL OR uid_next >= 0),
      subscribed BOOLEAN NOT NULL DEFAULT false,
      effective_rights TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      rights_source TEXT NOT NULL DEFAULT 'probe' CHECK (rights_source IN ('acl', 'select', 'probe', 'unknown')),
      last_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (binding_id, folder_id),
      UNIQUE (binding_id, remote_path)
    )
  `;
  await db`CREATE INDEX binding_folder_refs_folder_idx ON mail.binding_folder_refs (folder_id, binding_id)`;

  await db`
    CREATE TABLE mail.message_contents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT message_contents_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      message_id TEXT,
      in_reply_to TEXT,
      reference_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      subject TEXT NOT NULL DEFAULT '',
      internal_date TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ,
      size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
      selected_headers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(selected_headers) = 'object'),
      mime_structure JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mime_structure) = 'object'),
      plain_text TEXT,
      sanitized_html TEXT,
      source_hash TEXT CHECK (source_hash IS NULL OR char_length(source_hash) = 64),
      content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
      hydration_status TEXT NOT NULL DEFAULT 'envelope'
        CHECK (hydration_status IN ('envelope', 'headers', 'body', 'complete', 'failed')),
      hydration_error_code TEXT,
      search_document TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple'::regconfig, coalesce(subject, '')), 'A') ||
        setweight(to_tsvector('simple'::regconfig, coalesce(plain_text, '')), 'B')
      ) STORED,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      hydrated_at TIMESTAMPTZ,
      UNIQUE (mailbox_id, content_hash)
    )
  `;
  await db`CREATE INDEX message_contents_mailbox_date_idx ON mail.message_contents (mailbox_id, internal_date DESC, id DESC)`;
  await db`CREATE INDEX message_contents_message_id_idx ON mail.message_contents (mailbox_id, lower(message_id)) WHERE message_id IS NOT NULL`;
  await db`CREATE INDEX message_contents_search_idx ON mail.message_contents USING GIN (search_document)`;
  await db`CREATE INDEX message_contents_subject_trgm_idx ON mail.message_contents USING GIN (subject gin_trgm_ops)`;

  await db`
    CREATE TABLE mail.message_addresses (
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc', 'bcc')),
      position INTEGER NOT NULL CHECK (position >= 0),
      display_name TEXT,
      email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
      normalized_email TEXT NOT NULL CHECK (normalized_email = lower(normalized_email)),
      PRIMARY KEY (message_id, role, position)
    )
  `;
  await db`CREATE INDEX message_addresses_lookup_idx ON mail.message_addresses (normalized_email, role, message_id)`;
  await db`CREATE INDEX message_addresses_trgm_idx ON mail.message_addresses USING GIN (normalized_email gin_trgm_ops)`;

  await db`
    CREATE TABLE mail.message_part_blobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content_hash TEXT NOT NULL UNIQUE CHECK (char_length(content_hash) = 64),
      byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
      chunk_size INTEGER NOT NULL DEFAULT 1048576 CHECK (chunk_size BETWEEN 65536 AND 4194304),
      chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
      complete BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    )
  `;

  await db`
    CREATE TABLE mail.message_part_chunks (
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      bytes BYTEA NOT NULL CHECK (octet_length(bytes) <= 4194304),
      PRIMARY KEY (blob_id, position)
    )
  `;

  await db`
    CREATE TABLE mail.message_parts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      part_path TEXT NOT NULL CHECK (char_length(part_path) BETWEEN 1 AND 200),
      content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
      charset TEXT,
      transfer_encoding TEXT,
      disposition TEXT,
      content_id TEXT,
      filename TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
      blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      hydration_status TEXT NOT NULL DEFAULT 'pending' CHECK (hydration_status IN ('pending', 'hydrating', 'complete', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (message_id, part_path)
    )
  `;
  await db`CREATE INDEX message_parts_message_idx ON mail.message_parts (message_id, part_path)`;
  await db`CREATE INDEX message_parts_blob_idx ON mail.message_parts (blob_id) WHERE blob_id IS NOT NULL`;

  await db`
    CREATE TABLE mail.attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT attachments_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      part_id UUID NOT NULL UNIQUE REFERENCES mail.message_parts(id) ON DELETE CASCADE,
      filename TEXT,
      content_type TEXT NOT NULL,
      disposition TEXT,
      content_id TEXT,
      checksum TEXT CHECK (checksum IS NULL OR char_length(checksum) = 64),
      size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX attachments_message_idx ON mail.attachments (message_id, id)`;

  await db`
    CREATE TABLE mail.remote_message_refs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      folder_id UUID NOT NULL REFERENCES mail.folders(id) ON DELETE CASCADE,
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      uid_validity NUMERIC(20, 0) NOT NULL CHECK (uid_validity >= 0),
      uid NUMERIC(20, 0) NOT NULL CHECK (uid > 0),
      modseq NUMERIC(20, 0) CHECK (modseq IS NULL OR modseq >= 0),
      connector_ref JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(connector_ref) = 'object'),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      stale_at TIMESTAMPTZ,
      UNIQUE (folder_id, uid_validity, uid)
    )
  `;
  await db`CREATE INDEX remote_message_refs_message_idx ON mail.remote_message_refs (message_id, folder_id)`;
  await db`CREATE INDEX remote_message_refs_folder_scan_idx ON mail.remote_message_refs (folder_id, uid_validity, uid DESC) WHERE stale_at IS NULL`;

  await db`
    CREATE TABLE mail.message_placements (
      remote_message_ref_id UUID PRIMARY KEY REFERENCES mail.remote_message_refs(id) ON DELETE CASCADE,
      folder_id UUID NOT NULL REFERENCES mail.folders(id) ON DELETE CASCADE,
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      flags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      keywords TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      deleted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX message_placements_folder_idx ON mail.message_placements (folder_id, message_id) WHERE deleted_at IS NULL`;
  await db`CREATE INDEX message_placements_message_idx ON mail.message_placements (message_id, folder_id) WHERE deleted_at IS NULL`;
  await db`CREATE INDEX message_placements_flags_idx ON mail.message_placements USING GIN (flags)`;
  await db`CREATE INDEX message_placements_keywords_idx ON mail.message_placements USING GIN (keywords)`;

  await db`
    CREATE TABLE mail.conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT conversations_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      participant_summary TEXT NOT NULL DEFAULT '',
      latest_inbound_at TIMESTAMPTZ,
      latest_outbound_at TIMESTAMPTZ,
      latest_message_at TIMESTAMPTZ NOT NULL,
      assignee_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      work_status TEXT NOT NULL DEFAULT 'needs_action' CHECK (work_status IN ('needs_action', 'waiting', 'done')),
      snoozed_until TIMESTAMPTZ,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX conversations_mailbox_latest_idx ON mail.conversations (mailbox_id, latest_message_at DESC, id DESC)`;
  await db`CREATE INDEX conversations_mailbox_status_idx ON mail.conversations (mailbox_id, work_status, latest_message_at DESC, id DESC)`;

  await db`
    CREATE TABLE mail.conversation_messages (
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      message_id UUID NOT NULL UNIQUE REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      position BIGINT NOT NULL CHECK (position >= 0),
      added_by TEXT NOT NULL DEFAULT 'heuristic' CHECK (added_by IN ('provider', 'headers', 'heuristic', 'manual')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, message_id)
    )
  `;
  await db`CREATE INDEX conversation_messages_order_idx ON mail.conversation_messages (conversation_id, position, message_id)`;

  await db`
    CREATE TABLE mail.sender_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT sender_identities_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL CHECK (char_length(from_address) BETWEEN 3 AND 320),
      reply_to TEXT,
      envelope_sender TEXT,
      automation_policy TEXT NOT NULL DEFAULT 'mailbox' CHECK (automation_policy IN ('disabled', 'mailbox')),
      sent_folder_id UUID REFERENCES mail.folders(id) ON DELETE SET NULL,
      drafts_folder_id UUID REFERENCES mail.folders(id) ON DELETE SET NULL,
      is_default BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'rejected', 'disabled')),
      last_provider_rejection TEXT CHECK (last_provider_rejection IS NULL OR char_length(last_provider_rejection) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, from_address)
    )
  `;
  await db`
    CREATE UNIQUE INDEX sender_identities_default_idx
    ON mail.sender_identities (mailbox_id)
    WHERE is_default AND status <> 'disabled'
  `;

  await db`
    CREATE TABLE mail.sender_identity_bindings (
      sender_identity_id UUID NOT NULL REFERENCES mail.sender_identities(id) ON DELETE CASCADE,
      binding_id UUID NOT NULL REFERENCES mail.provider_bindings(id) ON DELETE CASCADE,
      provider_principal TEXT NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL,
      saves_sent_automatically BOOLEAN NOT NULL DEFAULT false,
      revoked_at TIMESTAMPTZ,
      last_error_code TEXT,
      PRIMARY KEY (sender_identity_id, binding_id)
    )
  `;

  await db`
    CREATE TABLE mail.commands (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('set_flags', 'move', 'copy', 'delete', 'send', 'sync_folder', 'discover_folders')),
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'executing', 'confirmed', 'failed', 'ambiguous', 'reconciled', 'needs_attention')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account', 'workflow', 'system')),
      actor_id UUID,
      initiator_actor_kind TEXT CHECK (initiator_actor_kind IN ('user', 'service_account')),
      initiator_actor_id UUID,
      delegated_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
      request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
      correlation_id TEXT,
      target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object'),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      workflow_execution_generation BIGINT
        CHECK (workflow_execution_generation IS NULL OR workflow_execution_generation > 0),
      credential_id UUID,
      credential_expires_at TIMESTAMPTZ,
      expected_revision BIGINT,
      selected_binding_id UUID REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT,
      rights_snapshot JSONB CHECK (rights_snapshot IS NULL OR jsonb_typeof(rights_snapshot) = 'object'),
      transport_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(transport_metadata) = 'object'),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT commands_actor_shape CHECK (
        (actor_kind = 'system' AND actor_id IS NULL) OR
        (actor_kind <> 'system' AND actor_id IS NOT NULL)
      ),
      CONSTRAINT commands_initiator_actor_check CHECK (
        (initiator_actor_kind IS NULL AND initiator_actor_id IS NULL)
        OR (initiator_actor_kind IN ('user', 'service_account') AND initiator_actor_id IS NOT NULL)
      ),
      UNIQUE (mailbox_id, idempotency_key)
    )
  `;
  await db`CREATE INDEX commands_dispatch_idx ON mail.commands (state, created_at, id) WHERE state IN ('queued', 'executing', 'ambiguous')`;
  await db`CREATE INDEX commands_mailbox_idx ON mail.commands (mailbox_id, created_at DESC, id DESC)`;
  await db`CREATE INDEX commands_binding_idx ON mail.commands (selected_binding_id, state) WHERE selected_binding_id IS NOT NULL`;

  await db`
    CREATE TABLE mail.drafts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT drafts_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES mail.conversations(id) ON DELETE SET NULL,
      sender_identity_id UUID NOT NULL REFERENCES mail.sender_identities(id) ON DELETE RESTRICT,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'service_account')),
      author_id UUID NOT NULL,
      to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(to_addresses) = 'array'),
      cc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(cc_addresses) = 'array'),
      bcc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(bcc_addresses) = 'array'),
      subject TEXT NOT NULL DEFAULT '',
      body_markdown TEXT NOT NULL DEFAULT '',
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'scheduled', 'sending', 'sent', 'discarded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX drafts_mailbox_state_idx ON mail.drafts (mailbox_id, state, updated_at DESC)`;

  await db`
    CREATE TABLE mail.outbox_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT outbox_submissions_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      draft_id UUID NOT NULL REFERENCES mail.drafts(id) ON DELETE RESTRICT,
      command_id UUID NOT NULL UNIQUE REFERENCES mail.commands(id) ON DELETE RESTRICT,
      sender_identity_id UUID NOT NULL REFERENCES mail.sender_identities(id) ON DELETE RESTRICT,
      selected_binding_id UUID NOT NULL REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT,
      stable_message_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled', 'undo_window', 'sending', 'accepted', 'sent_sync_pending', 'sent', 'failed', 'unknown', 'reconciled_accepted', 'reconciled_unsent', 'needs_attention')),
      scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      undo_until TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      provider_response JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_response) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, stable_message_id)
    )
  `;
  await db`CREATE INDEX outbox_ready_idx ON mail.outbox_submissions (state, scheduled_at, id) WHERE state IN ('scheduled', 'undo_window', 'unknown', 'sent_sync_pending')`;

  await db`
    CREATE TABLE mail.sync_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      remote_resource_id UUID NOT NULL REFERENCES mail.remote_resources(id) ON DELETE CASCADE,
      binding_id UUID NOT NULL REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT,
      fence_token BIGINT NOT NULL CHECK (fence_token > 0),
      generation BIGINT NOT NULL CHECK (generation > 0),
      kind TEXT NOT NULL CHECK (kind IN ('discovery', 'incremental', 'backfill', 'reconcile', 'body_hydration', 'attachment_hydration')),
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'completed', 'failed', 'cancelled', 'stale_fence')),
      cursor_before JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor_before) = 'object'),
      cursor_after JSONB CHECK (cursor_after IS NULL OR jsonb_typeof(cursor_after) = 'object'),
      stats JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(stats) = 'object'),
      error_code TEXT,
      error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 1000),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )
  `;
  await db`CREATE INDEX sync_runs_resource_idx ON mail.sync_runs (remote_resource_id, started_at DESC)`;
  await db`CREATE INDEX sync_runs_running_idx ON mail.sync_runs (remote_resource_id, state) WHERE state = 'running'`;

  await db`
    CREATE TABLE mail.activity_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID REFERENCES mail.conversations(id) ON DELETE SET NULL,
      command_id UUID REFERENCES mail.commands(id) ON DELETE SET NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account', 'workflow', 'system')),
      actor_id UUID,
      action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 200),
      outcome TEXT NOT NULL CHECK (outcome IN ('requested', 'confirmed', 'failed', 'reconciled')),
      target_type TEXT,
      target_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX activity_events_mailbox_idx ON mail.activity_events (mailbox_id, created_at DESC, id DESC)`;
  await db`CREATE INDEX activity_events_conversation_idx ON mail.activity_events (conversation_id, created_at DESC, id DESC) WHERE conversation_id IS NOT NULL`;

  await db`
    CREATE OR REPLACE FUNCTION mail.touch_updated_at()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$
  `;

  for (const table of [
    "mailboxes",
    "provider_connections",
    "remote_resources",
    "provider_bindings",
    "folders",
    "binding_folder_refs",
    "conversations",
    "sender_identities",
    "commands",
    "drafts",
    "outbox_submissions",
  ]) {
    await db.unsafe(`
      CREATE TRIGGER ${table}_touch_updated_at
      BEFORE UPDATE ON mail.${table}
      FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
    `);
  }
};

const addHydrationClaims = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.message_contents
    ADD COLUMN hydration_claim_id UUID,
    ADD COLUMN hydration_claimed_at TIMESTAMPTZ
  `;
  await db`
    ALTER TABLE mail.message_contents
    DROP CONSTRAINT message_contents_hydration_status_check
  `;
  await db`
    ALTER TABLE mail.message_contents
    ADD CONSTRAINT message_contents_hydration_status_check
    CHECK (hydration_status IN ('envelope', 'headers', 'hydrating', 'body', 'complete', 'failed'))
  `;
  await db`
    ALTER TABLE mail.message_contents
    ADD CONSTRAINT message_contents_hydration_claim_check
    CHECK (
      (hydration_status = 'hydrating' AND hydration_claim_id IS NOT NULL AND hydration_claimed_at IS NOT NULL)
      OR
      (hydration_status <> 'hydrating' AND hydration_claim_id IS NULL AND hydration_claimed_at IS NULL)
    )
  `;
  await db`
    CREATE INDEX message_contents_hydration_queue_idx
    ON mail.message_contents (mailbox_id, hydration_status, internal_date DESC, id)
    WHERE hydration_status <> 'complete'
  `;
};

const addThreadingProjection = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.message_contents
    ADD COLUMN provider_thread_id TEXT,
    ADD COLUMN normalized_subject TEXT NOT NULL DEFAULT ''
  `;
  await db`
    CREATE INDEX message_contents_provider_thread_idx
    ON mail.message_contents (mailbox_id, provider_thread_id, internal_date DESC)
    WHERE provider_thread_id IS NOT NULL
  `;
  await db`
    CREATE INDEX message_contents_subject_thread_idx
    ON mail.message_contents (mailbox_id, normalized_subject, internal_date DESC)
    WHERE normalized_subject <> ''
  `;
};

const addFieldSearchDocuments = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.message_contents
    ADD COLUMN subject_search_document TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, coalesce(subject, ''))
    ) STORED,
    ADD COLUMN body_search_document TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, coalesce(plain_text, ''))
    ) STORED
  `;
  await db`CREATE INDEX message_contents_subject_search_idx ON mail.message_contents USING GIN (subject_search_document)`;
  await db`CREATE INDEX message_contents_body_search_idx ON mail.message_contents USING GIN (body_search_document)`;
};

const addOptionalBm25Index = async (db: SqlClient): Promise<void> => {
  await db.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') THEN
        BEGIN
          EXECUTE $index$
            CREATE INDEX IF NOT EXISTS message_contents_bm25_idx
            ON mail.message_contents USING bm25 (
              (COALESCE(subject, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(plain_text, ''))
            ) WITH (text_config='simple')
          $index$;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'Optional Mail BM25 index unavailable: %', SQLERRM;
        END;
      END IF;
    END
    $$
  `);
};

const addDurableDraftSnapshots = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
    ADD COLUMN body_format TEXT NOT NULL DEFAULT 'markdown'
      CHECK (body_format IN ('plain', 'markdown'))
  `;
  await db`
    ALTER TABLE mail.outbox_submissions
    ADD COLUMN draft_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
      CHECK (jsonb_typeof(draft_snapshot) = 'object'),
    ADD COLUMN mime_blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT
  `;
};

const addDurableCommandExecution = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.commands
    ADD COLUMN access_subject_kind TEXT,
    ADD COLUMN access_subject_id UUID,
    ADD COLUMN credential_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::text[]
  `;
  await db`
    UPDATE mail.commands
    SET
      access_subject_kind = CASE
        WHEN actor_kind = 'user' THEN 'user'
        WHEN actor_kind = 'service_account' AND delegated_user_id IS NOT NULL THEN 'user'
        WHEN actor_kind = 'service_account' THEN 'service_account'
        ELSE 'system'
      END,
      access_subject_id = CASE
        WHEN actor_kind = 'user' THEN actor_id
        WHEN actor_kind = 'service_account' AND delegated_user_id IS NOT NULL THEN delegated_user_id
        WHEN actor_kind = 'service_account' THEN actor_id
        ELSE NULL
      END
  `;
  await db`
    ALTER TABLE mail.commands
    ALTER COLUMN access_subject_kind SET NOT NULL,
    DROP CONSTRAINT commands_state_check,
    ADD CONSTRAINT commands_state_check CHECK (
      state IN ('queued', 'executing', 'confirmed', 'failed', 'cancelled', 'ambiguous', 'reconciled', 'needs_attention')
    ),
    ADD CONSTRAINT commands_access_subject_check CHECK (
      (access_subject_kind = 'system' AND access_subject_id IS NULL)
      OR
      (access_subject_kind IN ('user', 'service_account') AND access_subject_id IS NOT NULL)
    )
  `;
  await db`
    ALTER TABLE mail.outbox_submissions
    ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    ADD COLUMN last_error_code TEXT,
    ADD COLUMN last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
    DROP CONSTRAINT outbox_submissions_state_check,
    ADD CONSTRAINT outbox_submissions_state_check CHECK (
      state IN (
        'scheduled', 'undo_window', 'sending', 'accepted', 'sent_sync_pending', 'sent', 'failed',
        'cancelled', 'unknown', 'reconciled_accepted', 'reconciled_unsent', 'needs_attention'
      )
    )
  `;
  await db`
    CREATE INDEX commands_stale_execution_idx
    ON mail.commands (started_at, id)
    WHERE state = 'executing'
  `;
};

const addBoundedHydrationRetries = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.message_contents
    ADD COLUMN hydration_attempt INTEGER NOT NULL DEFAULT 0 CHECK (hydration_attempt >= 0)
  `;
  await db`DROP INDEX mail.message_contents_hydration_queue_idx`;
  await db`
    CREATE INDEX message_contents_hydration_queue_idx
    ON mail.message_contents (mailbox_id, hydration_status, internal_date DESC, id)
    WHERE hydration_status IN ('envelope', 'headers', 'body')
       OR (hydration_status = 'failed' AND hydration_attempt < 5)
  `;
};

const addChunkedBodySearch = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.message_search_chunks (
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      search_document TSVECTOR NOT NULL,
      PRIMARY KEY (message_id, position)
    )
  `;
  await db`
    CREATE INDEX message_search_chunks_document_idx
    ON mail.message_search_chunks USING GIN (search_document)
  `;
  const stride = SEARCH_CHUNK_CHARACTERS - SEARCH_CHUNK_OVERLAP_CHARACTERS;
  await db.unsafe(`
    INSERT INTO mail.message_search_chunks (message_id, position, search_document)
    SELECT
      mc.id,
      chunk.position,
      to_tsvector(
        'simple'::regconfig,
        substring(mc.plain_text FROM chunk.position * ${stride} + 1 FOR ${SEARCH_CHUNK_CHARACTERS})
      )
    FROM mail.message_contents mc
    CROSS JOIN LATERAL generate_series(
      0,
      (char_length(mc.plain_text) - 1) / ${stride}
    ) AS chunk(position)
    WHERE mc.plain_text IS NOT NULL AND mc.plain_text <> ''
  `);
  await db`DROP INDEX mail.message_contents_search_idx`;
  await db`DROP INDEX mail.message_contents_body_search_idx`;
  await db`
    ALTER TABLE mail.message_contents
    DROP COLUMN search_document,
    DROP COLUMN body_search_document
  `;
};

const addSearchBackendModes = async (db: SqlClient): Promise<void> => {
  await db`
    UPDATE mail.mailboxes
    SET search_backend = 'postgres'
    WHERE search_backend = 'native'
  `;
  await db`
    ALTER TABLE mail.mailboxes
    DROP CONSTRAINT mailboxes_search_backend_check,
    ALTER COLUMN search_backend SET DEFAULT 'auto',
    ADD CONSTRAINT mailboxes_search_backend_check
      CHECK (search_backend IN ('auto', 'postgres', 'pg_textsearch'))
  `;
};

const addCredentialRevisionBindings = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.provider_bindings
    ADD COLUMN verified_secret_revision INTEGER NOT NULL DEFAULT 1
      CHECK (verified_secret_revision > 0)
  `;
  await db`
    UPDATE mail.provider_bindings binding
    SET verified_secret_revision = connection.secret_revision
    FROM mail.provider_connections connection
    WHERE connection.id = binding.connection_id
  `;
  await db`
    ALTER TABLE mail.sender_identity_bindings
    ADD COLUMN verified_secret_revision INTEGER NOT NULL DEFAULT 1
      CHECK (verified_secret_revision > 0)
  `;
  await db`
    UPDATE mail.sender_identity_bindings sender_binding
    SET verified_secret_revision = connection.secret_revision
    FROM mail.provider_bindings binding
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE binding.id = sender_binding.binding_id
  `;
  await db`
    ALTER TABLE mail.commands
    ADD COLUMN selected_secret_revision INTEGER
      CHECK (selected_secret_revision IS NULL OR selected_secret_revision > 0)
  `;
  await db`
    UPDATE mail.commands command
    SET selected_secret_revision = binding.verified_secret_revision
    FROM mail.provider_bindings binding
    WHERE binding.id = command.selected_binding_id
  `;
  await db`
    ALTER TABLE mail.commands
    ADD CONSTRAINT commands_selected_credential_check CHECK (
      (selected_binding_id IS NULL AND selected_secret_revision IS NULL)
      OR
      (selected_binding_id IS NOT NULL AND selected_secret_revision IS NOT NULL)
    )
  `;
};

const addCommandWorkerHeartbeats = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.commands
    ADD COLUMN worker_heartbeat_at TIMESTAMPTZ
  `;
  await db`DROP INDEX mail.commands_stale_execution_idx`;
  await db`
    CREATE INDEX commands_stale_execution_idx
    ON mail.commands (COALESCE(worker_heartbeat_at, started_at), id)
    WHERE state = 'executing'
  `;
};

const addLifecycleControlPlane = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.folders
    ADD COLUMN discovery_state TEXT NOT NULL DEFAULT 'active'
      CHECK (discovery_state IN ('active', 'missing', 'ambiguous')),
    ADD COLUMN missing_since TIMESTAMPTZ
  `;
  await db`
    ALTER TABLE mail.binding_folder_refs
    ADD COLUMN last_seen_generation BIGINT NOT NULL DEFAULT 0 CHECK (last_seen_generation >= 0),
    ADD COLUMN missing_since TIMESTAMPTZ
  `;
  await db`
    UPDATE mail.binding_folder_refs ref
    SET last_seen_generation = folder.discovery_generation
    FROM mail.folders folder
    WHERE folder.id = ref.folder_id
  `;
  await db`
    ALTER TABLE mail.commands
    ADD COLUMN result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
    DROP CONSTRAINT commands_kind_check,
    ADD CONSTRAINT commands_kind_check CHECK (
      kind IN (
        'set_flags', 'move', 'copy', 'delete', 'send',
        'sync_mailbox', 'sync_folder', 'discover_folders', 'verify_binding', 'rebuild_folder', 'hydrate_missing'
      )
    )
  `;
  await db`
    CREATE INDEX binding_folder_refs_discovery_idx
    ON mail.binding_folder_refs (binding_id, last_seen_generation, folder_id)
  `;
  await db`
    CREATE INDEX folders_discovery_state_idx
    ON mail.folders (remote_resource_id, discovery_state, role, id)
  `;
};

const addProviderBackedOperations = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.folder_role_overrides (
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('sent', 'drafts', 'trash', 'archive', 'junk')),
      folder_id UUID NOT NULL REFERENCES mail.folders(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (mailbox_id, role),
      UNIQUE (mailbox_id, folder_id)
    )
  `;
  await db`
    CREATE TRIGGER folder_role_overrides_touch_updated_at
    BEFORE UPDATE ON mail.folder_role_overrides
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
  await db`
    CREATE TABLE mail.draft_attachments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT draft_attachments_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      draft_id UUID NOT NULL REFERENCES mail.drafts(id) ON DELETE CASCADE,
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
      content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
      byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
      content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      removed_at TIMESTAMPTZ,
      UNIQUE (draft_id, position)
    )
  `;
  await db`CREATE INDEX draft_attachments_draft_idx ON mail.draft_attachments (draft_id, position, id)`;
  await db`
    ALTER TABLE mail.commands
    DROP CONSTRAINT commands_kind_check,
    ADD CONSTRAINT commands_kind_check CHECK (
      kind IN (
        'set_flags', 'change_message_state', 'move', 'copy', 'delete',
        'create_folder', 'rename_folder', 'delete_folder', 'set_folder_subscription', 'send',
        'sync_mailbox', 'sync_folder', 'discover_folders', 'verify_binding', 'rebuild_folder', 'hydrate_missing'
      )
    )
  `;
};

const hardenProviderBackedOperations = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.draft_attachments ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`;
};

const addConversationCollaboration = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.conversation_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT conversation_comments_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'service_account')),
      author_id UUID NOT NULL,
      body_markdown TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 50000),
      parent_comment_id UUID REFERENCES mail.conversation_comments(id) ON DELETE SET NULL,
      referenced_message_id UUID REFERENCES mail.message_contents(id) ON DELETE SET NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`CREATE INDEX conversation_comments_conversation_idx ON mail.conversation_comments (conversation_id, created_at, id)`;
  await db`
    CREATE TRIGGER conversation_comments_touch_updated_at
    BEFORE UPDATE ON mail.conversation_comments
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;

  await db`
    CREATE TABLE mail.conversation_comment_versions (
      comment_id UUID NOT NULL REFERENCES mail.conversation_comments(id) ON DELETE CASCADE,
      revision BIGINT NOT NULL CHECK (revision > 0),
      body_markdown TEXT NOT NULL CHECK (char_length(body_markdown) BETWEEN 1 AND 50000),
      editor_kind TEXT NOT NULL CHECK (editor_kind IN ('user', 'service_account')),
      editor_id UUID NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, revision)
    )
  `;

  await db`CREATE INDEX conversations_mailbox_assignee_idx ON mail.conversations (mailbox_id, assignee_user_id, latest_message_at DESC, id DESC)`;
  await db`CREATE INDEX conversations_mailbox_snoozed_idx ON mail.conversations (mailbox_id, snoozed_until, id) WHERE snoozed_until IS NOT NULL`;
  await db`CREATE INDEX conversations_mailbox_activity_idx ON mail.conversations (mailbox_id, updated_at DESC, id DESC)`;
};

const addConversationThreadOverrides = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.conversation_thread_overrides (
      message_id UUID PRIMARY KEY REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      reason TEXT NOT NULL CHECK (reason IN ('merge', 'split')),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    CREATE INDEX conversation_thread_overrides_conversation_idx
    ON mail.conversation_thread_overrides (conversation_id, message_id)
  `;
};

const addCollaborationOperations = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.conversation_reminders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT conversation_reminders_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      due_at TIMESTAMPTZ NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'canceled')),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      canceled_at TIMESTAMPTZ,
      UNIQUE (conversation_id, user_id)
    )
  `;
  await db`
    CREATE INDEX conversation_reminders_due_idx
    ON mail.conversation_reminders (due_at, id)
    WHERE state = 'pending'
  `;

  await db`
    CREATE TABLE mail.collaboration_notification_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL CHECK (kind = 'reminder'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      recipient_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      source_id UUID NOT NULL,
      source_short_id TEXT NOT NULL
        CONSTRAINT collaboration_notification_deliveries_source_short_id_format
        CHECK (source_short_id ~ '^[0-9A-Za-z]{6}$'),
      source_revision BIGINT NOT NULL CHECK (source_revision > 0),
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'skipped')),
      available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      claim_id UUID,
      claimed_at TIMESTAMPTZ,
      last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      CONSTRAINT collaboration_notification_claim_check CHECK (
        (state = 'sending' AND claim_id IS NOT NULL AND claimed_at IS NOT NULL)
        OR
        (state <> 'sending' AND claim_id IS NULL AND claimed_at IS NULL)
      ),
      UNIQUE (kind, source_id, source_revision, recipient_user_id)
    )
  `;
  await db`
    CREATE INDEX collaboration_notification_dispatch_idx
    ON mail.collaboration_notification_deliveries (available_at, created_at, id)
    WHERE state = 'pending'
  `;
  await db`
    CREATE INDEX collaboration_notification_stale_claim_idx
    ON mail.collaboration_notification_deliveries (claimed_at, id)
    WHERE state = 'sending'
  `;

  await db`
    CREATE TABLE mail.saved_conversation_views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT saved_conversation_views_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('private', 'mailbox')),
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      filter JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter) = 'object'),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'service_account')),
      created_by_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT saved_conversation_views_owner_check CHECK (
        (scope = 'private' AND owner_user_id IS NOT NULL)
        OR
        (scope = 'mailbox' AND owner_user_id IS NULL)
      )
    )
  `;
  await db`
    CREATE UNIQUE INDEX saved_conversation_views_private_name_idx
    ON mail.saved_conversation_views (mailbox_id, owner_user_id, lower(name))
    WHERE scope = 'private'
  `;
  await db`
    CREATE UNIQUE INDEX saved_conversation_views_mailbox_name_idx
    ON mail.saved_conversation_views (mailbox_id, lower(name))
    WHERE scope = 'mailbox'
  `;
  await db`
    CREATE INDEX saved_conversation_views_list_idx
    ON mail.saved_conversation_views (mailbox_id, scope, owner_user_id, name, id)
  `;

  for (const table of ["conversation_reminders", "collaboration_notification_deliveries", "saved_conversation_views"]) {
    await db.unsafe(`
      CREATE TRIGGER ${table}_touch_updated_at
      BEFORE UPDATE ON mail.${table}
      FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
    `);
  }
};

const addVerifiedSourceIdentityLookup = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE INDEX IF NOT EXISTS message_contents_source_identity_idx
    ON mail.message_contents (mailbox_id, source_hash, created_at, id)
    WHERE source_hash IS NOT NULL AND hydration_status = 'complete'
  `;
};

const fenceWorkflowProviderEffects = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.commands
      ADD COLUMN provider_effect_started_at TIMESTAMPTZ,
      ADD COLUMN provider_effect_attempt INTEGER,
      ADD CONSTRAINT commands_provider_effect_check CHECK (
        (provider_effect_started_at IS NULL AND provider_effect_attempt IS NULL)
        OR (provider_effect_started_at IS NOT NULL AND provider_effect_attempt IS NOT NULL AND provider_effect_attempt > 0)
      )
  `;
};

const addDurableDraftContinuity = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
      ADD COLUMN intent TEXT NOT NULL DEFAULT 'new'
        CHECK (intent IN ('new', 'reply', 'reply_all', 'forward')),
      ADD COLUMN source_message_id UUID REFERENCES mail.message_contents(id) ON DELETE RESTRICT,
      ADD COLUMN last_editor_kind TEXT CHECK (last_editor_kind IN ('user', 'service_account')),
      ADD COLUMN last_editor_id UUID
  `;
  await db`
    UPDATE mail.drafts draft
    SET
      intent = CASE WHEN draft.conversation_id IS NULL THEN 'new' ELSE 'reply' END,
      source_message_id = CASE
        WHEN draft.conversation_id IS NULL THEN NULL
        ELSE (
          SELECT conversation_message.message_id
          FROM mail.conversation_messages conversation_message
          JOIN mail.message_contents message ON message.id = conversation_message.message_id
          WHERE conversation_message.conversation_id = draft.conversation_id
          ORDER BY conversation_message.position DESC, message.internal_date DESC, message.id DESC
          LIMIT 1
        )
      END,
      last_editor_kind = draft.author_kind,
      last_editor_id = draft.author_id
  `;
  await db`
    UPDATE mail.drafts
    SET conversation_id = NULL, intent = 'new'
    WHERE conversation_id IS NOT NULL AND source_message_id IS NULL
  `;
  await db`
    ALTER TABLE mail.drafts
      ALTER COLUMN last_editor_kind SET NOT NULL,
      ALTER COLUMN last_editor_id SET NOT NULL,
      ADD CONSTRAINT drafts_intent_source_check CHECK (
        (intent = 'new' AND conversation_id IS NULL AND source_message_id IS NULL)
        OR (intent <> 'new' AND conversation_id IS NOT NULL AND source_message_id IS NOT NULL)
      )
  `;
  await db`
    CREATE TABLE mail.draft_recovery_copies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      draft_id UUID NOT NULL REFERENCES mail.drafts(id) ON DELETE CASCADE,
      base_revision BIGINT NOT NULL CHECK (base_revision > 0),
      content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      creator_kind TEXT NOT NULL CHECK (creator_kind IN ('user', 'service_account')),
      creator_id UUID NOT NULL,
      restored_at TIMESTAMPTZ,
      restored_by_kind TEXT CHECK (restored_by_kind IN ('user', 'service_account')),
      restored_by_id UUID,
      resulting_revision BIGINT CHECK (resulting_revision IS NULL OR resulting_revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT draft_recovery_restore_check CHECK (
        (restored_at IS NULL AND restored_by_kind IS NULL AND restored_by_id IS NULL AND resulting_revision IS NULL)
        OR (restored_at IS NOT NULL AND restored_by_kind IS NOT NULL AND restored_by_id IS NOT NULL AND resulting_revision IS NOT NULL)
      ),
      UNIQUE (draft_id, base_revision, creator_kind, creator_id, content_hash)
    )
  `;
  await db`
    CREATE INDEX draft_recovery_copies_draft_idx
    ON mail.draft_recovery_copies (draft_id, created_at DESC, id DESC)
  `;

  await db`
    CREATE TABLE mail.draft_attachment_uploads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      draft_id UUID NOT NULL REFERENCES mail.drafts(id) ON DELETE CASCADE,
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
      content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
      byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
      received_bytes BIGINT NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= byte_length),
      next_position INTEGER NOT NULL DEFAULT 0 CHECK (next_position >= 0),
      state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'uploaded', 'attached', 'cancelled')),
      creator_kind TEXT NOT NULL CHECK (creator_kind IN ('user', 'service_account')),
      creator_id UUID NOT NULL,
      attachment_id UUID UNIQUE REFERENCES mail.draft_attachments(id) ON DELETE SET NULL,
      finalized_revision BIGINT CHECK (finalized_revision IS NULL OR finalized_revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT draft_attachment_upload_state_check CHECK (
        (state = 'attached' AND attachment_id IS NOT NULL AND finalized_revision IS NOT NULL)
        OR (state <> 'attached' AND attachment_id IS NULL AND finalized_revision IS NULL)
      )
    )
  `;
  await db`
    CREATE INDEX draft_attachment_uploads_active_idx
    ON mail.draft_attachment_uploads (updated_at, id)
    WHERE state IN ('uploading', 'uploaded')
  `;
  await db`
    CREATE TRIGGER draft_attachment_uploads_touch_updated_at
    BEFORE UPDATE ON mail.draft_attachment_uploads
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const hardenDurableDraftContinuity = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.draft_attachment_uploads
      DROP CONSTRAINT draft_attachment_uploads_blob_id_fkey,
      ALTER COLUMN blob_id DROP NOT NULL,
      ADD CONSTRAINT draft_attachment_uploads_blob_id_fkey
        FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE SET NULL,
      ADD CONSTRAINT draft_attachment_uploads_blob_state_check CHECK (
        (state = 'cancelled' AND blob_id IS NULL)
        OR (state <> 'cancelled' AND blob_id IS NOT NULL)
      ),
      ADD CONSTRAINT draft_attachment_uploads_received_state_check CHECK (
        state IN ('uploading', 'cancelled')
        OR received_bytes = byte_length
      )
  `;
  await db`
    CREATE INDEX drafts_source_message_idx
    ON mail.drafts (source_message_id)
    WHERE source_message_id IS NOT NULL
  `;
  await db`
    CREATE INDEX draft_recovery_copies_unresolved_idx
    ON mail.draft_recovery_copies (draft_id, created_at DESC, id DESC)
    WHERE restored_at IS NULL
  `;
  await db`
    CREATE INDEX draft_attachment_uploads_draft_idx
    ON mail.draft_attachment_uploads (draft_id, created_at, id)
  `;
};

const hardCutMailboxOwnedConnections = async (db: SqlClient): Promise<void> => {
  await db`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'mail' AND table_name = 'mailboxes' AND column_name = 'connection_policy'
      ) THEN
        IF EXISTS (SELECT 1 FROM mail.mailboxes WHERE connection_policy <> 'shared_connection') THEN
          RAISE EXCEPTION 'Mail personal provider accounts must be removed before applying the mailbox-owned connection cut';
        END IF;
        ALTER TABLE mail.mailboxes DROP COLUMN connection_policy;
      END IF;
    END
    $$
  `;

  await db`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'mail' AND table_name = 'provider_connections' AND column_name = 'owner_user_id'
      ) THEN
        IF EXISTS (SELECT 1 FROM mail.provider_connections WHERE owner_mailbox_id IS NULL) THEN
          RAISE EXCEPTION 'Mail user-owned provider connections must be removed before applying the mailbox-owned connection cut';
        END IF;
        DROP INDEX IF EXISTS mail.provider_connections_user_name_idx;
        DROP INDEX IF EXISTS mail.provider_connections_service_account_name_idx;
        ALTER TABLE mail.provider_connections
          DROP CONSTRAINT IF EXISTS provider_connections_one_owner,
          DROP COLUMN owner_user_id,
          DROP COLUMN owner_service_account_id,
          ALTER COLUMN owner_mailbox_id SET NOT NULL;
      END IF;
    END
    $$
  `;

  await db`DROP INDEX IF EXISTS mail.provider_connections_mailbox_name_idx`;
  await db`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT owner_mailbox_id
        FROM mail.provider_connections
        WHERE status <> 'revoked'
        GROUP BY owner_mailbox_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Mail mailboxes with multiple active provider connections must be resolved before applying the hard cut';
      END IF;
    END
    $$
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_mailbox_active_idx
    ON mail.provider_connections (owner_mailbox_id)
    WHERE status <> 'revoked'
  `;

  await db`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT remote_resource_id
        FROM mail.provider_bindings
        WHERE state <> 'revoked'
        GROUP BY remote_resource_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Mail remote resources with multiple provider bindings must be resolved before applying the hard cut';
      END IF;
    END
    $$
  `;
  await db`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT connection_id
        FROM mail.provider_bindings
        WHERE state <> 'revoked'
        GROUP BY connection_id
        HAVING count(*) > 1
      ) THEN
        RAISE EXCEPTION 'Mail connections with multiple current provider bindings must be resolved before applying the hard cut';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM mail.provider_bindings binding
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        WHERE binding.state <> 'revoked'
          AND connection.owner_mailbox_id <> resource.mailbox_id
      ) THEN
        RAISE EXCEPTION 'Mail provider bindings must connect resources and credentials owned by the same mailbox';
      END IF;
    END
    $$
  `;
  await db`ALTER TABLE mail.provider_bindings DROP CONSTRAINT IF EXISTS provider_bindings_remote_resource_id_connection_id_key`;
  await db`DROP INDEX IF EXISTS mail.provider_bindings_resource_unique_idx`;
  await db`DROP INDEX IF EXISTS mail.provider_bindings_connection_unique_idx`;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_bindings_resource_current_idx
    ON mail.provider_bindings (remote_resource_id)
    WHERE state <> 'revoked'
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_bindings_connection_current_idx
    ON mail.provider_bindings (connection_id)
    WHERE state <> 'revoked'
  `;
  await enforceMailboxOwnedProviderBindings(db);

  await db`UPDATE mail.sender_identities SET automation_policy = 'disabled' WHERE automation_policy = 'pool'`;
  await db`ALTER TABLE mail.sender_identities DROP COLUMN IF EXISTS interactive_policy`;
  await db`ALTER TABLE mail.sender_identities DROP CONSTRAINT IF EXISTS sender_identities_automation_policy_check`;
  await db`
    ALTER TABLE mail.sender_identities
    ADD CONSTRAINT sender_identities_automation_policy_check CHECK (automation_policy IN ('disabled', 'mailbox'))
  `;
};

const installSearchReferenceCompatibility = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE OR REPLACE FUNCTION mail.search_reference_matches(
      searched_message_id UUID,
      searched_query TEXT,
      searched_match TEXT
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql
    STABLE
    AS $$
    DECLARE
      matched BOOLEAN;
    BEGIN
      IF to_regclass('mail.conversation_references') IS NULL THEN
        RETURN false;
      END IF;
      EXECUTE $query$
        SELECT EXISTS (
          SELECT 1
          FROM mail.conversation_messages link
          JOIN mail.conversation_references reference_row
            ON reference_row.conversation_id = link.conversation_id
          WHERE link.message_id = $1
            AND CASE
              WHEN $3 = 'exact' THEN lower(btrim(COALESCE(to_jsonb(reference_row)->>'value', ''))) = lower(btrim($2))
              WHEN $3 = 'words' THEN NOT EXISTS (
                SELECT 1
                FROM regexp_split_to_table(lower(btrim($2)), '\\s+') token
                WHERE strpos(lower(COALESCE(to_jsonb(reference_row)->>'value', '')), token) = 0
              )
              ELSE strpos(lower(COALESCE(to_jsonb(reference_row)->>'value', '')), lower($2)) > 0
            END
        )
      $query$ INTO matched USING searched_message_id, searched_query, searched_match;
      RETURN matched;
    END;
    $$
  `;
};

const addStructuredSearchAndLocalTags = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.conversations
    ADD CONSTRAINT conversations_id_mailbox_unique UNIQUE (id, mailbox_id)
  `;
  await db`
    CREATE TABLE mail.local_tags (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT local_tags_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 80
      ),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, normalized_name),
      UNIQUE (id, mailbox_id)
    )
  `;
  await db`CREATE INDEX local_tags_mailbox_name_idx ON mail.local_tags (mailbox_id, normalized_name, id)`;
  await db`
    CREATE TRIGGER local_tags_touch_updated_at
    BEFORE UPDATE ON mail.local_tags
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
  await db`
    CREATE TABLE mail.conversation_local_tags (
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL,
      tag_id UUID NOT NULL,
      assigned_by_actor_kind TEXT NOT NULL CHECK (assigned_by_actor_kind IN ('user', 'service_account')),
      assigned_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, tag_id),
      FOREIGN KEY (conversation_id, mailbox_id)
        REFERENCES mail.conversations(id, mailbox_id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id, mailbox_id)
        REFERENCES mail.local_tags(id, mailbox_id) ON DELETE CASCADE
    )
  `;
  await db`CREATE INDEX conversation_local_tags_tag_idx ON mail.conversation_local_tags (mailbox_id, tag_id, conversation_id)`;

  await installSearchReferenceCompatibility(db);
};

const addLocalTagColors = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.local_tags
    ADD COLUMN color TEXT NOT NULL DEFAULT '#6b7280'
      CHECK (color ~ '^#[0-9a-f]{6}$')
  `;
};

const addConversationReferencesAndResponsePolicies = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.reference_schemes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 80
      ),
      pattern TEXT NOT NULL CHECK (pattern = btrim(pattern) AND char_length(pattern) BETWEEN 1 AND 120),
      next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
      enabled BOOLEAN NOT NULL DEFAULT true,
      is_default BOOLEAN NOT NULL DEFAULT false,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, normalized_name),
      UNIQUE (id, mailbox_id)
    )
  `;
  await db`
    CREATE UNIQUE INDEX reference_schemes_default_idx
    ON mail.reference_schemes (mailbox_id)
    WHERE enabled AND is_default
  `;
  await db`CREATE INDEX reference_schemes_mailbox_idx ON mail.reference_schemes (mailbox_id, enabled DESC, normalized_name, id)`;
  await db`
    CREATE TRIGGER reference_schemes_touch_updated_at
    BEFORE UPDATE ON mail.reference_schemes
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;

  await db`
    CREATE TABLE mail.conversation_references (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL,
      origin_conversation_id UUID NOT NULL,
      scheme_id UUID NOT NULL,
      scheme_revision BIGINT NOT NULL CHECK (scheme_revision > 0),
      value TEXT NOT NULL CHECK (value = btrim(value) AND char_length(value) BETWEEN 1 AND 160),
      normalized_value TEXT NOT NULL CHECK (normalized_value = lower(value)),
      sequence BIGINT NOT NULL CHECK (sequence > 0),
      role TEXT NOT NULL CHECK (role IN ('primary', 'alias')),
      allocated_by_actor_kind TEXT NOT NULL CHECK (allocated_by_actor_kind IN ('user', 'service_account', 'workflow')),
      allocated_by_actor_id UUID NOT NULL,
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
      allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (conversation_id, mailbox_id)
        REFERENCES mail.conversations(id, mailbox_id) ON DELETE CASCADE,
      FOREIGN KEY (scheme_id, mailbox_id)
        REFERENCES mail.reference_schemes(id, mailbox_id) ON DELETE RESTRICT,
      UNIQUE (mailbox_id, normalized_value),
      UNIQUE (scheme_id, sequence)
    )
  `;
  await db`
    CREATE UNIQUE INDEX conversation_references_primary_idx
    ON mail.conversation_references (conversation_id)
    WHERE role = 'primary'
  `;
  await db`CREATE INDEX conversation_references_lookup_idx ON mail.conversation_references (mailbox_id, normalized_value, conversation_id)`;
  await db`
    CREATE UNIQUE INDEX conversation_references_mailbox_idempotency_idx
    ON mail.conversation_references (mailbox_id, idempotency_key)
  `;
  await db`CREATE INDEX conversation_references_conversation_idx ON mail.conversation_references (conversation_id, role, allocated_at, id)`;
  await db`
    CREATE OR REPLACE FUNCTION mail.protect_conversation_reference_allocation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.mailbox_id <> OLD.mailbox_id
        OR NEW.origin_conversation_id <> OLD.origin_conversation_id
        OR NEW.scheme_id <> OLD.scheme_id
        OR NEW.scheme_revision <> OLD.scheme_revision
        OR NEW.value <> OLD.value
        OR NEW.normalized_value <> OLD.normalized_value
        OR NEW.sequence <> OLD.sequence
        OR NEW.allocated_by_actor_kind <> OLD.allocated_by_actor_kind
        OR NEW.allocated_by_actor_id <> OLD.allocated_by_actor_id
        OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.allocated_at <> OLD.allocated_at
      THEN
        RAISE EXCEPTION 'Conversation reference allocation fields are immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$
  `;
  await db`
    CREATE TRIGGER conversation_references_protect_allocation
    BEFORE UPDATE ON mail.conversation_references
    FOR EACH ROW EXECUTE FUNCTION mail.protect_conversation_reference_allocation()
  `;

  await db`
    CREATE TABLE mail.response_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 80
      ),
      definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
      enabled BOOLEAN NOT NULL DEFAULT true,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, normalized_name),
      UNIQUE (id, mailbox_id)
    )
  `;
  await db`CREATE INDEX response_schedules_mailbox_idx ON mail.response_schedules (mailbox_id, enabled DESC, normalized_name, id)`;
  await db`
    CREATE TRIGGER response_schedules_touch_updated_at
    BEFORE UPDATE ON mail.response_schedules
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;

  await db`
    CREATE TABLE mail.automatic_reply_effects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      workflow_version_id UUID NOT NULL REFERENCES workflows.version(id) ON DELETE RESTRICT,
      workflow_run_id UUID NOT NULL REFERENCES workflows.run(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL CHECK (char_length(step_key) BETWEEN 1 AND 500),
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE RESTRICT,
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE RESTRICT,
      sender_identity_id UUID NOT NULL REFERENCES mail.sender_identities(id) ON DELETE RESTRICT,
      response_schedule_id UUID REFERENCES mail.response_schedules(id) ON DELETE RESTRICT,
      recipient TEXT NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 320),
      state TEXT NOT NULL CHECK (state IN ('suppressed', 'queued', 'confirmed', 'failed', 'needs_attention')),
      suppression_reasons TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      command_id UUID REFERENCES mail.commands(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (workflow_version_id, workflow_run_id, step_key)
    )
  `;
  await db`
    CREATE INDEX automatic_reply_rate_idx
    ON mail.automatic_reply_effects (mailbox_id, recipient, created_at DESC)
    WHERE state IN ('queued', 'confirmed', 'needs_attention')
  `;
  await db`
    CREATE TRIGGER automatic_reply_effects_touch_updated_at
    BEFORE UPDATE ON mail.automatic_reply_effects
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const hardenConversationReferencesAndResponsePolicies = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.conversations DROP COLUMN IF EXISTS primary_reference`;
  await db`
    ALTER TABLE mail.conversation_references
    DROP CONSTRAINT IF EXISTS conversation_references_conversation_id_scheme_id_key
  `;
  await db`ALTER TABLE mail.conversation_references ADD COLUMN IF NOT EXISTS origin_conversation_id UUID`;
  await db`ALTER TABLE mail.conversation_references ADD COLUMN IF NOT EXISTS scheme_revision BIGINT`;
  await db`ALTER TABLE mail.conversation_references ADD COLUMN IF NOT EXISTS idempotency_key TEXT`;
  await db`
    UPDATE mail.conversation_references reference
    SET
      origin_conversation_id = COALESCE(reference.origin_conversation_id, reference.conversation_id),
      scheme_revision = COALESCE(reference.scheme_revision, scheme.revision),
      idempotency_key = COALESCE(reference.idempotency_key, 'migration:' || reference.id::text)
    FROM mail.reference_schemes scheme
    WHERE scheme.id = reference.scheme_id
      AND (
        reference.origin_conversation_id IS NULL
        OR reference.scheme_revision IS NULL
        OR reference.idempotency_key IS NULL
      )
  `;
  await db`ALTER TABLE mail.conversation_references ALTER COLUMN origin_conversation_id SET NOT NULL`;
  await db`ALTER TABLE mail.conversation_references ALTER COLUMN scheme_revision SET NOT NULL`;
  await db`ALTER TABLE mail.conversation_references ALTER COLUMN idempotency_key SET NOT NULL`;
  await db`ALTER TABLE mail.conversation_references DROP CONSTRAINT IF EXISTS conversation_references_scheme_revision_check`;
  await db`
    ALTER TABLE mail.conversation_references
    ADD CONSTRAINT conversation_references_scheme_revision_check CHECK (scheme_revision > 0)
  `;
  await db`ALTER TABLE mail.conversation_references DROP CONSTRAINT IF EXISTS conversation_references_idempotency_key_check`;
  await db`
    ALTER TABLE mail.conversation_references
    ADD CONSTRAINT conversation_references_idempotency_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_references_mailbox_idempotency_idx
    ON mail.conversation_references (mailbox_id, idempotency_key)
  `;
  await db`
    CREATE OR REPLACE FUNCTION mail.protect_conversation_reference_allocation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.mailbox_id <> OLD.mailbox_id
        OR NEW.origin_conversation_id <> OLD.origin_conversation_id
        OR NEW.scheme_id <> OLD.scheme_id
        OR NEW.scheme_revision <> OLD.scheme_revision
        OR NEW.value <> OLD.value
        OR NEW.normalized_value <> OLD.normalized_value
        OR NEW.sequence <> OLD.sequence
        OR NEW.allocated_by_actor_kind <> OLD.allocated_by_actor_kind
        OR NEW.allocated_by_actor_id <> OLD.allocated_by_actor_id
        OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.allocated_at <> OLD.allocated_at
      THEN
        RAISE EXCEPTION 'Conversation reference allocation fields are immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$
  `;
  await db`DROP TRIGGER IF EXISTS conversation_references_protect_allocation ON mail.conversation_references`;
  await db`
    CREATE TRIGGER conversation_references_protect_allocation
    BEFORE UPDATE ON mail.conversation_references
    FOR EACH ROW EXECUTE FUNCTION mail.protect_conversation_reference_allocation()
  `;
};

const finalizeConversationReferenceMergeSemantics = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.conversation_references
    DROP CONSTRAINT IF EXISTS conversation_references_conversation_id_scheme_id_key
  `;
};

const hardenAutomaticReplyExecution = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.drafts ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`;
  await db`ALTER TABLE mail.drafts DROP CONSTRAINT drafts_author_kind_check`;
  await db`ALTER TABLE mail.drafts DROP CONSTRAINT drafts_last_editor_kind_check`;
  await db`ALTER TABLE mail.drafts ADD CONSTRAINT drafts_author_kind_check CHECK (author_kind IN ('user', 'service_account', 'workflow'))`;
  await db`
    ALTER TABLE mail.drafts
    ADD CONSTRAINT drafts_last_editor_kind_check CHECK (last_editor_kind IN ('user', 'service_account', 'workflow'))
  `;
  await db`
    ALTER TABLE mail.drafts
    ADD CONSTRAINT drafts_origin_check CHECK (
      (origin = 'user' AND author_kind IN ('user', 'service_account') AND last_editor_kind IN ('user', 'service_account'))
      OR (origin = 'workflow' AND author_kind = 'workflow' AND last_editor_kind = 'workflow')
    )
  `;
  await db`CREATE INDEX drafts_origin_state_idx ON mail.drafts (mailbox_id, origin, state, updated_at DESC)`;

  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN draft_id UUID REFERENCES mail.drafts(id) ON DELETE RESTRICT`;
  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN request_hash TEXT`;
  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN response_schedule_revision BIGINT`;
  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN protocol_facts JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN scheduled_at TIMESTAMPTZ`;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_request_hash_check CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$')
  `;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_schedule_revision_check
    CHECK (response_schedule_revision IS NULL OR response_schedule_revision > 0)
  `;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_protocol_facts_check CHECK (jsonb_typeof(protocol_facts) = 'object')
  `;
  await db`
    CREATE UNIQUE INDEX automatic_reply_effects_command_idx
    ON mail.automatic_reply_effects (command_id)
    WHERE command_id IS NOT NULL
  `;
};

const repairResponsePolicyExecution = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.automatic_reply_effects ALTER COLUMN recipient DROP NOT NULL`;
  await db`ALTER TABLE mail.automatic_reply_effects DROP CONSTRAINT IF EXISTS automatic_reply_effects_recipient_check`;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_recipient_check CHECK (recipient IS NULL OR char_length(recipient) BETWEEN 3 AND 320)
  `;
  await db`ALTER TABLE mail.automatic_reply_effects DROP CONSTRAINT IF EXISTS automatic_reply_effects_state_check`;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_state_check
    CHECK (state IN ('suppressed', 'queued', 'confirmed', 'failed', 'cancelled', 'needs_attention'))
  `;
};

const addConversationReferenceRequestLedger = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE UNIQUE INDEX conversation_references_id_mailbox_idx
    ON mail.conversation_references (id, mailbox_id)
  `;
  await db`
    CREATE TABLE mail.conversation_reference_requests (
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
      origin_conversation_id UUID NOT NULL,
      scheme_id UUID NOT NULL REFERENCES mail.reference_schemes(id) ON DELETE RESTRICT,
      reference_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (mailbox_id, idempotency_key),
      FOREIGN KEY (reference_id, mailbox_id)
        REFERENCES mail.conversation_references(id, mailbox_id) ON DELETE RESTRICT
    )
  `;
  await db`
    INSERT INTO mail.conversation_reference_requests (
      mailbox_id, idempotency_key, origin_conversation_id, scheme_id, reference_id, created_at
    )
    SELECT
      reference.mailbox_id,
      reference.idempotency_key,
      reference.origin_conversation_id,
      reference.scheme_id,
      reference.id,
      reference.allocated_at
    FROM mail.conversation_references reference
  `;
};

const addComposeTemplatesAndStyles = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.compose_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT compose_templates_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('signature', 'snippet')),
      scope TEXT NOT NULL CHECK (scope IN ('private', 'mailbox')),
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      normalized_name TEXT NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 120),
      shortcut TEXT NOT NULL CHECK (shortcut ~ '^[a-z][a-z0-9_]{0,39}$'),
      body_template TEXT NOT NULL CHECK (char_length(body_template) BETWEEN 1 AND 200000),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT compose_templates_scope_owner_check CHECK (
        (scope = 'private' AND owner_user_id IS NOT NULL)
        OR (scope = 'mailbox' AND owner_user_id IS NULL)
      )
    )
  `;
  await db`
    CREATE UNIQUE INDEX compose_templates_mailbox_shortcut_idx
    ON mail.compose_templates (mailbox_id, shortcut)
    WHERE scope = 'mailbox' AND archived_at IS NULL
  `;
  await db`
    CREATE UNIQUE INDEX compose_templates_private_shortcut_idx
    ON mail.compose_templates (mailbox_id, owner_user_id, shortcut)
    WHERE scope = 'private' AND archived_at IS NULL
  `;
  await db`
    CREATE INDEX compose_templates_visible_idx
    ON mail.compose_templates (mailbox_id, kind, scope, normalized_name, id)
    WHERE archived_at IS NULL
  `;
  await db`
    CREATE UNIQUE INDEX compose_templates_mailbox_id_idx
    ON mail.compose_templates (mailbox_id, id)
  `;
  await db`
    CREATE UNIQUE INDEX sender_identities_mailbox_id_idx
    ON mail.sender_identities (mailbox_id, id)
  `;

  await db`
    CREATE TABLE mail.compose_signature_defaults (
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      sender_identity_id UUID NOT NULL,
      user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      template_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT compose_signature_defaults_sender_fk
        FOREIGN KEY (mailbox_id, sender_identity_id)
        REFERENCES mail.sender_identities (mailbox_id, id) ON DELETE CASCADE,
      CONSTRAINT compose_signature_defaults_template_fk
        FOREIGN KEY (mailbox_id, template_id)
        REFERENCES mail.compose_templates (mailbox_id, id) ON DELETE CASCADE
    )
  `;
  await db`
    CREATE UNIQUE INDEX compose_signature_defaults_mailbox_idx
    ON mail.compose_signature_defaults (mailbox_id, sender_identity_id)
    WHERE user_id IS NULL
  `;
  await db`
    CREATE UNIQUE INDEX compose_signature_defaults_user_idx
    ON mail.compose_signature_defaults (mailbox_id, sender_identity_id, user_id)
    WHERE user_id IS NOT NULL
  `;
  await db`
    CREATE INDEX compose_signature_defaults_template_idx
    ON mail.compose_signature_defaults (template_id)
  `;

  await db`
    CREATE TABLE mail.compose_styles (
      mailbox_id UUID PRIMARY KEY REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      custom_css TEXT NOT NULL DEFAULT '' CHECK (char_length(custom_css) <= 100000),
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_by_actor_kind TEXT CHECK (updated_by_actor_kind IS NULL OR updated_by_actor_kind IN ('user', 'service_account')),
      updated_by_actor_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT compose_styles_actor_check CHECK (
        (updated_by_actor_kind IS NULL AND updated_by_actor_id IS NULL)
        OR (updated_by_actor_kind IS NOT NULL AND updated_by_actor_id IS NOT NULL)
      )
    )
  `;
  await db`
    INSERT INTO mail.compose_styles (mailbox_id)
    SELECT id FROM mail.mailboxes
    ON CONFLICT (mailbox_id) DO NOTHING
  `;
};

const hardenComposeTemplateReferences = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS compose_templates_mailbox_id_idx
    ON mail.compose_templates (mailbox_id, id)
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS sender_identities_mailbox_id_idx
    ON mail.sender_identities (mailbox_id, id)
  `;
  await db`
    ALTER TABLE mail.compose_signature_defaults
      DROP CONSTRAINT IF EXISTS compose_signature_defaults_sender_identity_id_fkey,
      DROP CONSTRAINT IF EXISTS compose_signature_defaults_template_id_fkey,
      DROP CONSTRAINT IF EXISTS compose_signature_defaults_sender_fk,
      DROP CONSTRAINT IF EXISTS compose_signature_defaults_template_fk,
      ADD CONSTRAINT compose_signature_defaults_sender_fk
        FOREIGN KEY (mailbox_id, sender_identity_id)
        REFERENCES mail.sender_identities (mailbox_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT compose_signature_defaults_template_fk
        FOREIGN KEY (mailbox_id, template_id)
        REFERENCES mail.compose_templates (mailbox_id, id) ON DELETE CASCADE
  `;
};

const addStableScheduledSendOrdering = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.outbox_submissions ADD COLUMN requested_at TIMESTAMPTZ`;
  await db`UPDATE mail.outbox_submissions SET requested_at = scheduled_at`;
  await db`ALTER TABLE mail.outbox_submissions ALTER COLUMN requested_at SET NOT NULL`;
  await db`
    CREATE INDEX outbox_scheduled_view_idx
    ON mail.outbox_submissions (mailbox_id, requested_at, id)
    WHERE state IN ('scheduled', 'undo_window')
  `;
};

const guardStableScheduledSendOrdering = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE OR REPLACE FUNCTION mail.guard_outbox_requested_at()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        NEW.requested_at := COALESCE(NEW.requested_at, NEW.scheduled_at);
      ELSIF NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
        RAISE EXCEPTION 'outbox requested_at is immutable' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END;
    $$
  `;
  await db`DROP TRIGGER IF EXISTS outbox_requested_at_guard ON mail.outbox_submissions`;
  await db`
    CREATE TRIGGER outbox_requested_at_guard
    BEFORE INSERT OR UPDATE OF requested_at ON mail.outbox_submissions
    FOR EACH ROW EXECUTE FUNCTION mail.guard_outbox_requested_at()
  `;
};

const normalizeProviderBindingAccountEvidence = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE OR REPLACE FUNCTION mail.normalize_provider_binding_account_evidence()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    DECLARE
      locator_account_id TEXT;
      evidence_account_id TEXT;
    BEGIN
      locator_account_id := NULLIF(NEW.remote_locator ->> 'accountId', '');
      IF locator_account_id IS NULL THEN
        RETURN NEW;
      END IF;

      evidence_account_id := NULLIF(NEW.verification_evidence ->> 'accountId', '');
      IF evidence_account_id IS NULL THEN
        NEW.verification_evidence := jsonb_set(
          COALESCE(NEW.verification_evidence, '{}'::jsonb),
          '{accountId}',
          to_jsonb(locator_account_id),
          true
        );
      ELSIF evidence_account_id <> locator_account_id THEN
        RAISE EXCEPTION 'provider binding account evidence does not match its remote locator'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$
  `;
  await db`DROP TRIGGER IF EXISTS provider_bindings_account_evidence_guard ON mail.provider_bindings`;
  await db`
    CREATE TRIGGER provider_bindings_account_evidence_guard
    BEFORE INSERT OR UPDATE OF remote_locator, verification_evidence ON mail.provider_bindings
    FOR EACH ROW EXECUTE FUNCTION mail.normalize_provider_binding_account_evidence()
  `;
  await db`
    UPDATE mail.provider_bindings
    SET verification_evidence = verification_evidence
    WHERE NULLIF(remote_locator ->> 'accountId', '') IS NOT NULL
      AND NULLIF(verification_evidence ->> 'accountId', '') IS NULL
  `;
  await db`
    ALTER TABLE mail.provider_bindings
    ADD CONSTRAINT provider_bindings_account_evidence_matches
    CHECK (
      NULLIF(remote_locator ->> 'accountId', '') IS NULL
      OR verification_evidence ->> 'accountId' = remote_locator ->> 'accountId'
    )
  `;
};

const addManagedAutomaticReplyConfigurations = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE UNIQUE INDEX sender_identities_id_mailbox_idx
    ON mail.sender_identities (id, mailbox_id)
  `;
  await db`
    CREATE TABLE mail.automatic_reply_configurations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT automatic_reply_configurations_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      response_schedule_id UUID NOT NULL,
      sender_identity_id UUID NOT NULL,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 80
      ),
      subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 998),
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2097152),
      format TEXT NOT NULL CHECK (format IN ('plain', 'markdown')),
      minimum_interval_hours INTEGER NOT NULL CHECK (minimum_interval_hours BETWEEN 0 AND 8760),
      inactive_behavior TEXT NOT NULL CHECK (inactive_behavior IN ('skip', 'defer')),
      enabled BOOLEAN NOT NULL DEFAULT true,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (workflow_id, mailbox_id)
        REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE RESTRICT,
      FOREIGN KEY (response_schedule_id, mailbox_id)
        REFERENCES mail.response_schedules(id, mailbox_id) ON DELETE RESTRICT,
      FOREIGN KEY (sender_identity_id, mailbox_id)
        REFERENCES mail.sender_identities(id, mailbox_id) ON DELETE RESTRICT,
      UNIQUE (mailbox_id, normalized_name),
      UNIQUE (workflow_id),
      UNIQUE (response_schedule_id)
    )
  `;
  await db`
    CREATE INDEX automatic_reply_configurations_mailbox_idx
    ON mail.automatic_reply_configurations (mailbox_id, enabled DESC, normalized_name, id)
  `;
  await db`
    CREATE TRIGGER automatic_reply_configurations_touch_updated_at
    BEFORE UPDATE ON mail.automatic_reply_configurations
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const hardenManagedAutomaticReplyConfigurations = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE UNIQUE INDEX automatic_reply_configurations_one_active_idx
    ON mail.automatic_reply_configurations (mailbox_id)
    WHERE enabled
  `;
  await db`DROP INDEX mail.automatic_reply_rate_idx`;
  await db`
    CREATE INDEX automatic_reply_rate_idx
    ON mail.automatic_reply_effects (mailbox_id, recipient, state, updated_at DESC)
    WHERE state IN ('queued', 'confirmed', 'needs_attention')
  `;
};

const addAutomaticReplyDeliveryTimestamps = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.automatic_reply_effects ADD COLUMN confirmed_at TIMESTAMPTZ`;
  await db`
    UPDATE mail.automatic_reply_effects
    SET confirmed_at = updated_at
    WHERE state = 'confirmed'
  `;
  await db`DROP INDEX mail.automatic_reply_rate_idx`;
  await db`
    CREATE INDEX automatic_reply_rate_idx
    ON mail.automatic_reply_effects (mailbox_id, recipient, state, confirmed_at DESC)
    WHERE state IN ('queued', 'confirmed', 'needs_attention')
  `;
};

const guardAutomaticReplyDeliveryTimestamps = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.automatic_reply_effects DROP CONSTRAINT IF EXISTS automatic_reply_effects_confirmed_at_check`;
  await db`
    ALTER TABLE mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_confirmed_at_check
    CHECK (state <> 'confirmed' OR confirmed_at IS NOT NULL)
  `;
};

const defaultSenderAutomationToMailbox = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.sender_identities ALTER COLUMN automation_policy SET DEFAULT 'mailbox'`;
};

const addAutomaticReplyManagementPermission = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.mailboxes
    ADD COLUMN automatic_reply_management_permission TEXT NOT NULL DEFAULT 'admin'
      CHECK (automatic_reply_management_permission IN ('write', 'admin'))
  `;
};

const inlineAutomaticReplyScheduleSchema = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.automatic_reply_configurations ADD COLUMN schedule_definition JSONB`;
  await db`
    ALTER TABLE mail.automatic_reply_configurations
      ALTER COLUMN schedule_definition SET NOT NULL,
      ADD CONSTRAINT automatic_reply_configurations_schedule_definition_check
        CHECK (jsonb_typeof(schedule_definition) = 'object')
  `;
  await db`ALTER TABLE mail.automatic_reply_effects DROP COLUMN response_schedule_revision`;
  await db`ALTER TABLE mail.automatic_reply_effects DROP COLUMN response_schedule_id`;
  await db`ALTER TABLE mail.automatic_reply_configurations DROP COLUMN response_schedule_id`;
  await db`DROP TABLE mail.response_schedules`;
};

const simplifyConversationReferenceConfiguration = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.reference_number_configurations (
      mailbox_id UUID PRIMARY KEY REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      pattern TEXT NOT NULL CHECK (pattern = btrim(pattern) AND char_length(pattern) BETWEEN 1 AND 120),
      next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
      enabled BOOLEAN NOT NULL DEFAULT true,
      include_in_reply_subjects BOOLEAN NOT NULL DEFAULT true,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    INSERT INTO mail.reference_number_configurations (
      mailbox_id, pattern, next_sequence, enabled, revision,
      created_by_actor_kind, created_by_actor_id, created_at, updated_at
    )
    SELECT
      chosen.mailbox_id,
      chosen.pattern,
      GREATEST(
        chosen.next_sequence,
        COALESCE((SELECT MAX(candidate.next_sequence) FROM mail.reference_schemes candidate WHERE candidate.mailbox_id = chosen.mailbox_id), 1),
        COALESCE((SELECT MAX(reference.sequence) + 1 FROM mail.conversation_references reference WHERE reference.mailbox_id = chosen.mailbox_id), 1)
      ),
      chosen.enabled,
      chosen.revision,
      chosen.created_by_actor_kind,
      chosen.created_by_actor_id,
      chosen.created_at,
      chosen.updated_at
    FROM (
      SELECT DISTINCT ON (scheme.mailbox_id) scheme.*
      FROM mail.reference_schemes scheme
      ORDER BY scheme.mailbox_id, scheme.is_default DESC, scheme.enabled DESC, scheme.created_at, scheme.id
    ) chosen
  `;
  await db`
    CREATE TRIGGER reference_number_configurations_touch_updated_at
    BEFORE UPDATE ON mail.reference_number_configurations
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;

  await db`DROP TRIGGER IF EXISTS conversation_references_protect_allocation ON mail.conversation_references`;
  await db`ALTER TABLE mail.conversation_references ADD COLUMN configuration_revision BIGINT`;
  await db`ALTER TABLE mail.conversation_references ADD COLUMN pattern_snapshot TEXT`;
  await db`
    UPDATE mail.conversation_references reference
    SET configuration_revision = reference.scheme_revision, pattern_snapshot = scheme.pattern
    FROM mail.reference_schemes scheme
    WHERE scheme.id = reference.scheme_id
  `;
  await db`
    ALTER TABLE mail.conversation_references
      ALTER COLUMN configuration_revision SET NOT NULL,
      ALTER COLUMN pattern_snapshot SET NOT NULL,
      ADD CONSTRAINT conversation_references_configuration_revision_check CHECK (configuration_revision > 0),
      ADD CONSTRAINT conversation_references_pattern_snapshot_check CHECK (
        pattern_snapshot = btrim(pattern_snapshot) AND char_length(pattern_snapshot) BETWEEN 1 AND 120
      )
  `;
  await db`ALTER TABLE mail.conversation_reference_requests DROP COLUMN scheme_id`;
  await db`ALTER TABLE mail.conversation_references DROP COLUMN scheme_id`;
  await db`ALTER TABLE mail.conversation_references DROP COLUMN scheme_revision`;
  await db`
    CREATE OR REPLACE FUNCTION mail.protect_conversation_reference_allocation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.mailbox_id <> OLD.mailbox_id
        OR NEW.origin_conversation_id <> OLD.origin_conversation_id
        OR NEW.configuration_revision <> OLD.configuration_revision
        OR NEW.pattern_snapshot <> OLD.pattern_snapshot
        OR NEW.value <> OLD.value
        OR NEW.normalized_value <> OLD.normalized_value
        OR NEW.sequence <> OLD.sequence
        OR NEW.allocated_by_actor_kind <> OLD.allocated_by_actor_kind
        OR NEW.allocated_by_actor_id <> OLD.allocated_by_actor_id
        OR NEW.idempotency_key <> OLD.idempotency_key
        OR NEW.allocated_at <> OLD.allocated_at
      THEN
        RAISE EXCEPTION 'Conversation reference allocation fields are immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$
  `;
  await db`
    CREATE TRIGGER conversation_references_protect_allocation
    BEFORE UPDATE ON mail.conversation_references
    FOR EACH ROW EXECUTE FUNCTION mail.protect_conversation_reference_allocation()
  `;
  await db`DROP TABLE mail.reference_schemes`;
  await db`ALTER TABLE mail.automatic_reply_configurations ADD COLUMN ensure_reference BOOLEAN NOT NULL DEFAULT false`;
};

const addGenericImapDraftProjection = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
      ALTER COLUMN author_id DROP NOT NULL,
      ALTER COLUMN last_editor_id DROP NOT NULL,
      DROP CONSTRAINT drafts_author_kind_check,
      DROP CONSTRAINT drafts_last_editor_kind_check,
      DROP CONSTRAINT drafts_origin_check,
      ADD CONSTRAINT drafts_author_kind_check CHECK (author_kind IN ('user', 'service_account', 'workflow', 'system')),
      ADD CONSTRAINT drafts_last_editor_kind_check CHECK (last_editor_kind IN ('user', 'service_account', 'workflow', 'system')),
      ADD CONSTRAINT drafts_actor_shape_check CHECK (
        (author_kind = 'system' AND author_id IS NULL)
        OR (author_kind <> 'system' AND author_id IS NOT NULL)
      ),
      ADD CONSTRAINT drafts_last_editor_shape_check CHECK (
        (last_editor_kind = 'system' AND last_editor_id IS NULL)
        OR (last_editor_kind <> 'system' AND last_editor_id IS NOT NULL)
      ),
      ADD CONSTRAINT drafts_origin_check CHECK (
        (origin = 'user'
          AND author_kind IN ('user', 'service_account', 'system')
          AND last_editor_kind IN ('user', 'service_account', 'system'))
        OR (origin = 'workflow' AND author_kind = 'workflow' AND last_editor_kind = 'workflow')
      )
  `;
  await db`
    ALTER TABLE mail.draft_recovery_copies
      ALTER COLUMN creator_id DROP NOT NULL,
      DROP CONSTRAINT draft_recovery_copies_creator_kind_check,
      ADD CONSTRAINT draft_recovery_copies_creator_kind_check CHECK (creator_kind IN ('user', 'service_account', 'system')),
      ADD CONSTRAINT draft_recovery_copies_creator_shape_check CHECK (
        (creator_kind = 'system' AND creator_id IS NULL)
        OR (creator_kind <> 'system' AND creator_id IS NOT NULL)
      )
  `;
  await db`
    CREATE TABLE mail.draft_provider_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      draft_id UUID REFERENCES mail.drafts(id) ON DELETE CASCADE,
      cloud_revision BIGINT CHECK (cloud_revision IS NULL OR cloud_revision > 0),
      direction TEXT NOT NULL CHECK (direction IN ('export', 'import')),
      state TEXT NOT NULL DEFAULT 'prepared' CHECK (
        state IN (
          'prepared', 'appending', 'active', 'retiring', 'retired',
          'external', 'importing', 'conflict', 'ambiguous', 'needs_attention'
        )
      ),
      stable_message_id TEXT NOT NULL CHECK (
        stable_message_id = btrim(stable_message_id)
        AND char_length(stable_message_id) BETWEEN 3 AND 998
      ),
      content_fingerprint TEXT CHECK (content_fingerprint IS NULL OR content_fingerprint ~ '^[a-f0-9]{64}$'),
      content_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content_snapshot) = 'object'),
      mime_blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      remote_resource_id UUID REFERENCES mail.remote_resources(id) ON DELETE SET NULL,
      binding_id UUID REFERENCES mail.provider_bindings(id) ON DELETE SET NULL,
      folder_id UUID REFERENCES mail.folders(id) ON DELETE SET NULL,
      uid_validity NUMERIC(20, 0) CHECK (uid_validity IS NULL OR uid_validity >= 0),
      uid NUMERIC(20, 0) CHECK (uid IS NULL OR uid > 0),
      modseq NUMERIC(20, 0) CHECK (modseq IS NULL OR modseq >= 0),
      transport_generation BIGINT CHECK (transport_generation IS NULL OR transport_generation > 0),
      secret_revision INTEGER CHECK (secret_revision IS NULL OR secret_revision > 0),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 80),
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      provider_effect_started_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT draft_provider_snapshots_cloud_shape CHECK (
        (direction = 'export' AND draft_id IS NOT NULL AND cloud_revision IS NOT NULL AND content_fingerprint IS NOT NULL)
        OR direction = 'import'
      ),
      CONSTRAINT draft_provider_snapshots_remote_shape CHECK (
        (uid_validity IS NULL AND uid IS NULL)
        OR (folder_id IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL)
      ),
      CONSTRAINT draft_provider_snapshots_effect_shape CHECK (
        provider_effect_started_at IS NULL OR attempt > 0
      )
    )
  `;
  await db`
    CREATE UNIQUE INDEX draft_provider_snapshots_export_revision_idx
    ON mail.draft_provider_snapshots (draft_id, cloud_revision)
    WHERE direction = 'export'
  `;
  await db`
    CREATE INDEX draft_provider_snapshots_remote_identity_idx
    ON mail.draft_provider_snapshots (folder_id, uid_validity, uid, created_at DESC)
    WHERE folder_id IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL
  `;
  await db`
    CREATE INDEX draft_provider_snapshots_pending_idx
    ON mail.draft_provider_snapshots (state, updated_at, id)
    WHERE state IN ('prepared', 'appending', 'external', 'importing', 'retiring')
  `;
  await db`
    CREATE INDEX draft_provider_snapshots_draft_history_idx
    ON mail.draft_provider_snapshots (draft_id, created_at DESC, id DESC)
    WHERE draft_id IS NOT NULL
  `;
  await db`
    CREATE INDEX draft_provider_snapshots_message_id_idx
    ON mail.draft_provider_snapshots (mailbox_id, lower(stable_message_id), created_at DESC)
  `;
  await db`
    CREATE UNIQUE INDEX draft_provider_snapshots_one_active_export_idx
    ON mail.draft_provider_snapshots (draft_id)
    WHERE direction = 'export' AND state = 'active'
  `;
  await db`
    CREATE TRIGGER draft_provider_snapshots_touch_updated_at
    BEFORE UPDATE ON mail.draft_provider_snapshots
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const addImapPushListenerHealth = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.imap_push_listener_health (
      binding_id UUID PRIMARY KEY REFERENCES mail.provider_bindings(id) ON DELETE CASCADE,
      generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
      state TEXT NOT NULL DEFAULT 'stopped'
        CHECK (state IN ('starting', 'listening', 'polling', 'reconnecting', 'stopped', 'degraded')),
      mode TEXT NOT NULL DEFAULT 'none'
        CHECK (mode IN ('none', 'idle', 'qresync', 'poll')),
      folder_id UUID REFERENCES mail.folders(id) ON DELETE SET NULL,
      capabilities JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
      reconnect_attempt INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_attempt >= 0),
      last_connected_at TIMESTAMPTZ,
      last_hint_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT CHECK (last_error_message IS NULL OR char_length(last_error_message) <= 1000),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    CREATE INDEX imap_push_listener_health_state_idx
    ON mail.imap_push_listener_health (state, last_heartbeat_at, binding_id)
  `;
};

const canonicalizeSavedConversationViews = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.saved_conversation_views
      ADD COLUMN IF NOT EXISTS invalid_filter JSONB,
      ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS migration_error TEXT CHECK (
        migration_error IS NULL OR char_length(migration_error) <= 1000
      )
  `;
  const rows = await db<{ id: string; filter: unknown | string }[]>`
    SELECT id, filter
    FROM mail.saved_conversation_views
    ORDER BY id
    FOR UPDATE
  `;
  for (const row of rows) {
    let value: unknown = row.filter;
    if (typeof row.filter === "string") {
      try {
        value = JSON.parse(row.filter) as unknown;
      } catch {
        value = { malformedJson: row.filter };
      }
    }
    const migrated = canonicalizeSavedViewFilter(value);
    if (!migrated.changed) continue;
    await db`
      UPDATE mail.saved_conversation_views
      SET
        filter = ${migrated.state}::jsonb,
        invalid_filter = CASE WHEN ${migrated.recovered} THEN ${value}::jsonb ELSE NULL END,
        disabled_at = CASE WHEN ${migrated.recovered} THEN now() ELSE NULL END,
        migration_error = CASE
          WHEN ${migrated.recovered} THEN 'Saved view used an unsupported search format and was disabled'
          ELSE NULL
        END
      WHERE id = ${row.id}::uuid
    `;
  }
  await db`ALTER TABLE mail.saved_conversation_views ALTER COLUMN filter DROP DEFAULT`;
  await db`
    ALTER TABLE mail.saved_conversation_views
    DROP CONSTRAINT IF EXISTS saved_conversation_views_canonical_search_check
  `;
  await db`
    ALTER TABLE mail.saved_conversation_views
    ADD CONSTRAINT saved_conversation_views_canonical_search_check
    CHECK ((
      jsonb_typeof(filter) = 'object'
      AND filter ? 'expression'
      AND filter ? 'sort'
      AND jsonb_typeof(filter->'expression') = 'object'
      AND filter->>'sort' IN ('relevance', 'newest')
    ) IS TRUE)
  `;
  await db`DROP INDEX IF EXISTS mail.saved_conversation_views_private_name_idx`;
  await db`DROP INDEX IF EXISTS mail.saved_conversation_views_mailbox_name_idx`;
  await db`
    CREATE UNIQUE INDEX saved_conversation_views_private_name_idx
    ON mail.saved_conversation_views (mailbox_id, owner_user_id, lower(name))
    WHERE scope = 'private' AND disabled_at IS NULL
  `;
  await db`
    CREATE UNIQUE INDEX saved_conversation_views_mailbox_name_idx
    ON mail.saved_conversation_views (mailbox_id, lower(name))
    WHERE scope = 'mailbox' AND disabled_at IS NULL
  `;
};

const repairCanonicalSavedConversationViewConstraint = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.saved_conversation_views
    DROP CONSTRAINT IF EXISTS saved_conversation_views_canonical_search_check
  `;
  await db`
    ALTER TABLE mail.saved_conversation_views
    ADD CONSTRAINT saved_conversation_views_canonical_search_check
    CHECK ((
      jsonb_typeof(filter) = 'object'
      AND filter ? 'expression'
      AND filter ? 'sort'
      AND jsonb_typeof(filter->'expression') = 'object'
      AND filter->>'sort' IN ('relevance', 'newest')
    ) IS TRUE)
  `;
};

const removeConversationFollowersAndMentions = async (db: SqlClient): Promise<void> => {
  await db`DELETE FROM mail.collaboration_notification_deliveries WHERE kind = 'mention'`;
  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    DROP CONSTRAINT IF EXISTS collaboration_notification_deliveries_kind_check
  `;
  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_kind_check CHECK (kind = 'reminder')
  `;
  await db`DROP TABLE IF EXISTS mail.conversation_comment_mentions`;
  await db`DROP TABLE IF EXISTS mail.conversation_watchers`;
  await db`
    DELETE FROM mail.activity_events
    WHERE action IN ('conversation.watcher_added', 'conversation.watcher_removed')
  `;
  await db`
    UPDATE mail.activity_events
    SET metadata = metadata - 'mentionUserIds'
    WHERE metadata ? 'mentionUserIds'
  `;

  await canonicalizeSavedConversationViews(db);

  await db`
    DO $$
    BEGIN
      IF to_regclass('notifications.events') IS NOT NULL THEN
        EXECUTE 'UPDATE notifications.events SET target_href = NULL WHERE definition_id = ''mail.commentMention''';
      END IF;
      IF to_regclass('notifications.definitions') IS NOT NULL THEN
        EXECUTE 'UPDATE notifications.definitions SET active = false, updated_at = now() WHERE id = ''mail.commentMention''';
      END IF;
    END
    $$
  `;
};

const unifyConversationWorkStates = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.conversations DROP CONSTRAINT IF EXISTS conversations_work_status_check`;
  await db`ALTER TABLE mail.conversations ALTER COLUMN work_status DROP DEFAULT`;
  await db`UPDATE mail.conversations SET work_status = 'needs_action' WHERE work_status = 'open'`;
  await db`ALTER TABLE mail.conversations ALTER COLUMN work_status SET DEFAULT 'needs_action'`;
  await db`
    ALTER TABLE mail.conversations
    ADD CONSTRAINT conversations_work_status_check CHECK (work_status IN ('needs_action', 'waiting', 'done'))
  `;
  await db`ALTER TABLE mail.conversations DROP COLUMN IF EXISTS response_needed`;
  await db`
    CREATE INDEX IF NOT EXISTS conversations_due_snooze_idx
    ON mail.conversations (snoozed_until, id)
    WHERE snoozed_until IS NOT NULL
  `;

  await db`
    UPDATE mail.activity_events
    SET metadata = jsonb_strip_nulls(
      jsonb_set(
        jsonb_set(
          metadata #- '{before,responseNeeded}' #- '{after,responseNeeded}',
          '{before,workStatus}',
          CASE WHEN metadata #>> '{before,workStatus}' = 'open' THEN '"needs_action"'::jsonb
               ELSE COALESCE(metadata #> '{before,workStatus}', 'null'::jsonb) END,
          true
        ),
        '{after,workStatus}',
        CASE WHEN metadata #>> '{after,workStatus}' = 'open' THEN '"needs_action"'::jsonb
             ELSE COALESCE(metadata #> '{after,workStatus}', 'null'::jsonb) END,
        true
      )
    )
    WHERE metadata::text LIKE '%responseNeeded%' OR metadata::text LIKE '%"workStatus": "open"%'
  `;

  await canonicalizeSavedConversationViews(db);
};

const repairDraftProviderRemoteIdentityIndex = async (db: SqlClient): Promise<void> => {
  await db`DROP INDEX IF EXISTS mail.draft_provider_snapshots_remote_identity_idx`;
  await db`
    CREATE INDEX draft_provider_snapshots_remote_identity_idx
    ON mail.draft_provider_snapshots (folder_id, uid_validity, uid, created_at DESC)
    WHERE folder_id IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL
  `;
};

const addDraftRecoveryAttachments = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.draft_recovery_copies
    ADD COLUMN has_attachment_snapshot BOOLEAN NOT NULL DEFAULT false
  `;
  await db`
    CREATE TABLE mail.draft_recovery_attachments (
      recovery_copy_id UUID NOT NULL REFERENCES mail.draft_recovery_copies(id) ON DELETE CASCADE,
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
      content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
      byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
      content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
      position INTEGER NOT NULL CHECK (position >= 0),
      PRIMARY KEY (recovery_copy_id, position)
    )
  `;
  await db`
    CREATE INDEX draft_recovery_attachments_blob_idx
    ON mail.draft_recovery_attachments (blob_id)
  `;
};

const addPublicAttachmentLinksAndStorageSnapshots = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.attachment_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE SET NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'draft')),
      source_id UUID NOT NULL,
      filename TEXT CHECK (filename IS NULL OR char_length(filename) BETWEEN 1 AND 255),
      content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
      byte_length BIGINT NOT NULL CHECK (byte_length BETWEEN 0 AND 104857600),
      token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      password_hash TEXT,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      download_count BIGINT NOT NULL DEFAULT 0 CHECK (download_count >= 0),
      max_downloads BIGINT CHECK (max_downloads BETWEEN 1 AND 1000000),
      last_downloaded_at TIMESTAMPTZ,
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT attachment_links_expiry_check CHECK (expires_at IS NULL OR expires_at > created_at)
    )
  `;
  await db`
    CREATE INDEX attachment_links_mailbox_idx
    ON mail.attachment_links (mailbox_id, created_at DESC, id DESC)
  `;
  await db`
    CREATE INDEX attachment_links_cleanup_idx
    ON mail.attachment_links (COALESCE(revoked_at, expires_at), id)
    WHERE revoked_at IS NOT NULL OR expires_at IS NOT NULL
  `;
  await db`
    CREATE TABLE mail.attachment_link_grants (
      token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
      link_id UUID NOT NULL REFERENCES mail.attachment_links(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      download_claimed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT attachment_link_grants_expiry_check CHECK (expires_at > created_at)
    )
  `;
  await db`CREATE INDEX attachment_link_grants_expiry_idx ON mail.attachment_link_grants (expires_at)`;

  await db`
    CREATE TABLE mail.storage_usage_snapshots (
      mailbox_id UUID PRIMARY KEY REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      message_count BIGINT NOT NULL DEFAULT 0 CHECK (message_count >= 0),
      message_bytes BIGINT NOT NULL DEFAULT 0 CHECK (message_bytes >= 0),
      received_attachment_bytes BIGINT NOT NULL DEFAULT 0 CHECK (received_attachment_bytes >= 0),
      draft_attachment_bytes BIGINT NOT NULL DEFAULT 0 CHECK (draft_attachment_bytes >= 0),
      external_link_bytes BIGINT NOT NULL DEFAULT 0 CHECK (external_link_bytes >= 0),
      logical_total_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_total_bytes >= 0),
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`
    CREATE TABLE mail.storage_system_snapshot (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      physical_database_bytes BIGINT NOT NULL DEFAULT 0 CHECK (physical_database_bytes >= 0),
      physical_blob_bytes BIGINT NOT NULL DEFAULT 0 CHECK (physical_blob_bytes >= 0),
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
};

const addManagedProviderOAuth = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.provider_connections
      ADD COLUMN IF NOT EXISTS oauth_provider_id TEXT CHECK (oauth_provider_id IN ('google', 'microsoft')),
      ADD COLUMN IF NOT EXISTS oauth_token_revision BIGINT NOT NULL DEFAULT 0 CHECK (oauth_token_revision >= 0),
      ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ
  `;
  await db`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'mail.provider_connections'::regclass
          AND conname = 'provider_connections_managed_oauth_check'
      ) THEN
        ALTER TABLE mail.provider_connections
          ADD CONSTRAINT provider_connections_managed_oauth_check CHECK (
            oauth_provider_id IS NULL OR secret_kind = 'oauth2'
          );
      END IF;
    END
    $$
  `;
  await db`
    CREATE INDEX IF NOT EXISTS provider_connections_oauth_expiry_idx
    ON mail.provider_connections (oauth_expires_at, id)
    WHERE oauth_provider_id IS NOT NULL AND status <> 'revoked'
  `;
  await db`
    CREATE TABLE IF NOT EXISTS mail.provider_oauth_flows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[a-f0-9]{64}$'),
      browser_nonce_hash TEXT NOT NULL CHECK (browser_nonce_hash ~ '^[a-f0-9]{64}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL CHECK (provider_id IN ('google', 'microsoft')),
      operation TEXT NOT NULL,
      connection_id UUID REFERENCES mail.provider_connections(id) ON DELETE CASCADE,
      connection_input JSONB NOT NULL CHECK (jsonb_typeof(connection_input) = 'object'),
      create_sender BOOLEAN NOT NULL DEFAULT false,
      saves_sent_automatically BOOLEAN NOT NULL DEFAULT false,
      encrypted_code_verifier TEXT NOT NULL CHECK (char_length(encrypted_code_verifier) > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'exchanging', 'completed', 'failed')),
      result_connection_id UUID REFERENCES mail.provider_connections(id) ON DELETE SET NULL,
      result_code TEXT CHECK (result_code IS NULL OR char_length(result_code) <= 100),
      result_message TEXT CHECK (result_message IS NULL OR char_length(result_message) <= 500),
      diagnostics JSONB CHECK (diagnostics IS NULL OR jsonb_typeof(diagnostics) = 'object'),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT provider_oauth_flows_operation_check CHECK (
        (operation = 'create' AND connection_id IS NULL) OR
        (operation = 'reconnect' AND connection_id IS NOT NULL)
      ),
      CONSTRAINT provider_oauth_flows_expiry_check CHECK (expires_at > created_at)
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS provider_oauth_flows_cleanup_idx
    ON mail.provider_oauth_flows (expires_at, id)
  `;
  await db`
    CREATE INDEX IF NOT EXISTS provider_oauth_flows_user_idx
    ON mail.provider_oauth_flows (user_id, created_at DESC)
  `;
};

const addDraftDeliveryClasses = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
      ADD COLUMN IF NOT EXISTS delivery_class TEXT NOT NULL DEFAULT 'normal',
      DROP CONSTRAINT IF EXISTS drafts_delivery_class_check,
      DROP CONSTRAINT IF EXISTS drafts_automatic_reply_origin_check,
      ADD CONSTRAINT drafts_delivery_class_check CHECK (delivery_class IN ('normal', 'automatic_reply')),
      ADD CONSTRAINT drafts_automatic_reply_origin_check CHECK (
        delivery_class <> 'automatic_reply' OR origin = 'workflow'
      )
  `;
  await db`UPDATE mail.drafts SET delivery_class = 'automatic_reply' WHERE origin = 'workflow'`;
  await db`
    ALTER TABLE mail.conversation_local_tags
      DROP CONSTRAINT IF EXISTS conversation_local_tags_assigned_by_actor_kind_check,
      ADD CONSTRAINT conversation_local_tags_assigned_by_actor_kind_check
        CHECK (assigned_by_actor_kind IN ('user', 'service_account', 'workflow'))
  `;
  await db`
    ALTER TABLE mail.conversation_comments
      DROP CONSTRAINT IF EXISTS conversation_comments_author_kind_check,
      ADD CONSTRAINT conversation_comments_author_kind_check CHECK (author_kind IN ('user', 'service_account', 'workflow'))
  `;
  await db`
    ALTER TABLE mail.conversation_comment_versions
      DROP CONSTRAINT IF EXISTS conversation_comment_versions_editor_kind_check,
      ADD CONSTRAINT conversation_comment_versions_editor_kind_check CHECK (editor_kind IN ('user', 'service_account', 'workflow'))
  `;
};

const exposeReviewableWorkflowDrafts = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
      DROP CONSTRAINT drafts_origin_check,
      ADD CONSTRAINT drafts_origin_check CHECK (
        (origin = 'user'
          AND author_kind IN ('user', 'service_account', 'workflow', 'system')
          AND last_editor_kind IN ('user', 'service_account', 'workflow', 'system'))
        OR (origin = 'workflow' AND author_kind = 'workflow' AND last_editor_kind = 'workflow')
      )
  `;
  await db`
    UPDATE mail.drafts
    SET origin = 'user'
    WHERE origin = 'workflow'
      AND delivery_class = 'normal'
  `;
};

const addOperatorMaintenanceCommands = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.commands
    DROP CONSTRAINT IF EXISTS commands_kind_check,
    ADD CONSTRAINT commands_kind_check CHECK (
      kind IN (
        'set_flags', 'change_message_state', 'move', 'copy', 'delete',
        'create_folder', 'rename_folder', 'delete_folder', 'set_folder_subscription', 'send',
        'sync_mailbox', 'sync_folder', 'discover_folders', 'verify_binding', 'rebuild_folder', 'hydrate_missing',
        'rebuild_search', 'rebuild_threads', 'reconcile_effect', 'retry_command', 'cancel_command'
      )
    )
  `;
};

const addOperatorAttentionIndex = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE INDEX IF NOT EXISTS commands_mailbox_attention_idx
    ON mail.commands (mailbox_id, updated_at DESC, id DESC)
    WHERE state IN ('failed', 'ambiguous', 'needs_attention')
  `;
};

const removeConversationSpaceLinks = async (db: SqlClient): Promise<void> => {
  await db`DROP TABLE IF EXISTS mail.conversation_space_links`;
  await db`DELETE FROM mail.schema_migrations WHERE version = 68 AND name = 'conversation_space_links'`;
};

const hardenMailboxScaleIndexes = async (db: SqlClient): Promise<void> => {
  await db`CREATE EXTENSION IF NOT EXISTS btree_gin`;
  await db.unsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS message_placements_folder_unread_idx
    ON mail.message_placements (folder_id, message_id)
    WHERE deleted_at IS NULL AND NOT ('\\Seen' = ANY(flags))
  `);
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN IF NOT EXISTS mailbox_id UUID`;
  for (;;) {
    const updated = await db<{ message_id: string }[]>`
      WITH batch AS (
        SELECT chunk.ctid, message.mailbox_id
        FROM mail.message_search_chunks chunk
        JOIN mail.message_contents message ON message.id = chunk.message_id
        WHERE chunk.mailbox_id IS NULL
        ORDER BY chunk.message_id, chunk.position
        LIMIT 5000
      )
      UPDATE mail.message_search_chunks chunk
      SET mailbox_id = batch.mailbox_id
      FROM batch
      WHERE chunk.ctid = batch.ctid
      RETURNING chunk.message_id
    `;
    if (updated.length < 5000) break;
  }
  await db`
    ALTER TABLE mail.message_search_chunks
    DROP CONSTRAINT IF EXISTS message_search_chunks_mailbox_present_chk
  `;
  await db`
    ALTER TABLE mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_mailbox_present_chk CHECK (mailbox_id IS NOT NULL) NOT VALID
  `;
  await db`
    ALTER TABLE mail.message_search_chunks
    VALIDATE CONSTRAINT message_search_chunks_mailbox_present_chk
  `;
  await db`ALTER TABLE mail.message_search_chunks ALTER COLUMN mailbox_id SET NOT NULL`;
  await db`ALTER TABLE mail.message_search_chunks DROP CONSTRAINT message_search_chunks_mailbox_present_chk`;
  await db.unsafe(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS message_contents_id_mailbox_idx
    ON mail.message_contents (id, mailbox_id)
  `);
  await db`
    ALTER TABLE mail.message_search_chunks
    DROP CONSTRAINT IF EXISTS message_search_chunks_message_mailbox_fkey
  `;
  await db`
    ALTER TABLE mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_message_mailbox_fkey
      FOREIGN KEY (message_id, mailbox_id)
      REFERENCES mail.message_contents(id, mailbox_id)
      ON DELETE CASCADE
      NOT VALID
  `;
  await db`
    ALTER TABLE mail.message_search_chunks
    VALIDATE CONSTRAINT message_search_chunks_message_mailbox_fkey
  `;
  await db.unsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS message_search_chunks_mailbox_document_idx
    ON mail.message_search_chunks USING GIN (mailbox_id, search_document)
  `);

  await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS mail.message_search_chunks_document_idx`);
  await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS mail.message_contents_subject_trgm_idx`);
  await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS mail.message_addresses_trgm_idx`);
  await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS mail.message_placements_flags_idx`);
  await db.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS mail.message_placements_keywords_idx`);
};

const addRuntimeMaintenanceIndexes = async (db: SqlClient): Promise<void> => {
  await db.unsafe(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS sync_runs_terminal_retention_idx
    ON mail.sync_runs ((COALESCE(finished_at, started_at)), id)
    WHERE state <> 'running'
  `);
  const [textSearch] = await db<{ installed: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed
  `;
  if (textSearch?.installed) {
    await db.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS message_contents_bm25_idx
      ON mail.message_contents USING bm25 (
        (COALESCE(subject, '') || ' ' || COALESCE(subject, '') || ' ' || COALESCE(plain_text, ''))
      ) WITH (text_config='simple')
    `);
  }
};

const repairConversationParticipantSummaries = async (db: SqlClient): Promise<void> => {
  let cursor = "00000000-0000-0000-0000-000000000000";
  const batchSize = 500;

  while (true) {
    const batch = await db<{ id: string }[]>`
      SELECT id::text
      FROM mail.conversations
      WHERE id > ${cursor}::uuid
      ORDER BY id
      LIMIT ${batchSize}
    `;
    if (batch.length === 0) return;
    cursor = batch.at(-1)!.id;
    const ids = batch.map((conversation) => conversation.id);

    await db`
      WITH classified AS (
        SELECT
          conversation.id AS conversation_id,
          message.id AS message_id,
          message.internal_date,
          EXISTS (
            SELECT 1
            FROM mail.message_addresses sender
            JOIN mail.sender_identities identity
              ON identity.mailbox_id = conversation.mailbox_id
             AND identity.status <> 'disabled'
             AND lower(identity.from_address) = sender.normalized_email
            WHERE sender.message_id = message.id AND sender.role = 'from'
          ) AS outbound
        FROM mail.conversations conversation
        JOIN mail.conversation_messages link ON link.conversation_id = conversation.id
        JOIN mail.message_contents message ON message.id = link.message_id
        WHERE conversation.id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb)
        )
      ),
      latest AS (
        SELECT DISTINCT ON (conversation_id) conversation_id, message_id, outbound
        FROM classified
        ORDER BY conversation_id, internal_date DESC, message_id DESC
      ),
      participant_labels AS (
        SELECT DISTINCT ON (latest.conversation_id, address.normalized_email)
          latest.conversation_id,
          address.normalized_email,
          COALESCE(NULLIF(address.display_name, ''), address.email) AS label
        FROM latest
        JOIN mail.message_addresses address ON address.message_id = latest.message_id
        WHERE (latest.outbound AND address.role IN ('to', 'cc', 'bcc'))
           OR (NOT latest.outbound AND address.role = 'from')
        ORDER BY latest.conversation_id, address.normalized_email, address.position
      ),
      participants AS (
        SELECT conversation_id, string_agg(label, ', ' ORDER BY label) AS summary
        FROM participant_labels
        GROUP BY conversation_id
      )
      UPDATE mail.conversations conversation
      SET participant_summary = COALESCE(participants.summary, '')
      FROM latest
      LEFT JOIN participants ON participants.conversation_id = latest.conversation_id
      WHERE conversation.id = latest.conversation_id
        AND conversation.participant_summary IS DISTINCT FROM COALESCE(participants.summary, '')
    `;
  }
};

type MailMigration = {
  version: number;
  name: string;
  run: (db: SqlClient) => Promise<void>;
  online?: boolean;
};

const addFolderSidebarVisibility = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.folders
    ADD COLUMN IF NOT EXISTS show_in_sidebar BOOLEAN NOT NULL DEFAULT true
  `;
};

const addDismissedFolderProjections = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.folders
    ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ
  `;
};

const completeSenderIdentities = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.sender_identities
      ADD COLUMN IF NOT EXISTS label TEXT,
      ADD COLUMN IF NOT EXISTS default_cc JSONB NOT NULL DEFAULT '[]'::jsonb
  `;
  await db`
    UPDATE mail.sender_identities
    SET label = COALESCE(NULLIF(btrim(display_name), ''), from_address)
    WHERE label IS NULL OR btrim(label) = ''
  `;
  await db`
    ALTER TABLE mail.sender_identities
      ALTER COLUMN label SET NOT NULL,
      DROP CONSTRAINT IF EXISTS sender_identities_label_chk,
      DROP CONSTRAINT IF EXISTS sender_identities_default_cc_array_chk,
      DROP CONSTRAINT IF EXISTS sender_identities_mailbox_id_from_address_key
  `;
  await db`
    ALTER TABLE mail.sender_identities
      ADD CONSTRAINT sender_identities_label_chk
        CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
      ADD CONSTRAINT sender_identities_default_cc_array_chk
        CHECK (jsonb_typeof(default_cc) = 'array')
  `;
  await db`
    CREATE INDEX IF NOT EXISTS sender_identities_mailbox_from_idx
    ON mail.sender_identities (mailbox_id, lower(from_address), id)
    WHERE status <> 'disabled'
  `;
};

const addMessageProtocolFoundations = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.message_contents
      ADD COLUMN IF NOT EXISTS source_blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS protocol_facts JSONB NOT NULL DEFAULT '{
        "version": 1,
        "returnPath": null,
        "autoSubmitted": null,
        "precedence": null,
        "autoResponseSuppress": null,
        "contentType": null,
        "deliveryStatus": false,
        "list": {
          "id": null,
          "unsubscribe": [],
          "unsubscribePost": null,
          "post": [],
          "help": [],
          "archive": []
        },
        "priority": {
          "importance": null,
          "priority": null,
          "xPriority": null
        },
        "receipts": {
          "dispositionNotificationTo": null
        },
        "spam": {
          "flag": null,
          "status": null,
          "score": null
        }
      }'::jsonb
  `;
  await db`
    ALTER TABLE mail.message_contents
      DROP CONSTRAINT IF EXISTS message_contents_protocol_facts_object_chk,
      ADD CONSTRAINT message_contents_protocol_facts_object_chk
        CHECK (jsonb_typeof(protocol_facts) = 'object')
  `;
  await db`
    UPDATE mail.message_contents
    SET
      protocol_facts = jsonb_build_object(
        'version', 1,
        'returnPath', COALESCE(selected_headers -> 'returnPath', selected_headers -> 'return-path', 'null'::jsonb),
        'autoSubmitted', COALESCE(selected_headers -> 'autoSubmitted', selected_headers -> 'auto-submitted', 'null'::jsonb),
        'precedence', COALESCE(selected_headers -> 'precedence', 'null'::jsonb),
        'autoResponseSuppress',
          COALESCE(selected_headers -> 'autoResponseSuppress', selected_headers -> 'x-auto-response-suppress', 'null'::jsonb),
        'contentType', COALESCE(selected_headers -> 'contentType', selected_headers -> 'content-type', 'null'::jsonb),
        'deliveryStatus',
          COALESCE(
            CASE
              WHEN jsonb_typeof(selected_headers -> 'deliveryStatus') = 'boolean'
                THEN (selected_headers ->> 'deliveryStatus')::boolean
              ELSE NULL
            END,
            COALESCE(selected_headers ->> 'contentType', selected_headers ->> 'content-type', '')
              ~* '(?:^|;)\\s*report-type\\s*=\\s*["'']?delivery-status\\b'
          ),
        'list', jsonb_build_object(
          'id', COALESCE(selected_headers -> 'listId', selected_headers -> 'list-id', 'null'::jsonb),
          'unsubscribe', '[]'::jsonb,
          'unsubscribePost', COALESCE(selected_headers -> 'list-unsubscribe-post', 'null'::jsonb),
          'post', '[]'::jsonb,
          'help', '[]'::jsonb,
          'archive', '[]'::jsonb
        ),
        'priority', jsonb_build_object(
          'importance', COALESCE(selected_headers -> 'importance', 'null'::jsonb),
          'priority', COALESCE(selected_headers -> 'priority', 'null'::jsonb),
          'xPriority', COALESCE(selected_headers -> 'x-priority', 'null'::jsonb)
        ),
        'receipts', jsonb_build_object(
          'dispositionNotificationTo', COALESCE(selected_headers -> 'disposition-notification-to', 'null'::jsonb)
        ),
        'spam', jsonb_build_object(
          'flag', COALESCE(selected_headers -> 'x-spam-flag', 'null'::jsonb),
          'status', COALESCE(selected_headers -> 'x-spam-status', 'null'::jsonb),
          'score', COALESCE(selected_headers -> 'x-spam-score', 'null'::jsonb)
        )
      ),
      selected_headers = selected_headers - ARRAY[
        'returnPath',
        'autoSubmitted',
        'listId',
        'autoResponseSuppress',
        'contentType',
        'deliveryStatus'
      ]::text[]
    WHERE protocol_facts ->> 'version' IS NULL
       OR protocol_facts = '{}'::jsonb
       OR selected_headers ?| ARRAY[
         'returnPath',
         'autoSubmitted',
         'listId',
         'autoResponseSuppress',
         'contentType',
         'deliveryStatus'
       ]::text[]
  `;
  await db`
    CREATE INDEX IF NOT EXISTS message_contents_source_blob_idx
    ON mail.message_contents (source_blob_id)
    WHERE source_blob_id IS NOT NULL
  `;
};

const addMailingListSubscriptions = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS mail.list_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      list_key TEXT NOT NULL CHECK (char_length(list_key) BETWEEN 1 AND 4096),
      state TEXT NOT NULL CHECK (state IN ('requesting', 'unsubscribe_requested', 'failed')),
      method TEXT NOT NULL CHECK (method IN ('one_click')),
      endpoint TEXT NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 2048),
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      requested_at TIMESTAMPTZ,
      last_error_code TEXT CHECK (last_error_code IS NULL OR char_length(last_error_code) <= 200),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, list_key)
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS list_subscriptions_mailbox_requested_idx
    ON mail.list_subscriptions (mailbox_id, requested_at DESC, id DESC)
  `;
  await db`DROP INDEX IF EXISTS mail.message_contents_mailbox_list_id_idx`;
  await db`
    CREATE INDEX IF NOT EXISTS message_contents_mailbox_list_hash_idx
    ON mail.message_contents (
      mailbox_id,
      md5(
        lower(
          btrim(
            CASE
              WHEN protocol_facts #>> '{list,id}' ~ '<[^<>]+>\\s*$'
                THEN regexp_replace(protocol_facts #>> '{list,id}', '^.*<([^<>]+)>\\s*$', '\\1')
              ELSE protocol_facts #>> '{list,id}'
            END
          )
        )
      ),
      internal_date DESC,
      id DESC
    )
    WHERE NULLIF(btrim(protocol_facts #>> '{list,id}'), '') IS NOT NULL
  `;
};

const addProviderLimitSnapshots = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.provider_connections
    ADD COLUMN limit_snapshot JSONB NOT NULL DEFAULT '{
      "checkedAt":"1970-01-01T00:00:00.000Z",
      "imap":{"status":"unavailable","storage":null,"messages":null},
      "smtp":{"status":"unavailable","maxMessageBytes":null}
    }'::jsonb
      CHECK (jsonb_typeof(limit_snapshot) = 'object')
  `;
};

const addOutboundMessagePreflight = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.outbox_submissions
    ADD COLUMN mime_date TIMESTAMPTZ,
    ADD COLUMN preflight_byte_length BIGINT
      CHECK (preflight_byte_length IS NULL OR preflight_byte_length >= 0),
    ADD COLUMN preflight_smtp_limit_bytes BIGINT
      CHECK (preflight_smtp_limit_bytes IS NULL OR preflight_smtp_limit_bytes > 0),
    ADD COLUMN preflight_checked_at TIMESTAMPTZ
  `;
  await db`UPDATE mail.outbox_submissions SET mime_date = created_at WHERE mime_date IS NULL`;
  await db`ALTER TABLE mail.outbox_submissions ALTER COLUMN mime_date SET NOT NULL`;
};

const addPrivacySafeRemoteContent = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS mail.message_remote_images (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0 AND position < 64),
      source_url TEXT NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 8192),
      source_host TEXT NOT NULL CHECK (
        char_length(source_host) BETWEEN 1 AND 253
        AND source_host = lower(source_host)
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (message_id, position)
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS message_remote_images_message_idx
    ON mail.message_remote_images (message_id, position)
  `;
  await db`
    CREATE TABLE IF NOT EXISTS mail.remote_content_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('sender', 'domain')),
      value TEXT NOT NULL CHECK (
        char_length(value) BETWEEN 1 AND 320
        AND value = lower(value)
      ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, actor_kind, actor_id, scope, value)
    )
  `;
  await db`
    CREATE INDEX IF NOT EXISTS remote_content_rules_principal_idx
    ON mail.remote_content_rules (mailbox_id, actor_kind, actor_id, scope, value)
  `;
};

const addIdentityDeliveryOptions = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.sender_identities
      ADD COLUMN default_bcc JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN default_format TEXT NOT NULL DEFAULT 'markdown',
      ADD COLUMN default_priority TEXT NOT NULL DEFAULT 'normal',
      ADD COLUMN default_delivery_receipt BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN default_read_receipt BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN vcard TEXT
  `;
  await db`
    ALTER TABLE mail.sender_identities
      ADD CONSTRAINT sender_identities_default_bcc_array_chk
        CHECK (jsonb_typeof(default_bcc) = 'array'),
      ADD CONSTRAINT sender_identities_default_format_chk
        CHECK (default_format IN ('plain', 'markdown')),
      ADD CONSTRAINT sender_identities_default_priority_chk
        CHECK (default_priority IN ('low', 'normal', 'high')),
      ADD CONSTRAINT sender_identities_vcard_size_chk
        CHECK (vcard IS NULL OR octet_length(vcard) <= 262144)
  `;
  await db`
    ALTER TABLE mail.drafts
      ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal',
      ADD COLUMN request_delivery_receipt BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN request_read_receipt BOOLEAN NOT NULL DEFAULT false,
      ADD CONSTRAINT drafts_priority_chk CHECK (priority IN ('low', 'normal', 'high'))
  `;
  await db`
    ALTER TABLE mail.outbox_submissions
      ADD COLUMN selected_identity_transport_revision INTEGER
        CHECK (selected_identity_transport_revision IS NULL OR selected_identity_transport_revision > 0)
  `;
  await db`
    CREATE TABLE mail.sender_identity_transports (
      sender_identity_id UUID PRIMARY KEY,
      mailbox_id UUID NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
      tls_mode TEXT NOT NULL CHECK (tls_mode IN ('implicit', 'starttls')),
      username TEXT NOT NULL,
      secret_kind TEXT NOT NULL CHECK (secret_kind IN ('password', 'oauth2')),
      encrypted_secret TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'revoked')),
      capabilities JSONB NOT NULL DEFAULT '{"dsn":false,"size":false,"maxMessageBytes":null}'::jsonb,
      last_verified_at TIMESTAMPTZ,
      last_error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (mailbox_id, sender_identity_id)
        REFERENCES mail.sender_identities (mailbox_id, id) ON DELETE CASCADE,
      CONSTRAINT sender_identity_transports_capabilities_object_chk
        CHECK (jsonb_typeof(capabilities) = 'object')
    )
  `;
  await db`
    CREATE INDEX sender_identity_transports_mailbox_idx
    ON mail.sender_identity_transports (mailbox_id, sender_identity_id)
  `;
  await db`
    CREATE TABLE mail.message_receipt_reports (
      report_message_id UUID PRIMARY KEY REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      conversation_id UUID NOT NULL REFERENCES mail.conversations(id) ON DELETE CASCADE,
      outbox_submission_id UUID NOT NULL REFERENCES mail.outbox_submissions(id) ON DELETE CASCADE,
      activity_id BIGINT NOT NULL UNIQUE REFERENCES mail.activity_events(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('delivery', 'read')),
      status TEXT NOT NULL CHECK (
        status IN ('delivered', 'delayed', 'failed', 'relayed', 'expanded', 'displayed', 'deleted', 'denied', 'other')
      ),
      original_envelope_id UUID,
      original_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT message_receipt_reports_correlation_chk CHECK (
        original_envelope_id IS NOT NULL OR original_message_id IS NOT NULL
      )
    )
  `;
  await db`
    CREATE INDEX message_receipt_reports_outbox_idx
    ON mail.message_receipt_reports (outbox_submission_id, created_at DESC)
  `;
};

const addComposerSafetyAndMessageReuse = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.mailboxes
    ADD COLUMN compose_safety JSONB NOT NULL DEFAULT '{
      "internalDomains":[],
      "largeRecipientThreshold":20
    }'::jsonb
      CHECK (jsonb_typeof(compose_safety) = 'object')
  `;
  await db`
    ALTER TABLE mail.drafts
    ADD COLUMN derived_from_message_id UUID REFERENCES mail.message_contents(id) ON DELETE RESTRICT,
    ADD COLUMN derivation_kind TEXT CHECK (derivation_kind IN ('edit_as_new', 'resend')),
    ADD CONSTRAINT drafts_derivation_shape_chk CHECK (
      (derived_from_message_id IS NULL AND derivation_kind IS NULL)
      OR (
        derived_from_message_id IS NOT NULL
        AND derivation_kind IS NOT NULL
        AND intent = 'new'
        AND conversation_id IS NULL
        AND source_message_id IS NULL
      )
    )
  `;
  await db`
    CREATE INDEX drafts_derived_message_idx
    ON mail.drafts (mailbox_id, derived_from_message_id, created_at DESC)
    WHERE derived_from_message_id IS NOT NULL
  `;
  await db`
    ALTER TABLE mail.outbox_submissions
    ADD COLUMN safety_review JSONB NOT NULL DEFAULT '{
      "fingerprint":null,
      "warningIds":[],
      "approved":false
    }'::jsonb
      CHECK (jsonb_typeof(safety_review) = 'object')
  `;
};

const addDraftDerivationIdempotency = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
    DROP CONSTRAINT drafts_derivation_shape_chk,
    ADD COLUMN derivation_key TEXT,
    ADD COLUMN derivation_request_hash TEXT CHECK (
      derivation_request_hash IS NULL OR derivation_request_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT drafts_derivation_shape_chk CHECK (
      (
        derived_from_message_id IS NULL
        AND derivation_kind IS NULL
        AND derivation_key IS NULL
        AND derivation_request_hash IS NULL
      )
      OR (
        derived_from_message_id IS NOT NULL
        AND derivation_kind IS NOT NULL
        AND derivation_key IS NOT NULL
        AND derivation_request_hash IS NOT NULL
        AND intent = 'new'
        AND conversation_id IS NULL
        AND source_message_id IS NULL
      )
    )
  `;
  await db`
    CREATE UNIQUE INDEX drafts_derivation_idempotency_idx
    ON mail.drafts (mailbox_id, author_kind, author_id, derivation_key)
    WHERE derivation_key IS NOT NULL
  `;
};

const addManagedMailRules = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.mail_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 120
      ),
      match_kind TEXT NOT NULL CHECK (match_kind IN ('sender', 'domain')),
      match_value TEXT NOT NULL CHECK (
        match_value = lower(btrim(match_value))
        AND char_length(match_value) BETWEEN 1 AND 320
      ),
      action JSONB NOT NULL CHECK (
        jsonb_typeof(action) = 'object'
        AND action ? 'kind'
        AND action->>'kind' IN ('junk', 'trash', 'mark_read', 'add_keyword')
      ),
      enabled BOOLEAN NOT NULL DEFAULT true,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      FOREIGN KEY (workflow_id, mailbox_id)
        REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE CASCADE,
      UNIQUE (workflow_id)
    )
  `;
  await db`
    CREATE UNIQUE INDEX mail_rules_mailbox_name_idx
    ON mail.mail_rules (mailbox_id, normalized_name)
    WHERE deleted_at IS NULL
  `;
  await db`
    CREATE INDEX mail_rules_mailbox_idx
    ON mail.mail_rules (mailbox_id, enabled DESC, normalized_name, id)
  `;
  await db`
    CREATE TRIGGER mail_rules_touch_updated_at
    BEFORE UPDATE ON mail.mail_rules
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const hardenManagedMailRules = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.mail_rules
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS mail_rules_mailbox_name_idx
    ON mail.mail_rules (mailbox_id, normalized_name)
    WHERE deleted_at IS NULL
  `;
};

const addSenderReadBatches = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.sender_read_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 150),
      match_kind TEXT NOT NULL CHECK (match_kind IN ('sender', 'domain')),
      match_value TEXT NOT NULL CHECK (char_length(match_value) BETWEEN 1 AND 320),
      command_ids UUID[] NOT NULL DEFAULT ARRAY[]::uuid[],
      capped BOOLEAN NOT NULL,
      application_limit INTEGER NOT NULL CHECK (application_limit > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, actor_kind, actor_id, idempotency_key)
    )
  `;
};

/** Mail-owned state for the shared workflow kernel. There is no pre-release table bridge. */
const addWorkflowKernelProfile = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.workflow_profile (
      id UUID PRIMARY KEY REFERENCES workflows.workflow(id) ON DELETE CASCADE,
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN -1000 AND 1000),
      enabled BOOLEAN NOT NULL DEFAULT false,
      managed_by TEXT CHECK (managed_by IS NULL OR managed_by IN ('automatic_reply', 'mail_rule')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id, mailbox_id)
    )
  `;
  await db`
    CREATE INDEX workflow_profile_mailbox_priority_idx
    ON mail.workflow_profile (mailbox_id, priority, id)
  `;
  await db`
    CREATE TRIGGER workflow_profile_touch_updated_at
    BEFORE UPDATE ON mail.workflow_profile
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
  await db`
    CREATE TABLE mail.workflow_run_state (
      run_id UUID PRIMARY KEY REFERENCES workflows.run(id) ON DELETE CASCADE,
      frozen_hydration JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(frozen_hydration) = 'object'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
};

const addProviderOAuthSentMode = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.provider_oauth_flows
    ADD COLUMN IF NOT EXISTS saves_sent_automatically BOOLEAN NOT NULL DEFAULT false
  `;
};

const addCanonicalOutboundMessages = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.outbox_submissions
    ADD COLUMN IF NOT EXISTS message_id UUID
  `;
  await db`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'outbox_submissions_message_id_fkey'
          AND conrelid = 'mail.outbox_submissions'::regclass
      ) THEN
        ALTER TABLE mail.outbox_submissions
        ADD CONSTRAINT outbox_submissions_message_id_fkey
          FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE SET NULL;
      END IF;
    END
    $$
  `;
  await db`
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_submissions_message_idx
    ON mail.outbox_submissions (message_id)
    WHERE message_id IS NOT NULL
  `;
  await db`
    ALTER TABLE mail.conversation_messages
    DROP CONSTRAINT IF EXISTS conversation_messages_added_by_check
  `;
  await db`
    ALTER TABLE mail.conversation_messages
    ADD CONSTRAINT conversation_messages_added_by_check
      CHECK (added_by IN ('provider', 'headers', 'heuristic', 'manual', 'outbox'))
  `;
};

const addComposableMailRuleActions = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.mail_rules DROP CONSTRAINT IF EXISTS mail_rules_action_check`;
  await db`ALTER TABLE mail.mail_rules RENAME COLUMN action TO actions`;
  await db`
    UPDATE mail.mail_rules
    SET actions = jsonb_build_array(actions)
    WHERE jsonb_typeof(actions) = 'object'
  `;
  await db`
    ALTER TABLE mail.mail_rules
    ADD CONSTRAINT mail_rules_actions_check CHECK (
      jsonb_typeof(actions) = 'array'
      AND jsonb_array_length(actions) BETWEEN 1 AND 8
    )
  `;
};

const addMailRuleBackfillPointer = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.mail_rules
    ADD COLUMN latest_backfill_operation_id UUID
  `;
};

const addDraftMaterializationIdempotency = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.drafts
    ADD COLUMN materialization_key TEXT,
    ADD COLUMN materialization_request_hash TEXT CHECK (
      materialization_request_hash IS NULL OR materialization_request_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT drafts_materialization_shape_chk CHECK (
      (materialization_key IS NULL AND materialization_request_hash IS NULL)
      OR (materialization_key IS NOT NULL AND materialization_request_hash IS NOT NULL)
    )
  `;
  await db`
    CREATE UNIQUE INDEX drafts_materialization_idempotency_idx
    ON mail.drafts (mailbox_id, author_kind, author_id, materialization_key)
    WHERE materialization_key IS NOT NULL
  `;
};

const generalizeMailRules = async (db: SqlClient): Promise<void> => {
  await db`
    DO $$
    BEGIN
      IF to_regclass('mail.sender_rules') IS NOT NULL
        AND to_regclass('mail.mail_rules') IS NULL
      THEN
        ALTER TABLE mail.sender_rules RENAME TO mail_rules;
      END IF;
    END
    $$
  `;
  await db`
    ALTER TABLE mail.mail_rules
    ADD COLUMN IF NOT EXISTS conditions JSONB
  `;
  await db`
    UPDATE mail.mail_rules
    SET conditions = jsonb_build_object(
      'mode', 'all',
      'items', jsonb_build_array(
        jsonb_build_object(
          'field', CASE match_kind WHEN 'sender' THEN 'sender_address' ELSE 'sender_domain' END,
          'operator', 'is',
          'value', match_value
        )
      )
    )
    WHERE conditions IS NULL
  `;
  await db`
    ALTER TABLE mail.mail_rules
    ALTER COLUMN conditions SET NOT NULL,
    ADD CONSTRAINT mail_rules_conditions_chk CHECK (
      jsonb_typeof(conditions) = 'object'
      AND conditions->>'mode' IN ('all', 'any')
      AND jsonb_typeof(conditions->'items') = 'array'
      AND jsonb_array_length(conditions->'items') BETWEEN 1 AND 8
    ),
    DROP COLUMN match_kind,
    DROP COLUMN match_value
  `;
  await db`
    ALTER TABLE mail.workflow_profile
    DROP CONSTRAINT IF EXISTS workflow_profile_managed_by_check
  `;
  await db`
    UPDATE mail.workflow_profile
    SET managed_by = 'mail_rule'
    WHERE managed_by = 'sender_rule'
  `;
  await db`
    ALTER TABLE mail.workflow_profile
    ADD CONSTRAINT workflow_profile_managed_by_check
      CHECK (managed_by IS NULL OR managed_by IN ('automatic_reply', 'mail_rule'))
  `;
};

const canonicalizeMailRuleObjectNames = async (db: SqlClient): Promise<void> => {
  await db`
    DO $$
    BEGIN
      IF to_regclass('mail.sender_rules_mailbox_name_idx') IS NOT NULL
        AND to_regclass('mail.mail_rules_mailbox_name_idx') IS NULL
      THEN
        ALTER INDEX mail.sender_rules_mailbox_name_idx RENAME TO mail_rules_mailbox_name_idx;
      END IF;
      IF to_regclass('mail.sender_rules_mailbox_idx') IS NOT NULL
        AND to_regclass('mail.mail_rules_mailbox_idx') IS NULL
      THEN
        ALTER INDEX mail.sender_rules_mailbox_idx RENAME TO mail_rules_mailbox_idx;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'mail.mail_rules'::regclass
          AND tgname = 'sender_rules_touch_updated_at'
          AND NOT tgisinternal
      ) THEN
        ALTER TRIGGER sender_rules_touch_updated_at ON mail.mail_rules RENAME TO mail_rules_touch_updated_at;
      END IF;
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'mail.mail_rules'::regclass
          AND conname = 'sender_rules_actions_check'
      ) THEN
        ALTER TABLE mail.mail_rules
        RENAME CONSTRAINT sender_rules_actions_check TO mail_rules_actions_check;
      END IF;
    END
    $$
  `;
};

const addMailboxCalendarDestination = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.mailboxes ADD COLUMN calendar_space_id UUID`;
};

const addMailSecurityOperations = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.security_settings (
      singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      trusted_authserv_ids TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      updated_by_user_id UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await db`INSERT INTO mail.security_settings (singleton) VALUES (true)`;
  await db`
    CREATE TABLE mail.security_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      disposition TEXT NOT NULL CHECK (disposition IN ('deny', 'trust')),
      target TEXT NOT NULL CHECK (target IN ('sender_address', 'sender_domain', 'link_domain')),
      value TEXT NOT NULL CHECK (char_length(value) BETWEEN 1 AND 320 AND value = lower(value)),
      note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (disposition, target, value),
      CHECK (disposition = 'deny' OR target IN ('sender_address', 'sender_domain'))
    )
  `;
  await db`CREATE INDEX security_policies_active_idx ON mail.security_policies (disposition, target, value) WHERE enabled`;
  await db`
    CREATE TABLE mail.protected_identities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
      normalized_name TEXT NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 160),
      allowed_domains TEXT[] NOT NULL CHECK (cardinality(allowed_domains) BETWEEN 1 AND 20),
      note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (normalized_name)
    )
  `;
  await db`
    CREATE TABLE mail.security_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      message_id UUID NOT NULL REFERENCES mail.message_contents(id) ON DELETE CASCADE,
      sender_address TEXT CHECK (sender_address IS NULL OR char_length(sender_address) <= 320),
      sender_domain TEXT CHECK (sender_domain IS NULL OR char_length(sender_domain) <= 253),
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'confirmed', 'dismissed')),
      report_count INTEGER NOT NULL DEFAULT 1 CHECK (report_count > 0),
      assessment JSONB NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
      resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 1000),
      reviewed_by_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, message_id)
    )
  `;
  await db`CREATE INDEX security_reports_status_idx ON mail.security_reports (status, updated_at DESC, id DESC)`;
  await db`
    CREATE TABLE mail.security_report_sources (
      report_id UUID NOT NULL REFERENCES mail.security_reports(id) ON DELETE CASCADE,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'service_account')),
      actor_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (report_id, actor_kind, actor_id)
    )
  `;
};

const hardenMailSecurityOperations = async (db: SqlClient): Promise<void> => {
  await db`DROP TABLE IF EXISTS mail.message_security_assessments`;
  await db`
    ALTER TABLE mail.security_reports
      ADD COLUMN IF NOT EXISTS sender_address TEXT CHECK (sender_address IS NULL OR char_length(sender_address) <= 320),
      ADD COLUMN IF NOT EXISTS sender_domain TEXT CHECK (sender_domain IS NULL OR char_length(sender_domain) <= 253)
  `;
};

const addGuidedAiAutomations = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.workflow_profile DROP CONSTRAINT workflow_profile_managed_by_check`;
  await db`
    ALTER TABLE mail.workflow_profile
    ADD CONSTRAINT workflow_profile_managed_by_check
    CHECK (managed_by IS NULL OR managed_by IN ('automatic_reply', 'mail_rule', 'ai_automation'))
  `;
  await db`
    CREATE TABLE mail.ai_automations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      normalized_name TEXT NOT NULL CHECK (char_length(normalized_name) BETWEEN 1 AND 120),
      enabled BOOLEAN NOT NULL DEFAULT false,
      scope JSONB NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
      definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id, mailbox_id),
      UNIQUE (workflow_id, mailbox_id),
      FOREIGN KEY (workflow_id, mailbox_id)
        REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE CASCADE
    )
  `;
  await db`
    CREATE UNIQUE INDEX ai_automations_mailbox_name_idx
    ON mail.ai_automations (mailbox_id, normalized_name)
    WHERE deleted_at IS NULL
  `;
  await db`
    CREATE INDEX ai_automations_mailbox_idx
    ON mail.ai_automations (mailbox_id, enabled DESC, normalized_name, id)
    WHERE deleted_at IS NULL
  `;
  await db`
    CREATE TRIGGER ai_automations_touch_updated_at
    BEFORE UPDATE ON mail.ai_automations
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const unifyIncomingAutomations = async (db: SqlClient): Promise<void> => {
  await db`
    DELETE FROM workflows.workflow
    WHERE id IN (
      SELECT id
      FROM mail.workflow_profile
      WHERE managed_by IN ('mail_rule', 'ai_automation')
    )
  `;
  await db`DROP TABLE mail.ai_automations`;
  await db`DROP TABLE mail.mail_rules`;
  await db`ALTER TABLE mail.workflow_profile DROP CONSTRAINT workflow_profile_managed_by_check`;
  await db`
    ALTER TABLE mail.workflow_profile
    ADD CONSTRAINT workflow_profile_managed_by_check
    CHECK (managed_by IS NULL OR managed_by IN ('automatic_reply', 'incoming_automation'))
  `;
  await db`
    CREATE TABLE mail.incoming_automations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL CONSTRAINT incoming_automations_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$'),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      workflow_id UUID NOT NULL,
      name TEXT NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
      normalized_name TEXT NOT NULL CHECK (
        normalized_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))
        AND char_length(normalized_name) BETWEEN 1 AND 120
      ),
      enabled BOOLEAN NOT NULL DEFAULT false,
      scope JSONB NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND scope ? 'mode'),
      steps JSONB NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 20),
      latest_backfill_operation_id UUID,
      created_by_actor_kind TEXT NOT NULL CHECK (created_by_actor_kind IN ('user', 'service_account')),
      created_by_actor_id UUID NOT NULL,
      revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (id, mailbox_id),
      UNIQUE (workflow_id, mailbox_id),
      FOREIGN KEY (workflow_id, mailbox_id)
        REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE CASCADE
    )
  `;
  await db`
    CREATE UNIQUE INDEX incoming_automations_mailbox_name_idx
    ON mail.incoming_automations (mailbox_id, normalized_name)
    WHERE deleted_at IS NULL
  `;
  await db`
    CREATE INDEX incoming_automations_mailbox_idx
    ON mail.incoming_automations (mailbox_id, enabled DESC, normalized_name, id)
    WHERE deleted_at IS NULL
  `;
  await db`
    CREATE TRIGGER incoming_automations_touch_updated_at
    BEFORE UPDATE ON mail.incoming_automations
    FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at()
  `;
};

const resetIncomingAutomationAuthoringModel = async (db: SqlClient): Promise<void> => {
  await db`
    DELETE FROM workflows.workflow
    WHERE id IN (
      SELECT workflow_id
      FROM mail.incoming_automations
    )
  `;
  await db`DELETE FROM mail.incoming_automations`;
};

const addConversationSummaries = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.conversations
    ADD COLUMN summary TEXT,
    ADD COLUMN summary_revision BIGINT NOT NULL DEFAULT 1 CHECK (summary_revision > 0)
  `;
};

const addIncomingAutomationIntegrationCredentials = async (db: SqlClient): Promise<void> => {
  await db`
    ALTER TABLE mail.incoming_automations
    ADD COLUMN integration_credential_id UUID,
    ADD COLUMN encrypted_integration_token TEXT
  `;
  await db`
    ALTER TABLE mail.incoming_automations
    ADD CONSTRAINT incoming_automations_integration_credential_shape CHECK (
      (integration_credential_id IS NULL) = (encrypted_integration_token IS NULL)
    )
  `;
};

const installLiveInvalidationEnqueue = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE OR REPLACE FUNCTION mail.enqueue_live_invalidation(
      target_mailbox_id UUID,
      target_conversation_id UUID DEFAULT NULL
    )
    RETURNS UUID
    LANGUAGE plpgsql
    AS $$
    DECLARE
      invalidation_id UUID;
      current_transaction_key TEXT := pg_current_xact_id()::text;
    BEGIN
      INSERT INTO mail.live_invalidation_outbox (
        mailbox_id,
        mailbox_short_id,
        conversation_id,
        conversation_short_id,
        transaction_key
      )
      SELECT
        mailbox.id,
        mailbox.short_id,
        conversation.id,
        conversation.short_id,
        current_transaction_key
      FROM mail.mailboxes mailbox
      LEFT JOIN mail.conversations conversation
        ON conversation.id = target_conversation_id
       AND conversation.mailbox_id = mailbox.id
      WHERE mailbox.id = target_mailbox_id
        AND (target_conversation_id IS NULL OR conversation.id IS NOT NULL)
      ON CONFLICT DO NOTHING
      RETURNING id INTO invalidation_id;

      IF invalidation_id IS NULL THEN
        SELECT id INTO invalidation_id
        FROM mail.live_invalidation_outbox
        WHERE mailbox_id = target_mailbox_id
          AND conversation_id IS NOT DISTINCT FROM target_conversation_id
          AND transaction_key = current_transaction_key;
      END IF;
      RETURN invalidation_id;
    END;
    $$
  `;
};

const addLiveInvalidationOutbox = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.live_invalidation_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mailbox_id UUID NOT NULL REFERENCES mail.mailboxes(id) ON DELETE CASCADE,
      mailbox_short_id TEXT NOT NULL
        CONSTRAINT live_invalidation_outbox_mailbox_short_id_format CHECK (mailbox_short_id ~ '^[0-9A-Za-z]{6}$'),
      conversation_id UUID,
      conversation_short_id TEXT
        CONSTRAINT live_invalidation_outbox_conversation_short_id_format
        CHECK (conversation_short_id IS NULL OR conversation_short_id ~ '^[0-9A-Za-z]{6}$'),
      transaction_key TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_until TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      last_error TEXT CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (mailbox_id, conversation_id, transaction_key)
    )
  `;
  await db`
    CREATE UNIQUE INDEX live_invalidation_outbox_mailbox_transaction_idx
    ON mail.live_invalidation_outbox (mailbox_id, transaction_key)
    WHERE conversation_id IS NULL
  `;
  await db`
    CREATE INDEX live_invalidation_outbox_pending_idx
    ON mail.live_invalidation_outbox (next_attempt_at, created_at, id)
    WHERE delivered_at IS NULL
  `;
  await db`
    CREATE INDEX live_invalidation_outbox_delivered_idx
    ON mail.live_invalidation_outbox (delivered_at)
    WHERE delivered_at IS NOT NULL
  `;
  await installLiveInvalidationEnqueue(db);
  await db`
    CREATE OR REPLACE FUNCTION mail.enqueue_activity_live_invalidation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM mail.enqueue_live_invalidation(NEW.mailbox_id, NEW.conversation_id);
      RETURN NEW;
    END;
    $$
  `;
  await db`
    CREATE TRIGGER activity_events_enqueue_live_invalidation
    AFTER INSERT ON mail.activity_events
    FOR EACH ROW EXECUTE FUNCTION mail.enqueue_activity_live_invalidation()
  `;
};

const detachLiveInvalidationScope = async (db: SqlClient): Promise<void> => {
  await db`ALTER TABLE mail.live_invalidation_outbox ADD COLUMN IF NOT EXISTS mailbox_short_id TEXT`;
  await db`ALTER TABLE mail.live_invalidation_outbox ADD COLUMN IF NOT EXISTS conversation_short_id TEXT`;
  await installLiveInvalidationEnqueue(db);
};

const PUBLIC_SHORT_ID_TABLES = [
  "mailboxes",
  "folders",
  "message_contents",
  "attachments",
  "conversations",
  "sender_identities",
  "drafts",
  "outbox_submissions",
  "draft_attachments",
  "conversation_comments",
  "conversation_reminders",
  "saved_conversation_views",
  "local_tags",
  "compose_templates",
  "automatic_reply_configurations",
  "incoming_automations",
] as const;

const finalizePublicShortIds = async (db: SqlClient): Promise<void> => {
  for (const table of PUBLIC_SHORT_ID_TABLES) {
    await db.unsafe(`ALTER TABLE mail.${table} ADD COLUMN IF NOT EXISTS short_id TEXT`);
    await db.unsafe(`ALTER TABLE mail.${table} ALTER COLUMN short_id SET NOT NULL`);
    await db.unsafe(`ALTER TABLE mail.${table} DROP CONSTRAINT IF EXISTS ${table}_short_id_format`);
    await db.unsafe(`
      ALTER TABLE mail.${table}
      ADD CONSTRAINT ${table}_short_id_format CHECK (short_id ~ '^[0-9A-Za-z]{6}$')
    `);
    await db.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_short_id_idx ON mail.${table} (short_id)`);
  }

  await db`ALTER TABLE mail.live_invalidation_outbox ADD COLUMN IF NOT EXISTS mailbox_short_id TEXT`;
  await db`ALTER TABLE mail.live_invalidation_outbox ADD COLUMN IF NOT EXISTS conversation_short_id TEXT`;
  await db`ALTER TABLE mail.live_invalidation_outbox ALTER COLUMN mailbox_short_id SET NOT NULL`;
  await db`
    ALTER TABLE mail.live_invalidation_outbox
    DROP CONSTRAINT IF EXISTS live_invalidation_outbox_mailbox_short_id_format
  `;
  await db`
    ALTER TABLE mail.live_invalidation_outbox
    ADD CONSTRAINT live_invalidation_outbox_mailbox_short_id_format
    CHECK (mailbox_short_id ~ '^[0-9A-Za-z]{6}$')
  `;
  await db`
    ALTER TABLE mail.live_invalidation_outbox
    DROP CONSTRAINT IF EXISTS live_invalidation_outbox_conversation_short_id_format
  `;
  await db`
    ALTER TABLE mail.live_invalidation_outbox
    ADD CONSTRAINT live_invalidation_outbox_conversation_short_id_format
    CHECK (conversation_short_id IS NULL OR conversation_short_id ~ '^[0-9A-Za-z]{6}$')
  `;

  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    ADD COLUMN IF NOT EXISTS source_short_id TEXT
  `;
  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    ALTER COLUMN source_short_id SET NOT NULL
  `;
  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    DROP CONSTRAINT IF EXISTS collaboration_notification_deliveries_source_short_id_format
  `;
  await db`
    ALTER TABLE mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_source_short_id_format
    CHECK (source_short_id ~ '^[0-9A-Za-z]{6}$')
  `;

  // Migration 116 may already exist with the UUID-only function body. Reinstall
  // after every public ID column is final so upgraded databases snapshot the
  // public envelope before a source row can be deleted.
  await installLiveInvalidationEnqueue(db);
};

const flattenConversationComments = async (db: SqlClient): Promise<void> => {
  await db`
    UPDATE mail.activity_events
    SET metadata = metadata - 'parentCommentId'
    WHERE metadata ? 'parentCommentId'
  `;
  await db`ALTER TABLE mail.conversation_comments DROP COLUMN IF EXISTS parent_comment_id`;
};

const addAttachmentDocumentExtraction = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE mail.attachment_extractions (
      blob_id UUID NOT NULL REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE,
      extractor_version TEXT NOT NULL CHECK (char_length(extractor_version) BETWEEN 1 AND 100),
      status TEXT NOT NULL CHECK (
        status IN (
          'pending', 'complete', 'unsupported', 'encrypted', 'ocr_required',
          'resource_limit', 'malformed', 'failed'
        )
      ),
      format TEXT,
      markdown TEXT,
      input_bytes BIGINT CHECK (input_bytes IS NULL OR input_bytes >= 0),
      output_bytes BIGINT CHECK (output_bytes IS NULL OR output_bytes >= 0),
      truncated BOOLEAN NOT NULL DEFAULT false,
      error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      PRIMARY KEY (blob_id, extractor_version),
      CHECK (
        (status = 'complete' AND markdown IS NOT NULL AND completed_at IS NOT NULL)
        OR (status <> 'complete' AND markdown IS NULL)
      )
    )
  `;
  await db`
    CREATE INDEX attachment_extractions_recovery_idx
    ON mail.attachment_extractions (next_attempt_at, updated_at, blob_id)
    WHERE status IN ('pending', 'failed')
  `;

  await db`ALTER TABLE mail.message_search_chunks DROP CONSTRAINT message_search_chunks_pkey`;
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN id BIGINT GENERATED ALWAYS AS IDENTITY`;
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'body'`;
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN attachment_id UUID REFERENCES mail.attachments(id) ON DELETE CASCADE`;
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN blob_id UUID REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE`;
  await db`ALTER TABLE mail.message_search_chunks ADD COLUMN extractor_version TEXT`;
  await db`ALTER TABLE mail.message_search_chunks ADD PRIMARY KEY (id)`;
  await db`
    ALTER TABLE mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_source_chk CHECK (
      (source_kind = 'body' AND attachment_id IS NULL AND blob_id IS NULL AND extractor_version IS NULL)
      OR
      (source_kind = 'attachment' AND attachment_id IS NOT NULL AND blob_id IS NOT NULL AND extractor_version IS NOT NULL)
    )
  `;
  await db`
    CREATE UNIQUE INDEX message_search_chunks_body_source_idx
    ON mail.message_search_chunks (message_id, position)
    WHERE source_kind = 'body'
  `;
  await db`
    CREATE UNIQUE INDEX message_search_chunks_attachment_source_idx
    ON mail.message_search_chunks (attachment_id, extractor_version, position)
    WHERE source_kind = 'attachment'
  `;
  await db`
    CREATE INDEX message_search_chunks_attachment_projection_idx
    ON mail.message_search_chunks (blob_id, extractor_version, attachment_id)
    WHERE source_kind = 'attachment'
  `;
};

const migrations: readonly MailMigration[] = [
  { version: 1, name: "initial_mail_schema", run: createInitialSchema },
  { version: 2, name: "message_hydration_claims", run: addHydrationClaims },
  { version: 3, name: "message_threading_projection", run: addThreadingProjection },
  { version: 4, name: "field_search_documents", run: addFieldSearchDocuments },
  { version: 5, name: "optional_bm25_index", run: addOptionalBm25Index },
  { version: 6, name: "durable_draft_snapshots", run: addDurableDraftSnapshots },
  { version: 7, name: "durable_command_execution", run: addDurableCommandExecution },
  { version: 8, name: "bounded_hydration_retries", run: addBoundedHydrationRetries },
  { version: 9, name: "chunked_body_search", run: addChunkedBodySearch },
  { version: 10, name: "search_backend_modes", run: addSearchBackendModes },
  { version: 11, name: "credential_revision_bindings", run: addCredentialRevisionBindings },
  { version: 12, name: "command_worker_heartbeats", run: addCommandWorkerHeartbeats },
  { version: 13, name: "lifecycle_control_plane", run: addLifecycleControlPlane },
  { version: 14, name: "provider_backed_operations", run: addProviderBackedOperations },
  { version: 15, name: "provider_backed_operations_hardening", run: hardenProviderBackedOperations },
  { version: 16, name: "conversation_collaboration", run: addConversationCollaboration },
  { version: 17, name: "workflow_kernel_profile", run: addWorkflowKernelProfile },
  { version: 22, name: "conversation_thread_overrides", run: addConversationThreadOverrides },
  { version: 23, name: "collaboration_operations", run: addCollaborationOperations },
  { version: 25, name: "verified_source_identity_lookup", run: addVerifiedSourceIdentityLookup },
  { version: 32, name: "fenced_workflow_provider_effects", run: fenceWorkflowProviderEffects },
  { version: 33, name: "durable_draft_continuity", run: addDurableDraftContinuity },
  { version: 34, name: "hardened_draft_continuity", run: hardenDurableDraftContinuity },
  { version: 35, name: "mailbox_owned_provider_connections", run: hardCutMailboxOwnedConnections },
  { version: 36, name: "mailbox_owned_provider_binding_invariants", run: hardCutMailboxOwnedConnections },
  { version: 37, name: "structured_search_local_tags", run: addStructuredSearchAndLocalTags },
  { version: 38, name: "conversation_references_response_policies", run: addConversationReferencesAndResponsePolicies },
  { version: 39, name: "conversation_references_response_policies_hardening", run: hardenConversationReferencesAndResponsePolicies },
  { version: 40, name: "conversation_reference_merge_semantics", run: finalizeConversationReferenceMergeSemantics },
  { version: 41, name: "automatic_reply_execution_hardening", run: hardenAutomaticReplyExecution },
  { version: 42, name: "search_reference_rolling_compatibility", run: installSearchReferenceCompatibility },
  { version: 43, name: "response_policy_execution_repairs", run: repairResponsePolicyExecution },
  { version: 44, name: "conversation_reference_request_ledger", run: addConversationReferenceRequestLedger },
  { version: 45, name: "compose_templates_and_styles", run: addComposeTemplatesAndStyles },
  { version: 46, name: "compose_template_reference_hardening", run: hardenComposeTemplateReferences },
  { version: 47, name: "stable_scheduled_send_ordering", run: addStableScheduledSendOrdering },
  { version: 48, name: "stable_scheduled_send_ordering_guard", run: guardStableScheduledSendOrdering },
  { version: 49, name: "provider_binding_account_evidence", run: normalizeProviderBindingAccountEvidence },
  { version: 50, name: "managed_automatic_reply_configurations", run: addManagedAutomaticReplyConfigurations },
  { version: 51, name: "managed_automatic_reply_invariants", run: hardenManagedAutomaticReplyConfigurations },
  { version: 52, name: "automatic_reply_delivery_timestamps", run: addAutomaticReplyDeliveryTimestamps },
  { version: 53, name: "automatic_reply_delivery_timestamp_guard", run: guardAutomaticReplyDeliveryTimestamps },
  { version: 54, name: "sender_automation_ready_by_default", run: defaultSenderAutomationToMailbox },
  { version: 55, name: "automatic_reply_management_permission", run: addAutomaticReplyManagementPermission },
  { version: 56, name: "inline_automatic_reply_schedule_schema", run: inlineAutomaticReplyScheduleSchema },
  { version: 57, name: "single_reference_number_configuration", run: simplifyConversationReferenceConfiguration },
  { version: 58, name: "generic_imap_draft_projection", run: addGenericImapDraftProjection },
  { version: 59, name: "imap_push_listener_health", run: addImapPushListenerHealth },
  { version: 60, name: "canonical_saved_view_search", run: canonicalizeSavedConversationViews },
  { version: 61, name: "draft_provider_remote_observations", run: repairDraftProviderRemoteIdentityIndex },
  { version: 62, name: "draft_recovery_attachments", run: addDraftRecoveryAttachments },
  { version: 63, name: "canonical_saved_view_search_guard", run: repairCanonicalSavedConversationViewConstraint },
  { version: 64, name: "public_attachment_links_storage_snapshots", run: addPublicAttachmentLinksAndStorageSnapshots },
  { version: 65, name: "managed_provider_oauth", run: addManagedProviderOAuth },
  { version: 66, name: "draft_delivery_classes", run: addDraftDeliveryClasses },
  { version: 67, name: "operator_maintenance_commands", run: addOperatorMaintenanceCommands },
  { version: 69, name: "operator_attention_query_index", run: addOperatorAttentionIndex },
  { version: 70, name: "remove_conversation_space_links", run: removeConversationSpaceLinks },
  { version: 71, name: "repair_draft_delivery_classes", run: addDraftDeliveryClasses },
  { version: 72, name: "mailbox_scale_indexes", run: hardenMailboxScaleIndexes, online: true },
  { version: 73, name: "repair_operator_maintenance_commands", run: addOperatorMaintenanceCommands },
  { version: 74, name: "runtime_maintenance_indexes", run: addRuntimeMaintenanceIndexes, online: true },
  { version: 75, name: "saved_view_quarantine", run: canonicalizeSavedConversationViews },
  { version: 76, name: "local_tag_colors", run: addLocalTagColors },
  { version: 77, name: "counterparty_participant_summaries", run: repairConversationParticipantSummaries, online: true },
  { version: 78, name: "remove_conversation_followers_and_mentions", run: removeConversationFollowersAndMentions },
  { version: 79, name: "unified_conversation_work_states", run: unifyConversationWorkStates },
  { version: 80, name: "folder_sidebar_visibility", run: addFolderSidebarVisibility },
  { version: 81, name: "complete_sender_identities", run: completeSenderIdentities },
  { version: 82, name: "dismissed_folder_projections", run: addDismissedFolderProjections },
  { version: 83, name: "message_protocol_foundations", run: addMessageProtocolFoundations },
  { version: 84, name: "mailing_list_subscriptions", run: addMailingListSubscriptions },
  { version: 85, name: "provider_limit_snapshots", run: addProviderLimitSnapshots },
  { version: 86, name: "outbound_message_preflight", run: addOutboundMessagePreflight },
  { version: 87, name: "privacy_safe_remote_content", run: addPrivacySafeRemoteContent },
  { version: 88, name: "identity_delivery_options", run: addIdentityDeliveryOptions },
  { version: 89, name: "composer_safety_message_reuse", run: addComposerSafetyAndMessageReuse },
  { version: 90, name: "draft_derivation_idempotency", run: addDraftDerivationIdempotency },
  { version: 91, name: "managed_sender_rules", run: addManagedMailRules },
  { version: 92, name: "managed_sender_rules_hardening", run: hardenManagedMailRules },
  { version: 96, name: "sender_read_batches", run: addSenderReadBatches },
  { version: 97, name: "provider_oauth_sent_mode", run: addProviderOAuthSentMode },
  { version: 98, name: "canonical_outbound_messages", run: addCanonicalOutboundMessages },
  { version: 99, name: "composable_sender_rule_actions", run: addComposableMailRuleActions },
  { version: 100, name: "sender_rule_backfill_pointer", run: addMailRuleBackfillPointer },
  { version: 101, name: "draft_materialization_idempotency", run: addDraftMaterializationIdempotency },
  { version: 103, name: "generalized_mail_rules", run: generalizeMailRules },
  { version: 104, name: "canonical_mail_rule_object_names", run: canonicalizeMailRuleObjectNames },
  { version: 105, name: "mailbox_calendar_destination", run: addMailboxCalendarDestination },
  { version: 106, name: "mail_security_operations", run: addMailSecurityOperations },
  { version: 107, name: "mail_security_operations_hardening", run: hardenMailSecurityOperations },
  { version: 108, name: "guided_ai_automations", run: addGuidedAiAutomations },
  { version: 109, name: "unified_incoming_automations", run: unifyIncomingAutomations },
  { version: 110, name: "compound_incoming_automation_steps", run: resetIncomingAutomationAuthoringModel },
  { version: 111, name: "workflow_aligned_incoming_automation_steps", run: resetIncomingAutomationAuthoringModel },
  { version: 112, name: "mail_automation_text_sources", run: resetIncomingAutomationAuthoringModel },
  { version: 113, name: "reviewable_workflow_drafts", run: exposeReviewableWorkflowDrafts },
  { version: 114, name: "conversation_summaries", run: addConversationSummaries },
  { version: 115, name: "live_invalidation_outbox", run: addLiveInvalidationOutbox },
  { version: 116, name: "detached_live_invalidation_scope", run: detachLiveInvalidationScope },
  { version: 117, name: "public_short_ids", run: finalizePublicShortIds },
  { version: 118, name: "flat_conversation_comments", run: flattenConversationComments },
  { version: 119, name: "attachment_document_extraction", run: addAttachmentDocumentExtraction },
  { version: 120, name: "incoming_automation_integration_credentials", run: addIncomingAutomationIntegrationCredentials },
];

const ensureMigrationFoundation = async (db: SqlClient): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    await tx`CREATE EXTENSION IF NOT EXISTS pgcrypto`;
    await tx`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    await tx`CREATE SCHEMA IF NOT EXISTS mail`;
    await tx`
      CREATE TABLE IF NOT EXISTS mail.schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
  });
};

const migrationApplied = async (db: SqlClient, migration: MailMigration): Promise<boolean> => {
  const [applied] = await db<{ version: number }[]>`
    SELECT version FROM mail.schema_migrations WHERE version = ${migration.version}
  `;
  return Boolean(applied);
};

const runMigration = async (db: SqlClient, migration: MailMigration): Promise<void> => {
  if (await migrationApplied(db, migration)) return;
  if (migration.online) {
    await db.unsafe(`SET lock_timeout = '10s'`);
    try {
      await migration.run(db);
      await db`
        INSERT INTO mail.schema_migrations (version, name)
        VALUES (${migration.version}, ${migration.name})
        ON CONFLICT (version) DO NOTHING
      `;
    } finally {
      await db.unsafe(`RESET lock_timeout`).catch(() => undefined);
    }
    return;
  }

  await db.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '10s'`;
    const [applied] = await tx<{ version: number }[]>`
      SELECT version FROM mail.schema_migrations WHERE version = ${migration.version}
    `;
    if (applied) return;
    await migration.run(tx);
    await tx`
      INSERT INTO mail.schema_migrations (version, name)
      VALUES (${migration.version}, ${migration.name})
    `;
  });
};

const runMigrations = async (db: SqlClient): Promise<void> => {
  await ensureMigrationFoundation(db);
  for (const migration of migrations) await runMigration(db, migration);
};

const migrationErrorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

const acquireMigrationLock = async (db: SqlClient): Promise<void> => {
  const deadline = Date.now() + 10_000;
  do {
    const [result] = await db<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtextextended('cloud.mail.migrations', 0)) AS locked
    `;
    if (result?.locked) return;
    await Bun.sleep(250);
  } while (Date.now() < deadline);

  const timeout = Object.assign(new Error("Timed out waiting for the Mail migration lock"), { code: "55P03" });
  throw timeout;
};

export const migrate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const connection = await sql.reserve();
    let locked = false;
    try {
      await acquireMigrationLock(connection);
      locked = true;
      await runMigrations(connection);
      await migrateWorkflowAi(connection);
      return;
    } catch (error) {
      if (migrationErrorCode(error) !== "55P03" || attempt === 2) throw error;
      await Bun.sleep(250 * 2 ** attempt);
    } finally {
      if (locked) {
        await connection`SELECT pg_advisory_unlock(hashtextextended('cloud.mail.migrations', 0))`.catch(() => undefined);
      }
      connection.release();
    }
  }
};
