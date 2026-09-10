-- Mail baseline schema.

-- The Mail application owns everything in the `mail` schema. This file is the
-- single source of truth for that schema: `migrate()` creates the schema, runs
-- this file once inside one transaction and records version 1 (`baseline`) in
-- `mail.schema_migrations`. There is no upgrade path from the historical
-- migration chain; Mail was never deployed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION mail.enforce_provider_binding_mailbox() RETURNS trigger
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
    $$;

CREATE FUNCTION mail.enqueue_activity_live_invalidation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM mail.enqueue_live_invalidation(NEW.mailbox_id, NEW.conversation_id);
      RETURN NEW;
    END;
    $$;

CREATE FUNCTION mail.enqueue_live_invalidation(target_mailbox_id uuid, target_conversation_id uuid DEFAULT NULL::uuid) RETURNS uuid
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
    $$;

CREATE FUNCTION mail.guard_outbox_requested_at() RETURNS trigger
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
    $$;

CREATE FUNCTION mail.normalize_provider_binding_account_evidence() RETURNS trigger
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
    $$;

CREATE FUNCTION mail.protect_conversation_reference_allocation() RETURNS trigger
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
    $$;

CREATE FUNCTION mail.search_reference_matches(searched_message_id uuid, searched_query text, searched_match text) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $_$
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
                FROM regexp_split_to_table(lower(btrim($2)), '\s+') token
                WHERE strpos(lower(COALESCE(to_jsonb(reference_row)->>'value', '')), token) = 0
              )
              ELSE strpos(lower(COALESCE(to_jsonb(reference_row)->>'value', '')), lower($2)) > 0
            END
        )
      $query$ INTO matched USING searched_message_id, searched_query, searched_match;
      RETURN matched;
    END;
    $_$;

CREATE FUNCTION mail.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$;

-- ---------------------------------------------------------------------------
-- Tables, constraints, indexes and triggers
-- ---------------------------------------------------------------------------

-- mail.activity_events ----------------------------------------------------

CREATE TABLE mail.activity_events (
    id bigint NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid,
    command_id uuid,
    actor_kind text NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    outcome text NOT NULL,
    target_type text,
    target_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activity_events_action_check CHECK (((char_length(action) >= 1) AND (char_length(action) <= 200))),
    CONSTRAINT activity_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text]))),
    CONSTRAINT activity_events_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text)),
    CONSTRAINT activity_events_outcome_check CHECK ((outcome = ANY (ARRAY['requested'::text, 'confirmed'::text, 'failed'::text, 'reconciled'::text])))
);

ALTER TABLE mail.activity_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mail.activity_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY mail.activity_events
    ADD CONSTRAINT activity_events_pkey PRIMARY KEY (id);

CREATE INDEX activity_events_conversation_idx ON mail.activity_events USING btree (conversation_id, created_at DESC, id DESC) WHERE (conversation_id IS NOT NULL);

CREATE INDEX activity_events_mailbox_idx ON mail.activity_events USING btree (mailbox_id, created_at DESC, id DESC);

CREATE TRIGGER activity_events_enqueue_live_invalidation AFTER INSERT ON mail.activity_events FOR EACH ROW EXECUTE FUNCTION mail.enqueue_activity_live_invalidation();

-- mail.attachment_extractions ---------------------------------------------

CREATE TABLE mail.attachment_extractions (
    blob_id uuid NOT NULL,
    extractor_version text NOT NULL,
    status text NOT NULL,
    format text,
    markdown text,
    input_bytes bigint,
    output_bytes bigint,
    truncated boolean DEFAULT false NOT NULL,
    error_code text,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT attachment_extractions_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT attachment_extractions_check CHECK ((((status = 'complete'::text) AND (markdown IS NOT NULL) AND (completed_at IS NOT NULL)) OR ((status <> 'complete'::text) AND (markdown IS NULL)))),
    CONSTRAINT attachment_extractions_extractor_version_check CHECK (((char_length(extractor_version) >= 1) AND (char_length(extractor_version) <= 100))),
    CONSTRAINT attachment_extractions_input_bytes_check CHECK (((input_bytes IS NULL) OR (input_bytes >= 0))),
    CONSTRAINT attachment_extractions_output_bytes_check CHECK (((output_bytes IS NULL) OR (output_bytes >= 0))),
    CONSTRAINT attachment_extractions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'complete'::text, 'unsupported'::text, 'encrypted'::text, 'ocr_required'::text, 'resource_limit'::text, 'malformed'::text, 'failed'::text])))
);

ALTER TABLE ONLY mail.attachment_extractions
    ADD CONSTRAINT attachment_extractions_pkey PRIMARY KEY (blob_id, extractor_version);

CREATE INDEX attachment_extractions_recovery_idx ON mail.attachment_extractions USING btree (next_attempt_at, updated_at, blob_id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));

-- mail.attachment_link_grants ---------------------------------------------

CREATE TABLE mail.attachment_link_grants (
    token_hash text NOT NULL,
    link_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    download_claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_link_grants_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT attachment_link_grants_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY mail.attachment_link_grants
    ADD CONSTRAINT attachment_link_grants_pkey PRIMARY KEY (token_hash);

CREATE INDEX attachment_link_grants_expiry_idx ON mail.attachment_link_grants USING btree (expires_at);

-- mail.attachment_links ---------------------------------------------------

CREATE TABLE mail.attachment_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    blob_id uuid,
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    filename text,
    content_type text NOT NULL,
    byte_length bigint NOT NULL,
    token_hash text NOT NULL,
    password_hash text,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    download_count bigint DEFAULT 0 NOT NULL,
    max_downloads bigint,
    last_downloaded_at timestamp with time zone,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachment_links_byte_length_check CHECK (((byte_length >= 0) AND (byte_length <= 104857600))),
    CONSTRAINT attachment_links_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT attachment_links_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT attachment_links_download_count_check CHECK ((download_count >= 0)),
    CONSTRAINT attachment_links_expiry_check CHECK (((expires_at IS NULL) OR (expires_at > created_at))),
    CONSTRAINT attachment_links_filename_check CHECK (((filename IS NULL) OR ((char_length(filename) >= 1) AND (char_length(filename) <= 255)))),
    CONSTRAINT attachment_links_max_downloads_check CHECK (((max_downloads >= 1) AND (max_downloads <= 1000000))),
    CONSTRAINT attachment_links_source_kind_check CHECK ((source_kind = ANY (ARRAY['message'::text, 'draft'::text]))),
    CONSTRAINT attachment_links_token_hash_check CHECK ((token_hash ~ '^[a-f0-9]{64}$'::text))
);

ALTER TABLE ONLY mail.attachment_links
    ADD CONSTRAINT attachment_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mail.attachment_links
    ADD CONSTRAINT attachment_links_token_hash_key UNIQUE (token_hash);

CREATE INDEX attachment_links_cleanup_idx ON mail.attachment_links USING btree (COALESCE(revoked_at, expires_at), id) WHERE ((revoked_at IS NOT NULL) OR (expires_at IS NOT NULL));

CREATE INDEX attachment_links_mailbox_idx ON mail.attachment_links USING btree (mailbox_id, created_at DESC, id DESC);

-- mail.attachments --------------------------------------------------------

CREATE TABLE mail.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    message_id uuid NOT NULL,
    part_id uuid NOT NULL,
    filename text,
    content_type text NOT NULL,
    disposition text,
    content_id text,
    checksum text,
    size_bytes bigint NOT NULL,
    blob_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT attachments_checksum_check CHECK (((checksum IS NULL) OR (char_length(checksum) = 64))),
    CONSTRAINT attachments_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT attachments_size_bytes_check CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY mail.attachments
    ADD CONSTRAINT attachments_part_id_key UNIQUE (part_id);

ALTER TABLE ONLY mail.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

CREATE INDEX attachments_message_idx ON mail.attachments USING btree (message_id, id);

CREATE UNIQUE INDEX attachments_short_id_idx ON mail.attachments USING btree (short_id);

-- mail.automatic_reply_configurations -------------------------------------

CREATE TABLE mail.automatic_reply_configurations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    sender_identity_id uuid NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    format text NOT NULL,
    minimum_interval_hours integer NOT NULL,
    inactive_behavior text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    schedule_definition jsonb NOT NULL,
    ensure_reference boolean DEFAULT false NOT NULL,
    CONSTRAINT automatic_reply_configurations_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 2097152))),
    CONSTRAINT automatic_reply_configurations_check CHECK (((normalized_name = lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text))) AND ((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 80)))),
    CONSTRAINT automatic_reply_configurations_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT automatic_reply_configurations_format_check CHECK ((format = ANY (ARRAY['plain'::text, 'markdown'::text]))),
    CONSTRAINT automatic_reply_configurations_inactive_behavior_check CHECK ((inactive_behavior = ANY (ARRAY['skip'::text, 'defer'::text]))),
    CONSTRAINT automatic_reply_configurations_minimum_interval_hours_check CHECK (((minimum_interval_hours >= 1) AND (minimum_interval_hours <= 8760))),
    CONSTRAINT automatic_reply_configurations_name_check CHECK (((name = btrim(name)) AND ((char_length(name) >= 1) AND (char_length(name) <= 80)))),
    CONSTRAINT automatic_reply_configurations_revision_check CHECK ((revision > 0)),
    CONSTRAINT automatic_reply_configurations_schedule_definition_check CHECK ((jsonb_typeof(schedule_definition) = 'object'::text)),
    CONSTRAINT automatic_reply_configurations_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT automatic_reply_configurations_subject_check CHECK (((char_length(subject) >= 1) AND (char_length(subject) <= 998)))
);

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configurations_mailbox_id_normalized_name_key UNIQUE (mailbox_id, normalized_name);

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configurations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configurations_workflow_id_key UNIQUE (workflow_id);

CREATE INDEX automatic_reply_configurations_mailbox_idx ON mail.automatic_reply_configurations USING btree (mailbox_id, enabled DESC, normalized_name, id);

CREATE UNIQUE INDEX automatic_reply_configurations_one_active_idx ON mail.automatic_reply_configurations USING btree (mailbox_id) WHERE enabled;

CREATE UNIQUE INDEX automatic_reply_configurations_short_id_idx ON mail.automatic_reply_configurations USING btree (short_id);

CREATE TRIGGER automatic_reply_configurations_touch_updated_at BEFORE UPDATE ON mail.automatic_reply_configurations FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.automatic_reply_effects --------------------------------------------

CREATE TABLE mail.automatic_reply_effects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    workflow_version_id uuid NOT NULL,
    workflow_run_id uuid NOT NULL,
    step_key text NOT NULL,
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    sender_identity_id uuid NOT NULL,
    recipient text,
    state text NOT NULL,
    suppression_reasons text[] DEFAULT ARRAY[]::text[] NOT NULL,
    command_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_id uuid,
    request_hash text,
    protocol_facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    scheduled_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    CONSTRAINT automatic_reply_effects_confirmed_at_check CHECK (((state <> 'confirmed'::text) OR (confirmed_at IS NOT NULL))),
    CONSTRAINT automatic_reply_effects_protocol_facts_check CHECK ((jsonb_typeof(protocol_facts) = 'object'::text)),
    CONSTRAINT automatic_reply_effects_recipient_check CHECK (((recipient IS NULL) OR ((char_length(recipient) >= 3) AND (char_length(recipient) <= 320)))),
    CONSTRAINT automatic_reply_effects_request_hash_check CHECK (((request_hash IS NULL) OR (request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT automatic_reply_effects_state_check CHECK ((state = ANY (ARRAY['suppressed'::text, 'queued'::text, 'confirmed'::text, 'failed'::text, 'cancelled'::text, 'needs_attention'::text]))),
    CONSTRAINT automatic_reply_effects_step_key_check CHECK (((char_length(step_key) >= 1) AND (char_length(step_key) <= 500)))
);

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_workflow_version_id_workflow_run_id_key UNIQUE (workflow_version_id, workflow_run_id, step_key);

CREATE UNIQUE INDEX automatic_reply_effects_command_idx ON mail.automatic_reply_effects USING btree (command_id) WHERE (command_id IS NOT NULL);

CREATE INDEX automatic_reply_rate_idx ON mail.automatic_reply_effects USING btree (mailbox_id, recipient, state, confirmed_at DESC) WHERE (state = ANY (ARRAY['queued'::text, 'confirmed'::text, 'needs_attention'::text]));

CREATE TRIGGER automatic_reply_effects_touch_updated_at BEFORE UPDATE ON mail.automatic_reply_effects FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.binding_folder_refs ------------------------------------------------

CREATE TABLE mail.binding_folder_refs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    remote_path text NOT NULL,
    delimiter text,
    namespace_kind text,
    uid_validity numeric(20,0),
    highest_modseq numeric(20,0),
    uid_next numeric(20,0),
    subscribed boolean DEFAULT false NOT NULL,
    effective_rights text[] DEFAULT ARRAY[]::text[] NOT NULL,
    rights_source text DEFAULT 'probe'::text NOT NULL,
    last_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_generation bigint DEFAULT 0 NOT NULL,
    missing_since timestamp with time zone,
    CONSTRAINT binding_folder_refs_highest_modseq_check CHECK (((highest_modseq IS NULL) OR (highest_modseq >= (0)::numeric))),
    CONSTRAINT binding_folder_refs_last_seen_generation_check CHECK ((last_seen_generation >= 0)),
    CONSTRAINT binding_folder_refs_namespace_kind_check CHECK (((namespace_kind IS NULL) OR (namespace_kind = ANY (ARRAY['personal'::text, 'other_users'::text, 'shared'::text])))),
    CONSTRAINT binding_folder_refs_remote_path_check CHECK (((char_length(remote_path) >= 1) AND (char_length(remote_path) <= 4000))),
    CONSTRAINT binding_folder_refs_rights_source_check CHECK ((rights_source = ANY (ARRAY['acl'::text, 'select'::text, 'probe'::text, 'unknown'::text]))),
    CONSTRAINT binding_folder_refs_uid_next_check CHECK (((uid_next IS NULL) OR (uid_next >= (0)::numeric))),
    CONSTRAINT binding_folder_refs_uid_validity_check CHECK (((uid_validity IS NULL) OR (uid_validity >= (0)::numeric)))
);

ALTER TABLE ONLY mail.binding_folder_refs
    ADD CONSTRAINT binding_folder_refs_binding_id_folder_id_key UNIQUE (binding_id, folder_id);

ALTER TABLE ONLY mail.binding_folder_refs
    ADD CONSTRAINT binding_folder_refs_binding_id_remote_path_key UNIQUE (binding_id, remote_path);

ALTER TABLE ONLY mail.binding_folder_refs
    ADD CONSTRAINT binding_folder_refs_pkey PRIMARY KEY (id);

CREATE INDEX binding_folder_refs_discovery_idx ON mail.binding_folder_refs USING btree (binding_id, last_seen_generation, folder_id);

CREATE INDEX binding_folder_refs_folder_idx ON mail.binding_folder_refs USING btree (folder_id, binding_id);

CREATE TRIGGER binding_folder_refs_touch_updated_at BEFORE UPDATE ON mail.binding_folder_refs FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.collaboration_notification_deliveries ------------------------------

CREATE TABLE mail.collaboration_notification_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    source_id uuid NOT NULL,
    source_short_id text NOT NULL,
    source_revision bigint NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    claim_id uuid,
    claimed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT collaboration_notification_claim_check CHECK ((((state = 'sending'::text) AND (claim_id IS NOT NULL) AND (claimed_at IS NOT NULL)) OR ((state <> 'sending'::text) AND (claim_id IS NULL) AND (claimed_at IS NULL)))),
    CONSTRAINT collaboration_notification_deliveries_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT collaboration_notification_deliveries_kind_check CHECK ((kind = 'reminder'::text)),
    CONSTRAINT collaboration_notification_deliveries_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 1000))),
    CONSTRAINT collaboration_notification_deliveries_source_revision_check CHECK ((source_revision > 0)),
    CONSTRAINT collaboration_notification_deliveries_source_short_id_format CHECK ((source_short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT collaboration_notification_deliveries_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'skipped'::text])))
);

ALTER TABLE ONLY mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_de_kind_source_id_source_revisio_key UNIQUE (kind, source_id, source_revision, recipient_user_id);

ALTER TABLE ONLY mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_pkey PRIMARY KEY (id);

