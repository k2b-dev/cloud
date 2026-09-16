import { sql as defaultSql, type SQL } from "bun";

// Current Grids schema plus explicit, one-way upgrades from the preceding schema.
// IF NOT EXISTS does not reconcile existing columns or constraints. Schema
// changes need idempotent steps here, not just edited CREATEs. Local calculations
// are populated transactionally before this schema becomes available to readers.
const defineSchema = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE SCHEMA IF NOT EXISTS grids
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.assert_federated_revision(p_table_id uuid, p_revision_id uuid, p_revision_token text, p_source_count integer)
     RETURNS boolean
     LANGUAGE plpgsql
    AS $function$
        DECLARE
          valid_sources INT;
          invalid_mappings INT;
        BEGIN
          SELECT COUNT(*)::int INTO valid_sources
          FROM grids.federated_table_revisions revision
          JOIN grids.tables target
            ON target.id = revision.table_id
           AND target.kind = 'federated'
           AND target.deleted_at IS NULL
          JOIN grids.bases target_base
            ON target_base.id = target.base_id
           AND target_base.deleted_at IS NULL
          JOIN grids.federated_table_sources source
            ON source.revision_id = revision.id
           AND source.authorized_at IS NOT NULL
           AND source.revoked_at IS NULL
          JOIN grids.tables source_table
            ON source_table.id = source.source_table_id
           AND source_table.kind = 'stored'
           AND source_table.deleted_at IS NULL
          JOIN grids.bases source_base
            ON source_base.id = source_table.base_id
           AND source_base.deleted_at IS NULL
          WHERE revision.id = p_revision_id
            AND revision.table_id = p_table_id
            AND extract(epoch FROM revision.updated_at)::numeric::text = p_revision_token
            AND revision.status = 'active';

          IF valid_sources <> p_source_count THEN
            RAISE EXCEPTION 'combined table publication changed; reload the query'
              USING ERRCODE = 'P0001';
          END IF;
          SELECT COUNT(*)::int INTO invalid_mappings
          FROM grids.federated_field_mappings mapping
          JOIN grids.federated_table_revisions revision ON revision.id = mapping.revision_id
          LEFT JOIN grids.fields target_field
            ON target_field.id = mapping.target_field_id
           AND target_field.table_id = revision.table_id
           AND target_field.deleted_at IS NULL
          LEFT JOIN grids.fields source_field
            ON source_field.id = mapping.source_field_id
           AND source_field.table_id = mapping.source_table_id
           AND source_field.deleted_at IS NULL
          WHERE mapping.revision_id = p_revision_id
            AND (target_field.id IS NULL OR source_field.id IS NULL);
          IF invalid_mappings <> 0 THEN
            RAISE EXCEPTION 'combined table publication mapping changed; reload the query'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN TRUE;
        END;
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.canonical_boolean(t text)
     RETURNS boolean
     LANGUAGE sql
     IMMUTABLE PARALLEL SAFE STRICT
    AS $function$ SELECT t::boolean $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.canonical_date(t text)
     RETURNS date
     LANGUAGE sql
     IMMUTABLE PARALLEL SAFE STRICT
    AS $function$ SELECT t::date $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.canonical_numeric(t text)
     RETURNS numeric
     LANGUAGE sql
     IMMUTABLE PARALLEL SAFE STRICT
    AS $function$ SELECT t::numeric $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.canonical_timestamptz(t text)
     RETURNS timestamp with time zone
     LANGUAGE sql
     IMMUTABLE PARALLEL SAFE STRICT
    AS $function$ SELECT t::timestamptz $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.enqueue_record_event(p_table_id uuid, p_record_id uuid, p_payload jsonb)
     RETURNS uuid
     LANGUAGE plpgsql
    AS $function$
        DECLARE
          outbox_id uuid := gen_random_uuid();
          event_base_id uuid;
        BEGIN
          SELECT base_id INTO event_base_id FROM grids.tables WHERE id = p_table_id;
          IF event_base_id IS NULL THEN
            RAISE EXCEPTION 'record event table does not exist';
          END IF;
          INSERT INTO grids.record_event_outbox (id, base_id, table_id, record_id, payload)
          VALUES (
            outbox_id,
            event_base_id,
            p_table_id,
            p_record_id,
            p_payload || jsonb_build_object(
              'baseId', event_base_id::text,
              'tableId', p_table_id::text,
              'recordId', p_record_id::text,
              'occurredAt', now()
            )
          );
          RETURN outbox_id;
        END;
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.guard_document_export_claim()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          -- Claims commit with the issued document, never with its preview.
          RAISE EXCEPTION 'Financial export claims are immutable' USING ERRCODE = '55000';
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.guard_document_issuance()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            IF OLD.document_id IS NOT NULL THEN
              RAISE EXCEPTION 'Completed Document issuance receipts are immutable' USING ERRCODE = '55000';
            END IF;
            RETURN OLD;
          END IF;
          IF OLD.document_id IS NULL AND OLD.confirmation_hash IS NOT NULL AND OLD.confirmed_at IS NULL
            AND NEW.confirmed_at IS NOT NULL AND NEW.confirmed_actor IS NOT NULL
            AND (to_jsonb(NEW) - 'confirmed_actor' - 'confirmed_at') = (to_jsonb(OLD) - 'confirmed_actor' - 'confirmed_at') THEN
            RETURN NEW;
          END IF;
          IF OLD.document_id IS NOT NULL
            OR NEW.document_id IS NULL
            OR NEW.completed_at IS NULL
            OR NEW.frozen_request IS NOT NULL
            OR (to_jsonb(NEW) - 'document_id' - 'completed_at' - 'frozen_request')
              <> (to_jsonb(OLD) - 'document_id' - 'completed_at' - 'frozen_request') THEN
            RAISE EXCEPTION 'Document issuance receipt is immutable' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.guard_file_protected_reference_mutation()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF OLD.owner_kind = 'document_artifact'
            OR (TG_OP = 'UPDATE' AND NEW.owner_kind = 'document_artifact') THEN
            RAISE EXCEPTION 'Document artifact protection is immutable' USING ERRCODE = '55000';
          END IF;
          IF TG_OP = 'DELETE' THEN
            RETURN OLD;
          END IF;
          RETURN NEW;
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.reject_document_artifact_mutation()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          RAISE EXCEPTION 'Rows in grids.% are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.reject_document_mutation()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          RAISE EXCEPTION 'completed Documents are immutable' USING ERRCODE = '55000';
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.reject_file_content_mutation()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF EXISTS (SELECT 1 FROM grids.document_artifacts WHERE file_id = OLD.id) THEN
            RAISE EXCEPTION 'Document artifact File content is immutable' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.reject_workflow_query_data_update()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          RAISE EXCEPTION 'captured workflow query data is immutable' USING ERRCODE = '55000';
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.require_captured_calculation(captured boolean, value jsonb)
     RETURNS jsonb
     LANGUAGE plpgsql
     IMMUTABLE PARALLEL SAFE
    AS $function$
        BEGIN
          IF captured IS NOT TRUE THEN
            RAISE EXCEPTION 'grids: missing captured calculation' USING ERRCODE = '22023';
          END IF;
          RETURN value;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.require_valid_calculation(failed boolean, value anyelement)
     RETURNS anyelement
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF failed IS TRUE THEN
            RAISE EXCEPTION 'grids: invalid calculation' USING ERRCODE = '22023';
          END IF;
          RETURN value;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.sync_view_base_id()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          SELECT base_id INTO NEW.base_id
          FROM grids.tables
          WHERE id = NEW.table_id;
          RETURN NEW;
        END
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_iso_date(t text)
     RETURNS date
     LANGUAGE plpgsql
     IMMUTABLE STRICT
    AS $function$
        BEGIN
          IF t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
          RETURN make_date(substring(t, 1, 4)::int, substring(t, 6, 2)::int, substring(t, 9, 2)::int);
        EXCEPTION WHEN others THEN RETURN NULL;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_numeric(t text)
     RETURNS numeric
     LANGUAGE plpgsql
     IMMUTABLE STRICT
    AS $function$
        BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_formula_numeric(operation text, a numeric, b numeric)
     RETURNS numeric LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $function$
        BEGIN
          IF a IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
            OR b IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN RETURN NULL; END IF;
          CASE operation
            WHEN '+' THEN RETURN a + b;
            WHEN '-' THEN RETURN a - b;
            WHEN '*' THEN RETURN a * b;
            WHEN '/' THEN RETURN trim_scale(a) / trim_scale(b);
            WHEN '%' THEN RETURN mod(a, b);
            WHEN 'round' THEN RETURN round(a, b::integer);
            WHEN 'floor' THEN RETURN floor(a);
            WHEN 'ceil' THEN RETURN ceil(a);
            WHEN 'percent' THEN RETURN (trim_scale(a) / trim_scale(b)) * 100;
            ELSE RAISE EXCEPTION 'Unknown formula numeric operation: %', operation;
          END CASE;
        EXCEPTION WHEN numeric_value_out_of_range OR division_by_zero THEN RETURN NULL;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_formula_numeric_aggregate(operation text, items numeric[])
     RETURNS numeric LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
    AS $function$
        DECLARE result numeric;
        BEGIN
          IF items && ARRAY['NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric] THEN RETURN NULL; END IF;
          CASE operation
            WHEN 'SUM' THEN SELECT sum(value) INTO result FROM unnest(items) AS item(value);
            WHEN 'AVG' THEN SELECT trim_scale(sum(value)) / NULLIF(count(value), 0) INTO result FROM unnest(items) AS item(value);
            WHEN 'MEDIAN' THEN SELECT CASE WHEN count(value) % 2 = 1
              THEN percentile_disc(0.5) WITHIN GROUP (ORDER BY value ASC)
              ELSE (percentile_disc(0.5) WITHIN GROUP (ORDER BY value ASC) + percentile_disc(0.5) WITHIN GROUP (ORDER BY value DESC)) / 2 END
              INTO result FROM unnest(items) AS item(value) WHERE value IS NOT NULL;
            ELSE RAISE EXCEPTION 'Unknown formula numeric aggregate: %', operation;
          END CASE;
          RETURN result;
        EXCEPTION WHEN numeric_value_out_of_range OR division_by_zero THEN RETURN NULL;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_numeric_power(base numeric, exponent numeric)
     RETURNS numeric
     LANGUAGE plpgsql
     IMMUTABLE STRICT
    AS $function$
        DECLARE
          result numeric;
          digits text;
          weight integer;
        BEGIN
          IF base IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
            OR exponent IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
            OR (base = 0 AND exponent < 0)
            OR (base < 0 AND exponent <> trunc(exponent)) THEN
            RETURN NULL;
          END IF;
          base := trim_scale(base);
          exponent := trim_scale(exponent);
          IF exponent = trunc(exponent) AND exponent BETWEEN -2147483648 AND 2147483647 THEN
            -- Request a stable minimum scale without changing the base's value.
            -- PostgreSQL versions otherwise choose different integer-power scales.
            RETURN round(power(base + 0.0000000000000000::numeric, exponent), least(1000, greatest(16, scale(base))));
          END IF;
          -- Native POWER gives a cheap first estimate of the result magnitude.
          -- Then request 80 significant digits plus 16 guard digits, without
          -- forcing every ordinary calculation to the 1000-place SQL limit.
          result := power(base, exponent);
          IF result = 0 THEN RETURN 0; END IF;
          digits := abs(trim_scale(result))::text;
          weight := CASE WHEN abs(result) >= 1 THEN length(split_part(digits, '.', 1)) - 1
            ELSE -1 - length(substring(split_part(digits, '.', 2) FROM '^0*')) END;
          result := power(base + round(0::numeric, least(1000, greatest(0, 96 - weight))), exponent);
          IF result = 0 THEN RETURN 0; END IF;
          digits := abs(trim_scale(result))::text;
          weight := CASE WHEN abs(result) >= 1 THEN length(split_part(digits, '.', 1)) - 1
            ELSE -1 - length(substring(split_part(digits, '.', 2) FROM '^0*')) END;
          RETURN round(result, least(1000, 79 - weight));
        EXCEPTION
          WHEN numeric_value_out_of_range OR division_by_zero OR invalid_argument_for_power_function THEN RETURN NULL;
        END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_timestamptz(t text)
     RETURNS timestamp with time zone
     LANGUAGE plpgsql
     STABLE STRICT
    AS $function$
        BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_mapping()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM grids.federated_table_revisions revision
            JOIN grids.fields target_field
              ON target_field.id = NEW.target_field_id
             AND target_field.table_id = revision.table_id
            JOIN grids.fields source_field
              ON source_field.id = NEW.source_field_id
             AND source_field.table_id = NEW.source_table_id
            WHERE revision.id = NEW.revision_id
          ) THEN
            RAISE EXCEPTION 'federated mapping fields must belong to their declared tables';
          END IF;
          RETURN NEW;
        END;
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_revision_target()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM grids.tables target
            WHERE target.id = NEW.table_id AND target.kind = 'federated'
          ) THEN
            RAISE EXCEPTION 'federated revision target must be a combined table';
          END IF;
          RETURN NEW;
        END;
        $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_source()
     RETURNS trigger
     LANGUAGE plpgsql
    AS $function$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM grids.federated_table_revisions revision
            JOIN grids.tables source_table ON source_table.id = NEW.source_table_id
            WHERE revision.id = NEW.revision_id
              AND source_table.kind = 'stored'
              AND source_table.id <> revision.table_id
          ) THEN
            RAISE EXCEPTION 'federated source must be a distinct stored table';
          END IF;
          RETURN NEW;
        END;
        $function$
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.audit_log (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid,
      table_id uuid,
      record_id uuid,
      user_id uuid,
      action text NOT NULL,
      diff jsonb,
      context jsonb,
      ip text,
      user_agent text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT audit_log_pkey PRIMARY KEY (id),
      CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_audit_record ON grids.audit_log USING btree (record_id, created_at DESC) WHERE (record_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_audit_table ON grids.audit_log USING btree (table_id, created_at DESC) WHERE (table_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_audit_table_records_page ON grids.audit_log USING btree (table_id, created_at DESC, id DESC) WHERE (record_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.bases (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      name text NOT NULL,
      description text,
      document_defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
      created_by uuid,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      navigation_groups jsonb DEFAULT '[]'::jsonb NOT NULL,
      navigation_revision integer DEFAULT 0 NOT NULL,
      CONSTRAINT bases_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT bases_pkey PRIMARY KEY (id),
      CONSTRAINT bases_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_bases_short_id ON grids.bases USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.files (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      filename text NOT NULL,
      mime_type text NOT NULL,
      size_bytes integer NOT NULL,
      sha256 text NOT NULL,
      bytes bytea NOT NULL,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT files_check CHECK ((octet_length(bytes) = size_bytes)),
      CONSTRAINT files_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT files_pkey PRIMARY KEY (id),
      CONSTRAINT files_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT files_size_bytes_check CHECK ((size_bytes >= 0))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_files_short_id ON grids.files USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.base_access (
      base_id uuid NOT NULL,
      access_id uuid NOT NULL,
      CONSTRAINT base_access_access_id_fkey FOREIGN KEY (access_id) REFERENCES auth.access(id) ON DELETE CASCADE,
      CONSTRAINT base_access_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT base_access_pkey PRIMARY KEY (base_id, access_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_base_access_access ON grids.base_access USING btree (access_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.controlled_destruction_runs (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      status text NOT NULL,
      requested_by uuid,
      requested_by_display_name text,
      requested_at timestamp with time zone DEFAULT now() NOT NULL,
      started_at timestamp with time zone,
      completed_at timestamp with time zone,
      last_error text,
      CONSTRAINT controlled_destruction_runs_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT controlled_destruction_runs_pkey PRIMARY KEY (id),
      CONSTRAINT controlled_destruction_runs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT controlled_destruction_runs_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT controlled_destruction_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'cancel_requested'::text, 'completed'::text, 'partial'::text, 'canceled'::text, 'failed'::text])))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_controlled_destruction_runs_base ON grids.controlled_destruction_runs USING btree (base_id, requested_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_controlled_destruction_runs_short_id ON grids.controlled_destruction_runs USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.custom_apps (
      id uuid NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      name text NOT NULL,
      icon text,
      draft_definition jsonb NOT NULL,
      draft_capabilities jsonb,
      published_definition jsonb,
      published_capabilities jsonb,
      published_at timestamp with time zone,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT custom_apps_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT custom_apps_pkey PRIMARY KEY (id),
      CONSTRAINT custom_apps_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_custom_apps_base ON grids.custom_apps USING btree (base_id, name) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_custom_apps_short_id ON grids.custom_apps USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_profile_counters (
      base_id uuid NOT NULL,
      profile_id text NOT NULL,
      next_value bigint DEFAULT 1 NOT NULL,
      CONSTRAINT document_profile_counters_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE RESTRICT,
      CONSTRAINT document_profile_counters_next_value_check CHECK ((next_value > 0)),
      CONSTRAINT document_profile_counters_pkey PRIMARY KEY (base_id, profile_id),
      CONSTRAINT document_profile_counters_profile_id_chk CHECK ((profile_id ~ '^[a-z][a-z0-9.-]{2,99}$'::text))
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.email_templates (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      name text NOT NULL,
      description text,
      subject text NOT NULL,
      html text NOT NULL,
      sample_data jsonb DEFAULT '{}'::jsonb NOT NULL,
      enabled boolean DEFAULT true NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      created_by uuid,
      updated_by uuid,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT email_templates_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT email_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT email_templates_html_length_chk CHECK (((length(html) >= 1) AND (length(html) <= 200000))),
      CONSTRAINT email_templates_pkey PRIMARY KEY (id),
      CONSTRAINT email_templates_sample_data_object_chk CHECK ((jsonb_typeof(sample_data) = 'object'::text)),
      CONSTRAINT email_templates_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT email_templates_subject_length_chk CHECK (((length(subject) >= 1) AND (length(subject) <= 1000))),
      CONSTRAINT email_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_email_templates_base_live ON grids.email_templates USING btree (base_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_email_templates_short_id ON grids.email_templates USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_protected_references (
      file_id uuid NOT NULL,
      owner_kind text NOT NULL,
      owner_id uuid NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid,
      record_id uuid,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT file_protected_references_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT file_protected_references_file_id_fkey FOREIGN KEY (file_id) REFERENCES grids.files(id) ON DELETE RESTRICT,
      CONSTRAINT file_protected_references_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['record_revision'::text, 'document_artifact'::text]))),
      CONSTRAINT file_protected_references_pkey PRIMARY KEY (file_id, owner_kind, owner_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_protected_references_owner ON grids.file_protected_references USING btree (owner_kind, owner_id, file_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_retention_candidates (
      file_id uuid NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid,
      table_short_id text,
      table_name text,
      unreferenced_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT file_retention_candidates_file_id_fkey FOREIGN KEY (file_id) REFERENCES grids.files(id) ON DELETE CASCADE,
      CONSTRAINT file_retention_candidates_pkey PRIMARY KEY (file_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_retention_candidates_base ON grids.file_retention_candidates USING btree (base_id, unreferenced_at, file_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.preservation_holds (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      scope_type text DEFAULT 'base'::text NOT NULL,
      table_id uuid,
      table_short_id text,
      table_name text,
      reason text NOT NULL,
      created_by uuid,
      created_by_display_name text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      release_reason text,
      released_by uuid,
      released_by_display_name text,
      released_at timestamp with time zone,
      CONSTRAINT preservation_holds_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT preservation_holds_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT preservation_holds_pkey PRIMARY KEY (id),
      CONSTRAINT preservation_holds_reason_check CHECK ((((char_length(reason) >= 1) AND (char_length(reason) <= 1000)) AND (reason = btrim(reason)))),
      CONSTRAINT preservation_holds_release_chk CHECK ((((released_at IS NULL) AND (release_reason IS NULL) AND (released_by IS NULL) AND (released_by_display_name IS NULL)) OR ((released_at IS NOT NULL) AND (release_reason IS NOT NULL)))),
      CONSTRAINT preservation_holds_release_reason_check CHECK (((release_reason IS NULL) OR (((char_length(release_reason) >= 1) AND (char_length(release_reason) <= 1000)) AND (release_reason = btrim(release_reason))))),
      CONSTRAINT preservation_holds_released_by_fkey FOREIGN KEY (released_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT preservation_holds_scope_chk CHECK ((((scope_type = 'base'::text) AND (table_id IS NULL) AND (table_short_id IS NULL) AND (table_name IS NULL)) OR ((scope_type = 'table'::text) AND (table_id IS NOT NULL) AND (table_short_id IS NOT NULL) AND (table_name IS NOT NULL)))),
      CONSTRAINT preservation_holds_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_preservation_holds_active_base ON grids.preservation_holds USING btree (base_id, created_at DESC, id DESC) WHERE (released_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_preservation_holds_active_table ON grids.preservation_holds USING btree (base_id, table_id, created_at DESC, id DESC) WHERE ((released_at IS NULL) AND (scope_type = 'table'::text))
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_preservation_holds_short_id ON grids.preservation_holds USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_delivery_failures (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid NOT NULL,
      consumer_group text NOT NULL,
      event_id text NOT NULL,
      payload text,
      error text NOT NULL,
      attempts integer DEFAULT 1 NOT NULL,
      status text DEFAULT 'retrying'::text NOT NULL,
      first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
      last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
      dead_at timestamp with time zone,
      CONSTRAINT record_event_delivery_failure_base_id_consumer_group_event__key UNIQUE (base_id, consumer_group, event_id),
      CONSTRAINT record_event_delivery_failures_attempts_check CHECK ((attempts > 0)),
      CONSTRAINT record_event_delivery_failures_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT record_event_delivery_failures_check CHECK (((status = 'dead'::text) = (dead_at IS NOT NULL))),
      CONSTRAINT record_event_delivery_failures_pkey PRIMARY KEY (id),
      CONSTRAINT record_event_delivery_failures_status_check CHECK ((status = ANY (ARRAY['retrying'::text, 'dead'::text])))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_delivery_failures_dead ON grids.record_event_delivery_failures USING btree (base_id, dead_at DESC) WHERE (status = 'dead'::text)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.retention_policies (
      base_id uuid NOT NULL,
      minimum_days integer NOT NULL,
      updated_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT retention_policies_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT retention_policies_minimum_days_check CHECK (((minimum_days >= 1) AND (minimum_days <= 36500))),
      CONSTRAINT retention_policies_pkey PRIMARY KEY (base_id),
      CONSTRAINT retention_policies_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.tables (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      kind text DEFAULT 'stored'::text NOT NULL,
      name text NOT NULL,
      description text,
      icon text,
      columns jsonb DEFAULT '[]'::jsonb NOT NULL,
      display_config jsonb DEFAULT '{"mode": "table"}'::jsonb NOT NULL,
      audit_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
      mutation_policy jsonb DEFAULT '{"mode": "all"}'::jsonb NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      disable_direct_insert boolean DEFAULT false NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      finalization_policy_revision integer DEFAULT 0 NOT NULL,
      CONSTRAINT tables_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT tables_federated_mutation_policy_chk CHECK (((kind <> 'federated'::text) OR (mutation_policy = '{"mode": "all"}'::jsonb))),
      CONSTRAINT tables_federated_read_only_chk CHECK (((kind <> 'federated'::text) OR (disable_direct_insert AND (audit_policy = '{}'::jsonb)))),
      CONSTRAINT tables_kind_chk CHECK ((kind = ANY (ARRAY['stored'::text, 'federated'::text]))),
      CONSTRAINT tables_pkey PRIMARY KEY (id),
      CONSTRAINT tables_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_grids_tables_id_base ON grids.tables USING btree (id, base_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_tables_base_live ON grids.tables USING btree (base_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_tables_live_name ON grids.tables USING btree (base_id, lower(btrim(name))) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_tables_short_id ON grids.tables USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_profile (
      id uuid NOT NULL,
      base_id uuid NOT NULL,
      short_id text NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      owner_user_id uuid,
      enabled boolean DEFAULT false NOT NULL,
      record_event_active_since timestamp with time zone,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT workflow_profile_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT workflow_profile_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT workflow_profile_pkey PRIMARY KEY (id),
      CONSTRAINT workflow_profile_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_profile_base_live ON grids.workflow_profile USING btree (base_id, "position", created_at, id) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_profile_record_events ON grids.workflow_profile USING btree (base_id, record_event_active_since) WHERE ((deleted_at IS NULL) AND enabled AND (record_event_active_since IS NOT NULL))
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_workflow_profile_short_id ON grids.workflow_profile USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_run_profile (
      run_id uuid NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      workflow_id uuid NOT NULL,
      launcher_id uuid,
      launcher_kind text,
      channel text NOT NULL,
      actor_user_id uuid,
      service_account_id uuid,
      request_fingerprint text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      captured_bytes bigint DEFAULT 0 NOT NULL,
      CONSTRAINT workflow_run_profile_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT workflow_run_profile_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT workflow_run_profile_captured_bytes_check CHECK ((captured_bytes >= 0)),
      CONSTRAINT workflow_run_profile_channel_check CHECK ((channel = ANY (ARRAY['api'::text, 'customApp'::text, 'scanner'::text, 'bulk'::text, 'record'::text, 'schedule'::text, 'recordEvent'::text]))),
      CONSTRAINT workflow_run_profile_launcher_kind_check CHECK (((launcher_kind IS NULL) OR (launcher_kind = ANY (ARRAY['scanner'::text, 'bulk'::text, 'record'::text, 'customApp'::text])))),
      CONSTRAINT workflow_run_profile_pkey PRIMARY KEY (run_id),
      CONSTRAINT workflow_run_profile_service_account_id_fkey FOREIGN KEY (service_account_id) REFERENCES auth.service_accounts(id) ON DELETE SET NULL,
      CONSTRAINT workflow_run_profile_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_base_identity ON grids.workflow_run_profile USING btree (run_id, base_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_base ON grids.workflow_run_profile USING btree (base_id, channel, created_at DESC, run_id DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_short_id ON grids.workflow_run_profile USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_run_profile_workflow ON grids.workflow_run_profile USING btree (workflow_id, created_at DESC, run_id DESC)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.controlled_destruction_items (
      run_id uuid NOT NULL,
      position integer NOT NULL,
      file_id uuid NOT NULL,
      file_short_id text NOT NULL,
      table_id uuid NOT NULL,
      table_short_id text NOT NULL,
      table_name text NOT NULL,
      filename text NOT NULL,
      size_bytes bigint NOT NULL,
      status text DEFAULT 'pending'::text NOT NULL,
      message text,
      processed_at timestamp with time zone,
      CONSTRAINT controlled_destruction_items_pkey PRIMARY KEY (run_id, "position"),
      CONSTRAINT controlled_destruction_items_run_id_file_id_key UNIQUE (run_id, file_id),
      CONSTRAINT controlled_destruction_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES grids.controlled_destruction_runs(id) ON DELETE CASCADE,
      CONSTRAINT controlled_destruction_items_size_bytes_check CHECK ((size_bytes >= 0)),
      CONSTRAINT controlled_destruction_items_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'destroyed'::text, 'skipped'::text, 'failed'::text])))
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.custom_app_access (
      custom_app_id uuid NOT NULL,
      access_id uuid NOT NULL,
      CONSTRAINT custom_app_access_access_id_fkey FOREIGN KEY (access_id) REFERENCES auth.access(id) ON DELETE CASCADE,
      CONSTRAINT custom_app_access_custom_app_id_fkey FOREIGN KEY (custom_app_id) REFERENCES grids.custom_apps(id) ON DELETE CASCADE,
      CONSTRAINT custom_app_access_pkey PRIMARY KEY (custom_app_id, access_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_custom_app_access_access ON grids.custom_app_access USING btree (access_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_templates (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      name text NOT NULL,
      description text,
      source text NOT NULL,
      renderer_kind text NOT NULL,
      issuance_policy text DEFAULT 'repeatable' NOT NULL CHECK (issuance_policy IN ('repeatable', 'oncePerFinalizedRecord')),
      html text,
      header_html text,
      footer_html text,
      page_css text,
      number_template text,
      filename_template text,
      profile_id text,
      profile_version integer,
      profile_input_template text,
      enabled boolean DEFAULT true NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      created_by uuid,
      updated_by uuid,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT document_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT document_templates_filename_template_length_chk CHECK (((filename_template IS NULL) OR ((length(filename_template) >= 1) AND (length(filename_template) <= 5000)))),
      CONSTRAINT document_templates_footer_html_length_chk CHECK (((footer_html IS NULL) OR ((length(footer_html) >= 1) AND (length(footer_html) <= 50000)))),
      CONSTRAINT document_templates_header_html_length_chk CHECK (((header_html IS NULL) OR ((length(header_html) >= 1) AND (length(header_html) <= 50000)))),
      CONSTRAINT document_templates_html_length_chk CHECK (((html IS NULL) OR ((length(html) >= 1) AND (length(html) <= 200000)))),
      CONSTRAINT document_templates_id_table_id_key UNIQUE (id, table_id),
      CONSTRAINT document_templates_number_template_length_chk CHECK (((number_template IS NULL) OR ((length(number_template) >= 1) AND (length(number_template) <= 5000)))),
      CONSTRAINT document_templates_page_css_length_chk CHECK (((page_css IS NULL) OR ((length(page_css) >= 1) AND (length(page_css) <= 50000)))),
      CONSTRAINT document_templates_pkey PRIMARY KEY (id),
      CONSTRAINT document_templates_renderer_chk CHECK ((((renderer_kind = 'html'::text) AND (html IS NOT NULL) AND (number_template IS NOT NULL) AND (filename_template IS NOT NULL) AND (profile_id IS NULL) AND (profile_version IS NULL) AND (profile_input_template IS NULL)) OR ((renderer_kind = 'profile'::text) AND (html IS NULL) AND (header_html IS NULL) AND (footer_html IS NULL) AND (page_css IS NULL) AND (number_template IS NULL) AND (filename_template IS NULL) AND (profile_id IS NOT NULL) AND (profile_version > 0) AND (profile_input_template IS NOT NULL)))),
      CONSTRAINT document_templates_renderer_kind_chk CHECK ((renderer_kind = ANY (ARRAY['html'::text, 'profile'::text]))),
      CONSTRAINT document_templates_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT document_templates_source_length_chk CHECK (((length(source) >= 1) AND (length(source) <= 20000))),
      CONSTRAINT document_templates_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE,
      CONSTRAINT document_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_templates_short_id ON grids.document_templates USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_templates_table_live ON grids.document_templates USING btree (table_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.evidence_exports (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid,
      requested_by uuid,
      requested_by_display_name text,
      sections text[] NOT NULL,
      range_from timestamp with time zone,
      range_to timestamp with time zone,
      status text DEFAULT 'queued'::text NOT NULL,
      attempt integer DEFAULT 1 NOT NULL,
      estimated_entries integer,
      processed_entries integer DEFAULT 0 NOT NULL,
      cut_at timestamp with time zone,
      package_filename text,
      package_size_bytes bigint,
      package_sha256 text,
      manifest_sha256 text,
      manifest jsonb,
      last_error text,
      requested_at timestamp with time zone DEFAULT now() NOT NULL,
      started_at timestamp with time zone,
      completed_at timestamp with time zone,
      expires_at timestamp with time zone,
      CONSTRAINT evidence_exports_attempt_check CHECK ((attempt >= 1)),
      CONSTRAINT evidence_exports_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT evidence_exports_package_chk CHECK ((((status <> 'completed'::text) AND (package_filename IS NULL) AND (package_size_bytes IS NULL) AND (package_sha256 IS NULL) AND (manifest_sha256 IS NULL)) OR ((status = 'completed'::text) AND (package_filename IS NOT NULL) AND (package_size_bytes IS NOT NULL) AND (package_sha256 ~ '^[a-f0-9]{64}$'::text) AND (manifest_sha256 ~ '^[a-f0-9]{64}$'::text) AND (manifest IS NOT NULL)))),
      CONSTRAINT evidence_exports_pkey PRIMARY KEY (id),
      CONSTRAINT evidence_exports_processed_entries_check CHECK ((processed_entries >= 0)),
      CONSTRAINT evidence_exports_range_chk CHECK (((range_from IS NULL) OR (range_to IS NULL) OR (range_from <= range_to))),
      CONSTRAINT evidence_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT evidence_exports_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT evidence_exports_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'cancel_requested'::text, 'completed'::text, 'failed'::text, 'canceled'::text, 'expired'::text]))),
      CONSTRAINT evidence_exports_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_evidence_exports_base_page ON grids.evidence_exports USING btree (base_id, requested_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_evidence_exports_short_id ON grids.evidence_exports USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_table_revisions (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      table_id uuid NOT NULL,
      revision integer NOT NULL,
      status text DEFAULT 'draft'::text NOT NULL,
      diagnostics jsonb DEFAULT '[]'::jsonb NOT NULL,
      created_by uuid,
      published_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      published_at timestamp with time zone,
      CONSTRAINT federated_table_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT federated_table_revisions_pkey PRIMARY KEY (id),
      CONSTRAINT federated_table_revisions_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT federated_table_revisions_revision_check CHECK ((revision > 0)),
      CONSTRAINT federated_table_revisions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'degraded'::text, 'superseded'::text]))),
      CONSTRAINT federated_table_revisions_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE,
      CONSTRAINT federated_table_revisions_table_id_revision_key UNIQUE (table_id, revision)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_revision_current ON grids.federated_table_revisions USING btree (table_id) WHERE (status = ANY (ARRAY['active'::text, 'degraded'::text]))
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_revision_draft ON grids.federated_table_revisions USING btree (table_id) WHERE (status = 'draft'::text)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.fields (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      name text NOT NULL,
      description text,
      icon text,
      type text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      required boolean DEFAULT false NOT NULL,
      default_value jsonb,
      indexed boolean DEFAULT false NOT NULL,
      unique_constraint boolean DEFAULT false NOT NULL,
      presentable boolean DEFAULT false NOT NULL,
      hide_in_table boolean DEFAULT false NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT fields_pkey PRIMARY KEY (id),
      CONSTRAINT fields_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT fields_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_fields_live_name ON grids.fields USING btree (table_id, lower(btrim(name))) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_fields_relation_target ON grids.fields USING btree (((config ->> 'targetTableId'::text)), table_id) WHERE ((deleted_at IS NULL) AND (type = 'relation'::text))
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_fields_short_id ON grids.fields USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_fields_table ON grids.fields USING btree (table_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.form_submissions (
      scope_hash text NOT NULL,
      key_hash text NOT NULL,
      request_hash text NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT form_submissions_pkey PRIMARY KEY (scope_hash, key_hash),
      CONSTRAINT form_submissions_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.forms (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      name text NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      public_token text,
      is_active boolean DEFAULT true NOT NULL,
      owner_user_id uuid,
      position integer DEFAULT 0 NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT forms_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT forms_pkey PRIMARY KEY (id),
      CONSTRAINT forms_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT forms_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_forms_public_token ON grids.forms USING btree (public_token) WHERE ((public_token IS NOT NULL) AND (deleted_at IS NULL))
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_forms_short_id ON grids.forms USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_forms_table_live ON grids.forms USING btree (table_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_outbox (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      payload jsonb NOT NULL,
      status text DEFAULT 'pending'::text NOT NULL,
      attempts integer DEFAULT 0 NOT NULL,
      next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
      last_error text,
      delivered_at timestamp with time zone,
      dead_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_event_outbox_attempts_check CHECK ((attempts >= 0)),
      CONSTRAINT record_event_outbox_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT record_event_outbox_pkey PRIMARY KEY (id),
      CONSTRAINT record_event_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'failed'::text, 'delivered'::text, 'dead'::text]))),
      CONSTRAINT record_event_outbox_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_dead ON grids.record_event_outbox USING btree (dead_at) WHERE (status = 'dead'::text)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_delivered ON grids.record_event_outbox USING btree (delivered_at) WHERE (status = 'delivered'::text)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_feed_base ON grids.record_event_outbox USING btree (base_id, created_at, id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_feed_table ON grids.record_event_outbox USING btree (base_id, table_id, created_at, id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_pending ON grids.record_event_outbox USING btree (next_attempt_at, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]))
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_record_pending ON grids.record_event_outbox USING btree (record_id, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]))
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.table_finalization_activations (
      table_id uuid NOT NULL,
      enabled_by uuid,
      enabled_at timestamp with time zone DEFAULT now() NOT NULL,
      mode text DEFAULT 'direct'::text NOT NULL,
      approver_group_id uuid,
      policy_revision integer DEFAULT 1 NOT NULL,
      CONSTRAINT table_finalization_activations_enabled_by_fkey FOREIGN KEY (enabled_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT table_finalization_activations_pkey PRIMARY KEY (table_id),
      CONSTRAINT table_finalization_activations_policy_chk CHECK ((((mode = 'direct'::text) AND (approver_group_id IS NULL)) OR ((mode = 'four_eyes'::text) AND (approver_group_id IS NOT NULL)))),
      CONSTRAINT table_finalization_activations_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.table_schema_revisions (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      table_id uuid NOT NULL,
      schema_hash text NOT NULL,
      fields jsonb NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT table_schema_revisions_pkey PRIMARY KEY (id),
      CONSTRAINT table_schema_revisions_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT,
      CONSTRAINT table_schema_revisions_table_id_schema_hash_key UNIQUE (table_id, schema_hash)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.views (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      base_id uuid NOT NULL,
      name text NOT NULL,
      description text,
      icon text,
      source text NOT NULL,
      ui jsonb DEFAULT '{}'::jsonb NOT NULL,
      owner_user_id uuid,
      position integer DEFAULT 0 NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT views_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT views_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
      CONSTRAINT views_pkey PRIMARY KEY (id),
      CONSTRAINT views_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT views_source_length_chk CHECK (((length(source) >= 1) AND (length(source) <= 20000))),
      CONSTRAINT views_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_views_live_name ON grids.views USING btree (base_id, lower(btrim(name))) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_views_short_id ON grids.views USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_views_table_live ON grids.views USING btree (table_id, "position") WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_email_deliveries (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid NOT NULL,
      workflow_id uuid,
      workflow_run_id uuid,
      workflow_step_key text NOT NULL,
      template_id uuid,
      recipient_kind text NOT NULL,
      recipient_value text,
      recipient_summary text NOT NULL,
      idempotency_key text NOT NULL,
      notification_id uuid,
      provider_status text,
      status text NOT NULL,
      subject text,
      rendered_html text,
      error text,
      recipient_index integer NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT workflow_email_deliveries_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT workflow_email_deliveries_idempotency_key_key UNIQUE (idempotency_key),
      CONSTRAINT workflow_email_deliveries_pkey PRIMARY KEY (id),
      CONSTRAINT workflow_email_deliveries_recipient_index_check CHECK ((recipient_index > 0)),
      CONSTRAINT workflow_email_deliveries_recipient_kind_check CHECK ((recipient_kind = ANY (ARRAY['email'::text, 'user'::text]))),
      CONSTRAINT workflow_email_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))),
      CONSTRAINT workflow_email_deliveries_template_id_fkey FOREIGN KEY (template_id) REFERENCES grids.email_templates(id) ON DELETE SET NULL,
      CONSTRAINT workflow_email_deliveries_workflow_run_id_workflow_step_key_key UNIQUE (workflow_run_id, workflow_step_key, recipient_index)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_email_deliveries_base ON grids.workflow_email_deliveries USING btree (base_id, created_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_email_deliveries_run ON grids.workflow_email_deliveries USING btree (workflow_run_id, created_at, id) WHERE (workflow_run_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_launchers (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      workflow_id uuid NOT NULL,
      name text NOT NULL,
      kind text NOT NULL,
      config jsonb NOT NULL,
      enabled boolean DEFAULT true NOT NULL,
      validated_revision integer NOT NULL,
      diagnostics jsonb DEFAULT '[]'::jsonb NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT workflow_launchers_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT workflow_launchers_diagnostics_array_chk CHECK ((jsonb_typeof(diagnostics) = 'array'::text)),
      CONSTRAINT workflow_launchers_kind_check CHECK ((kind = ANY (ARRAY['scanner'::text, 'bulk'::text, 'record'::text, 'customApp'::text]))),
      CONSTRAINT workflow_launchers_pkey PRIMARY KEY (id),
      CONSTRAINT workflow_launchers_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT workflow_launchers_validated_revision_check CHECK ((validated_revision >= 1)),
      CONSTRAINT workflow_launchers_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES grids.workflow_profile(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_workflow_launchers_short_id ON grids.workflow_launchers USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_workflow_launchers_workflow ON grids.workflow_launchers USING btree (workflow_id, kind, created_at, id) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.workflow_query_data (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      run_id uuid NOT NULL,
      step_key text NOT NULL,
      payload jsonb NOT NULL,
      sha256 text NOT NULL,
      row_count integer NOT NULL,
      captured_at timestamp with time zone NOT NULL,
      CONSTRAINT workflow_query_data_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
      CONSTRAINT workflow_query_data_pkey PRIMARY KEY (id),
      CONSTRAINT workflow_query_data_row_count_check CHECK (((row_count >= 0) AND (row_count <= 10000))),
      CONSTRAINT workflow_query_data_run_id_fkey FOREIGN KEY (run_id) REFERENCES grids.workflow_run_profile(run_id) ON DELETE CASCADE,
      CONSTRAINT workflow_query_data_run_id_step_key_key UNIQUE (run_id, step_key),
      CONSTRAINT workflow_query_data_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text)),
      CONSTRAINT workflow_query_data_step_key_check CHECK ((length(step_key) > 0))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_query_data_run_identity ON grids.workflow_query_data USING btree (id, run_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.durable_history_activations (
      table_id uuid NOT NULL,
      baseline_schema_revision_id uuid NOT NULL,
      status text DEFAULT 'activating'::text NOT NULL,
      activated_by uuid,
      activated_at timestamp with time zone NOT NULL,
      baseline_completed_at timestamp with time zone,
      CONSTRAINT durable_history_activations_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT durable_history_activations_baseline_schema_revision_id_fkey FOREIGN KEY (baseline_schema_revision_id) REFERENCES grids.table_schema_revisions(id) ON DELETE RESTRICT,
      CONSTRAINT durable_history_activations_pkey PRIMARY KEY (table_id),
      CONSTRAINT durable_history_activations_status_chk CHECK ((status = ANY (ARRAY['activating'::text, 'active'::text]))),
      CONSTRAINT durable_history_activations_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.evidence_export_chunks (
      export_id uuid NOT NULL,
      sequence integer NOT NULL,
      bytes bytea NOT NULL,
      CONSTRAINT evidence_export_chunks_bytes_check CHECK (((octet_length(bytes) >= 1) AND (octet_length(bytes) <= 1048576))),
      CONSTRAINT evidence_export_chunks_export_id_fkey FOREIGN KEY (export_id) REFERENCES grids.evidence_exports(id) ON DELETE CASCADE,
      CONSTRAINT evidence_export_chunks_pkey PRIMARY KEY (export_id, sequence),
      CONSTRAINT evidence_export_chunks_sequence_check CHECK ((sequence >= 0))
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_table_sources (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      revision_id uuid NOT NULL,
      source_table_id uuid NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      authorized_by uuid,
      authorized_at timestamp with time zone,
      revoked_by uuid,
      revoked_at timestamp with time zone,
      CONSTRAINT federated_table_sources_authorized_by_fkey FOREIGN KEY (authorized_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT federated_table_sources_pkey PRIMARY KEY (revision_id, source_table_id),
      CONSTRAINT federated_table_sources_position_check CHECK (("position" >= 0)),
      CONSTRAINT federated_table_sources_revision_id_fkey FOREIGN KEY (revision_id) REFERENCES grids.federated_table_revisions(id) ON DELETE CASCADE,
      CONSTRAINT federated_table_sources_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT federated_table_sources_source_table_id_fkey FOREIGN KEY (source_table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_sources_id ON grids.federated_table_sources USING btree (id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_sources_source ON grids.federated_table_sources USING btree (source_table_id, revision_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      owner_kind text NOT NULL,
      field_id uuid,
      document_template_id uuid,
      assignment text DEFAULT 'creation'::text NOT NULL,
      current_version integer DEFAULT 1 NOT NULL,
      archived_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT number_series_assignment_check CHECK ((assignment = ANY (ARRAY['creation'::text, 'finalization'::text]))),
      CONSTRAINT number_series_current_version_check CHECK ((current_version >= 1)),
      CONSTRAINT number_series_document_template_id_fkey FOREIGN KEY (document_template_id) REFERENCES grids.document_templates(id) ON DELETE CASCADE,
      CONSTRAINT number_series_document_template_id_key UNIQUE (document_template_id),
      CONSTRAINT number_series_field_id_fkey FOREIGN KEY (field_id) REFERENCES grids.fields(id) ON DELETE CASCADE,
      CONSTRAINT number_series_field_id_key UNIQUE (field_id),
      CONSTRAINT number_series_owner_chk CHECK ((((owner_kind = 'field'::text) AND (field_id IS NOT NULL) AND (document_template_id IS NULL)) OR ((owner_kind = 'document_template'::text) AND (document_template_id IS NOT NULL) AND (field_id IS NULL)))),
      CONSTRAINT number_series_owner_kind_check CHECK ((owner_kind = ANY (ARRAY['field'::text, 'document_template'::text]))),
      CONSTRAINT number_series_pkey PRIMARY KEY (id),
      CONSTRAINT number_series_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_number_series_short_id ON grids.number_series USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_snapshots (
      id uuid NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      event_type text NOT NULL,
      record_version integer NOT NULL,
      data jsonb NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_event_snapshots_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT record_event_snapshots_event_type_check CHECK ((event_type = ANY (ARRAY['record.created'::text, 'record.updated'::text, 'record.deleted'::text, 'record.restored'::text, 'record.finalized'::text, 'comment.created'::text]))),
      CONSTRAINT record_event_snapshots_id_fkey FOREIGN KEY (id) REFERENCES grids.record_event_outbox(id) ON DELETE CASCADE,
      CONSTRAINT record_event_snapshots_pkey PRIMARY KEY (id),
      CONSTRAINT record_event_snapshots_record_version_check CHECK ((record_version > 0)),
      CONSTRAINT record_event_snapshots_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_snapshots_record ON grids.record_event_snapshots USING btree (record_id, record_version, created_at DESC)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_revisions (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      schema_revision_id uuid NOT NULL,
      revision_no integer NOT NULL,
      action text NOT NULL,
      record_version integer NOT NULL,
      data jsonb NOT NULL,
      relations jsonb DEFAULT '{}'::jsonb NOT NULL,
      files jsonb DEFAULT '[]'::jsonb NOT NULL,
      changed_field_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
      deleted_at timestamp with time zone,
      actor_id uuid,
      actor_display_name text,
      actor_avatar_hash text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_revisions_action_chk CHECK ((action = ANY (ARRAY['baseline'::text, 'created'::text, 'updated'::text, 'deleted'::text, 'restored'::text, 'finalized'::text, 'file.added'::text, 'file.replaced'::text, 'file.removed'::text]))),
      CONSTRAINT record_revisions_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT record_revisions_pkey PRIMARY KEY (id),
      CONSTRAINT record_revisions_schema_revision_id_fkey FOREIGN KEY (schema_revision_id) REFERENCES grids.table_schema_revisions(id) ON DELETE RESTRICT,
      CONSTRAINT record_revisions_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT record_revisions_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT,
      CONSTRAINT record_revisions_table_id_record_id_revision_no_key UNIQUE (table_id, record_id, revision_no)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_revisions_baseline ON grids.record_revisions USING btree (table_id, record_id) WHERE (action = 'baseline'::text)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_revisions_short_id ON grids.record_revisions USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_field_mappings (
      revision_id uuid NOT NULL,
      target_field_id uuid NOT NULL,
      source_table_id uuid NOT NULL,
      source_field_id uuid NOT NULL,
      config jsonb DEFAULT '{}'::jsonb NOT NULL,
      CONSTRAINT federated_field_mappings_pkey PRIMARY KEY (revision_id, target_field_id, source_table_id),
      CONSTRAINT federated_field_mappings_revision_id_source_table_id_fkey FOREIGN KEY (revision_id, source_table_id) REFERENCES grids.federated_table_sources(revision_id, source_table_id) ON DELETE CASCADE,
      CONSTRAINT federated_field_mappings_source_field_id_fkey FOREIGN KEY (source_field_id) REFERENCES grids.fields(id) ON DELETE RESTRICT,
      CONSTRAINT federated_field_mappings_target_field_id_fkey FOREIGN KEY (target_field_id) REFERENCES grids.fields(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_mappings_source_field ON grids.federated_field_mappings USING btree (source_field_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_mappings_target_field ON grids.federated_field_mappings USING btree (target_field_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series_scopes (
      series_id uuid NOT NULL,
      scope text NOT NULL,
      sequence_name text NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT number_series_scopes_pkey PRIMARY KEY (series_id, scope),
      CONSTRAINT number_series_scopes_sequence_name_key UNIQUE (sequence_name),
      CONSTRAINT number_series_scopes_series_id_fkey FOREIGN KEY (series_id) REFERENCES grids.number_series(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series_versions (
      series_id uuid NOT NULL,
      version integer NOT NULL,
      strategy text NOT NULL,
      prefix text DEFAULT ''::text NOT NULL,
      padding integer DEFAULT 1 NOT NULL,
      period text,
      number_template text,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT number_series_versions_padding_check CHECK (((padding >= 1) AND (padding <= 16))),
      CONSTRAINT number_series_versions_period_check CHECK ((period = ANY (ARRAY['year'::text, 'month'::text, 'day'::text]))),
      CONSTRAINT number_series_versions_pkey PRIMARY KEY (series_id, version),
      CONSTRAINT number_series_versions_series_id_fkey FOREIGN KEY (series_id) REFERENCES grids.number_series(id) ON DELETE CASCADE,
      CONSTRAINT number_series_versions_strategy_check CHECK ((strategy = ANY (ARRAY['sequence'::text, 'date_sequence'::text, 'document'::text]))),
      CONSTRAINT number_series_versions_version_check CHECK ((version >= 1))
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.records (
      id uuid NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      data jsonb DEFAULT '{}'::jsonb NOT NULL,
      local_calculations jsonb DEFAULT '{}'::jsonb NOT NULL,
      version integer DEFAULT 1 NOT NULL,
      deleted_at timestamp with time zone,
      created_by uuid,
      updated_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      finalized_computed_types jsonb,
      finalized_computed_dependencies jsonb,
      finalized_at timestamp with time zone,
      finalized_by uuid,
      final_revision_id uuid,
      CONSTRAINT records_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT records_final_revision_id_fkey FOREIGN KEY (final_revision_id) REFERENCES grids.record_revisions(id) ON DELETE RESTRICT,
      CONSTRAINT records_finalization_marker_chk CHECK ((((finalized_at IS NULL) AND (final_revision_id IS NULL)) OR ((finalized_at IS NOT NULL) AND (final_revision_id IS NOT NULL)))),
      CONSTRAINT records_finalized_by_fkey FOREIGN KEY (finalized_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT records_pkey PRIMARY KEY (id),
      CONSTRAINT records_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT records_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE,
      CONSTRAINT records_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL
    )
  `.simple();
  await sql`ALTER TABLE grids.records ADD COLUMN IF NOT EXISTS local_calculations jsonb NOT NULL DEFAULT '{}'::jsonb`.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.current_local_calculations(value jsonb, expected_signature text, field_id text)
    RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $function$
    BEGIN
      IF value->>'signature' IS DISTINCT FROM expected_signature
        OR NOT COALESCE((value->'values') ? field_id, false)
        OR jsonb_typeof(value->'errors'->field_id) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'grids: stale local calculation';
      END IF;
      RETURN value;
    END;
    $function$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.invalidate_local_calculations()
    RETURNS trigger LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.finalized_at IS NULL AND NEW.local_calculations->>'inputs' IS DISTINCT FROM md5(NEW.data::text) THEN
        NEW.local_calculations := '{}'::jsonb;
      END IF;
      RETURN NEW;
    END;
    $function$
  `.simple();
  await sql`DROP TRIGGER IF EXISTS record_local_calculations ON grids.records`.simple();
  await sql`CREATE TRIGGER record_local_calculations BEFORE INSERT OR UPDATE OF data, local_calculations
    ON grids.records FOR EACH ROW EXECUTE FUNCTION grids.invalidate_local_calculations()`.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_grids_records_id_table ON grids.records USING btree (id, table_id)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_records_short_id ON grids.records USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_records_table_creator_live ON grids.records USING btree (table_id, created_by, id) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_records_table_finalized ON grids.records USING btree (table_id, finalized_at) WHERE (finalized_at IS NOT NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_records_table_live ON grids.records USING btree (table_id, id) WHERE (deleted_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_records_table_trash ON grids.records USING btree (table_id, deleted_at) WHERE (deleted_at IS NOT NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_attachments (
      file_id uuid NOT NULL,
      record_id uuid NOT NULL,
      field_id uuid NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      attached_by uuid,
      attached_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT file_attachments_attached_by_fkey FOREIGN KEY (attached_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT file_attachments_field_id_fkey FOREIGN KEY (field_id) REFERENCES grids.fields(id) ON DELETE CASCADE,
      CONSTRAINT file_attachments_file_id_fkey FOREIGN KEY (file_id) REFERENCES grids.files(id) ON DELETE RESTRICT,
      CONSTRAINT file_attachments_pkey PRIMARY KEY (file_id),
      CONSTRAINT file_attachments_record_id_fkey FOREIGN KEY (record_id) REFERENCES grids.records(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_attachments_field ON grids.file_attachments USING btree (field_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_attachments_record_field ON grids.file_attachments USING btree (record_id, field_id, "position", attached_at, file_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_allocations (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      series_id uuid NOT NULL,
      version integer NOT NULL,
      scope text NOT NULL,
      value bigint NOT NULL,
      rendered_value text NOT NULL,
      consumer_kind text,
      consumer_id uuid,
      allocated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT number_allocations_consumer_chk CHECK ((((consumer_kind IS NULL) AND (consumer_id IS NULL)) OR ((consumer_kind IS NOT NULL) AND (consumer_id IS NOT NULL)))),
      CONSTRAINT number_allocations_consumer_kind_check CHECK ((consumer_kind = ANY (ARRAY['record'::text, 'document'::text]))),
      CONSTRAINT number_allocations_pkey PRIMARY KEY (id),
      CONSTRAINT number_allocations_series_id_fkey FOREIGN KEY (series_id) REFERENCES grids.number_series(id) ON DELETE CASCADE,
      CONSTRAINT number_allocations_series_id_rendered_value_key UNIQUE (series_id, rendered_value),
      CONSTRAINT number_allocations_series_id_scope_value_key UNIQUE (series_id, scope, value),
      CONSTRAINT number_allocations_series_id_version_fkey FOREIGN KEY (series_id, version) REFERENCES grids.number_series_versions(series_id, version) ON DELETE CASCADE,
      CONSTRAINT number_allocations_value_check CHECK ((value >= 1))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_number_allocations_consumer ON grids.number_allocations USING btree (consumer_kind, consumer_id) WHERE (consumer_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_comments (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      author_user_id uuid,
      body text NOT NULL,
      deleted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_comments_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT record_comments_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT record_comments_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 10000))),
      CONSTRAINT record_comments_pkey PRIMARY KEY (id),
      CONSTRAINT record_comments_record_id_fkey FOREIGN KEY (record_id) REFERENCES grids.records(id) ON DELETE CASCADE,
      CONSTRAINT record_comments_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT record_comments_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_comments_short_id ON grids.record_comments USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_comments_thread ON grids.record_comments USING btree (base_id, table_id, record_id, created_at DESC, id DESC) INCLUDE (author_user_id, updated_at, deleted_at)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_external_bindings (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      provider text NOT NULL,
      provider_account text NOT NULL,
      resource_kind text NOT NULL,
      external_id text NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_external_bindings_external_id_check CHECK (((char_length(external_id) >= 1) AND (char_length(external_id) <= 500))),
      CONSTRAINT record_external_bindings_pkey PRIMARY KEY (id),
      CONSTRAINT record_external_bindings_provider_account_check CHECK (((char_length(provider_account) >= 1) AND (char_length(provider_account) <= 200))),
      CONSTRAINT record_external_bindings_provider_check CHECK (((char_length(provider) >= 1) AND (char_length(provider) <= 100))),
      CONSTRAINT record_external_bindings_provider_provider_account_resource_key UNIQUE (provider, provider_account, resource_kind, external_id),
      CONSTRAINT record_external_bindings_record_table_fkey FOREIGN KEY (record_id, table_id) REFERENCES grids.records(id, table_id) ON DELETE CASCADE,
      CONSTRAINT record_external_bindings_resource_kind_check CHECK (((char_length(resource_kind) >= 1) AND (char_length(resource_kind) <= 100))),
      CONSTRAINT record_external_bindings_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_external_bindings_record ON grids.record_external_bindings USING btree (record_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_finalization_requests (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      record_version integer NOT NULL,
      policy_revision integer NOT NULL,
      status text DEFAULT 'pending'::text NOT NULL,
      requested_by uuid NOT NULL,
      request_comment text,
      requested_at timestamp with time zone DEFAULT now() NOT NULL,
      resolved_by uuid,
      resolution_comment text,
      resolved_at timestamp with time zone,
      computed_snapshot jsonb,
      CONSTRAINT record_finalization_requests_pkey PRIMARY KEY (id),
      CONSTRAINT record_finalization_requests_record_id_fkey FOREIGN KEY (record_id) REFERENCES grids.records(id) ON DELETE RESTRICT,
      CONSTRAINT record_finalization_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
      CONSTRAINT record_finalization_requests_resolution_chk CHECK ((((status = 'pending'::text) AND (resolved_by IS NULL) AND (resolved_at IS NULL)) OR ((status <> 'pending'::text) AND (resolved_at IS NOT NULL)))),
      CONSTRAINT record_finalization_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT record_finalization_requests_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT record_finalization_requests_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'superseded'::text]))),
      CONSTRAINT record_finalization_requests_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_pending ON grids.record_finalization_requests USING btree (record_id) WHERE (status = 'pending'::text)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_pending_table ON grids.record_finalization_requests USING btree (table_id, record_id, record_version, policy_revision) WHERE (status = 'pending'::text)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_short_id ON grids.record_finalization_requests USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_table ON grids.record_finalization_requests USING btree (table_id, requested_at DESC)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_links (
      from_record_id uuid NOT NULL,
      from_field_id uuid NOT NULL,
      to_record_id uuid NOT NULL,
      position integer DEFAULT 0 NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_links_from_field_id_fkey FOREIGN KEY (from_field_id) REFERENCES grids.fields(id) ON DELETE CASCADE,
      CONSTRAINT record_links_from_record_id_fkey FOREIGN KEY (from_record_id) REFERENCES grids.records(id) ON DELETE CASCADE,
      CONSTRAINT record_links_pkey PRIMARY KEY (from_record_id, from_field_id, to_record_id),
      CONSTRAINT record_links_to_record_id_fkey FOREIGN KEY (to_record_id) REFERENCES grids.records(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_links_forward ON grids.record_links USING btree (from_field_id, from_record_id, "position")
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_links_reverse_page ON grids.record_links USING btree (to_record_id, from_field_id, from_record_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_scan_codes (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      code text NOT NULL,
      active boolean DEFAULT true NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      rotated_at timestamp with time zone,
      CONSTRAINT record_scan_codes_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE CASCADE,
      CONSTRAINT record_scan_codes_code_length_chk CHECK (((length(code) >= 16) AND (length(code) <= 200))),
      CONSTRAINT record_scan_codes_pkey PRIMARY KEY (id),
      CONSTRAINT record_scan_codes_record_id_fkey FOREIGN KEY (record_id) REFERENCES grids.records(id) ON DELETE CASCADE,
      CONSTRAINT record_scan_codes_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_scan_codes_active_record ON grids.record_scan_codes USING btree (record_id) WHERE (active = true)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_scan_codes_code ON grids.record_scan_codes USING btree (code)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_scan_codes_table ON grids.record_scan_codes USING btree (table_id, record_id) WHERE (active = true)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_snapshots (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      root jsonb NOT NULL,
      graph jsonb NOT NULL,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_snapshots_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE RESTRICT,
      CONSTRAINT record_snapshots_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT record_snapshots_id_base_id_table_id_record_id_key UNIQUE (id, base_id, table_id, record_id),
      CONSTRAINT record_snapshots_pkey PRIMARY KEY (id),
      CONSTRAINT record_snapshots_record_table_fkey FOREIGN KEY (record_id, table_id) REFERENCES grids.records(id, table_id) ON DELETE RESTRICT,
      CONSTRAINT record_snapshots_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT record_snapshots_table_base_fkey FOREIGN KEY (table_id, base_id) REFERENCES grids.tables(id, base_id) ON DELETE RESTRICT,
      CONSTRAINT record_snapshots_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_snapshots_record ON grids.record_snapshots USING btree (table_id, record_id, created_at DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_snapshots_short_id ON grids.record_snapshots USING btree (short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.documents (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      template_id uuid,
      workflow_run_id uuid,
      workflow_step_key text,
      snapshot_id uuid,
      base_id uuid NOT NULL,
      table_id uuid,
      record_id uuid,
      document_number text NOT NULL,
      filename text NOT NULL,
      tags text[] DEFAULT '{}'::text[] NOT NULL,
      template_snapshot jsonb NOT NULL,
      render_data jsonb NOT NULL,
      renderer_kind text NOT NULL,
      renderer_version text NOT NULL,
      template_revision text NOT NULL,
      profile_id text,
      profile_version integer,
      profile_snapshot jsonb,
      snapshot_sha256 text,
      validator_version text,
      validation_status text,
      validation_report jsonb,
      issued_actor jsonb NOT NULL,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      profile_output jsonb,
      record_sources_complete boolean DEFAULT false NOT NULL,
      primary_artifact_key text NOT NULL,
      query_data_id uuid,
      associated_query_data_id uuid,
      CONSTRAINT documents_associated_query_binding_fkey FOREIGN KEY (associated_query_data_id, workflow_run_id) REFERENCES grids.workflow_query_data(id, run_id) ON DELETE RESTRICT,
      CONSTRAINT documents_associated_query_source_chk CHECK (((associated_query_data_id IS NULL) OR ((query_data_id IS NOT NULL) AND (workflow_run_id IS NOT NULL)))),
      CONSTRAINT documents_base_id_document_number_key UNIQUE (base_id, document_number),
      CONSTRAINT documents_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE RESTRICT,
      CONSTRAINT documents_check CHECK (((profile_output IS NULL) OR ((renderer_kind = 'profile'::text) AND (jsonb_typeof(profile_output) = 'object'::text)))),
      CONSTRAINT documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT documents_filename_length_chk CHECK (((length(filename) >= 1) AND (length(filename) <= 255))),
      CONSTRAINT documents_id_base_id_key UNIQUE (id, base_id),
      CONSTRAINT documents_id_base_id_short_id_key UNIQUE (id, base_id, short_id),
      CONSTRAINT documents_id_base_id_table_id_record_id_key UNIQUE (id, base_id, table_id, record_id),
      CONSTRAINT documents_issued_actor_object_chk CHECK ((jsonb_typeof(issued_actor) = 'object'::text)),
      CONSTRAINT documents_number_length_chk CHECK (((length(document_number) >= 1) AND (length(document_number) <= 200))),
      CONSTRAINT documents_pkey PRIMARY KEY (id),
      CONSTRAINT documents_query_data_binding_fkey FOREIGN KEY (query_data_id, workflow_run_id) REFERENCES grids.workflow_query_data(id, run_id) ON DELETE RESTRICT,
      CONSTRAINT documents_query_source_chk CHECK (((query_data_id IS NULL) OR ((template_id IS NULL) AND (workflow_run_id IS NOT NULL)))),
      CONSTRAINT documents_render_data_object_chk CHECK ((jsonb_typeof(render_data) = 'object'::text)),
      CONSTRAINT documents_renderer_chk CHECK ((((renderer_kind = 'html'::text) AND (profile_id IS NULL) AND (profile_version IS NULL) AND (profile_snapshot IS NULL) AND (snapshot_sha256 IS NULL) AND (validator_version IS NULL) AND (validation_status IS NULL) AND (validation_report IS NULL)) OR ((renderer_kind = 'profile'::text) AND (profile_id IS NOT NULL) AND (profile_version > 0) AND (jsonb_typeof(profile_snapshot) = 'object'::text) AND (snapshot_sha256 ~ '^[a-f0-9]{64}$'::text) AND (validator_version IS NOT NULL) AND (validation_status = ANY (ARRAY['valid'::text, 'warning'::text, 'unchecked'::text])) AND (jsonb_typeof(validation_report) = 'object'::text)))),
      CONSTRAINT documents_renderer_kind_chk CHECK ((renderer_kind = ANY (ARRAY['html'::text, 'profile'::text]))),
      CONSTRAINT documents_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT documents_snapshot_binding_fkey FOREIGN KEY (snapshot_id, base_id, table_id, record_id) REFERENCES grids.record_snapshots(id, base_id, table_id, record_id) ON DELETE RESTRICT,
      CONSTRAINT documents_snapshot_id_fkey FOREIGN KEY (snapshot_id) REFERENCES grids.record_snapshots(id) ON DELETE RESTRICT,
      CONSTRAINT documents_source_binding_chk CHECK ((((template_id IS NOT NULL) AND (snapshot_id IS NOT NULL) AND (table_id IS NOT NULL) AND (record_id IS NOT NULL)) OR ((template_id IS NULL) AND (snapshot_id IS NULL) AND (table_id IS NULL) AND (record_id IS NULL) AND (workflow_run_id IS NOT NULL)))),
      CONSTRAINT documents_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT,
      CONSTRAINT documents_tags_count_chk CHECK ((cardinality(tags) <= 20)),
      CONSTRAINT documents_template_snapshot_object_chk CHECK ((jsonb_typeof(template_snapshot) = 'object'::text)),
      CONSTRAINT documents_template_table_fkey FOREIGN KEY (template_id, table_id) REFERENCES grids.document_templates(id, table_id) ON DELETE RESTRICT,
      CONSTRAINT documents_workflow_base_fkey FOREIGN KEY (workflow_run_id, base_id) REFERENCES grids.workflow_run_profile(run_id, base_id) ON DELETE RESTRICT,
      CONSTRAINT documents_workflow_pair_chk CHECK (((workflow_run_id IS NULL) = (workflow_step_key IS NULL)))
    )
  `.simple();
  // Existing immutable evidence retains its original status and report.
  await sql`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_renderer_chk'
        AND position('unchecked' in pg_get_constraintdef(oid)) > 0) THEN
      ALTER TABLE grids.documents DROP CONSTRAINT IF EXISTS documents_renderer_chk;
      ALTER TABLE grids.documents ADD CONSTRAINT documents_renderer_chk CHECK ((((renderer_kind = 'html'::text) AND (profile_id IS NULL) AND (profile_version IS NULL) AND (profile_snapshot IS NULL) AND (snapshot_sha256 IS NULL) AND (validator_version IS NULL) AND (validation_status IS NULL) AND (validation_report IS NULL)) OR ((renderer_kind = 'profile'::text) AND (profile_id IS NOT NULL) AND (profile_version > 0) AND (jsonb_typeof(profile_snapshot) = 'object'::text) AND (snapshot_sha256 ~ '^[a-f0-9]{64}$'::text) AND (validator_version IS NOT NULL) AND (validation_status = ANY (ARRAY['valid'::text, 'warning'::text, 'unchecked'::text])) AND (jsonb_typeof(validation_report) = 'object'::text))));
    END IF;
  END $$`.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_documents_record ON grids.documents USING btree (table_id, record_id, created_at DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_documents_short_id ON grids.documents USING btree (short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_documents_tags ON grids.documents USING gin (tags)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_documents_template ON grids.documents USING btree (template_id, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_documents_template_cursor ON grids.documents USING btree (template_id, created_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_documents_workflow_run ON grids.documents USING btree (workflow_run_id, created_at DESC, id DESC) WHERE (workflow_run_id IS NOT NULL)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_documents_workflow_step ON grids.documents USING btree (workflow_run_id, workflow_step_key) WHERE ((workflow_run_id IS NOT NULL) AND (workflow_step_key IS NOT NULL))
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_external_operations (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      operation_scope_hash text NOT NULL,
      operation_key_hash text NOT NULL,
      binding_id uuid NOT NULL,
      request_hash text NOT NULL,
      result_version integer NOT NULL,
      created boolean NOT NULL,
      changed boolean NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT record_external_operations_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES grids.record_external_bindings(id) ON DELETE CASCADE,
      CONSTRAINT record_external_operations_operation_key_hash_check CHECK ((char_length(operation_key_hash) = 64)),
      CONSTRAINT record_external_operations_operation_scope_hash_check CHECK ((char_length(operation_scope_hash) = 64)),
      CONSTRAINT record_external_operations_pkey PRIMARY KEY (id),
      CONSTRAINT record_external_operations_request_hash_check CHECK ((char_length(request_hash) = 64)),
      CONSTRAINT record_external_operations_result_version_check CHECK ((result_version > 0))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_external_operations_created ON grids.record_external_operations USING btree (created_at, id)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_grids_record_external_operations_scope_key ON grids.record_external_operations USING btree (operation_scope_hash, operation_key_hash)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_artifacts (
      document_id uuid NOT NULL,
      artifact_key text NOT NULL,
      file_id uuid NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT document_artifacts_document_id_fkey FOREIGN KEY (document_id) REFERENCES grids.documents(id) ON DELETE RESTRICT,
      CONSTRAINT document_artifacts_file_id_fkey FOREIGN KEY (file_id) REFERENCES grids.files(id) ON DELETE RESTRICT,
      CONSTRAINT document_artifacts_file_id_key UNIQUE (file_id),
      CONSTRAINT document_artifacts_key_chk CHECK ((artifact_key ~ '^[a-z][a-z0-9._-]{0,63}$'::text)),
      CONSTRAINT document_artifacts_pkey PRIMARY KEY (document_id, artifact_key)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_issuances (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      base_id uuid NOT NULL,
      document_short_id text NOT NULL,
      operation_key_hash text NOT NULL,
      request_hash text NOT NULL,
      request_identity_hash text,
      frozen_request jsonb,
      document_id uuid,
      completed_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      confirmation_hash text,
      confirmed_actor jsonb,
      confirmed_at timestamp with time zone,
      query_data_id uuid,
      CONSTRAINT document_issuances_base_id_fkey FOREIGN KEY (base_id) REFERENCES grids.bases(id) ON DELETE RESTRICT,
      CONSTRAINT document_issuances_base_id_operation_key_hash_key UNIQUE (base_id, operation_key_hash),
      CONSTRAINT document_issuances_confirmation_chk CHECK (((((confirmed_actor IS NULL) AND (confirmed_at IS NULL)) OR ((confirmation_hash IS NOT NULL) AND (confirmed_actor IS NOT NULL) AND (confirmed_at IS NOT NULL) AND (jsonb_typeof(confirmed_actor) = 'object'::text) AND (confirmed_at >= created_at))) AND ((confirmation_hash IS NULL) OR (document_id IS NULL) OR (confirmed_at IS NOT NULL)))),
      CONSTRAINT document_issuances_confirmation_hash_check CHECK ((confirmation_hash ~ '^[a-f0-9]{64}$'::text)),
      CONSTRAINT document_issuances_document_base_fkey FOREIGN KEY (document_id, base_id, document_short_id) REFERENCES grids.documents(id, base_id, short_id) ON DELETE RESTRICT,
      CONSTRAINT document_issuances_document_id_key UNIQUE (document_id),
      CONSTRAINT document_issuances_document_short_id_key UNIQUE (document_short_id),
      CONSTRAINT document_issuances_operation_key_hash_check CHECK ((operation_key_hash ~ '^[a-f0-9]{64}$'::text)),
      CONSTRAINT document_issuances_pkey PRIMARY KEY (id),
      CONSTRAINT document_issuances_query_data_id_fkey FOREIGN KEY (query_data_id) REFERENCES grids.workflow_query_data(id) ON DELETE RESTRICT,
      CONSTRAINT document_issuances_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
      CONSTRAINT document_issuances_request_identity_hash_check CHECK ((request_identity_hash ~ '^[a-f0-9]{64}$'::text)),
      CONSTRAINT document_issuances_short_id_format_chk CHECK ((document_short_id ~ '^[A-Za-z0-9]{6}$'::text)),
      CONSTRAINT document_issuances_state_chk CHECK ((((document_id IS NULL) AND (completed_at IS NULL) AND (jsonb_typeof(frozen_request) = 'object'::text)) OR ((document_id IS NOT NULL) AND (completed_at IS NOT NULL) AND (completed_at >= created_at) AND (frozen_request IS NULL))))
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_issuance_base ON grids.document_issuances USING btree (id, base_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_issuances_pending ON grids.document_issuances USING btree (created_at, id) WHERE (document_id IS NULL)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_links (
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      short_id text NOT NULL,
      document_id uuid NOT NULL,
      base_id uuid NOT NULL,
      table_id uuid,
      record_id uuid,
      token_hash text NOT NULL,
      comment text,
      created_by uuid,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      expires_at timestamp with time zone NOT NULL,
      revoked_at timestamp with time zone,
      revoked_by uuid,
      last_accessed_at timestamp with time zone,
      access_count integer DEFAULT 0 NOT NULL,
      CONSTRAINT document_links_access_count_chk CHECK ((access_count >= 0)),
      CONSTRAINT document_links_base_binding_fkey FOREIGN KEY (document_id, base_id) REFERENCES grids.documents(id, base_id) ON DELETE RESTRICT,
      CONSTRAINT document_links_comment_length_chk CHECK (((comment IS NULL) OR (length(comment) <= 500))),
      CONSTRAINT document_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT document_links_document_binding_fkey FOREIGN KEY (document_id, base_id, table_id, record_id) REFERENCES grids.documents(id, base_id, table_id, record_id) ON DELETE RESTRICT,
      CONSTRAINT document_links_document_id_fkey FOREIGN KEY (document_id) REFERENCES grids.documents(id) ON DELETE RESTRICT,
      CONSTRAINT document_links_pkey PRIMARY KEY (id),
      CONSTRAINT document_links_record_pair_chk CHECK (((table_id IS NULL) = (record_id IS NULL))),
      CONSTRAINT document_links_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL,
      CONSTRAINT document_links_short_id_format_chk CHECK ((short_id ~ '^[A-Za-z0-9]{6}$'::text))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_links_active ON grids.document_links USING btree (expires_at) WHERE (revoked_at IS NULL)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_links_document ON grids.document_links USING btree (document_id, created_at DESC)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_links_short_id ON grids.document_links USING btree (short_id)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_links_token_hash ON grids.document_links USING btree (token_hash)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_record_sources (
      document_id uuid NOT NULL,
      table_id uuid NOT NULL,
      record_id uuid NOT NULL,
      version bigint NOT NULL,
      CONSTRAINT document_record_sources_document_id_fkey FOREIGN KEY (document_id) REFERENCES grids.documents(id) ON DELETE RESTRICT,
      CONSTRAINT document_record_sources_pkey PRIMARY KEY (document_id, table_id, record_id),
      CONSTRAINT document_record_sources_record_id_fkey FOREIGN KEY (record_id) REFERENCES grids.records(id) ON DELETE RESTRICT,
      CONSTRAINT document_record_sources_table_id_fkey FOREIGN KEY (table_id) REFERENCES grids.tables(id) ON DELETE RESTRICT,
      CONSTRAINT document_record_sources_version_check CHECK ((version > 0))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_document_record_sources_record ON grids.document_record_sources USING btree (table_id, record_id, document_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_export_claims (
      base_id uuid NOT NULL,
      destination_key text NOT NULL,
      purpose text NOT NULL,
      business_id text NOT NULL,
      receipt_id uuid NOT NULL,
      created_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT document_export_claims_business_id_check CHECK (((length(business_id) >= 1) AND (length(business_id) <= 200))),
      CONSTRAINT document_export_claims_destination_key_check CHECK (((length(destination_key) >= 1) AND (length(destination_key) <= 200))),
      CONSTRAINT document_export_claims_pkey PRIMARY KEY (base_id, destination_key, purpose, business_id),
      CONSTRAINT document_export_claims_purpose_check CHECK ((purpose = ANY (ARRAY['accounting'::text, 'payment'::text]))),
      CONSTRAINT document_export_claims_receipt_id_base_id_fkey FOREIGN KEY (receipt_id, base_id) REFERENCES grids.document_issuances(id, base_id) ON DELETE RESTRICT
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_export_claims_receipt ON grids.document_export_claims USING btree (receipt_id)
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS document_artifacts_immutable ON grids.document_artifacts
  `.simple();
  await sql`
    CREATE TRIGGER document_artifacts_immutable BEFORE DELETE OR UPDATE ON grids.document_artifacts FOR EACH ROW EXECUTE FUNCTION grids.reject_document_artifact_mutation()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS document_export_claim_guard ON grids.document_export_claims
  `.simple();
  await sql`
    CREATE TRIGGER document_export_claim_guard BEFORE DELETE OR UPDATE ON grids.document_export_claims FOR EACH ROW EXECUTE FUNCTION grids.guard_document_export_claim()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS document_issuances_guard ON grids.document_issuances
  `.simple();
  await sql`
    CREATE TRIGGER document_issuances_guard BEFORE DELETE OR UPDATE ON grids.document_issuances FOR EACH ROW EXECUTE FUNCTION grids.guard_document_issuance()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS document_record_sources_immutable ON grids.document_record_sources
  `.simple();
  await sql`
    CREATE TRIGGER document_record_sources_immutable BEFORE DELETE OR UPDATE ON grids.document_record_sources FOR EACH ROW EXECUTE FUNCTION grids.reject_document_artifact_mutation()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS documents_immutable ON grids.documents
  `.simple();
  await sql`
    CREATE TRIGGER documents_immutable BEFORE DELETE OR UPDATE ON grids.documents FOR EACH ROW EXECUTE FUNCTION grids.reject_document_mutation()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS trg_grids_validate_federated_mapping ON grids.federated_field_mappings
  `.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_mapping BEFORE INSERT OR UPDATE OF revision_id, target_field_id, source_table_id, source_field_id ON grids.federated_field_mappings FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_mapping()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS trg_grids_validate_federated_revision_target ON grids.federated_table_revisions
  `.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_revision_target BEFORE INSERT OR UPDATE OF table_id ON grids.federated_table_revisions FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_revision_target()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS trg_grids_validate_federated_source ON grids.federated_table_sources
  `.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_source BEFORE INSERT OR UPDATE OF revision_id, source_table_id ON grids.federated_table_sources FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_source()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS file_protected_references_guard ON grids.file_protected_references
  `.simple();
  await sql`
    CREATE TRIGGER file_protected_references_guard BEFORE DELETE OR UPDATE ON grids.file_protected_references FOR EACH ROW EXECUTE FUNCTION grids.guard_file_protected_reference_mutation()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS files_content_immutable ON grids.files
  `.simple();
  await sql`
    CREATE TRIGGER files_content_immutable BEFORE UPDATE OF filename, mime_type, size_bytes, sha256, bytes ON grids.files FOR EACH ROW EXECUTE FUNCTION grids.reject_file_content_mutation()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS grids_views_sync_base_id ON grids.views
  `.simple();
  await sql`
    CREATE TRIGGER grids_views_sync_base_id BEFORE INSERT OR UPDATE OF table_id, base_id ON grids.views FOR EACH ROW EXECUTE FUNCTION grids.sync_view_base_id()
  `.simple();
  await sql`
    DROP TRIGGER IF EXISTS workflow_query_data_immutable ON grids.workflow_query_data
  `.simple();
  await sql`
    CREATE TRIGGER workflow_query_data_immutable BEFORE UPDATE ON grids.workflow_query_data FOR EACH ROW EXECUTE FUNCTION grids.reject_workflow_query_data_update()
  `.simple();
  await sql`
    CREATE OR REPLACE VIEW grids.operational_health AS
     WITH outbox AS (
             SELECT (count(*) FILTER (WHERE (record_event_outbox.status = 'pending'::text)))::integer AS pending,
                (count(*) FILTER (WHERE (record_event_outbox.status = 'failed'::text)))::integer AS failed,
                (count(*) FILTER (WHERE (record_event_outbox.status = 'dead'::text)))::integer AS dead,
                (COALESCE(EXTRACT(epoch FROM (now() - min(record_event_outbox.created_at) FILTER (WHERE (record_event_outbox.status = ANY (ARRAY['pending'::text, 'failed'::text]))))), (0)::numeric))::double precision AS oldest_active_age_seconds
               FROM grids.record_event_outbox
            ), workflow_runs AS (
             SELECT (count(*) FILTER (WHERE (run.state = 'queued'::text)))::integer AS queued,
                (count(*) FILTER (WHERE (run.state = 'running'::text)))::integer AS running,
                (count(*) FILTER (WHERE (run.state = 'waiting'::text)))::integer AS waiting,
                (count(*) FILTER (WHERE (run.state = 'needs_attention'::text)))::integer AS needs_attention,
                (count(*) FILTER (WHERE ((run.state = 'needs_attention'::text) AND (run.finished_at >= (now() - '24:00:00'::interval)))))::integer AS needs_attention_recent,
                (count(*) FILTER (WHERE ((run.state = 'running'::text) AND ((run.lease_expires_at IS NULL) OR (run.lease_expires_at < now())))))::integer AS stale_running,
                (COALESCE(EXTRACT(epoch FROM (now() - min(run.created_at) FILTER (WHERE (run.state = 'queued'::text)))), (0)::numeric))::double precision AS oldest_queued_age_seconds
               FROM workflows.run
              WHERE ((run.app_id = 'grids'::text) AND (run.mode = 'execute'::text))
            ), effects AS (
             SELECT (count(*) FILTER (WHERE (s.effect_state = 'executing'::text)))::integer AS executing,
                (count(*) FILTER (WHERE (s.effect_state = 'ambiguous'::text)))::integer AS needs_attention,
                (count(*) FILTER (WHERE ((s.effect_state = 'ambiguous'::text) AND (COALESCE(s.finished_at, s.effect_started_at) >= (now() - '24:00:00'::interval)))))::integer AS needs_attention_recent,
                (COALESCE(EXTRACT(epoch FROM (now() - min(s.effect_started_at) FILTER (WHERE (s.effect_state = ANY (ARRAY['executing'::text, 'ambiguous'::text]))))), (0)::numeric))::double precision AS oldest_active_age_seconds
               FROM (workflows.step_outcome s
                 JOIN workflows.run r ON (((r.id = s.run_id) AND (r.app_id = 'grids'::text))))
            ), federation AS (
             SELECT (count(*) FILTER (WHERE (federated_table_revisions.status = 'degraded'::text)))::integer AS degraded
               FROM grids.federated_table_revisions
            ), email_deliveries AS (
             SELECT (count(*) FILTER (WHERE ((workflow_email_deliveries.status = 'failed'::text) AND (workflow_email_deliveries.created_at >= (now() - '24:00:00'::interval)))))::integer AS failed_24h
               FROM grids.workflow_email_deliveries
            )
     SELECT
            CASE
                WHEN ((outbox.dead > 0) OR (workflow_runs.needs_attention_recent > 0) OR (workflow_runs.stale_running > 0) OR (effects.needs_attention_recent > 0)) THEN 'error'::text
                WHEN ((outbox.failed > 0) OR (outbox.oldest_active_age_seconds > (60)::double precision) OR (workflow_runs.oldest_queued_age_seconds > (60)::double precision) OR (effects.oldest_active_age_seconds > (300)::double precision) OR (federation.degraded > 0) OR (email_deliveries.failed_24h > 0) OR (workflow_runs.needs_attention > 0) OR (effects.needs_attention > 0)) THEN 'warn'::text
                ELSE 'ok'::text
            END AS status,
        outbox.pending AS outbox_pending,
        outbox.failed AS outbox_failed,
        outbox.dead AS outbox_dead,
        outbox.oldest_active_age_seconds AS outbox_oldest_active_age_seconds,
        workflow_runs.queued AS workflow_queued,
        workflow_runs.running AS workflow_running,
        workflow_runs.waiting AS workflow_waiting,
        workflow_runs.needs_attention AS workflow_needs_attention,
        workflow_runs.stale_running AS workflow_stale_running,
        workflow_runs.oldest_queued_age_seconds AS workflow_oldest_queued_age_seconds,
        effects.executing AS effects_executing,
        effects.needs_attention AS effects_needs_attention,
        effects.oldest_active_age_seconds AS effects_oldest_active_age_seconds,
        federation.degraded AS federated_degraded,
        email_deliveries.failed_24h AS email_failed_24h,
        now() AS observed_at
       FROM outbox,
        workflow_runs,
        effects,
        federation,
        email_deliveries;
  `.simple();
};

const assertWorkflowKernelReady = async (sql: SQL): Promise<void> => {
  const [kernel] = await sql<Array<{ ready: boolean }>>`
    SELECT to_regclass('workflows.run') IS NOT NULL
      AND to_regclass('workflows.version') IS NOT NULL
      AND to_regclass('workflows.step_outcome') IS NOT NULL AS ready
  `;
  if (!kernel?.ready) {
    throw new Error("Grids requires the workflow kernel schema. Start Core before Grids.");
  }
};

export const migrate = async (sql: SQL = defaultSql): Promise<void> => {
  const connection = await sql.reserve();
  let locked = false;
  let transactionStarted = false;
  try {
    await connection`SELECT pg_advisory_lock(hashtextextended('grids:migrate', 0))`;
    locked = true;
    await assertWorkflowKernelReady(connection);
    await connection`BEGIN`.simple();
    transactionStarted = true;
    // Writers acquire parent locks before touching records. Match that order
    // before DDL takes an exclusive records lock, including during a restart.
    const [existing] = await connection<Array<{ present: boolean }>>`SELECT to_regclass('grids.tables') IS NOT NULL AS present`;
    if (existing?.present) await connection`SELECT id FROM grids.tables ORDER BY id FOR UPDATE`;
    await defineSchema(connection);
    // One-way population of the current representation; reads never fall back
    // to the old read-time calculation path for missing materializations.
    const { refreshLocalCalculations } = await import("./service/local-calculation-storage");
    const tables = await connection<Array<{ id: string }>>`SELECT id::text FROM grids.tables WHERE kind = 'stored' ORDER BY id FOR UPDATE`;
    for (const table of tables) await refreshLocalCalculations(connection, table.id);
    await connection`COMMIT`.simple();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection`ROLLBACK`.simple().catch(() => undefined);
    throw error;
  } finally {
    if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended('grids:migrate', 0))`.catch(() => undefined);
    connection.release();
  }
};