CREATE INDEX collaboration_notification_dispatch_idx ON mail.collaboration_notification_deliveries USING btree (available_at, created_at, id) WHERE (state = 'pending'::text);

CREATE INDEX collaboration_notification_stale_claim_idx ON mail.collaboration_notification_deliveries USING btree (claimed_at, id) WHERE (state = 'sending'::text);

CREATE TRIGGER collaboration_notification_deliveries_touch_updated_at BEFORE UPDATE ON mail.collaboration_notification_deliveries FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.commands -----------------------------------------------------------

CREATE TABLE mail.commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid,
    initiator_actor_kind text,
    initiator_actor_id uuid,
    delegated_user_id uuid,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    correlation_id text,
    target jsonb NOT NULL,
    payload jsonb NOT NULL,
    workflow_execution_generation bigint,
    credential_id uuid,
    credential_expires_at timestamp with time zone,
    expected_revision bigint,
    selected_binding_id uuid,
    rights_snapshot jsonb,
    transport_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempt integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    access_subject_kind text NOT NULL,
    access_subject_id uuid,
    credential_scopes text[] DEFAULT ARRAY[]::text[] NOT NULL,
    selected_secret_revision integer,
    worker_heartbeat_at timestamp with time zone,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    provider_effect_started_at timestamp with time zone,
    provider_effect_attempt integer,
    CONSTRAINT commands_access_subject_check CHECK ((((access_subject_kind = 'system'::text) AND (access_subject_id IS NULL)) OR ((access_subject_kind = ANY (ARRAY['user'::text, 'service_account'::text])) AND (access_subject_id IS NOT NULL)))),
    CONSTRAINT commands_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text]))),
    CONSTRAINT commands_actor_shape CHECK ((((actor_kind = 'system'::text) AND (actor_id IS NULL)) OR ((actor_kind <> 'system'::text) AND (actor_id IS NOT NULL)))),
    CONSTRAINT commands_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT commands_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT commands_initiator_actor_check CHECK ((((initiator_actor_kind IS NULL) AND (initiator_actor_id IS NULL)) OR ((initiator_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text])) AND (initiator_actor_id IS NOT NULL)))),
    CONSTRAINT commands_initiator_actor_kind_check CHECK ((initiator_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT commands_kind_check CHECK ((kind = ANY (ARRAY['set_flags'::text, 'change_message_state'::text, 'move'::text, 'copy'::text, 'delete'::text, 'create_folder'::text, 'rename_folder'::text, 'delete_folder'::text, 'set_folder_subscription'::text, 'send'::text, 'sync_mailbox'::text, 'sync_folder'::text, 'discover_folders'::text, 'verify_binding'::text, 'rebuild_folder'::text, 'hydrate_missing'::text, 'rebuild_search'::text, 'rebuild_threads'::text, 'reconcile_effect'::text, 'retry_command'::text, 'cancel_command'::text]))),
    CONSTRAINT commands_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT commands_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT commands_provider_effect_check CHECK ((((provider_effect_started_at IS NULL) AND (provider_effect_attempt IS NULL)) OR ((provider_effect_started_at IS NOT NULL) AND (provider_effect_attempt IS NOT NULL) AND (provider_effect_attempt > 0)))),
    CONSTRAINT commands_request_hash_check CHECK ((char_length(request_hash) = 64)),
    CONSTRAINT commands_result_check CHECK ((jsonb_typeof(result) = 'object'::text)),
    CONSTRAINT commands_rights_snapshot_check CHECK (((rights_snapshot IS NULL) OR (jsonb_typeof(rights_snapshot) = 'object'::text))),
    CONSTRAINT commands_selected_credential_check CHECK ((((selected_binding_id IS NULL) AND (selected_secret_revision IS NULL)) OR ((selected_binding_id IS NOT NULL) AND (selected_secret_revision IS NOT NULL)))),
    CONSTRAINT commands_selected_secret_revision_check CHECK (((selected_secret_revision IS NULL) OR (selected_secret_revision > 0))),
    CONSTRAINT commands_state_check CHECK ((state = ANY (ARRAY['queued'::text, 'executing'::text, 'confirmed'::text, 'failed'::text, 'cancelled'::text, 'ambiguous'::text, 'reconciled'::text, 'needs_attention'::text]))),
    CONSTRAINT commands_target_check CHECK ((jsonb_typeof(target) = 'object'::text)),
    CONSTRAINT commands_transport_metadata_check CHECK ((jsonb_typeof(transport_metadata) = 'object'::text)),
    CONSTRAINT commands_workflow_execution_generation_check CHECK (((workflow_execution_generation IS NULL) OR (workflow_execution_generation > 0)))
);

ALTER TABLE ONLY mail.commands
    ADD CONSTRAINT commands_mailbox_id_idempotency_key_key UNIQUE (mailbox_id, idempotency_key);

ALTER TABLE ONLY mail.commands
    ADD CONSTRAINT commands_pkey PRIMARY KEY (id);

CREATE INDEX commands_binding_idx ON mail.commands USING btree (selected_binding_id, state) WHERE (selected_binding_id IS NOT NULL);

CREATE INDEX commands_dispatch_idx ON mail.commands USING btree (state, created_at, id) WHERE (state = ANY (ARRAY['queued'::text, 'executing'::text, 'ambiguous'::text]));

CREATE INDEX commands_mailbox_attention_idx ON mail.commands USING btree (mailbox_id, updated_at DESC, id DESC) WHERE (state = ANY (ARRAY['failed'::text, 'ambiguous'::text, 'needs_attention'::text]));

CREATE INDEX commands_mailbox_idx ON mail.commands USING btree (mailbox_id, created_at DESC, id DESC);

CREATE INDEX commands_stale_execution_idx ON mail.commands USING btree (COALESCE(worker_heartbeat_at, started_at), id) WHERE (state = 'executing'::text);

CREATE TRIGGER commands_touch_updated_at BEFORE UPDATE ON mail.commands FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.compose_signature_defaults -----------------------------------------

CREATE TABLE mail.compose_signature_defaults (
    mailbox_id uuid NOT NULL,
    sender_identity_id uuid NOT NULL,
    user_id uuid,
    template_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compose_signature_defaults_revision_check CHECK ((revision > 0))
);

CREATE UNIQUE INDEX compose_signature_defaults_mailbox_idx ON mail.compose_signature_defaults USING btree (mailbox_id, sender_identity_id) WHERE (user_id IS NULL);

CREATE INDEX compose_signature_defaults_template_idx ON mail.compose_signature_defaults USING btree (template_id);

CREATE UNIQUE INDEX compose_signature_defaults_user_idx ON mail.compose_signature_defaults USING btree (mailbox_id, sender_identity_id, user_id) WHERE (user_id IS NOT NULL);

-- mail.compose_styles -----------------------------------------------------

CREATE TABLE mail.compose_styles (
    mailbox_id uuid NOT NULL,
    custom_css text DEFAULT ''::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_by_actor_kind text,
    updated_by_actor_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compose_styles_actor_check CHECK ((((updated_by_actor_kind IS NULL) AND (updated_by_actor_id IS NULL)) OR ((updated_by_actor_kind IS NOT NULL) AND (updated_by_actor_id IS NOT NULL)))),
    CONSTRAINT compose_styles_custom_css_check CHECK ((char_length(custom_css) <= 100000)),
    CONSTRAINT compose_styles_revision_check CHECK ((revision > 0)),
    CONSTRAINT compose_styles_updated_by_actor_kind_check CHECK (((updated_by_actor_kind IS NULL) OR (updated_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))))
);

ALTER TABLE ONLY mail.compose_styles
    ADD CONSTRAINT compose_styles_pkey PRIMARY KEY (mailbox_id);

-- mail.compose_templates --------------------------------------------------

CREATE TABLE mail.compose_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    owner_user_id uuid,
    name text NOT NULL,
    normalized_name text NOT NULL,
    shortcut text NOT NULL,
    body_template text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT compose_templates_body_template_check CHECK (((char_length(body_template) >= 1) AND (char_length(body_template) <= 200000))),
    CONSTRAINT compose_templates_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT compose_templates_kind_check CHECK ((kind = ANY (ARRAY['signature'::text, 'snippet'::text]))),
    CONSTRAINT compose_templates_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT compose_templates_normalized_name_check CHECK (((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 120))),
    CONSTRAINT compose_templates_revision_check CHECK ((revision > 0)),
    CONSTRAINT compose_templates_scope_check CHECK ((scope = ANY (ARRAY['private'::text, 'mailbox'::text]))),
    CONSTRAINT compose_templates_scope_owner_check CHECK ((((scope = 'private'::text) AND (owner_user_id IS NOT NULL)) OR ((scope = 'mailbox'::text) AND (owner_user_id IS NULL)))),
    CONSTRAINT compose_templates_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT compose_templates_shortcut_check CHECK ((shortcut ~ '^[a-z][a-z0-9_]{0,39}$'::text))
);

ALTER TABLE ONLY mail.compose_templates
    ADD CONSTRAINT compose_templates_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX compose_templates_mailbox_id_idx ON mail.compose_templates USING btree (mailbox_id, id);

CREATE UNIQUE INDEX compose_templates_mailbox_shortcut_idx ON mail.compose_templates USING btree (mailbox_id, shortcut) WHERE ((scope = 'mailbox'::text) AND (archived_at IS NULL));

CREATE UNIQUE INDEX compose_templates_private_shortcut_idx ON mail.compose_templates USING btree (mailbox_id, owner_user_id, shortcut) WHERE ((scope = 'private'::text) AND (archived_at IS NULL));

CREATE UNIQUE INDEX compose_templates_short_id_idx ON mail.compose_templates USING btree (short_id);

CREATE INDEX compose_templates_visible_idx ON mail.compose_templates USING btree (mailbox_id, kind, scope, normalized_name, id) WHERE (archived_at IS NULL);

-- mail.conversation_comment_versions --------------------------------------

CREATE TABLE mail.conversation_comment_versions (
    comment_id uuid NOT NULL,
    revision bigint NOT NULL,
    body_markdown text NOT NULL,
    editor_kind text NOT NULL,
    editor_id uuid NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_comment_versions_body_markdown_check CHECK (((char_length(body_markdown) >= 1) AND (char_length(body_markdown) <= 50000))),
    CONSTRAINT conversation_comment_versions_editor_kind_check CHECK ((editor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text]))),
    CONSTRAINT conversation_comment_versions_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY mail.conversation_comment_versions
    ADD CONSTRAINT conversation_comment_versions_pkey PRIMARY KEY (comment_id, revision);

-- mail.conversation_comments ----------------------------------------------

CREATE TABLE mail.conversation_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    conversation_id uuid NOT NULL,
    author_kind text NOT NULL,
    author_id uuid NOT NULL,
    body_markdown text NOT NULL,
    referenced_message_id uuid,
    revision bigint DEFAULT 1 NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_comments_author_kind_check CHECK ((author_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text]))),
    CONSTRAINT conversation_comments_body_markdown_check CHECK (((char_length(body_markdown) >= 1) AND (char_length(body_markdown) <= 50000))),
    CONSTRAINT conversation_comments_revision_check CHECK ((revision > 0)),
    CONSTRAINT conversation_comments_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.conversation_comments
    ADD CONSTRAINT conversation_comments_pkey PRIMARY KEY (id);

CREATE INDEX conversation_comments_conversation_idx ON mail.conversation_comments USING btree (conversation_id, created_at, id);

CREATE UNIQUE INDEX conversation_comments_short_id_idx ON mail.conversation_comments USING btree (short_id);

CREATE TRIGGER conversation_comments_touch_updated_at BEFORE UPDATE ON mail.conversation_comments FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.conversation_local_tags --------------------------------------------

CREATE TABLE mail.conversation_local_tags (
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    assigned_by_actor_kind text NOT NULL,
    assigned_by_actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_local_tags_assigned_by_actor_kind_check CHECK ((assigned_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text])))
);

ALTER TABLE ONLY mail.conversation_local_tags
    ADD CONSTRAINT conversation_local_tags_pkey PRIMARY KEY (conversation_id, tag_id);

CREATE INDEX conversation_local_tags_tag_idx ON mail.conversation_local_tags USING btree (mailbox_id, tag_id, conversation_id);

-- mail.conversation_messages ----------------------------------------------

CREATE TABLE mail.conversation_messages (
    conversation_id uuid NOT NULL,
    message_id uuid NOT NULL,
    "position" bigint NOT NULL,
    added_by text DEFAULT 'heuristic'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_messages_added_by_check CHECK ((added_by = ANY (ARRAY['provider'::text, 'headers'::text, 'heuristic'::text, 'manual'::text, 'outbox'::text]))),
    CONSTRAINT conversation_messages_position_check CHECK (("position" >= 0))
);

ALTER TABLE ONLY mail.conversation_messages
    ADD CONSTRAINT conversation_messages_message_id_key UNIQUE (message_id);

ALTER TABLE ONLY mail.conversation_messages
    ADD CONSTRAINT conversation_messages_pkey PRIMARY KEY (conversation_id, message_id);

CREATE INDEX conversation_messages_order_idx ON mail.conversation_messages USING btree (conversation_id, "position", message_id);

-- mail.conversation_reference_requests ------------------------------------

CREATE TABLE mail.conversation_reference_requests (
    mailbox_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    origin_conversation_id uuid NOT NULL,
    reference_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_reference_requests_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200)))
);

ALTER TABLE ONLY mail.conversation_reference_requests
    ADD CONSTRAINT conversation_reference_requests_pkey PRIMARY KEY (mailbox_id, idempotency_key);

-- mail.conversation_references --------------------------------------------

CREATE TABLE mail.conversation_references (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    origin_conversation_id uuid NOT NULL,
    value text NOT NULL,
    normalized_value text NOT NULL,
    sequence bigint NOT NULL,
    role text NOT NULL,
    allocated_by_actor_kind text NOT NULL,
    allocated_by_actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    allocated_at timestamp with time zone DEFAULT now() NOT NULL,
    configuration_revision bigint NOT NULL,
    pattern_snapshot text NOT NULL,
    CONSTRAINT conversation_references_allocated_by_actor_kind_check CHECK ((allocated_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text]))),
    CONSTRAINT conversation_references_check CHECK ((normalized_value = lower(value))),
    CONSTRAINT conversation_references_configuration_revision_check CHECK ((configuration_revision > 0)),
    CONSTRAINT conversation_references_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200))),
    CONSTRAINT conversation_references_pattern_snapshot_check CHECK (((pattern_snapshot = btrim(pattern_snapshot)) AND ((char_length(pattern_snapshot) >= 1) AND (char_length(pattern_snapshot) <= 120)))),
    CONSTRAINT conversation_references_role_check CHECK ((role = ANY (ARRAY['primary'::text, 'alias'::text]))),
    CONSTRAINT conversation_references_sequence_check CHECK ((sequence > 0)),
    CONSTRAINT conversation_references_value_check CHECK (((value = btrim(value)) AND ((char_length(value) >= 1) AND (char_length(value) <= 160))))
);

ALTER TABLE ONLY mail.conversation_references
    ADD CONSTRAINT conversation_references_mailbox_id_normalized_value_key UNIQUE (mailbox_id, normalized_value);

ALTER TABLE ONLY mail.conversation_references
    ADD CONSTRAINT conversation_references_pkey PRIMARY KEY (id);

CREATE INDEX conversation_references_conversation_idx ON mail.conversation_references USING btree (conversation_id, role, allocated_at, id);

CREATE UNIQUE INDEX conversation_references_id_mailbox_idx ON mail.conversation_references USING btree (id, mailbox_id);

CREATE INDEX conversation_references_lookup_idx ON mail.conversation_references USING btree (mailbox_id, normalized_value, conversation_id);

CREATE UNIQUE INDEX conversation_references_mailbox_idempotency_idx ON mail.conversation_references USING btree (mailbox_id, idempotency_key);

CREATE UNIQUE INDEX conversation_references_primary_idx ON mail.conversation_references USING btree (conversation_id) WHERE (role = 'primary'::text);

CREATE TRIGGER conversation_references_protect_allocation BEFORE UPDATE ON mail.conversation_references FOR EACH ROW EXECUTE FUNCTION mail.protect_conversation_reference_allocation();

-- mail.conversation_reminders ---------------------------------------------

CREATE TABLE mail.conversation_reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    canceled_at timestamp with time zone,
    CONSTRAINT conversation_reminders_revision_check CHECK ((revision > 0)),
    CONSTRAINT conversation_reminders_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT conversation_reminders_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sent'::text, 'canceled'::text])))
);

ALTER TABLE ONLY mail.conversation_reminders
    ADD CONSTRAINT conversation_reminders_conversation_id_user_id_key UNIQUE (conversation_id, user_id);

ALTER TABLE ONLY mail.conversation_reminders
    ADD CONSTRAINT conversation_reminders_pkey PRIMARY KEY (id);

CREATE INDEX conversation_reminders_due_idx ON mail.conversation_reminders USING btree (due_at, id) WHERE (state = 'pending'::text);

CREATE UNIQUE INDEX conversation_reminders_short_id_idx ON mail.conversation_reminders USING btree (short_id);

CREATE TRIGGER conversation_reminders_touch_updated_at BEFORE UPDATE ON mail.conversation_reminders FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.conversation_thread_overrides --------------------------------------

CREATE TABLE mail.conversation_thread_overrides (
    message_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    reason text NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_thread_overrides_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT conversation_thread_overrides_reason_check CHECK ((reason = ANY (ARRAY['merge'::text, 'split'::text]))),
    CONSTRAINT conversation_thread_overrides_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY mail.conversation_thread_overrides
    ADD CONSTRAINT conversation_thread_overrides_pkey PRIMARY KEY (message_id);

CREATE INDEX conversation_thread_overrides_conversation_idx ON mail.conversation_thread_overrides USING btree (conversation_id, message_id);

-- mail.conversations ------------------------------------------------------

CREATE TABLE mail.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    participant_summary text DEFAULT ''::text NOT NULL,
    latest_inbound_at timestamp with time zone,
    latest_outbound_at timestamp with time zone,
    latest_message_at timestamp with time zone NOT NULL,
    assignee_user_id uuid,
    work_status text DEFAULT 'needs_action'::text NOT NULL,
    snoozed_until timestamp with time zone,
    revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text,
    summary_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT conversations_revision_check CHECK ((revision > 0)),
    CONSTRAINT conversations_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT conversations_summary_revision_check CHECK ((summary_revision > 0)),
    CONSTRAINT conversations_work_status_check CHECK ((work_status = ANY (ARRAY['needs_action'::text, 'waiting'::text, 'done'::text])))
);

ALTER TABLE ONLY mail.conversations
    ADD CONSTRAINT conversations_id_mailbox_unique UNIQUE (id, mailbox_id);

ALTER TABLE ONLY mail.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

CREATE INDEX conversations_due_snooze_idx ON mail.conversations USING btree (snoozed_until, id) WHERE (snoozed_until IS NOT NULL);

CREATE INDEX conversations_mailbox_activity_idx ON mail.conversations USING btree (mailbox_id, updated_at DESC, id DESC);

CREATE INDEX conversations_mailbox_assignee_idx ON mail.conversations USING btree (mailbox_id, assignee_user_id, latest_message_at DESC, id DESC);

CREATE INDEX conversations_mailbox_latest_idx ON mail.conversations USING btree (mailbox_id, latest_message_at DESC, id DESC);

CREATE INDEX conversations_mailbox_snoozed_idx ON mail.conversations USING btree (mailbox_id, snoozed_until, id) WHERE (snoozed_until IS NOT NULL);

CREATE INDEX conversations_mailbox_status_idx ON mail.conversations USING btree (mailbox_id, work_status, latest_message_at DESC, id DESC);

CREATE UNIQUE INDEX conversations_short_id_idx ON mail.conversations USING btree (short_id);

CREATE TRIGGER conversations_touch_updated_at BEFORE UPDATE ON mail.conversations FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.draft_attachment_uploads -------------------------------------------

CREATE TABLE mail.draft_attachment_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    draft_id uuid NOT NULL,
    blob_id uuid,
    filename text NOT NULL,
    content_type text NOT NULL,
    byte_length bigint NOT NULL,
    received_bytes bigint DEFAULT 0 NOT NULL,
    next_position integer DEFAULT 0 NOT NULL,
    state text DEFAULT 'uploading'::text NOT NULL,
    creator_kind text NOT NULL,
    creator_id uuid NOT NULL,
    attachment_id uuid,
    finalized_revision bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT draft_attachment_upload_state_check CHECK ((((state = 'attached'::text) AND (attachment_id IS NOT NULL) AND (finalized_revision IS NOT NULL)) OR ((state <> 'attached'::text) AND (attachment_id IS NULL) AND (finalized_revision IS NULL)))),
    CONSTRAINT draft_attachment_uploads_blob_state_check CHECK ((((state = 'cancelled'::text) AND (blob_id IS NULL)) OR ((state <> 'cancelled'::text) AND (blob_id IS NOT NULL)))),
    CONSTRAINT draft_attachment_uploads_byte_length_check CHECK (((byte_length >= 0) AND (byte_length <= 104857600))),
    CONSTRAINT draft_attachment_uploads_check CHECK (((received_bytes >= 0) AND (received_bytes <= byte_length))),
    CONSTRAINT draft_attachment_uploads_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT draft_attachment_uploads_creator_kind_check CHECK ((creator_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT draft_attachment_uploads_filename_check CHECK (((char_length(filename) >= 1) AND (char_length(filename) <= 255))),
    CONSTRAINT draft_attachment_uploads_finalized_revision_check CHECK (((finalized_revision IS NULL) OR (finalized_revision > 0))),
    CONSTRAINT draft_attachment_uploads_next_position_check CHECK ((next_position >= 0)),
    CONSTRAINT draft_attachment_uploads_received_state_check CHECK (((state = ANY (ARRAY['uploading'::text, 'cancelled'::text])) OR (received_bytes = byte_length))),
    CONSTRAINT draft_attachment_uploads_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'uploaded'::text, 'attached'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY mail.draft_attachment_uploads
    ADD CONSTRAINT draft_attachment_uploads_attachment_id_key UNIQUE (attachment_id);

ALTER TABLE ONLY mail.draft_attachment_uploads
    ADD CONSTRAINT draft_attachment_uploads_pkey PRIMARY KEY (id);

CREATE INDEX draft_attachment_uploads_active_idx ON mail.draft_attachment_uploads USING btree (updated_at, id) WHERE (state = ANY (ARRAY['uploading'::text, 'uploaded'::text]));

CREATE INDEX draft_attachment_uploads_draft_idx ON mail.draft_attachment_uploads USING btree (draft_id, created_at, id);

CREATE TRIGGER draft_attachment_uploads_touch_updated_at BEFORE UPDATE ON mail.draft_attachment_uploads FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.draft_attachments --------------------------------------------------

CREATE TABLE mail.draft_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    draft_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    byte_length bigint NOT NULL,
    content_hash text NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT draft_attachments_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT draft_attachments_content_hash_check CHECK ((char_length(content_hash) = 64)),
    CONSTRAINT draft_attachments_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT draft_attachments_filename_check CHECK (((char_length(filename) >= 1) AND (char_length(filename) <= 255))),
    CONSTRAINT draft_attachments_position_check CHECK (("position" >= 0)),
    CONSTRAINT draft_attachments_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.draft_attachments
    ADD CONSTRAINT draft_attachments_draft_id_position_key UNIQUE (draft_id, "position");

ALTER TABLE ONLY mail.draft_attachments
    ADD CONSTRAINT draft_attachments_pkey PRIMARY KEY (id);

CREATE INDEX draft_attachments_draft_idx ON mail.draft_attachments USING btree (draft_id, "position", id);

CREATE UNIQUE INDEX draft_attachments_short_id_idx ON mail.draft_attachments USING btree (short_id);

-- mail.draft_provider_snapshots -------------------------------------------

CREATE TABLE mail.draft_provider_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    draft_id uuid,
    cloud_revision bigint,
    direction text NOT NULL,
    state text DEFAULT 'prepared'::text NOT NULL,
    stable_message_id text NOT NULL,
    content_fingerprint text,
    content_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    mime_blob_id uuid,
    remote_resource_id uuid,
    binding_id uuid,
    folder_id uuid,
    uid_validity numeric(20,0),
    uid numeric(20,0),
    modseq numeric(20,0),
    transport_generation bigint,
    secret_revision integer,
    attempt integer DEFAULT 0 NOT NULL,
    last_error_code text,
    last_error_message text,
    provider_effect_started_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT draft_provider_snapshots_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT draft_provider_snapshots_cloud_revision_check CHECK (((cloud_revision IS NULL) OR (cloud_revision > 0))),
    CONSTRAINT draft_provider_snapshots_cloud_shape CHECK ((((direction = 'export'::text) AND (draft_id IS NOT NULL) AND (cloud_revision IS NOT NULL) AND (content_fingerprint IS NOT NULL)) OR (direction = 'import'::text))),
    CONSTRAINT draft_provider_snapshots_content_fingerprint_check CHECK (((content_fingerprint IS NULL) OR (content_fingerprint ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT draft_provider_snapshots_content_snapshot_check CHECK ((jsonb_typeof(content_snapshot) = 'object'::text)),
    CONSTRAINT draft_provider_snapshots_direction_check CHECK ((direction = ANY (ARRAY['export'::text, 'import'::text]))),
    CONSTRAINT draft_provider_snapshots_effect_shape CHECK (((provider_effect_started_at IS NULL) OR (attempt > 0))),
    CONSTRAINT draft_provider_snapshots_last_error_code_check CHECK (((last_error_code IS NULL) OR (char_length(last_error_code) <= 80))),
    CONSTRAINT draft_provider_snapshots_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT draft_provider_snapshots_modseq_check CHECK (((modseq IS NULL) OR (modseq >= (0)::numeric))),
    CONSTRAINT draft_provider_snapshots_remote_shape CHECK ((((uid_validity IS NULL) AND (uid IS NULL)) OR ((folder_id IS NOT NULL) AND (uid_validity IS NOT NULL) AND (uid IS NOT NULL)))),
    CONSTRAINT draft_provider_snapshots_secret_revision_check CHECK (((secret_revision IS NULL) OR (secret_revision > 0))),
    CONSTRAINT draft_provider_snapshots_stable_message_id_check CHECK (((stable_message_id = btrim(stable_message_id)) AND ((char_length(stable_message_id) >= 3) AND (char_length(stable_message_id) <= 998)))),
    CONSTRAINT draft_provider_snapshots_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'appending'::text, 'active'::text, 'retiring'::text, 'retired'::text, 'external'::text, 'importing'::text, 'conflict'::text, 'ambiguous'::text, 'needs_attention'::text]))),
    CONSTRAINT draft_provider_snapshots_transport_generation_check CHECK (((transport_generation IS NULL) OR (transport_generation > 0))),
    CONSTRAINT draft_provider_snapshots_uid_check CHECK (((uid IS NULL) OR (uid > (0)::numeric))),
    CONSTRAINT draft_provider_snapshots_uid_validity_check CHECK (((uid_validity IS NULL) OR (uid_validity >= (0)::numeric)))
);

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_pkey PRIMARY KEY (id);

CREATE INDEX draft_provider_snapshots_draft_history_idx ON mail.draft_provider_snapshots USING btree (draft_id, created_at DESC, id DESC) WHERE (draft_id IS NOT NULL);

CREATE UNIQUE INDEX draft_provider_snapshots_export_revision_idx ON mail.draft_provider_snapshots USING btree (draft_id, cloud_revision) WHERE (direction = 'export'::text);

CREATE INDEX draft_provider_snapshots_message_id_idx ON mail.draft_provider_snapshots USING btree (mailbox_id, lower(stable_message_id), created_at DESC);

CREATE UNIQUE INDEX draft_provider_snapshots_one_active_export_idx ON mail.draft_provider_snapshots USING btree (draft_id) WHERE ((direction = 'export'::text) AND (state = 'active'::text));

CREATE INDEX draft_provider_snapshots_pending_idx ON mail.draft_provider_snapshots USING btree (state, updated_at, id) WHERE (state = ANY (ARRAY['prepared'::text, 'appending'::text, 'external'::text, 'importing'::text, 'retiring'::text]));

CREATE INDEX draft_provider_snapshots_remote_identity_idx ON mail.draft_provider_snapshots USING btree (folder_id, uid_validity, uid, created_at DESC) WHERE ((folder_id IS NOT NULL) AND (uid_validity IS NOT NULL) AND (uid IS NOT NULL));

CREATE TRIGGER draft_provider_snapshots_touch_updated_at BEFORE UPDATE ON mail.draft_provider_snapshots FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.draft_recovery_attachments -----------------------------------------

CREATE TABLE mail.draft_recovery_attachments (
    recovery_copy_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    filename text NOT NULL,
    content_type text NOT NULL,
    byte_length bigint NOT NULL,
    content_hash text NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT draft_recovery_attachments_byte_length_check CHECK (((byte_length >= 0) AND (byte_length <= 104857600))),
    CONSTRAINT draft_recovery_attachments_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT draft_recovery_attachments_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT draft_recovery_attachments_filename_check CHECK (((char_length(filename) >= 1) AND (char_length(filename) <= 255))),
    CONSTRAINT draft_recovery_attachments_position_check CHECK (("position" >= 0))
);

ALTER TABLE ONLY mail.draft_recovery_attachments
    ADD CONSTRAINT draft_recovery_attachments_pkey PRIMARY KEY (recovery_copy_id, "position");

CREATE INDEX draft_recovery_attachments_blob_idx ON mail.draft_recovery_attachments USING btree (blob_id);

-- mail.draft_recovery_copies ----------------------------------------------

CREATE TABLE mail.draft_recovery_copies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    draft_id uuid NOT NULL,
    base_revision bigint NOT NULL,
    content jsonb NOT NULL,
    content_hash text NOT NULL,
    creator_kind text NOT NULL,
    creator_id uuid,
    restored_at timestamp with time zone,
    restored_by_kind text,
    restored_by_id uuid,
    resulting_revision bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    has_attachment_snapshot boolean DEFAULT false NOT NULL,
    CONSTRAINT draft_recovery_copies_base_revision_check CHECK ((base_revision > 0)),
    CONSTRAINT draft_recovery_copies_content_check CHECK ((jsonb_typeof(content) = 'object'::text)),
    CONSTRAINT draft_recovery_copies_content_hash_check CHECK ((content_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT draft_recovery_copies_creator_kind_check CHECK ((creator_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'system'::text]))),
    CONSTRAINT draft_recovery_copies_creator_shape_check CHECK ((((creator_kind = 'system'::text) AND (creator_id IS NULL)) OR ((creator_kind <> 'system'::text) AND (creator_id IS NOT NULL)))),
    CONSTRAINT draft_recovery_copies_restored_by_kind_check CHECK ((restored_by_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT draft_recovery_copies_resulting_revision_check CHECK (((resulting_revision IS NULL) OR (resulting_revision > 0))),
    CONSTRAINT draft_recovery_restore_check CHECK ((((restored_at IS NULL) AND (restored_by_kind IS NULL) AND (restored_by_id IS NULL) AND (resulting_revision IS NULL)) OR ((restored_at IS NOT NULL) AND (restored_by_kind IS NOT NULL) AND (restored_by_id IS NOT NULL) AND (resulting_revision IS NOT NULL))))
);

ALTER TABLE ONLY mail.draft_recovery_copies
    ADD CONSTRAINT draft_recovery_copies_draft_id_base_revision_creator_kind_c_key UNIQUE (draft_id, base_revision, creator_kind, creator_id, content_hash);

ALTER TABLE ONLY mail.draft_recovery_copies
    ADD CONSTRAINT draft_recovery_copies_pkey PRIMARY KEY (id);

CREATE INDEX draft_recovery_copies_draft_idx ON mail.draft_recovery_copies USING btree (draft_id, created_at DESC, id DESC);

CREATE INDEX draft_recovery_copies_unresolved_idx ON mail.draft_recovery_copies USING btree (draft_id, created_at DESC, id DESC) WHERE (restored_at IS NULL);

-- mail.drafts -------------------------------------------------------------

CREATE TABLE mail.drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid,
    sender_identity_id uuid NOT NULL,
    author_kind text NOT NULL,
    author_id uuid,
    to_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    cc_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    bcc_addresses jsonb DEFAULT '[]'::jsonb NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    body_markdown text DEFAULT ''::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    body_format text DEFAULT 'markdown'::text NOT NULL,
    intent text DEFAULT 'new'::text NOT NULL,
    source_message_id uuid,
    last_editor_kind text NOT NULL,
    last_editor_id uuid,
    origin text DEFAULT 'user'::text NOT NULL,
    delivery_class text DEFAULT 'normal'::text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    request_delivery_receipt boolean DEFAULT false NOT NULL,
    request_read_receipt boolean DEFAULT false NOT NULL,
    derived_from_message_id uuid,
    derivation_kind text,
    derivation_key text,
    derivation_request_hash text,
    materialization_key text,
    materialization_request_hash text,
    CONSTRAINT drafts_actor_shape_check CHECK ((((author_kind = 'system'::text) AND (author_id IS NULL)) OR ((author_kind <> 'system'::text) AND (author_id IS NOT NULL)))),
    CONSTRAINT drafts_author_kind_check CHECK ((author_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text]))),
    CONSTRAINT drafts_automatic_reply_origin_check CHECK (((delivery_class <> 'automatic_reply'::text) OR (origin = 'workflow'::text))),
    CONSTRAINT drafts_bcc_addresses_check CHECK ((jsonb_typeof(bcc_addresses) = 'array'::text)),
    CONSTRAINT drafts_body_format_check CHECK ((body_format = ANY (ARRAY['plain'::text, 'markdown'::text]))),
    CONSTRAINT drafts_cc_addresses_check CHECK ((jsonb_typeof(cc_addresses) = 'array'::text)),
    CONSTRAINT drafts_delivery_class_check CHECK ((delivery_class = ANY (ARRAY['normal'::text, 'automatic_reply'::text]))),
    CONSTRAINT drafts_derivation_kind_check CHECK ((derivation_kind = ANY (ARRAY['edit_as_new'::text, 'resend'::text]))),
    CONSTRAINT drafts_derivation_request_hash_check CHECK (((derivation_request_hash IS NULL) OR (derivation_request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT drafts_derivation_shape_chk CHECK ((((derived_from_message_id IS NULL) AND (derivation_kind IS NULL) AND (derivation_key IS NULL) AND (derivation_request_hash IS NULL)) OR ((derived_from_message_id IS NOT NULL) AND (derivation_kind IS NOT NULL) AND (derivation_key IS NOT NULL) AND (derivation_request_hash IS NOT NULL) AND (intent = 'new'::text) AND (conversation_id IS NULL) AND (source_message_id IS NULL)))),
    CONSTRAINT drafts_intent_check CHECK ((intent = ANY (ARRAY['new'::text, 'reply'::text, 'reply_all'::text, 'forward'::text]))),
    CONSTRAINT drafts_intent_source_check CHECK ((((intent = 'new'::text) AND (conversation_id IS NULL) AND (source_message_id IS NULL)) OR ((intent <> 'new'::text) AND (conversation_id IS NOT NULL) AND (source_message_id IS NOT NULL)))),
    CONSTRAINT drafts_last_editor_kind_check CHECK ((last_editor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text]))),
    CONSTRAINT drafts_last_editor_shape_check CHECK ((((last_editor_kind = 'system'::text) AND (last_editor_id IS NULL)) OR ((last_editor_kind <> 'system'::text) AND (last_editor_id IS NOT NULL)))),
    CONSTRAINT drafts_materialization_request_hash_check CHECK (((materialization_request_hash IS NULL) OR (materialization_request_hash ~ '^[a-f0-9]{64}$'::text))),
    CONSTRAINT drafts_materialization_shape_chk CHECK ((((materialization_key IS NULL) AND (materialization_request_hash IS NULL)) OR ((materialization_key IS NOT NULL) AND (materialization_request_hash IS NOT NULL)))),
    CONSTRAINT drafts_origin_check CHECK ((((origin = 'user'::text) AND (author_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text])) AND (last_editor_kind = ANY (ARRAY['user'::text, 'service_account'::text, 'workflow'::text, 'system'::text]))) OR ((origin = 'workflow'::text) AND (author_kind = 'workflow'::text) AND (last_editor_kind = 'workflow'::text)))),
    CONSTRAINT drafts_priority_chk CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text]))),
    CONSTRAINT drafts_revision_check CHECK ((revision > 0)),
    CONSTRAINT drafts_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT drafts_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'discarded'::text]))),
    CONSTRAINT drafts_to_addresses_check CHECK ((jsonb_typeof(to_addresses) = 'array'::text))
);

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX drafts_derivation_idempotency_idx ON mail.drafts USING btree (mailbox_id, author_kind, author_id, derivation_key) WHERE (derivation_key IS NOT NULL);

CREATE INDEX drafts_derived_message_idx ON mail.drafts USING btree (mailbox_id, derived_from_message_id, created_at DESC) WHERE (derived_from_message_id IS NOT NULL);

CREATE INDEX drafts_mailbox_state_idx ON mail.drafts USING btree (mailbox_id, state, updated_at DESC);

CREATE UNIQUE INDEX drafts_materialization_idempotency_idx ON mail.drafts USING btree (mailbox_id, author_kind, author_id, materialization_key) WHERE (materialization_key IS NOT NULL);

CREATE INDEX drafts_origin_state_idx ON mail.drafts USING btree (mailbox_id, origin, state, updated_at DESC);

CREATE UNIQUE INDEX drafts_short_id_idx ON mail.drafts USING btree (short_id);

CREATE INDEX drafts_source_message_idx ON mail.drafts USING btree (source_message_id) WHERE (source_message_id IS NOT NULL);

CREATE TRIGGER drafts_touch_updated_at BEFORE UPDATE ON mail.drafts FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.folder_role_overrides ----------------------------------------------

CREATE TABLE mail.folder_role_overrides (
    mailbox_id uuid NOT NULL,
    role text NOT NULL,
    folder_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT folder_role_overrides_role_check CHECK ((role = ANY (ARRAY['sent'::text, 'drafts'::text, 'trash'::text, 'archive'::text, 'junk'::text])))
);

ALTER TABLE ONLY mail.folder_role_overrides
    ADD CONSTRAINT folder_role_overrides_mailbox_id_folder_id_key UNIQUE (mailbox_id, folder_id);

ALTER TABLE ONLY mail.folder_role_overrides
    ADD CONSTRAINT folder_role_overrides_pkey PRIMARY KEY (mailbox_id, role);

CREATE TRIGGER folder_role_overrides_touch_updated_at BEFORE UPDATE ON mail.folder_role_overrides FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.folders ------------------------------------------------------------

CREATE TABLE mail.folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    remote_resource_id uuid NOT NULL,
    parent_id uuid,
    stable_key text NOT NULL,
    name text NOT NULL,
    role text DEFAULT 'other'::text NOT NULL,
    selectable boolean DEFAULT true NOT NULL,
    selected_for_sync boolean DEFAULT true NOT NULL,
    show_in_sidebar boolean DEFAULT true NOT NULL,
    discovery_generation bigint DEFAULT 0 NOT NULL,
    sync_status text DEFAULT 'pending'::text NOT NULL,
    envelope_cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    body_cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    attachment_cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_reconciled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    discovery_state text DEFAULT 'active'::text NOT NULL,
    missing_since timestamp with time zone,
    dismissed_at timestamp with time zone,
    CONSTRAINT folders_attachment_cursor_check CHECK ((jsonb_typeof(attachment_cursor) = 'object'::text)),
    CONSTRAINT folders_body_cursor_check CHECK ((jsonb_typeof(body_cursor) = 'object'::text)),
    CONSTRAINT folders_discovery_generation_check CHECK ((discovery_generation >= 0)),
    CONSTRAINT folders_discovery_state_check CHECK ((discovery_state = ANY (ARRAY['active'::text, 'missing'::text, 'ambiguous'::text]))),
    CONSTRAINT folders_envelope_cursor_check CHECK ((jsonb_typeof(envelope_cursor) = 'object'::text)),
    CONSTRAINT folders_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 1000))),
    CONSTRAINT folders_role_check CHECK ((role = ANY (ARRAY['inbox'::text, 'sent'::text, 'drafts'::text, 'trash'::text, 'archive'::text, 'junk'::text, 'all'::text, 'other'::text]))),
    CONSTRAINT folders_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT folders_stable_key_check CHECK (((char_length(stable_key) >= 1) AND (char_length(stable_key) <= 1000))),
    CONSTRAINT folders_sync_status_check CHECK ((sync_status = ANY (ARRAY['pending'::text, 'syncing'::text, 'current'::text, 'degraded'::text, 'rebuilding'::text, 'excluded'::text])))
);

ALTER TABLE ONLY mail.folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mail.folders
    ADD CONSTRAINT folders_remote_resource_id_stable_key_key UNIQUE (remote_resource_id, stable_key);

CREATE INDEX folders_discovery_state_idx ON mail.folders USING btree (remote_resource_id, discovery_state, role, id);

CREATE INDEX folders_resource_parent_idx ON mail.folders USING btree (remote_resource_id, parent_id, name);

CREATE UNIQUE INDEX folders_short_id_idx ON mail.folders USING btree (short_id);

CREATE INDEX folders_sync_idx ON mail.folders USING btree (remote_resource_id, sync_status, role) WHERE selected_for_sync;

CREATE TRIGGER folders_touch_updated_at BEFORE UPDATE ON mail.folders FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.imap_push_listener_health ------------------------------------------

CREATE TABLE mail.imap_push_listener_health (
    binding_id uuid NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'stopped'::text NOT NULL,
    mode text DEFAULT 'none'::text NOT NULL,
    folder_id uuid,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    reconnect_attempt integer DEFAULT 0 NOT NULL,
    last_connected_at timestamp with time zone,
    last_hint_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT imap_push_listener_health_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT imap_push_listener_health_generation_check CHECK ((generation >= 0)),
    CONSTRAINT imap_push_listener_health_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT imap_push_listener_health_mode_check CHECK ((mode = ANY (ARRAY['none'::text, 'idle'::text, 'qresync'::text, 'poll'::text]))),
    CONSTRAINT imap_push_listener_health_reconnect_attempt_check CHECK ((reconnect_attempt >= 0)),
    CONSTRAINT imap_push_listener_health_state_check CHECK ((state = ANY (ARRAY['starting'::text, 'listening'::text, 'polling'::text, 'reconnecting'::text, 'stopped'::text, 'degraded'::text])))
);

ALTER TABLE ONLY mail.imap_push_listener_health
    ADD CONSTRAINT imap_push_listener_health_pkey PRIMARY KEY (binding_id);

CREATE INDEX imap_push_listener_health_state_idx ON mail.imap_push_listener_health USING btree (state, last_heartbeat_at, binding_id);

-- mail.incoming_automations -----------------------------------------------

CREATE TABLE mail.incoming_automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    workflow_id uuid NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    scope jsonb NOT NULL,
    steps jsonb NOT NULL,
    latest_backfill_operation_id uuid,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mandate_id uuid,
    CONSTRAINT incoming_automations_check CHECK (((normalized_name = lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text))) AND ((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 120)))),
    CONSTRAINT incoming_automations_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT incoming_automations_name_check CHECK (((name = btrim(name)) AND ((char_length(name) >= 1) AND (char_length(name) <= 120)))),
    CONSTRAINT incoming_automations_revision_check CHECK ((revision > 0)),
    CONSTRAINT incoming_automations_scope_check CHECK (((jsonb_typeof(scope) = 'object'::text) AND (scope ? 'mode'::text))),
    CONSTRAINT incoming_automations_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT incoming_automations_steps_check CHECK (((jsonb_typeof(steps) = 'array'::text) AND ((jsonb_array_length(steps) >= 1) AND (jsonb_array_length(steps) <= 20))))
);

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_id_mailbox_id_key UNIQUE (id, mailbox_id);

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_workflow_id_mailbox_id_key UNIQUE (workflow_id, mailbox_id);

CREATE INDEX incoming_automations_mailbox_idx ON mail.incoming_automations USING btree (mailbox_id, enabled DESC, normalized_name, id) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX incoming_automations_mailbox_name_idx ON mail.incoming_automations USING btree (mailbox_id, normalized_name) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX incoming_automations_short_id_idx ON mail.incoming_automations USING btree (short_id);

CREATE TRIGGER incoming_automations_touch_updated_at BEFORE UPDATE ON mail.incoming_automations FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.list_subscriptions -------------------------------------------------

CREATE TABLE mail.list_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    list_key text NOT NULL,
    state text NOT NULL,
    method text NOT NULL,
    endpoint text NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    requested_at timestamp with time zone,
    last_error_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT list_subscriptions_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT list_subscriptions_endpoint_check CHECK (((char_length(endpoint) >= 1) AND (char_length(endpoint) <= 2048))),
    CONSTRAINT list_subscriptions_last_error_code_check CHECK (((last_error_code IS NULL) OR (char_length(last_error_code) <= 200))),
    CONSTRAINT list_subscriptions_list_key_check CHECK (((char_length(list_key) >= 1) AND (char_length(list_key) <= 4096))),
    CONSTRAINT list_subscriptions_method_check CHECK ((method = 'one_click'::text)),
    CONSTRAINT list_subscriptions_state_check CHECK ((state = ANY (ARRAY['requesting'::text, 'unsubscribe_requested'::text, 'failed'::text])))
);

ALTER TABLE ONLY mail.list_subscriptions
    ADD CONSTRAINT list_subscriptions_mailbox_id_list_key_key UNIQUE (mailbox_id, list_key);

ALTER TABLE ONLY mail.list_subscriptions
    ADD CONSTRAINT list_subscriptions_pkey PRIMARY KEY (id);

CREATE INDEX list_subscriptions_mailbox_requested_idx ON mail.list_subscriptions USING btree (mailbox_id, requested_at DESC, id DESC);

-- mail.live_invalidation_outbox -------------------------------------------

CREATE TABLE mail.live_invalidation_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    mailbox_short_id text NOT NULL,
    conversation_id uuid,
    conversation_short_id text,
    transaction_key text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_until timestamp with time zone,
    delivered_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT live_invalidation_outbox_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT live_invalidation_outbox_conversation_short_id_format CHECK (((conversation_short_id IS NULL) OR (conversation_short_id ~ '^[0-9A-Za-z]{6}$'::text))),
    CONSTRAINT live_invalidation_outbox_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 1000))),
    CONSTRAINT live_invalidation_outbox_mailbox_short_id_format CHECK ((mailbox_short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.live_invalidation_outbox
    ADD CONSTRAINT live_invalidation_outbox_mailbox_id_conversation_id_transac_key UNIQUE (mailbox_id, conversation_id, transaction_key);

ALTER TABLE ONLY mail.live_invalidation_outbox
    ADD CONSTRAINT live_invalidation_outbox_pkey PRIMARY KEY (id);

CREATE INDEX live_invalidation_outbox_delivered_idx ON mail.live_invalidation_outbox USING btree (delivered_at) WHERE (delivered_at IS NOT NULL);

CREATE UNIQUE INDEX live_invalidation_outbox_mailbox_transaction_idx ON mail.live_invalidation_outbox USING btree (mailbox_id, transaction_key) WHERE (conversation_id IS NULL);

CREATE INDEX live_invalidation_outbox_pending_idx ON mail.live_invalidation_outbox USING btree (next_attempt_at, created_at, id) WHERE (delivered_at IS NULL);

-- mail.local_tags ---------------------------------------------------------

CREATE TABLE mail.local_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    color text DEFAULT '#6b7280'::text NOT NULL,
    CONSTRAINT local_tags_check CHECK (((normalized_name = lower(regexp_replace(btrim(name), '\s+'::text, ' '::text, 'g'::text))) AND ((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 80)))),
    CONSTRAINT local_tags_color_check CHECK ((color ~ '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT local_tags_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT local_tags_name_check CHECK (((name = btrim(name)) AND ((char_length(name) >= 1) AND (char_length(name) <= 80)))),
    CONSTRAINT local_tags_revision_check CHECK ((revision > 0)),
    CONSTRAINT local_tags_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.local_tags
    ADD CONSTRAINT local_tags_id_mailbox_id_key UNIQUE (id, mailbox_id);

ALTER TABLE ONLY mail.local_tags
    ADD CONSTRAINT local_tags_mailbox_id_normalized_name_key UNIQUE (mailbox_id, normalized_name);

ALTER TABLE ONLY mail.local_tags
    ADD CONSTRAINT local_tags_pkey PRIMARY KEY (id);

CREATE INDEX local_tags_mailbox_name_idx ON mail.local_tags USING btree (mailbox_id, normalized_name, id);

CREATE UNIQUE INDEX local_tags_short_id_idx ON mail.local_tags USING btree (short_id);

CREATE TRIGGER local_tags_touch_updated_at BEFORE UPDATE ON mail.local_tags FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.mailbox_access -----------------------------------------------------

CREATE TABLE mail.mailbox_access (
    mailbox_id uuid NOT NULL,
    access_id uuid NOT NULL
);

ALTER TABLE ONLY mail.mailbox_access
    ADD CONSTRAINT mailbox_access_pkey PRIMARY KEY (mailbox_id, access_id);

CREATE INDEX mailbox_access_access_idx ON mail.mailbox_access USING btree (access_id, mailbox_id);

-- mail.mailboxes ----------------------------------------------------------

CREATE TABLE mail.mailboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    name text NOT NULL,
    description text,
    health text DEFAULT 'disconnected'::text NOT NULL,
    health_reason text,
    sync_enabled boolean DEFAULT true NOT NULL,
    search_backend text DEFAULT 'auto'::text NOT NULL,
    created_by_user_id uuid,
    created_by_service_account_id uuid,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    automatic_reply_management_permission text DEFAULT 'admin'::text NOT NULL,
    compose_safety jsonb DEFAULT '{"internalDomains": [], "largeRecipientThreshold": 20}'::jsonb NOT NULL,
    calendar_space_id uuid,
    CONSTRAINT mailboxes_automatic_reply_management_permission_check CHECK ((automatic_reply_management_permission = ANY (ARRAY['write'::text, 'admin'::text]))),
    CONSTRAINT mailboxes_compose_safety_check CHECK ((jsonb_typeof(compose_safety) = 'object'::text)),
    CONSTRAINT mailboxes_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT mailboxes_health_check CHECK ((health = ANY (ARRAY['disconnected'::text, 'verifying'::text, 'bootstrapping'::text, 'active'::text, 'auth_required'::text, 'degraded'::text, 'reconnecting'::text, 'connection_required'::text, 'paused'::text]))),
    CONSTRAINT mailboxes_health_reason_check CHECK (((health_reason IS NULL) OR (char_length(health_reason) <= 1000))),
    CONSTRAINT mailboxes_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 160))),
    CONSTRAINT mailboxes_search_backend_check CHECK ((search_backend = ANY (ARRAY['auto'::text, 'postgres'::text, 'pg_textsearch'::text]))),
    CONSTRAINT mailboxes_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.mailboxes
    ADD CONSTRAINT mailboxes_pkey PRIMARY KEY (id);

CREATE INDEX mailboxes_active_created_idx ON mail.mailboxes USING btree (created_at DESC, id DESC) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX mailboxes_short_id_idx ON mail.mailboxes USING btree (short_id);

CREATE TRIGGER mailboxes_touch_updated_at BEFORE UPDATE ON mail.mailboxes FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.message_addresses --------------------------------------------------

CREATE TABLE mail.message_addresses (
    message_id uuid NOT NULL,
    role text NOT NULL,
    "position" integer NOT NULL,
    display_name text,
    email text NOT NULL,
    normalized_email text NOT NULL,
    CONSTRAINT message_addresses_email_check CHECK (((char_length(email) >= 3) AND (char_length(email) <= 320))),
    CONSTRAINT message_addresses_normalized_email_check CHECK ((normalized_email = lower(normalized_email))),
    CONSTRAINT message_addresses_position_check CHECK (("position" >= 0)),
    CONSTRAINT message_addresses_role_check CHECK ((role = ANY (ARRAY['from'::text, 'reply_to'::text, 'to'::text, 'cc'::text, 'bcc'::text])))
);

ALTER TABLE ONLY mail.message_addresses
    ADD CONSTRAINT message_addresses_pkey PRIMARY KEY (message_id, role, "position");

CREATE INDEX message_addresses_lookup_idx ON mail.message_addresses USING btree (normalized_email, role, message_id);

-- mail.message_contents ---------------------------------------------------

CREATE TABLE mail.message_contents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    message_id text,
    in_reply_to text,
    reference_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    subject text DEFAULT ''::text NOT NULL,
    internal_date timestamp with time zone NOT NULL,
    sent_at timestamp with time zone,
    size_bytes bigint DEFAULT 0 NOT NULL,
    selected_headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    mime_structure jsonb DEFAULT '{}'::jsonb NOT NULL,
    plain_text text,
    sanitized_html text,
    source_hash text,
    content_hash text NOT NULL,
    hydration_status text DEFAULT 'envelope'::text NOT NULL,
    hydration_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hydrated_at timestamp with time zone,
    hydration_claim_id uuid,
    hydration_claimed_at timestamp with time zone,
    provider_thread_id text,
    normalized_subject text DEFAULT ''::text NOT NULL,
    subject_search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, COALESCE(subject, ''::text))) STORED,
    hydration_attempt integer DEFAULT 0 NOT NULL,
    source_blob_id uuid,
    protocol_facts jsonb DEFAULT '{"list": {"id": null, "help": [], "post": [], "archive": [], "unsubscribe": [], "unsubscribePost": null}, "spam": {"flag": null, "score": null, "status": null}, "version": 1, "priority": {"priority": null, "xPriority": null, "importance": null}, "receipts": {"dispositionNotificationTo": null}, "precedence": null, "returnPath": null, "contentType": null, "autoSubmitted": null, "deliveryStatus": false, "autoResponseSuppress": null}'::jsonb NOT NULL,
    CONSTRAINT message_contents_content_hash_check CHECK ((char_length(content_hash) = 64)),
    CONSTRAINT message_contents_hydration_attempt_check CHECK ((hydration_attempt >= 0)),
    CONSTRAINT message_contents_hydration_claim_check CHECK ((((hydration_status = 'hydrating'::text) AND (hydration_claim_id IS NOT NULL) AND (hydration_claimed_at IS NOT NULL)) OR ((hydration_status <> 'hydrating'::text) AND (hydration_claim_id IS NULL) AND (hydration_claimed_at IS NULL)))),
    CONSTRAINT message_contents_hydration_status_check CHECK ((hydration_status = ANY (ARRAY['envelope'::text, 'headers'::text, 'hydrating'::text, 'body'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT message_contents_mime_structure_check CHECK ((jsonb_typeof(mime_structure) = 'object'::text)),
    CONSTRAINT message_contents_protocol_facts_object_chk CHECK ((jsonb_typeof(protocol_facts) = 'object'::text)),
    CONSTRAINT message_contents_selected_headers_check CHECK ((jsonb_typeof(selected_headers) = 'object'::text)),
    CONSTRAINT message_contents_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT message_contents_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT message_contents_source_hash_check CHECK (((source_hash IS NULL) OR (char_length(source_hash) = 64)))
);

ALTER TABLE ONLY mail.message_contents
    ADD CONSTRAINT message_contents_mailbox_id_content_hash_key UNIQUE (mailbox_id, content_hash);

ALTER TABLE ONLY mail.message_contents
    ADD CONSTRAINT message_contents_pkey PRIMARY KEY (id);

CREATE INDEX message_contents_hydration_queue_idx ON mail.message_contents USING btree (mailbox_id, hydration_status, internal_date DESC, id) WHERE ((hydration_status = ANY (ARRAY['envelope'::text, 'headers'::text, 'body'::text])) OR ((hydration_status = 'failed'::text) AND (hydration_attempt < 5)));

CREATE UNIQUE INDEX message_contents_id_mailbox_idx ON mail.message_contents USING btree (id, mailbox_id);

CREATE INDEX message_contents_mailbox_date_idx ON mail.message_contents USING btree (mailbox_id, internal_date DESC, id DESC);

CREATE INDEX message_contents_mailbox_list_hash_idx ON mail.message_contents USING btree (mailbox_id, md5(lower(btrim(
CASE
    WHEN ((protocol_facts #>> '{list,id}'::text[]) ~ '<[^<>]+>\s*$'::text) THEN regexp_replace((protocol_facts #>> '{list,id}'::text[]), '^.*<([^<>]+)>\s*$'::text, '\1'::text)
    ELSE (protocol_facts #>> '{list,id}'::text[])
END))), internal_date DESC, id DESC) WHERE (NULLIF(btrim((protocol_facts #>> '{list,id}'::text[])), ''::text) IS NOT NULL);

CREATE INDEX message_contents_message_id_idx ON mail.message_contents USING btree (mailbox_id, lower(message_id)) WHERE (message_id IS NOT NULL);

CREATE INDEX message_contents_provider_thread_idx ON mail.message_contents USING btree (mailbox_id, provider_thread_id, internal_date DESC) WHERE (provider_thread_id IS NOT NULL);

CREATE UNIQUE INDEX message_contents_short_id_idx ON mail.message_contents USING btree (short_id);

CREATE INDEX message_contents_source_blob_idx ON mail.message_contents USING btree (source_blob_id) WHERE (source_blob_id IS NOT NULL);

CREATE INDEX message_contents_source_identity_idx ON mail.message_contents USING btree (mailbox_id, source_hash, created_at, id) WHERE ((source_hash IS NOT NULL) AND (hydration_status = 'complete'::text));

CREATE INDEX message_contents_subject_search_idx ON mail.message_contents USING gin (subject_search_document);

CREATE INDEX message_contents_subject_thread_idx ON mail.message_contents USING btree (mailbox_id, normalized_subject, internal_date DESC) WHERE (normalized_subject <> ''::text);

-- mail.message_part_blobs -------------------------------------------------

CREATE TABLE mail.message_part_blobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content_hash text NOT NULL,
    byte_length bigint NOT NULL,
    chunk_size integer DEFAULT 1048576 NOT NULL,
    chunk_count integer NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT message_part_blobs_byte_length_check CHECK ((byte_length >= 0)),
    CONSTRAINT message_part_blobs_chunk_count_check CHECK ((chunk_count >= 0)),
    CONSTRAINT message_part_blobs_chunk_size_check CHECK (((chunk_size >= 65536) AND (chunk_size <= 4194304))),
    CONSTRAINT message_part_blobs_content_hash_check CHECK ((char_length(content_hash) = 64))
);

ALTER TABLE ONLY mail.message_part_blobs
    ADD CONSTRAINT message_part_blobs_content_hash_key UNIQUE (content_hash);

ALTER TABLE ONLY mail.message_part_blobs
    ADD CONSTRAINT message_part_blobs_pkey PRIMARY KEY (id);

-- mail.message_part_chunks ------------------------------------------------

CREATE TABLE mail.message_part_chunks (
    blob_id uuid NOT NULL,
    "position" integer NOT NULL,
    bytes bytea NOT NULL,
    CONSTRAINT message_part_chunks_bytes_check CHECK ((octet_length(bytes) <= 4194304)),
    CONSTRAINT message_part_chunks_position_check CHECK (("position" >= 0))
);

ALTER TABLE ONLY mail.message_part_chunks
    ADD CONSTRAINT message_part_chunks_pkey PRIMARY KEY (blob_id, "position");

-- mail.message_parts ------------------------------------------------------

CREATE TABLE mail.message_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    part_path text NOT NULL,
    content_type text NOT NULL,
    charset text,
    transfer_encoding text,
    disposition text,
    content_id text,
    filename text,
    size_bytes bigint DEFAULT 0 NOT NULL,
    blob_id uuid,
    hydration_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_parts_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT message_parts_hydration_status_check CHECK ((hydration_status = ANY (ARRAY['pending'::text, 'hydrating'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT message_parts_part_path_check CHECK (((char_length(part_path) >= 1) AND (char_length(part_path) <= 200))),
    CONSTRAINT message_parts_size_bytes_check CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY mail.message_parts
    ADD CONSTRAINT message_parts_message_id_part_path_key UNIQUE (message_id, part_path);

ALTER TABLE ONLY mail.message_parts
    ADD CONSTRAINT message_parts_pkey PRIMARY KEY (id);

CREATE INDEX message_parts_blob_idx ON mail.message_parts USING btree (blob_id) WHERE (blob_id IS NOT NULL);

CREATE INDEX message_parts_message_idx ON mail.message_parts USING btree (message_id, part_path);

-- mail.message_placements -------------------------------------------------

CREATE TABLE mail.message_placements (
    remote_message_ref_id uuid NOT NULL,
    folder_id uuid NOT NULL,
    message_id uuid NOT NULL,
    flags text[] DEFAULT ARRAY[]::text[] NOT NULL,
    keywords text[] DEFAULT ARRAY[]::text[] NOT NULL,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY mail.message_placements
    ADD CONSTRAINT message_placements_pkey PRIMARY KEY (remote_message_ref_id);

CREATE INDEX message_placements_folder_idx ON mail.message_placements USING btree (folder_id, message_id) WHERE (deleted_at IS NULL);

CREATE INDEX message_placements_folder_unread_idx ON mail.message_placements USING btree (folder_id, message_id) WHERE ((deleted_at IS NULL) AND (NOT ('\Seen'::text = ANY (flags))));

CREATE INDEX message_placements_message_idx ON mail.message_placements USING btree (message_id, folder_id) WHERE (deleted_at IS NULL);

-- mail.message_receipt_reports --------------------------------------------

CREATE TABLE mail.message_receipt_reports (
    report_message_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    outbox_submission_id uuid NOT NULL,
    activity_id bigint NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    original_envelope_id uuid,
    original_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_receipt_reports_correlation_chk CHECK (((original_envelope_id IS NOT NULL) OR (original_message_id IS NOT NULL))),
    CONSTRAINT message_receipt_reports_kind_check CHECK ((kind = ANY (ARRAY['delivery'::text, 'read'::text]))),
    CONSTRAINT message_receipt_reports_status_check CHECK ((status = ANY (ARRAY['delivered'::text, 'delayed'::text, 'failed'::text, 'relayed'::text, 'expanded'::text, 'displayed'::text, 'deleted'::text, 'denied'::text, 'other'::text])))
);

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_activity_id_key UNIQUE (activity_id);

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_pkey PRIMARY KEY (report_message_id);

CREATE INDEX message_receipt_reports_outbox_idx ON mail.message_receipt_reports USING btree (outbox_submission_id, created_at DESC);

-- mail.message_remote_images ----------------------------------------------

CREATE TABLE mail.message_remote_images (
    id uuid NOT NULL,
    message_id uuid NOT NULL,
    "position" integer NOT NULL,
    source_url text NOT NULL,
    source_host text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT message_remote_images_position_check CHECK ((("position" >= 0) AND ("position" < 64))),
    CONSTRAINT message_remote_images_source_host_check CHECK ((char_length(source_host) BETWEEN 1 AND 253) AND (source_host = lower(source_host))),
    CONSTRAINT message_remote_images_source_url_check CHECK (((char_length(source_url) >= 1) AND (char_length(source_url) <= 8192)))
);

ALTER TABLE ONLY mail.message_remote_images
    ADD CONSTRAINT message_remote_images_message_id_position_key UNIQUE (message_id, "position");

ALTER TABLE ONLY mail.message_remote_images
    ADD CONSTRAINT message_remote_images_pkey PRIMARY KEY (id);

CREATE INDEX message_remote_images_message_idx ON mail.message_remote_images USING btree (message_id, "position");

-- mail.message_search_chunks ----------------------------------------------

CREATE TABLE mail.message_search_chunks (
    message_id uuid NOT NULL,
    "position" integer NOT NULL,
    search_document tsvector NOT NULL,
    mailbox_id uuid NOT NULL,
    id bigint NOT NULL,
    source_kind text DEFAULT 'body'::text NOT NULL,
    attachment_id uuid,
    blob_id uuid,
    extractor_version text,
    CONSTRAINT message_search_chunks_position_check CHECK (("position" >= 0)),
    CONSTRAINT message_search_chunks_source_chk CHECK ((((source_kind = 'body'::text) AND (attachment_id IS NULL) AND (blob_id IS NULL) AND (extractor_version IS NULL)) OR ((source_kind = 'attachment'::text) AND (attachment_id IS NOT NULL) AND (blob_id IS NOT NULL) AND (extractor_version IS NOT NULL))))
);

ALTER TABLE mail.message_search_chunks ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME mail.message_search_chunks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_pkey PRIMARY KEY (id);

CREATE INDEX message_search_chunks_attachment_projection_idx ON mail.message_search_chunks USING btree (blob_id, extractor_version, attachment_id) WHERE (source_kind = 'attachment'::text);

CREATE UNIQUE INDEX message_search_chunks_attachment_source_idx ON mail.message_search_chunks USING btree (attachment_id, extractor_version, "position") WHERE (source_kind = 'attachment'::text);

CREATE UNIQUE INDEX message_search_chunks_body_source_idx ON mail.message_search_chunks USING btree (message_id, "position") WHERE (source_kind = 'body'::text);

CREATE INDEX message_search_chunks_mailbox_document_idx ON mail.message_search_chunks USING gin (mailbox_id, search_document);

-- mail.outbox_submissions -------------------------------------------------

CREATE TABLE mail.outbox_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    draft_id uuid NOT NULL,
    command_id uuid NOT NULL,
    sender_identity_id uuid NOT NULL,
    selected_binding_id uuid NOT NULL,
    stable_message_id text NOT NULL,
    state text DEFAULT 'scheduled'::text NOT NULL,
    scheduled_at timestamp with time zone DEFAULT now() NOT NULL,
    undo_until timestamp with time zone,
    accepted_at timestamp with time zone,
    provider_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    mime_blob_id uuid,
    attempt integer DEFAULT 0 NOT NULL,
    last_error_code text,
    last_error_message text,
    requested_at timestamp with time zone NOT NULL,
    mime_date timestamp with time zone NOT NULL,
    preflight_byte_length bigint,
    preflight_smtp_limit_bytes bigint,
    preflight_checked_at timestamp with time zone,
    selected_identity_transport_revision integer,
    safety_review jsonb DEFAULT '{"approved": false, "warningIds": [], "fingerprint": null}'::jsonb NOT NULL,
    message_id uuid,
    CONSTRAINT outbox_submissions_attempt_check CHECK ((attempt >= 0)),
    CONSTRAINT outbox_submissions_draft_snapshot_check CHECK ((jsonb_typeof(draft_snapshot) = 'object'::text)),
    CONSTRAINT outbox_submissions_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT outbox_submissions_preflight_byte_length_check CHECK (((preflight_byte_length IS NULL) OR (preflight_byte_length >= 0))),
    CONSTRAINT outbox_submissions_preflight_smtp_limit_bytes_check CHECK (((preflight_smtp_limit_bytes IS NULL) OR (preflight_smtp_limit_bytes > 0))),
    CONSTRAINT outbox_submissions_provider_response_check CHECK ((jsonb_typeof(provider_response) = 'object'::text)),
    CONSTRAINT outbox_submissions_safety_review_check CHECK ((jsonb_typeof(safety_review) = 'object'::text)),
    CONSTRAINT outbox_submissions_selected_identity_transport_revision_check CHECK (((selected_identity_transport_revision IS NULL) OR (selected_identity_transport_revision > 0))),
    CONSTRAINT outbox_submissions_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT outbox_submissions_state_check CHECK ((state = ANY (ARRAY['scheduled'::text, 'undo_window'::text, 'sending'::text, 'accepted'::text, 'sent_sync_pending'::text, 'sent'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text, 'reconciled_accepted'::text, 'reconciled_unsent'::text, 'needs_attention'::text])))
);

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_command_id_key UNIQUE (command_id);

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_mailbox_id_stable_message_id_key UNIQUE (mailbox_id, stable_message_id);

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_pkey PRIMARY KEY (id);

CREATE INDEX outbox_ready_idx ON mail.outbox_submissions USING btree (state, scheduled_at, id) WHERE (state = ANY (ARRAY['scheduled'::text, 'undo_window'::text, 'unknown'::text, 'sent_sync_pending'::text]));

CREATE INDEX outbox_scheduled_view_idx ON mail.outbox_submissions USING btree (mailbox_id, requested_at, id) WHERE (state = ANY (ARRAY['scheduled'::text, 'undo_window'::text]));

CREATE UNIQUE INDEX outbox_submissions_message_idx ON mail.outbox_submissions USING btree (message_id) WHERE (message_id IS NOT NULL);

CREATE UNIQUE INDEX outbox_submissions_short_id_idx ON mail.outbox_submissions USING btree (short_id);

CREATE TRIGGER outbox_requested_at_guard BEFORE INSERT OR UPDATE OF requested_at ON mail.outbox_submissions FOR EACH ROW EXECUTE FUNCTION mail.guard_outbox_requested_at();

CREATE TRIGGER outbox_submissions_touch_updated_at BEFORE UPDATE ON mail.outbox_submissions FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.protected_identities -----------------------------------------------

CREATE TABLE mail.protected_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    allowed_domains text[] NOT NULL,
    note text,
    enabled boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT protected_identities_allowed_domains_check CHECK (((cardinality(allowed_domains) >= 1) AND (cardinality(allowed_domains) <= 20))),
    CONSTRAINT protected_identities_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 160))),
    CONSTRAINT protected_identities_normalized_name_check CHECK (((char_length(normalized_name) >= 1) AND (char_length(normalized_name) <= 160))),
    CONSTRAINT protected_identities_note_check CHECK (((note IS NULL) OR (char_length(note) <= 500)))
);

ALTER TABLE ONLY mail.protected_identities
    ADD CONSTRAINT protected_identities_normalized_name_key UNIQUE (normalized_name);

ALTER TABLE ONLY mail.protected_identities
    ADD CONSTRAINT protected_identities_pkey PRIMARY KEY (id);

-- mail.provider_bindings --------------------------------------------------

CREATE TABLE mail.provider_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    remote_resource_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    authenticated_principal text,
    remote_locator jsonb NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    rights jsonb DEFAULT '{}'::jsonb NOT NULL,
    verification_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    verified_scope_fingerprint text,
    last_verified_at timestamp with time zone,
    last_used_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_secret_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT provider_bindings_account_evidence_matches CHECK (((NULLIF((remote_locator ->> 'accountId'::text), ''::text) IS NULL) OR ((verification_evidence ->> 'accountId'::text) = (remote_locator ->> 'accountId'::text)))),
    CONSTRAINT provider_bindings_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT provider_bindings_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT provider_bindings_remote_locator_check CHECK ((jsonb_typeof(remote_locator) = 'object'::text)),
    CONSTRAINT provider_bindings_rights_check CHECK ((jsonb_typeof(rights) = 'object'::text)),
    CONSTRAINT provider_bindings_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'verifying'::text, 'active'::text, 'degraded'::text, 'revoked'::text]))),
    CONSTRAINT provider_bindings_verification_evidence_check CHECK ((jsonb_typeof(verification_evidence) = 'object'::text)),
    CONSTRAINT provider_bindings_verified_scope_fingerprint_check CHECK (((verified_scope_fingerprint IS NULL) OR (char_length(verified_scope_fingerprint) = 64))),
    CONSTRAINT provider_bindings_verified_secret_revision_check CHECK ((verified_secret_revision > 0))
);

ALTER TABLE ONLY mail.provider_bindings
    ADD CONSTRAINT provider_bindings_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX provider_bindings_connection_current_idx ON mail.provider_bindings USING btree (connection_id) WHERE (state <> 'revoked'::text);

CREATE INDEX provider_bindings_connection_idx ON mail.provider_bindings USING btree (connection_id, state);

CREATE UNIQUE INDEX provider_bindings_resource_current_idx ON mail.provider_bindings USING btree (remote_resource_id) WHERE (state <> 'revoked'::text);

CREATE INDEX provider_bindings_resource_state_idx ON mail.provider_bindings USING btree (remote_resource_id, state, last_verified_at DESC);

CREATE TRIGGER provider_bindings_account_evidence_guard BEFORE INSERT OR UPDATE OF remote_locator, verification_evidence ON mail.provider_bindings FOR EACH ROW EXECUTE FUNCTION mail.normalize_provider_binding_account_evidence();

CREATE TRIGGER provider_bindings_mailbox_guard BEFORE INSERT OR UPDATE OF remote_resource_id, connection_id ON mail.provider_bindings FOR EACH ROW EXECUTE FUNCTION mail.enforce_provider_binding_mailbox();

CREATE TRIGGER provider_bindings_touch_updated_at BEFORE UPDATE ON mail.provider_bindings FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.provider_connections -----------------------------------------------

CREATE TABLE mail.provider_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_mailbox_id uuid NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    username text NOT NULL,
    connector_kind text DEFAULT 'imap_smtp'::text NOT NULL,
    imap_host text NOT NULL,
    imap_port integer NOT NULL,
    imap_tls_mode text NOT NULL,
    smtp_host text NOT NULL,
    smtp_port integer NOT NULL,
    smtp_tls_mode text NOT NULL,
    secret_kind text NOT NULL,
    encrypted_secret text,
    secret_revision integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    authenticated_principal text,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    server_identity jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_verified_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    limit_snapshot jsonb DEFAULT '{"imap": {"status": "unavailable", "storage": null, "messages": null}, "smtp": {"status": "unavailable", "maxMessageBytes": null}, "checkedAt": "1970-01-01T00:00:00.000Z"}'::jsonb NOT NULL,
    CONSTRAINT provider_connections_capabilities_check CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT provider_connections_connector_kind_check CHECK ((connector_kind = 'imap_smtp'::text)),
    CONSTRAINT provider_connections_email_check CHECK (((char_length(email) >= 3) AND (char_length(email) <= 320))),
    CONSTRAINT provider_connections_encrypted_secret_check CHECK (((encrypted_secret IS NULL) OR (char_length(encrypted_secret) > 0))),
    CONSTRAINT provider_connections_imap_host_check CHECK (((char_length(imap_host) >= 1) AND (char_length(imap_host) <= 253))),
    CONSTRAINT provider_connections_imap_port_check CHECK (((imap_port >= 1) AND (imap_port <= 65535))),
    CONSTRAINT provider_connections_imap_tls_mode_check CHECK ((imap_tls_mode = ANY (ARRAY['implicit'::text, 'starttls'::text]))),
    CONSTRAINT provider_connections_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT provider_connections_limit_snapshot_check CHECK ((jsonb_typeof(limit_snapshot) = 'object'::text)),
    CONSTRAINT provider_connections_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT provider_connections_secret_kind_check CHECK ((secret_kind = 'password'::text)),
    CONSTRAINT provider_connections_secret_lifecycle CHECK ((((status = 'revoked'::text) AND (encrypted_secret IS NULL)) OR ((status <> 'revoked'::text) AND (encrypted_secret IS NOT NULL)))),
    CONSTRAINT provider_connections_secret_revision_check CHECK ((secret_revision > 0)),
    CONSTRAINT provider_connections_server_identity_check CHECK ((jsonb_typeof(server_identity) = 'object'::text)),
    CONSTRAINT provider_connections_smtp_host_check CHECK (((char_length(smtp_host) >= 1) AND (char_length(smtp_host) <= 253))),
    CONSTRAINT provider_connections_smtp_port_check CHECK (((smtp_port >= 1) AND (smtp_port <= 65535))),
    CONSTRAINT provider_connections_smtp_tls_mode_check CHECK ((smtp_tls_mode = ANY (ARRAY['implicit'::text, 'starttls'::text]))),
    CONSTRAINT provider_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'degraded'::text, 'revoked'::text]))),
    CONSTRAINT provider_connections_username_check CHECK (((char_length(username) >= 1) AND (char_length(username) <= 320)))
);

ALTER TABLE ONLY mail.provider_connections
    ADD CONSTRAINT provider_connections_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX provider_connections_mailbox_active_idx ON mail.provider_connections USING btree (owner_mailbox_id) WHERE (status <> 'revoked'::text);

CREATE TRIGGER provider_connections_touch_updated_at BEFORE UPDATE ON mail.provider_connections FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.reference_number_configurations ------------------------------------

CREATE TABLE mail.reference_number_configurations (
    mailbox_id uuid NOT NULL,
    pattern text NOT NULL,
    next_sequence bigint DEFAULT 1 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    include_in_reply_subjects boolean DEFAULT true NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_actor_kind text NOT NULL,
    created_by_actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reference_number_configurations_created_by_actor_kind_check CHECK ((created_by_actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT reference_number_configurations_next_sequence_check CHECK ((next_sequence > 0)),
    CONSTRAINT reference_number_configurations_pattern_check CHECK (((pattern = btrim(pattern)) AND ((char_length(pattern) >= 1) AND (char_length(pattern) <= 120)))),
    CONSTRAINT reference_number_configurations_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY mail.reference_number_configurations
    ADD CONSTRAINT reference_number_configurations_pkey PRIMARY KEY (mailbox_id);

CREATE TRIGGER reference_number_configurations_touch_updated_at BEFORE UPDATE ON mail.reference_number_configurations FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.remote_content_rules -----------------------------------------------

CREATE TABLE mail.remote_content_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    scope text NOT NULL,
    value text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_content_rules_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT remote_content_rules_scope_check CHECK ((scope = ANY (ARRAY['sender'::text, 'domain'::text]))),
    CONSTRAINT remote_content_rules_value_check CHECK ((char_length(value) BETWEEN 1 AND 320) AND (value = lower(value)))
);

ALTER TABLE ONLY mail.remote_content_rules
    ADD CONSTRAINT remote_content_rules_mailbox_id_actor_kind_actor_id_scope_v_key UNIQUE (mailbox_id, actor_kind, actor_id, scope, value);

ALTER TABLE ONLY mail.remote_content_rules
    ADD CONSTRAINT remote_content_rules_pkey PRIMARY KEY (id);

CREATE INDEX remote_content_rules_principal_idx ON mail.remote_content_rules USING btree (mailbox_id, actor_kind, actor_id, scope, value);

-- mail.remote_message_refs ------------------------------------------------

CREATE TABLE mail.remote_message_refs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    folder_id uuid NOT NULL,
    message_id uuid NOT NULL,
    uid_validity numeric(20,0) NOT NULL,
    uid numeric(20,0) NOT NULL,
    modseq numeric(20,0),
    connector_ref jsonb DEFAULT '{}'::jsonb NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    stale_at timestamp with time zone,
    CONSTRAINT remote_message_refs_connector_ref_check CHECK ((jsonb_typeof(connector_ref) = 'object'::text)),
    CONSTRAINT remote_message_refs_modseq_check CHECK (((modseq IS NULL) OR (modseq >= (0)::numeric))),
    CONSTRAINT remote_message_refs_uid_check CHECK ((uid > (0)::numeric)),
    CONSTRAINT remote_message_refs_uid_validity_check CHECK ((uid_validity >= (0)::numeric))
);

ALTER TABLE ONLY mail.remote_message_refs
    ADD CONSTRAINT remote_message_refs_folder_id_uid_validity_uid_key UNIQUE (folder_id, uid_validity, uid);

ALTER TABLE ONLY mail.remote_message_refs
    ADD CONSTRAINT remote_message_refs_pkey PRIMARY KEY (id);

CREATE INDEX remote_message_refs_folder_scan_idx ON mail.remote_message_refs USING btree (folder_id, uid_validity, uid DESC) WHERE (stale_at IS NULL);

CREATE INDEX remote_message_refs_message_idx ON mail.remote_message_refs USING btree (message_id, folder_id);

-- mail.remote_namespaces --------------------------------------------------

CREATE TABLE mail.remote_namespaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    binding_id uuid NOT NULL,
    kind text NOT NULL,
    prefix text NOT NULL,
    delimiter text,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_namespaces_kind_check CHECK ((kind = ANY (ARRAY['personal'::text, 'other_users'::text, 'shared'::text])))
);

ALTER TABLE ONLY mail.remote_namespaces
    ADD CONSTRAINT remote_namespaces_binding_id_kind_prefix_key UNIQUE (binding_id, kind, prefix);

ALTER TABLE ONLY mail.remote_namespaces
    ADD CONSTRAINT remote_namespaces_pkey PRIMARY KEY (id);

-- mail.remote_resources ---------------------------------------------------

CREATE TABLE mail.remote_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    connector_kind text DEFAULT 'imap_smtp'::text NOT NULL,
    remote_locator jsonb NOT NULL,
    server_identity jsonb NOT NULL,
    scope_fingerprint text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sync_generation bigint DEFAULT 1 NOT NULL,
    current_fence_token bigint DEFAULT 0 NOT NULL,
    discovery_generation bigint DEFAULT 0 NOT NULL,
    last_sync_at timestamp with time zone,
    last_discovery_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT remote_resources_connector_kind_check CHECK ((connector_kind = 'imap_smtp'::text)),
    CONSTRAINT remote_resources_current_fence_token_check CHECK ((current_fence_token >= 0)),
    CONSTRAINT remote_resources_discovery_generation_check CHECK ((discovery_generation >= 0)),
    CONSTRAINT remote_resources_last_error_message_check CHECK (((last_error_message IS NULL) OR (char_length(last_error_message) <= 1000))),
    CONSTRAINT remote_resources_remote_locator_check CHECK ((jsonb_typeof(remote_locator) = 'object'::text)),
    CONSTRAINT remote_resources_scope_fingerprint_check CHECK ((char_length(scope_fingerprint) = 64)),
    CONSTRAINT remote_resources_server_identity_check CHECK ((jsonb_typeof(server_identity) = 'object'::text)),
    CONSTRAINT remote_resources_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'degraded'::text, 'connection_required'::text, 'paused'::text]))),
    CONSTRAINT remote_resources_sync_generation_check CHECK ((sync_generation > 0))
);

ALTER TABLE ONLY mail.remote_resources
    ADD CONSTRAINT remote_resources_mailbox_id_key UNIQUE (mailbox_id);

ALTER TABLE ONLY mail.remote_resources
    ADD CONSTRAINT remote_resources_pkey PRIMARY KEY (id);

CREATE INDEX remote_resources_status_idx ON mail.remote_resources USING btree (status, last_sync_at);

CREATE TRIGGER remote_resources_touch_updated_at BEFORE UPDATE ON mail.remote_resources FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.saved_conversation_views -------------------------------------------

CREATE TABLE mail.saved_conversation_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    scope text NOT NULL,
    owner_user_id uuid,
    name text NOT NULL,
    filter jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    created_by_kind text NOT NULL,
    created_by_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    invalid_filter jsonb,
    disabled_at timestamp with time zone,
    migration_error text,
    CONSTRAINT saved_conversation_views_canonical_search_check CHECK ((((jsonb_typeof(filter) = 'object'::text) AND (filter ? 'expression'::text) AND (filter ? 'sort'::text) AND (jsonb_typeof((filter -> 'expression'::text)) = 'object'::text) AND ((filter ->> 'sort'::text) = ANY (ARRAY['relevance'::text, 'newest'::text]))) IS TRUE)),
    CONSTRAINT saved_conversation_views_created_by_kind_check CHECK ((created_by_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT saved_conversation_views_filter_check CHECK ((jsonb_typeof(filter) = 'object'::text)),
    CONSTRAINT saved_conversation_views_migration_error_check CHECK (((migration_error IS NULL) OR (char_length(migration_error) <= 1000))),
    CONSTRAINT saved_conversation_views_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT saved_conversation_views_owner_check CHECK ((((scope = 'private'::text) AND (owner_user_id IS NOT NULL)) OR ((scope = 'mailbox'::text) AND (owner_user_id IS NULL)))),
    CONSTRAINT saved_conversation_views_revision_check CHECK ((revision > 0)),
    CONSTRAINT saved_conversation_views_scope_check CHECK ((scope = ANY (ARRAY['private'::text, 'mailbox'::text]))),
    CONSTRAINT saved_conversation_views_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text))
);

ALTER TABLE ONLY mail.saved_conversation_views
    ADD CONSTRAINT saved_conversation_views_pkey PRIMARY KEY (id);

CREATE INDEX saved_conversation_views_list_idx ON mail.saved_conversation_views USING btree (mailbox_id, scope, owner_user_id, name, id);

CREATE UNIQUE INDEX saved_conversation_views_mailbox_name_idx ON mail.saved_conversation_views USING btree (mailbox_id, lower(name)) WHERE ((scope = 'mailbox'::text) AND (disabled_at IS NULL));

CREATE UNIQUE INDEX saved_conversation_views_private_name_idx ON mail.saved_conversation_views USING btree (mailbox_id, owner_user_id, lower(name)) WHERE ((scope = 'private'::text) AND (disabled_at IS NULL));

CREATE UNIQUE INDEX saved_conversation_views_short_id_idx ON mail.saved_conversation_views USING btree (short_id);

CREATE TRIGGER saved_conversation_views_touch_updated_at BEFORE UPDATE ON mail.saved_conversation_views FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.security_policies --------------------------------------------------

CREATE TABLE mail.security_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    disposition text NOT NULL,
    target text NOT NULL,
    value text NOT NULL,
    note text,
    enabled boolean DEFAULT true NOT NULL,
    created_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_policies_check CHECK (((disposition = 'deny'::text) OR (target = ANY (ARRAY['sender_address'::text, 'sender_domain'::text])))),
    CONSTRAINT security_policies_disposition_check CHECK ((disposition = ANY (ARRAY['deny'::text, 'trust'::text]))),
    CONSTRAINT security_policies_note_check CHECK (((note IS NULL) OR (char_length(note) <= 500))),
    CONSTRAINT security_policies_target_check CHECK ((target = ANY (ARRAY['sender_address'::text, 'sender_domain'::text, 'link_domain'::text]))),
    CONSTRAINT security_policies_value_check CHECK ((char_length(value) BETWEEN 1 AND 320) AND (value = lower(value)))
);

ALTER TABLE ONLY mail.security_policies
    ADD CONSTRAINT security_policies_disposition_target_value_key UNIQUE (disposition, target, value);

ALTER TABLE ONLY mail.security_policies
    ADD CONSTRAINT security_policies_pkey PRIMARY KEY (id);

CREATE INDEX security_policies_active_idx ON mail.security_policies USING btree (disposition, target, value) WHERE enabled;

-- mail.security_report_sources --------------------------------------------

CREATE TABLE mail.security_report_sources (
    report_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_report_sources_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text])))
);

ALTER TABLE ONLY mail.security_report_sources
    ADD CONSTRAINT security_report_sources_pkey PRIMARY KEY (report_id, actor_kind, actor_id);

-- mail.security_reports ---------------------------------------------------

CREATE TABLE mail.security_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    message_id uuid NOT NULL,
    sender_address text,
    sender_domain text,
    status text DEFAULT 'new'::text NOT NULL,
    report_count integer DEFAULT 1 NOT NULL,
    assessment jsonb NOT NULL,
    resolution_note text,
    reviewed_by_user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_reports_assessment_check CHECK ((jsonb_typeof(assessment) = 'object'::text)),
    CONSTRAINT security_reports_report_count_check CHECK ((report_count > 0)),
    CONSTRAINT security_reports_resolution_note_check CHECK (((resolution_note IS NULL) OR (char_length(resolution_note) <= 1000))),
    CONSTRAINT security_reports_sender_address_check CHECK (((sender_address IS NULL) OR (char_length(sender_address) <= 320))),
    CONSTRAINT security_reports_sender_domain_check CHECK (((sender_domain IS NULL) OR (char_length(sender_domain) <= 253))),
    CONSTRAINT security_reports_status_check CHECK ((status = ANY (ARRAY['new'::text, 'in_review'::text, 'confirmed'::text, 'dismissed'::text])))
);

ALTER TABLE ONLY mail.security_reports
    ADD CONSTRAINT security_reports_mailbox_id_message_id_key UNIQUE (mailbox_id, message_id);

ALTER TABLE ONLY mail.security_reports
    ADD CONSTRAINT security_reports_pkey PRIMARY KEY (id);

CREATE INDEX security_reports_status_idx ON mail.security_reports USING btree (status, updated_at DESC, id DESC);

-- mail.security_settings --------------------------------------------------

CREATE TABLE mail.security_settings (
    singleton boolean DEFAULT true NOT NULL,
    trusted_authserv_ids text[] DEFAULT ARRAY[]::text[] NOT NULL,
    updated_by_user_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_settings_singleton_check CHECK (singleton)
);

ALTER TABLE ONLY mail.security_settings
    ADD CONSTRAINT security_settings_pkey PRIMARY KEY (singleton);

-- mail.sender_identities --------------------------------------------------

CREATE TABLE mail.sender_identities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    short_id text NOT NULL,
    mailbox_id uuid NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    from_address text NOT NULL,
    reply_to text,
    envelope_sender text,
    automation_policy text DEFAULT 'mailbox'::text NOT NULL,
    sent_folder_id uuid,
    drafts_folder_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    status text DEFAULT 'unverified'::text NOT NULL,
    last_provider_rejection text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text NOT NULL,
    default_cc jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_bcc jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_format text DEFAULT 'markdown'::text NOT NULL,
    default_priority text DEFAULT 'normal'::text NOT NULL,
    default_delivery_receipt boolean DEFAULT false NOT NULL,
    default_read_receipt boolean DEFAULT false NOT NULL,
    vcard text,
    CONSTRAINT sender_identities_automation_policy_check CHECK ((automation_policy = ANY (ARRAY['disabled'::text, 'mailbox'::text]))),
    CONSTRAINT sender_identities_default_bcc_array_chk CHECK ((jsonb_typeof(default_bcc) = 'array'::text)),
    CONSTRAINT sender_identities_default_cc_array_chk CHECK ((jsonb_typeof(default_cc) = 'array'::text)),
    CONSTRAINT sender_identities_default_format_chk CHECK ((default_format = ANY (ARRAY['plain'::text, 'markdown'::text]))),
    CONSTRAINT sender_identities_default_priority_chk CHECK ((default_priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text]))),
    CONSTRAINT sender_identities_from_address_check CHECK (((char_length(from_address) >= 3) AND (char_length(from_address) <= 320))),
    CONSTRAINT sender_identities_label_chk CHECK (((char_length(btrim(label)) >= 1) AND (char_length(btrim(label)) <= 200))),
    CONSTRAINT sender_identities_last_provider_rejection_check CHECK (((last_provider_rejection IS NULL) OR (char_length(last_provider_rejection) <= 1000))),
    CONSTRAINT sender_identities_short_id_format CHECK ((short_id ~ '^[0-9A-Za-z]{6}$'::text)),
    CONSTRAINT sender_identities_status_check CHECK ((status = ANY (ARRAY['unverified'::text, 'verified'::text, 'rejected'::text, 'disabled'::text]))),
    CONSTRAINT sender_identities_vcard_size_chk CHECK (((vcard IS NULL) OR (octet_length(vcard) <= 262144)))
);

ALTER TABLE ONLY mail.sender_identities
    ADD CONSTRAINT sender_identities_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX sender_identities_default_idx ON mail.sender_identities USING btree (mailbox_id) WHERE (is_default AND (status <> 'disabled'::text));

CREATE UNIQUE INDEX sender_identities_id_mailbox_idx ON mail.sender_identities USING btree (id, mailbox_id);

CREATE INDEX sender_identities_mailbox_from_idx ON mail.sender_identities USING btree (mailbox_id, lower(from_address), id) WHERE (status <> 'disabled'::text);

CREATE UNIQUE INDEX sender_identities_mailbox_id_idx ON mail.sender_identities USING btree (mailbox_id, id);

CREATE UNIQUE INDEX sender_identities_short_id_idx ON mail.sender_identities USING btree (short_id);

CREATE TRIGGER sender_identities_touch_updated_at BEFORE UPDATE ON mail.sender_identities FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.sender_identity_bindings -------------------------------------------

CREATE TABLE mail.sender_identity_bindings (
    sender_identity_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    provider_principal text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    saves_sent_automatically boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone,
    last_error_code text,
    verified_secret_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT sender_identity_bindings_verified_secret_revision_check CHECK ((verified_secret_revision > 0))
);

ALTER TABLE ONLY mail.sender_identity_bindings
    ADD CONSTRAINT sender_identity_bindings_pkey PRIMARY KEY (sender_identity_id, binding_id);

-- mail.sender_identity_transports -----------------------------------------

CREATE TABLE mail.sender_identity_transports (
    sender_identity_id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    host text NOT NULL,
    port integer NOT NULL,
    tls_mode text NOT NULL,
    username text NOT NULL,
    secret_kind text NOT NULL,
    encrypted_secret text,
    revision integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    capabilities jsonb DEFAULT '{"dsn": false, "size": false, "maxMessageBytes": null}'::jsonb NOT NULL,
    last_verified_at timestamp with time zone,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sender_identity_transports_capabilities_object_chk CHECK ((jsonb_typeof(capabilities) = 'object'::text)),
    CONSTRAINT sender_identity_transports_port_check CHECK (((port >= 1) AND (port <= 65535))),
    CONSTRAINT sender_identity_transports_revision_check CHECK ((revision > 0)),
    CONSTRAINT sender_identity_transports_secret_kind_check CHECK ((secret_kind = 'password'::text)),
    CONSTRAINT sender_identity_transports_status_check CHECK ((status = ANY (ARRAY['active'::text, 'degraded'::text, 'revoked'::text]))),
    CONSTRAINT sender_identity_transports_tls_mode_check CHECK ((tls_mode = ANY (ARRAY['implicit'::text, 'starttls'::text])))
);

ALTER TABLE ONLY mail.sender_identity_transports
    ADD CONSTRAINT sender_identity_transports_pkey PRIMARY KEY (sender_identity_id);

CREATE INDEX sender_identity_transports_mailbox_idx ON mail.sender_identity_transports USING btree (mailbox_id, sender_identity_id);

-- mail.sender_read_batches ------------------------------------------------

CREATE TABLE mail.sender_read_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    match_kind text NOT NULL,
    match_value text NOT NULL,
    command_ids uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
    capped boolean NOT NULL,
    application_limit integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sender_read_batches_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['user'::text, 'service_account'::text]))),
    CONSTRAINT sender_read_batches_application_limit_check CHECK ((application_limit > 0)),
    CONSTRAINT sender_read_batches_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 150))),
    CONSTRAINT sender_read_batches_match_kind_check CHECK ((match_kind = ANY (ARRAY['sender'::text, 'domain'::text]))),
    CONSTRAINT sender_read_batches_match_value_check CHECK (((char_length(match_value) >= 1) AND (char_length(match_value) <= 320)))
);

ALTER TABLE ONLY mail.sender_read_batches
    ADD CONSTRAINT sender_read_batches_mailbox_id_actor_kind_actor_id_idempote_key UNIQUE (mailbox_id, actor_kind, actor_id, idempotency_key);

ALTER TABLE ONLY mail.sender_read_batches
    ADD CONSTRAINT sender_read_batches_pkey PRIMARY KEY (id);

-- mail.storage_system_snapshot --------------------------------------------

CREATE TABLE mail.storage_system_snapshot (
    singleton boolean DEFAULT true NOT NULL,
    physical_database_bytes bigint DEFAULT 0 NOT NULL,
    physical_blob_bytes bigint DEFAULT 0 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_system_snapshot_physical_blob_bytes_check CHECK ((physical_blob_bytes >= 0)),
    CONSTRAINT storage_system_snapshot_physical_database_bytes_check CHECK ((physical_database_bytes >= 0)),
    CONSTRAINT storage_system_snapshot_singleton_check CHECK (singleton)
);

ALTER TABLE ONLY mail.storage_system_snapshot
    ADD CONSTRAINT storage_system_snapshot_pkey PRIMARY KEY (singleton);

-- mail.storage_usage_snapshots --------------------------------------------

CREATE TABLE mail.storage_usage_snapshots (
    mailbox_id uuid NOT NULL,
    message_count bigint DEFAULT 0 NOT NULL,
    message_bytes bigint DEFAULT 0 NOT NULL,
    received_attachment_bytes bigint DEFAULT 0 NOT NULL,
    draft_attachment_bytes bigint DEFAULT 0 NOT NULL,
    external_link_bytes bigint DEFAULT 0 NOT NULL,
    logical_total_bytes bigint DEFAULT 0 NOT NULL,
    calculated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT storage_usage_snapshots_draft_attachment_bytes_check CHECK ((draft_attachment_bytes >= 0)),
    CONSTRAINT storage_usage_snapshots_external_link_bytes_check CHECK ((external_link_bytes >= 0)),
    CONSTRAINT storage_usage_snapshots_logical_total_bytes_check CHECK ((logical_total_bytes >= 0)),
    CONSTRAINT storage_usage_snapshots_message_bytes_check CHECK ((message_bytes >= 0)),
    CONSTRAINT storage_usage_snapshots_message_count_check CHECK ((message_count >= 0)),
    CONSTRAINT storage_usage_snapshots_received_attachment_bytes_check CHECK ((received_attachment_bytes >= 0))
);

ALTER TABLE ONLY mail.storage_usage_snapshots
    ADD CONSTRAINT storage_usage_snapshots_pkey PRIMARY KEY (mailbox_id);

-- mail.sync_runs ----------------------------------------------------------

CREATE TABLE mail.sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    remote_resource_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    fence_token bigint NOT NULL,
    generation bigint NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    cursor_before jsonb DEFAULT '{}'::jsonb NOT NULL,
    cursor_after jsonb,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error_code text,
    error_message text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT sync_runs_cursor_after_check CHECK (((cursor_after IS NULL) OR (jsonb_typeof(cursor_after) = 'object'::text))),
    CONSTRAINT sync_runs_cursor_before_check CHECK ((jsonb_typeof(cursor_before) = 'object'::text)),
    CONSTRAINT sync_runs_error_message_check CHECK (((error_message IS NULL) OR (char_length(error_message) <= 1000))),
    CONSTRAINT sync_runs_fence_token_check CHECK ((fence_token > 0)),
    CONSTRAINT sync_runs_generation_check CHECK ((generation > 0)),
    CONSTRAINT sync_runs_kind_check CHECK ((kind = ANY (ARRAY['discovery'::text, 'incremental'::text, 'backfill'::text, 'reconcile'::text, 'body_hydration'::text, 'attachment_hydration'::text]))),
    CONSTRAINT sync_runs_state_check CHECK ((state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'stale_fence'::text]))),
    CONSTRAINT sync_runs_stats_check CHECK ((jsonb_typeof(stats) = 'object'::text))
);

ALTER TABLE ONLY mail.sync_runs
    ADD CONSTRAINT sync_runs_pkey PRIMARY KEY (id);

CREATE INDEX sync_runs_resource_idx ON mail.sync_runs USING btree (remote_resource_id, started_at DESC);

CREATE INDEX sync_runs_running_idx ON mail.sync_runs USING btree (remote_resource_id, state) WHERE (state = 'running'::text);

CREATE INDEX sync_runs_terminal_retention_idx ON mail.sync_runs USING btree (COALESCE(finished_at, started_at), id) WHERE (state <> 'running'::text);

-- mail.workflow_profile ---------------------------------------------------

CREATE TABLE mail.workflow_profile (
    id uuid NOT NULL,
    mailbox_id uuid NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    managed_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_profile_managed_by_check CHECK (((managed_by IS NULL) OR (managed_by = ANY (ARRAY['automatic_reply'::text, 'incoming_automation'::text])))),
    CONSTRAINT workflow_profile_priority_check CHECK (((priority >= '-1000'::integer) AND (priority <= 1000)))
);

ALTER TABLE ONLY mail.workflow_profile
    ADD CONSTRAINT workflow_profile_id_mailbox_id_key UNIQUE (id, mailbox_id);

ALTER TABLE ONLY mail.workflow_profile
    ADD CONSTRAINT workflow_profile_pkey PRIMARY KEY (id);

CREATE INDEX workflow_profile_mailbox_priority_idx ON mail.workflow_profile USING btree (mailbox_id, priority, id);

CREATE TRIGGER workflow_profile_touch_updated_at BEFORE UPDATE ON mail.workflow_profile FOR EACH ROW EXECUTE FUNCTION mail.touch_updated_at();

-- mail.workflow_run_state -------------------------------------------------

CREATE TABLE mail.workflow_run_state (
    run_id uuid NOT NULL,
    frozen_hydration jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_run_state_frozen_hydration_check CHECK ((jsonb_typeof(frozen_hydration) = 'object'::text))
);

ALTER TABLE ONLY mail.workflow_run_state
    ADD CONSTRAINT workflow_run_state_pkey PRIMARY KEY (run_id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY mail.activity_events
    ADD CONSTRAINT activity_events_command_id_fkey FOREIGN KEY (command_id) REFERENCES mail.commands(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.activity_events
    ADD CONSTRAINT activity_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.activity_events
    ADD CONSTRAINT activity_events_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.attachment_extractions
    ADD CONSTRAINT attachment_extractions_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.attachment_link_grants
    ADD CONSTRAINT attachment_link_grants_link_id_fkey FOREIGN KEY (link_id) REFERENCES mail.attachment_links(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.attachment_links
    ADD CONSTRAINT attachment_links_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.attachment_links
    ADD CONSTRAINT attachment_links_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.attachments
    ADD CONSTRAINT attachments_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.attachments
    ADD CONSTRAINT attachments_part_id_fkey FOREIGN KEY (part_id) REFERENCES mail.message_parts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configuration_sender_identity_id_mailbox_i_fkey FOREIGN KEY (sender_identity_id, mailbox_id) REFERENCES mail.sender_identities(id, mailbox_id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configurations_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.automatic_reply_configurations
    ADD CONSTRAINT automatic_reply_configurations_workflow_id_mailbox_id_fkey FOREIGN KEY (workflow_id, mailbox_id) REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_command_id_fkey FOREIGN KEY (command_id) REFERENCES mail.commands(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_sender_identity_id_fkey FOREIGN KEY (sender_identity_id) REFERENCES mail.sender_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_workflow_run_id_fkey FOREIGN KEY (workflow_run_id) REFERENCES workflows.run(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.automatic_reply_effects
    ADD CONSTRAINT automatic_reply_effects_workflow_version_id_fkey FOREIGN KEY (workflow_version_id) REFERENCES workflows.version(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.binding_folder_refs
    ADD CONSTRAINT binding_folder_refs_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.binding_folder_refs
    ADD CONSTRAINT binding_folder_refs_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.collaboration_notification_deliveries
    ADD CONSTRAINT collaboration_notification_deliveries_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.commands
    ADD CONSTRAINT commands_delegated_user_id_fkey FOREIGN KEY (delegated_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.commands
    ADD CONSTRAINT commands_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.commands
    ADD CONSTRAINT commands_selected_binding_id_fkey FOREIGN KEY (selected_binding_id) REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.compose_signature_defaults
    ADD CONSTRAINT compose_signature_defaults_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_signature_defaults
    ADD CONSTRAINT compose_signature_defaults_sender_fk FOREIGN KEY (mailbox_id, sender_identity_id) REFERENCES mail.sender_identities(mailbox_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_signature_defaults
    ADD CONSTRAINT compose_signature_defaults_template_fk FOREIGN KEY (mailbox_id, template_id) REFERENCES mail.compose_templates(mailbox_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_signature_defaults
    ADD CONSTRAINT compose_signature_defaults_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_styles
    ADD CONSTRAINT compose_styles_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_templates
    ADD CONSTRAINT compose_templates_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.compose_templates
    ADD CONSTRAINT compose_templates_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_comment_versions
    ADD CONSTRAINT conversation_comment_versions_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES mail.conversation_comments(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_comments
    ADD CONSTRAINT conversation_comments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_comments
    ADD CONSTRAINT conversation_comments_referenced_message_id_fkey FOREIGN KEY (referenced_message_id) REFERENCES mail.message_contents(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.conversation_local_tags
    ADD CONSTRAINT conversation_local_tags_conversation_id_mailbox_id_fkey FOREIGN KEY (conversation_id, mailbox_id) REFERENCES mail.conversations(id, mailbox_id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_local_tags
    ADD CONSTRAINT conversation_local_tags_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_local_tags
    ADD CONSTRAINT conversation_local_tags_tag_id_mailbox_id_fkey FOREIGN KEY (tag_id, mailbox_id) REFERENCES mail.local_tags(id, mailbox_id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_messages
    ADD CONSTRAINT conversation_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_messages
    ADD CONSTRAINT conversation_messages_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_reference_requests
    ADD CONSTRAINT conversation_reference_requests_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_reference_requests
    ADD CONSTRAINT conversation_reference_requests_reference_id_mailbox_id_fkey FOREIGN KEY (reference_id, mailbox_id) REFERENCES mail.conversation_references(id, mailbox_id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.conversation_references
    ADD CONSTRAINT conversation_references_conversation_id_mailbox_id_fkey FOREIGN KEY (conversation_id, mailbox_id) REFERENCES mail.conversations(id, mailbox_id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_references
    ADD CONSTRAINT conversation_references_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_reminders
    ADD CONSTRAINT conversation_reminders_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_reminders
    ADD CONSTRAINT conversation_reminders_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_reminders
    ADD CONSTRAINT conversation_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_thread_overrides
    ADD CONSTRAINT conversation_thread_overrides_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_thread_overrides
    ADD CONSTRAINT conversation_thread_overrides_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversation_thread_overrides
    ADD CONSTRAINT conversation_thread_overrides_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.conversations
    ADD CONSTRAINT conversations_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.conversations
    ADD CONSTRAINT conversations_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_attachment_uploads
    ADD CONSTRAINT draft_attachment_uploads_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES mail.draft_attachments(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.draft_attachment_uploads
    ADD CONSTRAINT draft_attachment_uploads_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.draft_attachment_uploads
    ADD CONSTRAINT draft_attachment_uploads_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_attachments
    ADD CONSTRAINT draft_attachments_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.draft_attachments
    ADD CONSTRAINT draft_attachments_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_mime_blob_id_fkey FOREIGN KEY (mime_blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.draft_provider_snapshots
    ADD CONSTRAINT draft_provider_snapshots_remote_resource_id_fkey FOREIGN KEY (remote_resource_id) REFERENCES mail.remote_resources(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.draft_recovery_attachments
    ADD CONSTRAINT draft_recovery_attachments_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.draft_recovery_attachments
    ADD CONSTRAINT draft_recovery_attachments_recovery_copy_id_fkey FOREIGN KEY (recovery_copy_id) REFERENCES mail.draft_recovery_copies(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.draft_recovery_copies
    ADD CONSTRAINT draft_recovery_copies_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_derived_from_message_id_fkey FOREIGN KEY (derived_from_message_id) REFERENCES mail.message_contents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_sender_identity_id_fkey FOREIGN KEY (sender_identity_id) REFERENCES mail.sender_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.drafts
    ADD CONSTRAINT drafts_source_message_id_fkey FOREIGN KEY (source_message_id) REFERENCES mail.message_contents(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.folder_role_overrides
    ADD CONSTRAINT folder_role_overrides_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.folder_role_overrides
    ADD CONSTRAINT folder_role_overrides_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.folders
    ADD CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES mail.folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.folders
    ADD CONSTRAINT folders_remote_resource_id_fkey FOREIGN KEY (remote_resource_id) REFERENCES mail.remote_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.imap_push_listener_health
    ADD CONSTRAINT imap_push_listener_health_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.imap_push_listener_health
    ADD CONSTRAINT imap_push_listener_health_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_mandate_id_fkey FOREIGN KEY (mandate_id) REFERENCES auth.mandates(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.incoming_automations
    ADD CONSTRAINT incoming_automations_workflow_id_mailbox_id_fkey FOREIGN KEY (workflow_id, mailbox_id) REFERENCES mail.workflow_profile(id, mailbox_id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.list_subscriptions
    ADD CONSTRAINT list_subscriptions_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.live_invalidation_outbox
    ADD CONSTRAINT live_invalidation_outbox_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.local_tags
    ADD CONSTRAINT local_tags_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.mailbox_access
    ADD CONSTRAINT mailbox_access_access_id_fkey FOREIGN KEY (access_id) REFERENCES auth.access(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.mailbox_access
    ADD CONSTRAINT mailbox_access_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.mailboxes
    ADD CONSTRAINT mailboxes_created_by_service_account_id_fkey FOREIGN KEY (created_by_service_account_id) REFERENCES auth.service_accounts(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.mailboxes
    ADD CONSTRAINT mailboxes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.message_addresses
    ADD CONSTRAINT message_addresses_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_contents
    ADD CONSTRAINT message_contents_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_contents
    ADD CONSTRAINT message_contents_source_blob_id_fkey FOREIGN KEY (source_blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.message_part_chunks
    ADD CONSTRAINT message_part_chunks_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_parts
    ADD CONSTRAINT message_parts_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.message_parts
    ADD CONSTRAINT message_parts_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_placements
    ADD CONSTRAINT message_placements_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_placements
    ADD CONSTRAINT message_placements_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_placements
    ADD CONSTRAINT message_placements_remote_message_ref_id_fkey FOREIGN KEY (remote_message_ref_id) REFERENCES mail.remote_message_refs(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES mail.activity_events(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES mail.conversations(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_outbox_submission_id_fkey FOREIGN KEY (outbox_submission_id) REFERENCES mail.outbox_submissions(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_receipt_reports
    ADD CONSTRAINT message_receipt_reports_report_message_id_fkey FOREIGN KEY (report_message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_remote_images
    ADD CONSTRAINT message_remote_images_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_attachment_id_fkey FOREIGN KEY (attachment_id) REFERENCES mail.attachments(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_blob_id_fkey FOREIGN KEY (blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.message_search_chunks
    ADD CONSTRAINT message_search_chunks_message_mailbox_fkey FOREIGN KEY (message_id, mailbox_id) REFERENCES mail.message_contents(id, mailbox_id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_command_id_fkey FOREIGN KEY (command_id) REFERENCES mail.commands(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES mail.drafts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_mime_blob_id_fkey FOREIGN KEY (mime_blob_id) REFERENCES mail.message_part_blobs(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_selected_binding_id_fkey FOREIGN KEY (selected_binding_id) REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.outbox_submissions
    ADD CONSTRAINT outbox_submissions_sender_identity_id_fkey FOREIGN KEY (sender_identity_id) REFERENCES mail.sender_identities(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.provider_bindings
    ADD CONSTRAINT provider_bindings_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES mail.provider_connections(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.provider_bindings
    ADD CONSTRAINT provider_bindings_remote_resource_id_fkey FOREIGN KEY (remote_resource_id) REFERENCES mail.remote_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.provider_connections
    ADD CONSTRAINT provider_connections_owner_mailbox_id_fkey FOREIGN KEY (owner_mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.reference_number_configurations
    ADD CONSTRAINT reference_number_configurations_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.remote_content_rules
    ADD CONSTRAINT remote_content_rules_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.remote_message_refs
    ADD CONSTRAINT remote_message_refs_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES mail.folders(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.remote_message_refs
    ADD CONSTRAINT remote_message_refs_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.remote_namespaces
    ADD CONSTRAINT remote_namespaces_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.remote_resources
    ADD CONSTRAINT remote_resources_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.saved_conversation_views
    ADD CONSTRAINT saved_conversation_views_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.saved_conversation_views
    ADD CONSTRAINT saved_conversation_views_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.security_report_sources
    ADD CONSTRAINT security_report_sources_report_id_fkey FOREIGN KEY (report_id) REFERENCES mail.security_reports(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.security_reports
    ADD CONSTRAINT security_reports_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.security_reports
    ADD CONSTRAINT security_reports_message_id_fkey FOREIGN KEY (message_id) REFERENCES mail.message_contents(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sender_identities
    ADD CONSTRAINT sender_identities_drafts_folder_id_fkey FOREIGN KEY (drafts_folder_id) REFERENCES mail.folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.sender_identities
    ADD CONSTRAINT sender_identities_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sender_identities
    ADD CONSTRAINT sender_identities_sent_folder_id_fkey FOREIGN KEY (sent_folder_id) REFERENCES mail.folders(id) ON DELETE SET NULL;

ALTER TABLE ONLY mail.sender_identity_bindings
    ADD CONSTRAINT sender_identity_bindings_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sender_identity_bindings
    ADD CONSTRAINT sender_identity_bindings_sender_identity_id_fkey FOREIGN KEY (sender_identity_id) REFERENCES mail.sender_identities(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sender_identity_transports
    ADD CONSTRAINT sender_identity_transports_mailbox_id_sender_identity_id_fkey FOREIGN KEY (mailbox_id, sender_identity_id) REFERENCES mail.sender_identities(mailbox_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sender_read_batches
    ADD CONSTRAINT sender_read_batches_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.storage_usage_snapshots
    ADD CONSTRAINT storage_usage_snapshots_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.sync_runs
    ADD CONSTRAINT sync_runs_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES mail.provider_bindings(id) ON DELETE RESTRICT;

ALTER TABLE ONLY mail.sync_runs
    ADD CONSTRAINT sync_runs_remote_resource_id_fkey FOREIGN KEY (remote_resource_id) REFERENCES mail.remote_resources(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.workflow_profile
    ADD CONSTRAINT workflow_profile_id_fkey FOREIGN KEY (id) REFERENCES workflows.workflow(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.workflow_profile
    ADD CONSTRAINT workflow_profile_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES mail.mailboxes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mail.workflow_run_state
    ADD CONSTRAINT workflow_run_state_run_id_fkey FOREIGN KEY (run_id) REFERENCES workflows.run(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Seed rows a fresh installation needs
-- ---------------------------------------------------------------------------

INSERT INTO mail.security_settings (singleton) VALUES (true);
