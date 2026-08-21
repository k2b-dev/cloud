import { toPgTextArray, toPgUuidArray } from "@valentinkolb/cloud/services";
import { sql as defaultSql, type SQL } from "bun";
import { parseJsonbRow } from "./service/jsonb";
import { numberSeriesFormatForField, numberSeriesSequenceName } from "./service/number-series";
import { migratePersistedPublicIdReferences } from "./service/public-id-source-migration";
import { newShortId, SHORT_ID_REGEX } from "./service/short-id";
import { migrateGridsWorkflowTables } from "./workflows/migrate";

const MIGRATION_LOCK_NAME = "grids:migrate";
const CANONICAL_SCALAR_STORAGE_CONTRACT = "canonical_scalar_values_v1";

const PUBLIC_ID_RESOURCES = [
  { table: "bases", key: "id", parent: null, index: "idx_grids_bases_short_id" },
  { table: "tables", key: "id", parent: "base_id", index: "idx_grids_tables_short_id" },
  { table: "fields", key: "id", parent: "table_id", index: "idx_grids_fields_short_id" },
  { table: "records", key: "id", parent: "table_id", index: "idx_grids_records_short_id" },
  { table: "record_revisions", key: "id", parent: "table_id", index: "idx_grids_record_revisions_short_id" },
  { table: "record_comments", key: "id", parent: "record_id", index: "idx_grids_record_comments_short_id" },
  { table: "files", key: "id", parent: null, index: "idx_grids_files_short_id" },
  { table: "views", key: "id", parent: "table_id", index: "idx_grids_views_short_id" },
  { table: "forms", key: "id", parent: "table_id", index: "idx_grids_forms_short_id" },
  { table: "document_templates", key: "id", parent: "table_id", index: "idx_grids_document_templates_short_id" },
  { table: "number_series", key: "id", parent: null, index: "idx_grids_number_series_short_id" },
  { table: "email_templates", key: "id", parent: "base_id", index: "idx_grids_email_templates_short_id" },
  { table: "record_snapshots", key: "id", parent: "table_id", index: "idx_grids_record_snapshots_short_id" },
  { table: "document_runs", key: "id", parent: "table_id", index: "idx_grids_document_runs_short_id" },
  { table: "document_links", key: "id", parent: "document_run_id", index: "idx_grids_document_links_short_id" },
  { table: "evidence_exports", key: "id", parent: "base_id", index: "idx_grids_evidence_exports_short_id" },
  { table: "preservation_holds", key: "id", parent: "base_id", index: "idx_grids_preservation_holds_short_id" },
  { table: "controlled_destruction_runs", key: "id", parent: "base_id", index: "idx_grids_controlled_destruction_runs_short_id" },
  { table: "custom_apps", key: "id", parent: "base_id", index: "idx_grids_custom_apps_short_id" },
  { table: "workflow_profile", key: "id", parent: "base_id", index: "idx_grids_workflow_profile_short_id" },
  { table: "workflow_launchers", key: "id", parent: "workflow_id", index: "idx_grids_workflow_launchers_short_id" },
  { table: "workflow_run_profile", key: "run_id", parent: "workflow_id", index: "idx_grids_workflow_run_profile_short_id" },
] as const;

const DECLARATIVE_REFERENCE_RESOURCES = new Set([
  "bases",
  "tables",
  "fields",
  "views",
  "forms",
  "document_templates",
  "document_runs",
  "email_templates",
  "custom_apps",
  "workflow_profile",
  "workflow_launchers",
]);

const publicIdConstraint = (table: string): string => `${table}_short_id_format_chk`;

const allocateMigrationShortId = (allocated: ReadonlySet<string>, table: string): string => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const shortId = newShortId();
    if (!allocated.has(shortId)) return shortId;
  }
  throw new Error(`cannot allocate a unique Grids public ID for ${table} after 10 attempts`);
};

export const gridsPublicIdsReady = async (sql: SQL = defaultSql): Promise<boolean> => {
  for (const resource of PUBLIC_ID_RESOURCES) {
    const [schema] = await sql<Array<{ nullable: string; constraintReady: boolean; indexReady: boolean }>>`
      SELECT column_info.is_nullable AS nullable,
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_info
          WHERE constraint_info.conrelid = to_regclass(${`grids.${resource.table}`})
            AND constraint_info.conname = ${publicIdConstraint(resource.table)}
            AND constraint_info.convalidated
            AND pg_get_constraintdef(constraint_info.oid) LIKE '%[A-Za-z0-9]{6}%'
        ) AS "constraintReady",
        EXISTS (
          SELECT 1
          FROM pg_indexes index_info
          WHERE index_info.schemaname = 'grids'
            AND index_info.tablename = ${resource.table}
            AND index_info.indexname = ${resource.index}
            AND index_info.indexdef LIKE 'CREATE UNIQUE INDEX % USING btree (short_id)'
        ) AS "indexReady"
      FROM information_schema.columns column_info
      WHERE column_info.table_schema = 'grids'
        AND column_info.table_name = ${resource.table}
        AND column_info.column_name = 'short_id'
    `;
    if (schema?.nullable !== "NO" || !schema.constraintReady || !schema.indexReady) return false;
  }
  return true;
};

const migratePublicIds = async (sql: SQL): Promise<void> => {
  if (await gridsPublicIdsReady(sql)) return;

  await sql`
      CREATE TEMP TABLE public_id_migration (
        resource TEXT NOT NULL,
        id UUID NOT NULL,
        parent_id UUID,
        old_short_id TEXT,
        new_short_id TEXT NOT NULL,
        PRIMARY KEY (resource, id)
      ) ON COMMIT DROP
    `;
  for (const resource of PUBLIC_ID_RESOURCES) {
    await sql.unsafe(`ALTER TABLE grids.${resource.table} ADD COLUMN IF NOT EXISTS short_id TEXT`);
  }

  await sql.unsafe(`LOCK TABLE ${PUBLIC_ID_RESOURCES.map((resource) => `grids.${resource.table}`).join(", ")} IN ACCESS EXCLUSIVE MODE`);

  for (const resource of PUBLIC_ID_RESOURCES) {
    await sql.unsafe(`ALTER TABLE grids.${resource.table} DROP CONSTRAINT IF EXISTS ${publicIdConstraint(resource.table)}`);
    await sql.unsafe(`DROP INDEX IF EXISTS grids.${resource.index}`);
  }

  for (const resource of PUBLIC_ID_RESOURCES) {
    const rows = (await sql.unsafe(
      `SELECT ${resource.key}::text AS id, ${resource.parent ?? "NULL::uuid"}::text AS "parentId", short_id AS "shortId"
         FROM grids.${resource.table} ORDER BY ${resource.key} FOR UPDATE`,
    )) as Array<{ id: string; parentId: string | null; shortId: string | null }>;
    const validOwners = new Map<string, string>();
    for (const row of rows) {
      if (row.shortId !== null && SHORT_ID_REGEX.test(row.shortId) && !validOwners.has(row.shortId)) {
        validOwners.set(row.shortId, row.id);
      }
    }
    const allocated = new Set(validOwners.keys());
    const updates: Array<{ id: string; shortId: string }> = [];
    for (const row of rows) {
      let shortId: string;
      if (row.shortId !== null && validOwners.get(row.shortId) === row.id) {
        shortId = row.shortId;
      } else {
        shortId = allocateMigrationShortId(allocated, resource.table);
        updates.push({ id: row.id, shortId });
        allocated.add(shortId);
      }
      if (DECLARATIVE_REFERENCE_RESOURCES.has(resource.table)) {
        await sql`
            INSERT INTO pg_temp.public_id_migration (resource, id, parent_id, old_short_id, new_short_id)
            VALUES (${resource.table}, ${row.id}::uuid, ${row.parentId}::uuid, ${row.shortId}, ${shortId})
          `;
      }
    }
    if (updates.length > 0) {
      await sql.unsafe(
        `UPDATE grids.${resource.table} target SET short_id = source.short_id
         FROM unnest($1::uuid[], $2::text[]) AS source(id, short_id)
         WHERE target.${resource.key} = source.id`,
        [toPgUuidArray(updates.map((update) => update.id)), toPgTextArray(updates.map((update) => update.shortId))],
      );
    }
  }

  await migratePersistedPublicIdReferences(sql);

  for (const resource of PUBLIC_ID_RESOURCES) {
    await sql.unsafe(`ALTER TABLE grids.${resource.table} ALTER COLUMN short_id SET NOT NULL`);
    await sql.unsafe(
      `ALTER TABLE grids.${resource.table} ADD CONSTRAINT ${publicIdConstraint(resource.table)} CHECK (short_id ~ '^[A-Za-z0-9]{6}$')`,
    );
    await sql.unsafe(`CREATE UNIQUE INDEX ${resource.index} ON grids.${resource.table}(short_id)`);
  }

  if (!(await gridsPublicIdsReady(sql))) throw new Error("grids public short IDs are not ready after migration");
  console.log("  ✓ grids public short IDs (6 chars, globally unique per resource, tombstones included)");
};

/**
 * Schema for the Grids app: bases → tables → fields, records, views, forms,
 * document templates, Grids Apps, workflows, and generated artifacts.
 *
 * Storage strategy: records use JSONB keyed by stable field IDs. Per-field
 * expression indexes are opt-in (`fields.indexed=true`). No GIN on `data` by
 * default — ad-hoc filter performance is the user's call when they enable
 * indexing per field.
 *
 * Permission model: raw Grids resources inherit one base grant. Published
 * Grids Apps have an independent read grant and execute only their compiled
 * capabilities.
 */
const migrateSchema = async (sql: SQL): Promise<void> => {
  await sql`CREATE SCHEMA IF NOT EXISTS grids`.simple();
  console.log("  ✓ grids schema");
};

const migrateSafeCastHelpers = async (sql: SQL): Promise<void> => {
  // ──────────────────────────────────────────────────────────────────
  // Safe-cast helpers
  // ──────────────────────────────────────────────────────────────────
  // Existing expression indexes depend on these function OIDs. The canonical
  // storage migration renames the indexed helpers in place, then recreates
  // only the tolerant conversions that formulas still need for arbitrary text.
  await sql`
    DO $$
    BEGIN
      IF to_regprocedure('grids.canonical_numeric(text)') IS NULL THEN
        CREATE OR REPLACE FUNCTION grids.try_numeric(t text) RETURNS numeric
        LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE AS $fn$
        BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $fn$;
      END IF;
    END $$
  `.simple();
  // Immutable ISO date parser for expression indexes. We only accept the
  // canonical app-written date shape (YYYY-MM-DD); anything else returns NULL
  // instead of depending on session DateStyle.
  await sql`
    DO $$
    BEGIN
      IF to_regprocedure('grids.canonical_date(text)') IS NULL THEN
        CREATE OR REPLACE FUNCTION grids.try_iso_date(t text) RETURNS date
        LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE AS $fn$
        BEGIN
          IF t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
          RETURN make_date(substring(t, 1, 4)::int, substring(t, 6, 2)::int, substring(t, 9, 2)::int);
        EXCEPTION WHEN others THEN RETURN NULL;
        END $fn$;
      END IF;
    END $$
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF to_regprocedure('grids.canonical_timestamptz(text)') IS NULL THEN
        CREATE OR REPLACE FUNCTION grids.try_timestamptz(t text) RETURNS timestamptz
        LANGUAGE plpgsql STABLE STRICT PARALLEL UNSAFE AS $fn$
        BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $fn$;
      END IF;
    END $$
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF to_regprocedure('grids.canonical_boolean(text)') IS NULL THEN
        CREATE OR REPLACE FUNCTION grids.try_boolean(t text) RETURNS boolean
        LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE AS $fn$
        BEGIN RETURN t::boolean; EXCEPTION WHEN others THEN RETURN NULL; END $fn$;
      END IF;
    END $$
  `.simple();
  console.log("  ✓ grids.try_* safe-cast helpers");
};

type CanonicalScalarField = {
  id: string;
  shortId: string;
  tableId: string;
  type: string;
  config: unknown;
};

const scalarInvalidCondition = (sql: SQL, field: CanonicalScalarField): unknown => {
  const value = sql`r.data->${field.id}`;
  const text = sql`r.data->>${field.id}`;
  const present = sql`r.data ? ${field.id} AND ${value} <> 'null'::jsonb`;
  switch (field.type) {
    case "number":
      return sql`${present} AND NOT (
        jsonb_typeof(${value}) = 'number'
        OR (
          jsonb_typeof(${value}) = 'string'
          AND ${text} ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
          AND grids.try_numeric(${text}) IS NOT NULL
        )
      )`;
    case "percent":
      return sql`${present} AND jsonb_typeof(${value}) IS DISTINCT FROM 'number'`;
    case "duration":
      return sql`${present} AND NOT (jsonb_typeof(${value}) = 'number' AND ${text} ~ '^[0-9]+$')`;
    case "boolean":
      return sql`${present} AND jsonb_typeof(${value}) IS DISTINCT FROM 'boolean'`;
    case "date": {
      const config = parseJsonbRow<{ includeTime?: boolean }>(field.config, {});
      return config.includeTime
        ? sql`${present} AND NOT (
            jsonb_typeof(${value}) = 'string'
            AND ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
            AND grids.try_timestamptz(${text}) IS NOT NULL
          )`
        : sql`${present} AND NOT (
            jsonb_typeof(${value}) = 'string'
            AND ${text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
            AND grids.try_iso_date(${text}) IS NOT NULL
          )`;
    }
    default:
      throw new Error(`unsupported canonical scalar field type ${field.type}`);
  }
};

const assertCanonicalScalarStorage = async (sql: SQL): Promise<void> => {
  const fields = await sql<Array<CanonicalScalarField>>`
    SELECT id::text AS id, short_id AS "shortId", table_id::text AS "tableId", type, config
    FROM grids.fields
    WHERE deleted_at IS NULL AND type IN ('number', 'percent', 'duration', 'boolean', 'date')
    ORDER BY table_id, position, id
  `;
  const byTable = Map.groupBy(fields, (field) => field.tableId);
  for (const [tableId, tableFields] of byTable) {
    const conditions = tableFields.map((field) => scalarInvalidCondition(sql, field));
    const invalid = conditions.slice(1).reduce((combined, condition) => sql`${combined} OR ${condition}`, conditions[0]!);
    const fieldCases = tableFields.map((field) => sql`WHEN ${scalarInvalidCondition(sql, field)} THEN ${field.shortId}`);
    const fieldCase = fieldCases.slice(1).reduce((combined, item) => sql`${combined} ${item}`, fieldCases[0]!);
    const [row] = await sql<Array<{ recordShortId: string; fieldShortId: string }>>`
      SELECT r.short_id AS "recordShortId", CASE ${fieldCase} END AS "fieldShortId"
      FROM grids.records r
      WHERE r.table_id = ${tableId}::uuid AND (${invalid})
      LIMIT 1
    `;
    if (row) {
      throw new Error(
        `cannot enable canonical scalar storage: Record ${row.recordShortId} has a non-canonical value in Field ${row.fieldShortId}`,
      );
    }
  }
};

const migrateCanonicalScalarStorage = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.storage_contracts (
      name TEXT PRIMARY KEY,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  const [contract] = await sql<Array<{ active: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM grids.storage_contracts WHERE name = ${CANONICAL_SCALAR_STORAGE_CONTRACT}
    ) AS active
  `;
  if (!contract?.active) await assertCanonicalScalarStorage(sql);

  await sql`
    DO $$
    BEGIN
      IF to_regprocedure('grids.canonical_numeric(text)') IS NULL THEN
        ALTER FUNCTION grids.try_numeric(text) RENAME TO canonical_numeric;
      END IF;
      IF to_regprocedure('grids.canonical_date(text)') IS NULL THEN
        ALTER FUNCTION grids.try_iso_date(text) RENAME TO canonical_date;
      END IF;
      IF to_regprocedure('grids.canonical_timestamptz(text)') IS NULL THEN
        ALTER FUNCTION grids.try_timestamptz(text) RENAME TO canonical_timestamptz;
      END IF;
      IF to_regprocedure('grids.canonical_boolean(text)') IS NULL THEN
        ALTER FUNCTION grids.try_boolean(text) RENAME TO canonical_boolean;
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.canonical_numeric(t text) RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT t::numeric $$;
    CREATE OR REPLACE FUNCTION grids.canonical_date(t text) RETURNS date
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT t::date $$;
    CREATE OR REPLACE FUNCTION grids.canonical_timestamptz(t text) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT t::timestamptz $$;
    CREATE OR REPLACE FUNCTION grids.canonical_boolean(t text) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT t::boolean $$
  `.simple();

  // Formula coercion accepts arbitrary text and intentionally keeps NULL-on-error
  // semantics. These new OIDs are not used by stored-field indexes or hot reads.
  await sql`
    CREATE OR REPLACE FUNCTION grids.try_numeric(t text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE AS $$
    BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;
    CREATE OR REPLACE FUNCTION grids.try_iso_date(t text) RETURNS date
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL UNSAFE AS $$
    BEGIN
      IF t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN NULL; END IF;
      RETURN make_date(substring(t, 1, 4)::int, substring(t, 6, 2)::int, substring(t, 9, 2)::int);
    EXCEPTION WHEN others THEN RETURN NULL;
    END $$;
    CREATE OR REPLACE FUNCTION grids.try_timestamptz(t text) RETURNS timestamptz
    LANGUAGE plpgsql STABLE STRICT PARALLEL UNSAFE AS $$
    BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$
  `.simple();
  await sql`DROP FUNCTION IF EXISTS grids.try_boolean(text)`.simple();
  await sql`DROP FUNCTION IF EXISTS grids.try_date(text)`.simple();
  await sql`DROP FUNCTION IF EXISTS grids.try_timestamp(text)`.simple();
  await sql`
    INSERT INTO grids.storage_contracts (name)
    VALUES (${CANONICAL_SCALAR_STORAGE_CONTRACT})
    ON CONFLICT (name) DO NOTHING
  `;
  console.log("  ✓ canonical scalar storage");
};

const assertNoDuplicateLiveTableNames = async (sql: SQL): Promise<void> => {
  const [schema] = await sql<Array<{ tables: string | null }>>`SELECT to_regclass('grids.tables')::text AS tables`;
  if (!schema?.tables) return;
  const [duplicateTableName] = await sql<Array<{ baseId: string; name: string }>>`
    SELECT base_id::text AS "baseId", lower(btrim(name)) AS name
    FROM grids.tables
    WHERE deleted_at IS NULL
    GROUP BY base_id, lower(btrim(name))
    HAVING count(*) > 1
    LIMIT 1
  `;
  if (duplicateTableName) {
    throw new Error(
      `cannot enforce unique table names: grid ${duplicateTableName.baseId} contains multiple live tables named "${duplicateTableName.name}"`,
    );
  }
};

const migrateCoreRecords = async (sql: SQL): Promise<void> => {
  // ──────────────────────────────────────────────────────────────────
  // bases
  // ──────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS grids.bases (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      document_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT bases_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`ALTER TABLE grids.bases ADD COLUMN IF NOT EXISTS document_profile JSONB NOT NULL DEFAULT '{}'::jsonb`.simple();
  console.log("  ✓ grids.bases");

  await sql`
    CREATE TABLE IF NOT EXISTS grids.base_access (
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (base_id, access_id)
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_base_access_access ON grids.base_access(access_id)`.simple();
  console.log("  ✓ grids.base_access");

  // ──────────────────────────────────────────────────────────────────
  // tables
  // ──────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS grids.tables (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'stored',
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      display_config JSONB NOT NULL DEFAULT '{"mode":"table"}'::jsonb,
      audit_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      mutation_policy JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
      position INT NOT NULL DEFAULT 0,
      disable_direct_insert BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT tables_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT tables_kind_chk CHECK (kind IN ('stored', 'federated'))
    )
  `.simple();
  await sql`ALTER TABLE grids.tables ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'stored'`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tables_kind_chk' AND conrelid = 'grids.tables'::regclass) THEN
        ALTER TABLE grids.tables ADD CONSTRAINT tables_kind_chk CHECK (kind IN ('stored', 'federated'));
      END IF;
    END $$
  `.simple();
  await sql`ALTER TABLE grids.tables ADD COLUMN IF NOT EXISTS audit_policy JSONB NOT NULL DEFAULT '{}'::jsonb`.simple();
  await sql`ALTER TABLE grids.tables ADD COLUMN IF NOT EXISTS mutation_policy JSONB NOT NULL DEFAULT '{"mode":"all"}'::jsonb`.simple();
  await sql`
    UPDATE grids.tables
    SET disable_direct_insert = TRUE,
        audit_policy = '{}'::jsonb,
        mutation_policy = '{"mode":"all"}'::jsonb
    WHERE kind = 'federated'
      AND (disable_direct_insert IS NOT TRUE OR audit_policy <> '{}'::jsonb OR mutation_policy <> '{"mode":"all"}'::jsonb)
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tables_federated_read_only_chk' AND conrelid = 'grids.tables'::regclass) THEN
        ALTER TABLE grids.tables
          ADD CONSTRAINT tables_federated_read_only_chk
          CHECK (kind <> 'federated' OR (disable_direct_insert AND audit_policy = '{}'::jsonb));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tables_federated_mutation_policy_chk' AND conrelid = 'grids.tables'::regclass) THEN
        ALTER TABLE grids.tables
          ADD CONSTRAINT tables_federated_mutation_policy_chk
          CHECK (kind <> 'federated' OR mutation_policy = '{"mode":"all"}'::jsonb);
      END IF;
    END $$
  `.simple();
  // Hot-path index: list live tables of a base in order.
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_tables_base_live ON grids.tables(base_id, position) WHERE deleted_at IS NULL`.simple();
  await assertNoDuplicateLiveTableNames(sql);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_tables_live_name
    ON grids.tables(base_id, lower(btrim(name)))
    WHERE deleted_at IS NULL
  `.simple();
  console.log("  ✓ grids.tables");

  // ──────────────────────────────────────────────────────────────────
  // fields
  // ──────────────────────────────────────────────────────────────────
  // `type` is a free TEXT (not enum) so we can introduce new field types
  // without DDL. The application layer rejects unknown types at write time.
  // `config` carries type-specific validation (regex/min/max/options/etc).
  await sql`
    CREATE TABLE IF NOT EXISTS grids.fields (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      type TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      position INT NOT NULL DEFAULT 0,
      required BOOLEAN NOT NULL DEFAULT FALSE,
      default_value JSONB,
      indexed BOOLEAN NOT NULL DEFAULT FALSE,
      unique_constraint BOOLEAN NOT NULL DEFAULT FALSE,
      presentable BOOLEAN NOT NULL DEFAULT FALSE,
      hide_in_table BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT fields_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_fields_table ON grids.fields(table_id, position) WHERE deleted_at IS NULL`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_fields_relation_target
    ON grids.fields ((config->>'targetTableId'), table_id)
    WHERE deleted_at IS NULL AND type = 'relation'
  `.simple();
  const [duplicateFieldName] = await sql<Array<{ tableId: string; name: string }>>`
    SELECT table_id::text AS "tableId", lower(btrim(name)) AS name
    FROM grids.fields
    WHERE deleted_at IS NULL
    GROUP BY table_id, lower(btrim(name))
    HAVING count(*) > 1
    LIMIT 1
  `;
  if (duplicateFieldName) {
    throw new Error(
      `cannot enforce unique field names: table ${duplicateFieldName.tableId} contains multiple live fields named "${duplicateFieldName.name}"`,
    );
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_fields_live_name
    ON grids.fields(table_id, lower(btrim(name)))
    WHERE deleted_at IS NULL
  `.simple();
  // Alpha cleanup: number precision used to persist as `scale`. Normalize once
  // so runtime and UI only have one decimal-place config key.
  await sql`
    UPDATE grids.fields
    SET config = (config - 'scale') || jsonb_build_object('decimalPlaces', (config->>'scale')::int)
    WHERE type = 'number'
      AND config ? 'scale'
      AND NOT (config ? 'decimalPlaces')
      AND jsonb_typeof(config->'scale') = 'number'
      AND config->>'scale' ~ '^[0-9]+$'
      AND (config->>'scale')::int BETWEEN 0 AND 20
  `.simple();
  await sql`
    UPDATE grids.fields
    SET config = config - 'scale'
    WHERE type = 'number'
      AND config ? 'scale'
  `.simple();
  console.log("  ✓ grids.fields");

  // ──────────────────────────────────────────────────────────────────
  // federated table revisions — draft configuration is isolated from
  // the single active revision consumed by readers.
  // ──────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_table_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      revision INT NOT NULL CHECK (revision > 0),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'degraded', 'superseded')),
      diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      published_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      UNIQUE (table_id, revision)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_revision_draft
    ON grids.federated_table_revisions(table_id)
    WHERE status = 'draft'
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_revision_current
    ON grids.federated_table_revisions(table_id)
    WHERE status IN ('active', 'degraded')
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_table_sources (
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      revision_id UUID NOT NULL REFERENCES grids.federated_table_revisions(id) ON DELETE CASCADE,
      source_table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE RESTRICT,
      position INT NOT NULL DEFAULT 0 CHECK (position >= 0),
      authorized_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      authorized_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      revoked_at TIMESTAMPTZ,
      PRIMARY KEY (revision_id, source_table_id)
    )
  `.simple();
  await sql`ALTER TABLE grids.federated_table_sources ADD COLUMN IF NOT EXISTS id UUID`.simple();
  await sql`UPDATE grids.federated_table_sources SET id = gen_random_uuid() WHERE id IS NULL`.simple();
  await sql`ALTER TABLE grids.federated_table_sources ALTER COLUMN id SET DEFAULT gen_random_uuid()`.simple();
  await sql`ALTER TABLE grids.federated_table_sources ALTER COLUMN id SET NOT NULL`.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_federated_sources_id
    ON grids.federated_table_sources(id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_sources_source
    ON grids.federated_table_sources(source_table_id, revision_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.federated_field_mappings (
      revision_id UUID NOT NULL,
      target_field_id UUID NOT NULL REFERENCES grids.fields(id) ON DELETE RESTRICT,
      source_table_id UUID NOT NULL,
      source_field_id UUID NOT NULL REFERENCES grids.fields(id) ON DELETE RESTRICT,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (revision_id, target_field_id, source_table_id),
      FOREIGN KEY (revision_id, source_table_id)
        REFERENCES grids.federated_table_sources(revision_id, source_table_id)
        ON DELETE CASCADE
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_mappings_source_field
    ON grids.federated_field_mappings(source_field_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_federated_mappings_target_field
    ON grids.federated_field_mappings(target_field_id)
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_revision_target()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM grids.tables target
        WHERE target.id = NEW.table_id AND target.kind = 'federated'
      ) THEN
        RAISE EXCEPTION 'federated revision target must be a combined table';
      END IF;
      RETURN NEW;
    END;
    $$
  `.simple();
  await sql`DROP TRIGGER IF EXISTS trg_grids_validate_federated_revision_target ON grids.federated_table_revisions`.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_revision_target
    BEFORE INSERT OR UPDATE OF table_id ON grids.federated_table_revisions
    FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_revision_target()
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_source()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    $$
  `.simple();
  await sql`DROP TRIGGER IF EXISTS trg_grids_validate_federated_source ON grids.federated_table_sources`.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_source
    BEFORE INSERT OR UPDATE OF revision_id, source_table_id ON grids.federated_table_sources
    FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_source()
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.validate_federated_mapping()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
    $$
  `.simple();
  await sql`DROP TRIGGER IF EXISTS trg_grids_validate_federated_mapping ON grids.federated_field_mappings`.simple();
  await sql`
    CREATE TRIGGER trg_grids_validate_federated_mapping
    BEFORE INSERT OR UPDATE OF revision_id, target_field_id, source_table_id, source_field_id
    ON grids.federated_field_mappings
    FOR EACH ROW EXECUTE FUNCTION grids.validate_federated_mapping()
  `.simple();
  await sql`DROP FUNCTION IF EXISTS grids.assert_federated_revision(UUID, UUID, INT)`.simple();
  await sql`DROP FUNCTION IF EXISTS grids.assert_federated_revision(UUID, UUID, TIMESTAMPTZ, INT)`.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.assert_federated_revision(
      p_table_id UUID,
      p_revision_id UUID,
      p_revision_token TEXT,
      p_source_count INT
    ) RETURNS BOOLEAN
    LANGUAGE plpgsql
    AS $$
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
    $$
  `.simple();
  console.log("  ✓ grids.federated_table_revisions");

  // ──────────────────────────────────────────────────────────────────
  // records (JSONB-keyed by field ID)
  // ──────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS grids.records (
      id UUID PRIMARY KEY,
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INT NOT NULL DEFAULT 1,
      deleted_at TIMESTAMPTZ,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT records_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  // Composite index for the hot path: list live rows of a table in id order.
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_records_table_live ON grids.records(table_id, id) WHERE deleted_at IS NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_records_table_creator_live ON grids.records(table_id, created_by, id) WHERE deleted_at IS NULL`.simple();
  // Trash queries: list soft-deleted rows of a table (ordered by deletion time).
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_records_table_trash ON grids.records(table_id, deleted_at) WHERE deleted_at IS NOT NULL`.simple();
  console.log("  ✓ grids.records");

  // Connector identities are durable bindings, not user-editable Record
  // fields. Operations keep only a hash of the caller's idempotency key.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_external_bindings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
      provider_account TEXT NOT NULL CHECK (char_length(provider_account) BETWEEN 1 AND 200),
      resource_kind TEXT NOT NULL CHECK (char_length(resource_kind) BETWEEN 1 AND 100),
      external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 500),
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_account, resource_kind, external_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_external_bindings_record
    ON grids.record_external_bindings(record_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_external_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 100),
      provider_account TEXT NOT NULL CHECK (char_length(provider_account) BETWEEN 1 AND 200),
      resource_kind TEXT NOT NULL CHECK (char_length(resource_kind) BETWEEN 1 AND 100),
      operation_key_hash TEXT NOT NULL CHECK (char_length(operation_key_hash) = 64),
      binding_id UUID NOT NULL REFERENCES grids.record_external_bindings(id) ON DELETE CASCADE,
      request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
      created BOOLEAN NOT NULL,
      changed BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_account, resource_kind, operation_key_hash)
    )
  `.simple();
  console.log("  ✓ grids.record_external_bindings");

  // Record comments inherit the record's live access policy. The repeated
  // base/table keys keep bounded thread reads indexed without copying ACLs.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      author_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT record_comments_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_comments_thread
    ON grids.record_comments(base_id, table_id, record_id, created_at DESC, id DESC)
    INCLUDE (author_user_id, updated_at, deleted_at)
  `.simple();
  console.log("  ✓ grids.record_comments");

  // ──────────────────────────────────────────────────────────────────
  // files — durable byte assets plus explicit current/protected references
  // ──────────────────────────────────────────────────────────────────
  // File field values do not live in records.data. `files` owns immutable
  // bytes and their public identity; attachment/protection rows own lifecycle.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.files (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INT NOT NULL CHECK (size_bytes >= 0),
      sha256 TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT files_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CHECK (octet_length(bytes) = size_bytes)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_attachments (
      file_id UUID PRIMARY KEY REFERENCES grids.files(id) ON DELETE RESTRICT,
      record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      field_id UUID NOT NULL REFERENCES grids.fields(id) ON DELETE CASCADE,
      position INT NOT NULL DEFAULT 0,
      attached_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      attached_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_attachments_record_field
    ON grids.file_attachments(record_id, field_id, position, attached_at, file_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_attachments_field
    ON grids.file_attachments(field_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_protected_references (
      file_id UUID NOT NULL REFERENCES grids.files(id) ON DELETE RESTRICT,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('record_revision', 'document_artifact')),
      owner_id UUID NOT NULL,
      base_id UUID NOT NULL,
      table_id UUID,
      record_id UUID,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (file_id, owner_kind, owner_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_protected_references_owner
    ON grids.file_protected_references(owner_kind, owner_id, file_id)
  `.simple();
  // Hard-cut legacy rows into the single attachment source of truth. Dynamic
  // SQL keeps this migration valid for both legacy and fresh installations.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'grids' AND table_name = 'files' AND column_name = 'record_id'
      ) THEN
        EXECUTE $migration$
          INSERT INTO grids.file_attachments (
            file_id, record_id, field_id, position, attached_by, attached_at
          )
          SELECT id, record_id, field_id, position, created_by, created_at
          FROM grids.files
          ON CONFLICT (file_id) DO NOTHING
        $migration$;
        IF EXISTS (
          SELECT 1
          FROM grids.files file
          LEFT JOIN grids.file_attachments attachment
            ON attachment.file_id = file.id
           AND attachment.record_id = file.record_id
           AND attachment.field_id = file.field_id
           AND attachment.position = file.position
          WHERE attachment.file_id IS NULL
        ) THEN
          RAISE EXCEPTION 'grids file attachment backfill did not preserve every legacy owner';
        END IF;
        EXECUTE 'DROP INDEX IF EXISTS grids.idx_grids_files_record_field';
        EXECUTE 'DROP INDEX IF EXISTS grids.idx_grids_files_field';
        EXECUTE 'ALTER TABLE grids.files DROP COLUMN record_id, DROP COLUMN field_id, DROP COLUMN position';
      END IF;
    END
    $$
  `.simple();
  console.log("  ✓ grids.files");

  // ──────────────────────────────────────────────────────────────────
  // record_links — junction table for relation fields
  // ──────────────────────────────────────────────────────────────────
  // Relation values live in a junction table instead of records.data so
  // Postgres enforces link integrity and reverse lookups stay indexed.
  // `position` preserves user order for multi-relation fields.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_links (
      from_record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      from_field_id  UUID NOT NULL REFERENCES grids.fields(id)  ON DELETE CASCADE,
      to_record_id   UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      position       INT NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (from_record_id, from_field_id, to_record_id)
    )
  `.simple();
  // Forward read: "all targets of (record, field)" — used on every record fetch.
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_record_links_forward ON grids.record_links(from_field_id, from_record_id, position)`.simple();
  // Reverse read: "all records linking to X via field F".
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_links_reverse_page
    ON grids.record_links(to_record_id, from_field_id, from_record_id)
  `.simple();
  await sql`DROP INDEX IF EXISTS grids.idx_grids_record_links_reverse`.simple();
  console.log("  ✓ grids.record_links");
};

const migrateDurableHistory = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.table_schema_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE RESTRICT,
      schema_hash TEXT NOT NULL,
      fields JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (table_id, schema_hash)
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS grids.durable_history_activations (
      table_id UUID PRIMARY KEY REFERENCES grids.tables(id) ON DELETE RESTRICT,
      baseline_schema_revision_id UUID NOT NULL REFERENCES grids.table_schema_revisions(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'activating',
      activated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      activated_at TIMESTAMPTZ NOT NULL,
      baseline_completed_at TIMESTAMPTZ,
      CONSTRAINT durable_history_activations_status_chk CHECK (status IN ('activating', 'active'))
    )
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_revisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE RESTRICT,
      record_id UUID NOT NULL,
      schema_revision_id UUID NOT NULL REFERENCES grids.table_schema_revisions(id) ON DELETE RESTRICT,
      revision_no INT NOT NULL,
      action TEXT NOT NULL,
      record_version INT NOT NULL,
      data JSONB NOT NULL,
      relations JSONB NOT NULL DEFAULT '{}'::jsonb,
      files JSONB NOT NULL DEFAULT '[]'::jsonb,
      changed_field_ids UUID[] NOT NULL DEFAULT '{}',
      deleted_at TIMESTAMPTZ,
      actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      actor_display_name TEXT,
      actor_avatar_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT record_revisions_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT record_revisions_action_chk CHECK (
        action IN ('baseline', 'created', 'updated', 'deleted', 'restored', 'finalized', 'file.added', 'file.replaced', 'file.removed')
      ),
      UNIQUE (table_id, record_id, revision_no)
    )
  `.simple();
  await sql`ALTER TABLE grids.record_revisions ADD COLUMN IF NOT EXISTS actor_display_name TEXT`.simple();
  await sql`ALTER TABLE grids.record_revisions ADD COLUMN IF NOT EXISTS actor_avatar_hash TEXT`.simple();
  await sql`ALTER TABLE grids.record_revisions DROP CONSTRAINT IF EXISTS record_revisions_action_chk`.simple();
  await sql`
    ALTER TABLE grids.record_revisions ADD CONSTRAINT record_revisions_action_chk CHECK (
      action IN ('baseline', 'created', 'updated', 'deleted', 'restored', 'finalized', 'file.added', 'file.replaced', 'file.removed')
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_revisions_short_id
    ON grids.record_revisions(short_id)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_revisions_baseline
    ON grids.record_revisions(table_id, record_id)
    WHERE action = 'baseline'
  `.simple();
  await sql`DROP INDEX IF EXISTS grids.idx_grids_record_revisions_record_page`.simple();
  console.log("  ✓ grids durable history");
};

const migrateRecordFinalization = async (sql: SQL): Promise<void> => {
  await sql`ALTER TABLE grids.tables ADD COLUMN IF NOT EXISTS finalization_policy_revision INT NOT NULL DEFAULT 0`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.table_finalization_activations (
      table_id UUID PRIMARY KEY REFERENCES grids.tables(id) ON DELETE RESTRICT,
      enabled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      mode TEXT NOT NULL DEFAULT 'direct',
      approver_group_id UUID,
      policy_revision INT NOT NULL DEFAULT 1
    )
  `.simple();
  await sql`ALTER TABLE grids.table_finalization_activations ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'direct'`.simple();
  await sql`ALTER TABLE grids.table_finalization_activations ADD COLUMN IF NOT EXISTS approver_group_id UUID`.simple();
  await sql`ALTER TABLE grids.table_finalization_activations ADD COLUMN IF NOT EXISTS policy_revision INT NOT NULL DEFAULT 1`.simple();
  await sql`
    UPDATE grids.tables table_ref
    SET finalization_policy_revision = GREATEST(table_ref.finalization_policy_revision, activation.policy_revision)
    FROM grids.table_finalization_activations activation
    WHERE activation.table_id = table_ref.id
  `.simple();
  await sql`ALTER TABLE grids.table_finalization_activations DROP CONSTRAINT IF EXISTS table_finalization_activations_policy_chk`.simple();
  await sql`
    ALTER TABLE grids.table_finalization_activations ADD CONSTRAINT table_finalization_activations_policy_chk CHECK (
      (mode = 'direct' AND approver_group_id IS NULL)
      OR (mode = 'four_eyes' AND approver_group_id IS NOT NULL)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_finalization_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE RESTRICT,
      record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE RESTRICT,
      record_version INT NOT NULL,
      policy_revision INT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
      request_comment TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      resolution_comment TEXT,
      resolved_at TIMESTAMPTZ,
      CONSTRAINT record_finalization_requests_status_chk CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
      CONSTRAINT record_finalization_requests_resolution_chk CHECK (
        (status = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL)
        OR (status <> 'pending' AND resolved_at IS NOT NULL)
      )
    )
  `.simple();
  await sql`ALTER TABLE grids.record_finalization_requests ADD COLUMN IF NOT EXISTS short_id TEXT`.simple();
  const finalizationRequests = await sql<Array<{ id: string; short_id: string | null }>>`
    SELECT id::text, short_id FROM grids.record_finalization_requests ORDER BY id FOR UPDATE
  `;
  const validOwners = new Map<string, string>();
  for (const request of finalizationRequests) {
    if (request.short_id && SHORT_ID_REGEX.test(request.short_id) && !validOwners.has(request.short_id)) {
      validOwners.set(request.short_id, request.id);
    }
  }
  const allocated = new Set(validOwners.keys());
  for (const request of finalizationRequests) {
    if (request.short_id && validOwners.get(request.short_id) === request.id) continue;
    const shortId = allocateMigrationShortId(allocated, "record_finalization_requests");
    allocated.add(shortId);
    await sql`UPDATE grids.record_finalization_requests SET short_id = ${shortId} WHERE id = ${request.id}::uuid`;
  }
  const [requestIdConstraint] = await sql<Array<{ ready: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'grids.record_finalization_requests'::regclass
        AND conname = 'record_finalization_requests_short_id_format_chk'
        AND convalidated
    ) AS ready
  `;
  if (!requestIdConstraint?.ready) {
    await sql`
      ALTER TABLE grids.record_finalization_requests
      ADD CONSTRAINT record_finalization_requests_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    `.simple();
  }
  const [requestIdColumn] = await sql<Array<{ nullable: string }>>`
    SELECT is_nullable AS nullable
    FROM information_schema.columns
    WHERE table_schema = 'grids' AND table_name = 'record_finalization_requests' AND column_name = 'short_id'
  `;
  if (requestIdColumn?.nullable !== "NO") {
    await sql`ALTER TABLE grids.record_finalization_requests ALTER COLUMN short_id SET NOT NULL`.simple();
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_short_id
    ON grids.record_finalization_requests(short_id)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_pending
    ON grids.record_finalization_requests(record_id) WHERE status = 'pending'
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_table
    ON grids.record_finalization_requests(table_id, requested_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_finalization_requests_pending_table
    ON grids.record_finalization_requests(table_id, record_id, record_version, policy_revision)
    WHERE status = 'pending'
  `.simple();
  await sql`ALTER TABLE grids.records ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE grids.records ADD COLUMN IF NOT EXISTS finalized_by UUID REFERENCES auth.users(id) ON DELETE SET NULL`.simple();
  await sql`
    ALTER TABLE grids.records ADD COLUMN IF NOT EXISTS final_revision_id UUID REFERENCES grids.record_revisions(id) ON DELETE RESTRICT
  `.simple();
  await sql`ALTER TABLE grids.records DROP CONSTRAINT IF EXISTS records_finalization_marker_chk`.simple();
  await sql`
    ALTER TABLE grids.records ADD CONSTRAINT records_finalization_marker_chk CHECK (
      (finalized_at IS NULL AND final_revision_id IS NULL)
      OR (finalized_at IS NOT NULL AND final_revision_id IS NOT NULL)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_records_table_finalized
    ON grids.records(table_id, finalized_at) WHERE finalized_at IS NOT NULL
  `.simple();
  console.log("  ✓ grids record finalization");
};

const migrateViews = async (sql: SQL): Promise<void> => {
  // ──────────────────────────────────────────────────────────────────
  // views
  // ──────────────────────────────────────────────────────────────────
  // owner_user_id NULL = shared (visible to anyone with table-read).
  // `source` carries the canonical GQL query. `ui` carries view-owned
  // presentation settings; data semantics are never persisted as RecordQuery.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.views (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      source TEXT NOT NULL,
      ui JSONB NOT NULL DEFAULT '{}'::jsonb,
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
      position INT NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT views_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT views_source_length_chk CHECK (length(source) BETWEEN 1 AND 20000)
    )
  `.simple();
  await sql`ALTER TABLE grids.views ADD COLUMN IF NOT EXISTS base_id UUID REFERENCES grids.bases(id) ON DELETE CASCADE`.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.sync_view_base_id() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      SELECT base_id INTO NEW.base_id
      FROM grids.tables
      WHERE id = NEW.table_id;
      RETURN NEW;
    END
    $$
  `.simple();
  await sql`
    CREATE OR REPLACE TRIGGER grids_views_sync_base_id
    BEFORE INSERT OR UPDATE OF table_id, base_id ON grids.views
    FOR EACH ROW EXECUTE FUNCTION grids.sync_view_base_id()
  `.simple();
  await sql`
    UPDATE grids.views v
    SET base_id = t.base_id
    FROM grids.tables t
    WHERE t.id = v.table_id
      AND v.base_id IS DISTINCT FROM t.base_id
  `.simple();
  await sql`ALTER TABLE grids.views ALTER COLUMN base_id SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.views ADD COLUMN IF NOT EXISTS description TEXT`.simple();
  await sql`ALTER TABLE grids.views ADD COLUMN IF NOT EXISTS ui JSONB NOT NULL DEFAULT '{}'::jsonb`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_views_table_live ON grids.views(table_id, position) WHERE deleted_at IS NULL`.simple();
  const [duplicateViewName] = await sql<Array<{ baseId: string; name: string }>>`
    SELECT base_id::text AS "baseId", lower(btrim(name)) AS name
    FROM grids.views
    WHERE deleted_at IS NULL
    GROUP BY base_id, lower(btrim(name))
    HAVING count(*) > 1
    LIMIT 1
  `;
  if (duplicateViewName) {
    throw new Error(
      `cannot enforce unique view names: grid ${duplicateViewName.baseId} contains multiple live views named "${duplicateViewName.name}"`,
    );
  }
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_views_live_name
    ON grids.views(base_id, lower(btrim(name)))
    WHERE deleted_at IS NULL
  `.simple();
  console.log("  ✓ grids.views");
};

const migrateDocumentTemplates = async (sql: SQL): Promise<void> => {
  // ──────────────────────────────────────────────────────────────────
  // document templates / snapshots / runs
  // ──────────────────────────────────────────────────────────────────
  // Templates are table-level render definitions. They store a Liquid-rendered
  // GQL source plus a Liquid-rendered HTML template. Official document runs
  // snapshot the template and render data; PDFs are regenerated on download.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL,
      html TEXT NOT NULL,
      header_html TEXT,
      footer_html TEXT,
      page_css TEXT,
      number_template TEXT NOT NULL DEFAULT '{{ template.id }}-{{ date.yyyyMMdd }}-{{ run.id }}',
      filename_template TEXT NOT NULL DEFAULT '{{ document.number }}.pdf',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      position INT NOT NULL DEFAULT 0,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT document_templates_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT document_templates_source_length_chk CHECK (length(source) BETWEEN 1 AND 20000),
      CONSTRAINT document_templates_html_length_chk CHECK (length(html) BETWEEN 1 AND 200000),
      CONSTRAINT document_templates_header_html_length_chk CHECK (header_html IS NULL OR length(header_html) <= 50000),
      CONSTRAINT document_templates_footer_html_length_chk CHECK (footer_html IS NULL OR length(footer_html) <= 50000),
      CONSTRAINT document_templates_page_css_length_chk CHECK (page_css IS NULL OR length(page_css) <= 50000),
      CONSTRAINT document_templates_number_template_length_chk CHECK (length(number_template) BETWEEN 1 AND 5000),
      CONSTRAINT document_templates_filename_template_length_chk CHECK (length(filename_template) BETWEEN 1 AND 5000)
    )
  `.simple();
  await sql`ALTER TABLE grids.document_templates ADD COLUMN IF NOT EXISTS header_html TEXT`.simple();
  await sql`ALTER TABLE grids.document_templates ADD COLUMN IF NOT EXISTS footer_html TEXT`.simple();
  await sql`ALTER TABLE grids.document_templates ADD COLUMN IF NOT EXISTS page_css TEXT`.simple();
  await sql`ALTER TABLE grids.document_templates ADD COLUMN IF NOT EXISTS number_template TEXT`.simple();
  await sql`ALTER TABLE grids.document_templates ADD COLUMN IF NOT EXISTS filename_template TEXT`.simple();
  await sql`
    UPDATE grids.document_templates
    SET number_template = '{{ template.id }}-{{ date.yyyyMMdd }}-{{ run.id }}'
    WHERE number_template IS NULL OR btrim(number_template) = ''
  `.simple();
  await sql`
    UPDATE grids.document_templates
    SET filename_template = '{{ document.number }}.pdf'
    WHERE filename_template IS NULL OR btrim(filename_template) = ''
  `.simple();
  await sql`
    UPDATE grids.document_templates
    SET source = replace(replace(source, 'template.shortId', 'template.id'), 'run.shortId', 'run.id'),
        html = replace(replace(html, 'template.shortId', 'template.id'), 'run.shortId', 'run.id'),
        header_html = replace(replace(header_html, 'template.shortId', 'template.id'), 'run.shortId', 'run.id'),
        footer_html = replace(replace(footer_html, 'template.shortId', 'template.id'), 'run.shortId', 'run.id'),
        number_template = replace(replace(number_template, 'template.shortId', 'template.id'), 'run.shortId', 'run.id'),
        filename_template = replace(replace(filename_template, 'template.shortId', 'template.id'), 'run.shortId', 'run.id')
    WHERE source LIKE '%template.shortId%' OR source LIKE '%run.shortId%'
       OR html LIKE '%template.shortId%' OR html LIKE '%run.shortId%'
       OR header_html LIKE '%template.shortId%' OR header_html LIKE '%run.shortId%'
       OR footer_html LIKE '%template.shortId%' OR footer_html LIKE '%run.shortId%'
       OR number_template LIKE '%template.shortId%' OR number_template LIKE '%run.shortId%'
       OR filename_template LIKE '%template.shortId%' OR filename_template LIKE '%run.shortId%'
  `.simple();
  await sql`ALTER TABLE grids.document_templates ALTER COLUMN number_template SET DEFAULT '{{ template.id }}-{{ date.yyyyMMdd }}-{{ run.id }}'`.simple();
  await sql`ALTER TABLE grids.document_templates ALTER COLUMN number_template SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_templates ALTER COLUMN filename_template SET DEFAULT '{{ document.number }}.pdf'`.simple();
  await sql`ALTER TABLE grids.document_templates ALTER COLUMN filename_template SET NOT NULL`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_templates_header_html_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_templates
        ADD CONSTRAINT document_templates_header_html_length_chk CHECK (header_html IS NULL OR length(header_html) <= 50000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_templates_footer_html_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_templates
        ADD CONSTRAINT document_templates_footer_html_length_chk CHECK (footer_html IS NULL OR length(footer_html) <= 50000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_templates_page_css_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_templates
        ADD CONSTRAINT document_templates_page_css_length_chk CHECK (page_css IS NULL OR length(page_css) <= 50000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_templates_number_template_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_templates
        ADD CONSTRAINT document_templates_number_template_length_chk CHECK (length(number_template) BETWEEN 1 AND 5000);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_templates_filename_template_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_templates
        ADD CONSTRAINT document_templates_filename_template_length_chk CHECK (length(filename_template) BETWEEN 1 AND 5000);
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_templates_table_live
    ON grids.document_templates(table_id, position) WHERE deleted_at IS NULL
  `.simple();
  console.log("  ✓ grids.document_templates");

  // ──────────────────────────────────────────────────────────────────
  // email templates
  // ──────────────────────────────────────────────────────────────────
  // Email templates are base-level Liquid templates used by workflows. They
  // intentionally stay separate from document templates: no GQL source, no PDF
  // page parts, no record snapshot ownership.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.email_templates (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      subject TEXT NOT NULL,
      html TEXT NOT NULL,
      sample_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      position INT NOT NULL DEFAULT 0,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT email_templates_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT email_templates_subject_length_chk CHECK (length(subject) BETWEEN 1 AND 1000),
      CONSTRAINT email_templates_html_length_chk CHECK (length(html) BETWEEN 1 AND 200000),
      CONSTRAINT email_templates_sample_data_object_chk CHECK (jsonb_typeof(sample_data) = 'object')
    )
  `.simple();
  await sql`ALTER TABLE grids.email_templates ADD COLUMN IF NOT EXISTS sample_data JSONB`.simple();
  await sql`
    UPDATE grids.email_templates
    SET sample_data = CASE
      WHEN html LIKE '%data.requesterName%' AND html LIKE '%data.agreement.url%' THEN
        '{"requesterName":"Alex Morgan","loanNumber":"LOAN-2026-0001","dueDate":"31 July 2026","agreement":{"url":"https://cloud.example.org/share/grids/documents/example"}}'::jsonb
      WHEN html LIKE '%data.customerName%' AND html LIKE '%data.invoice.url%' THEN
        '{"customerName":"Ada Lovelace","orderNumber":"ORD-2026-0042","invoice":{"url":"https://cloud.example.org/share/grids/documents/example"}}'::jsonb
      WHEN html LIKE '%data.reference%' AND html LIKE '%data.receipt.url%' THEN
        '{"reference":"TX-2026-0042","merchant":"Office Supply GmbH","receipt":{"url":"https://cloud.example.org/share/grids/documents/example"}}'::jsonb
      ELSE '{}'::jsonb
    END
    WHERE sample_data IS NULL
  `.simple();
  await sql`
    ALTER TABLE grids.email_templates
    ALTER COLUMN sample_data SET DEFAULT '{}'::jsonb,
    ALTER COLUMN sample_data SET NOT NULL
  `.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'email_templates_sample_data_object_chk'
          AND conrelid = 'grids.email_templates'::regclass
      ) THEN
        ALTER TABLE grids.email_templates
        ADD CONSTRAINT email_templates_sample_data_object_chk CHECK (jsonb_typeof(sample_data) = 'object');
      END IF;
    END
    $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_email_templates_base_live
    ON grids.email_templates(base_id, position) WHERE deleted_at IS NULL
  `.simple();
  console.log("  ✓ grids.email_templates");
};

const migrateDocumentArtifacts = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL,
      table_id UUID NOT NULL,
      record_id UUID NOT NULL,
      root JSONB NOT NULL,
      graph JSONB NOT NULL,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT record_snapshots_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_snapshots_record
    ON grids.record_snapshots(table_id, record_id, created_at DESC)
  `.simple();
  console.log("  ✓ grids.record_snapshots");

  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      template_id UUID,
      workflow_run_id UUID,
      snapshot_id UUID NOT NULL REFERENCES grids.record_snapshots(id) ON DELETE RESTRICT,
      base_id UUID NOT NULL,
      table_id UUID NOT NULL,
      record_id UUID NOT NULL,
      document_number TEXT NOT NULL,
      filename TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      template_snapshot JSONB NOT NULL,
      render_data JSONB NOT NULL,
      artifact_file_id UUID NOT NULL REFERENCES grids.files(id) ON DELETE RESTRICT,
      artifact_mime_type TEXT NOT NULL,
      artifact_size_bytes INT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      renderer_version TEXT NOT NULL,
      template_revision TEXT NOT NULL,
      generated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT document_runs_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT document_runs_filename_length_chk CHECK (length(filename) BETWEEN 1 AND 255),
      CONSTRAINT document_runs_tags_count_chk CHECK (cardinality(tags) <= 20)
    )
  `.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS workflow_run_id UUID`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS filename TEXT`.simple();
  await sql`
    UPDATE grids.document_runs
    SET filename = document_number || '.pdf'
    WHERE filename IS NULL OR btrim(filename) = ''
  `.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN filename SET DEFAULT 'document.pdf'`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN filename SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}'`.simple();
  await sql`UPDATE grids.document_runs SET tags = '{}' WHERE tags IS NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN tags SET NOT NULL`.simple();
  await sql`
    ALTER TABLE grids.document_runs
    ADD COLUMN IF NOT EXISTS artifact_file_id UUID REFERENCES grids.files(id) ON DELETE RESTRICT
  `.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS artifact_mime_type TEXT`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS artifact_size_bytes INT`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS artifact_sha256 TEXT`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS renderer_version TEXT`.simple();
  await sql`ALTER TABLE grids.document_runs ADD COLUMN IF NOT EXISTS template_revision TEXT`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_runs_filename_length_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_runs
        ADD CONSTRAINT document_runs_filename_length_chk CHECK (length(filename) BETWEEN 1 AND 255);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_runs_tags_count_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_runs
        ADD CONSTRAINT document_runs_tags_count_chk CHECK (cardinality(tags) <= 20);
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_runs_number
    ON grids.document_runs(document_number)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_runs_template
    ON grids.document_runs(template_id, generated_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_runs_template_cursor
    ON grids.document_runs(template_id, generated_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_runs_record
    ON grids.document_runs(table_id, record_id, generated_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_runs_workflow_run
    ON grids.document_runs(workflow_run_id, generated_at DESC, id DESC)
    WHERE workflow_run_id IS NOT NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_runs_tags
    ON grids.document_runs USING GIN(tags)
  `.simple();
  console.log("  ✓ grids.document_runs");

  await sql`
    CREATE TABLE IF NOT EXISTS grids.document_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      document_run_id UUID NOT NULL REFERENCES grids.document_runs(id) ON DELETE CASCADE,
      base_id UUID NOT NULL,
      table_id UUID NOT NULL,
      record_id UUID NOT NULL,
      token_hash TEXT NOT NULL,
      comment TEXT,
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      last_accessed_at TIMESTAMPTZ,
      access_count INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT document_links_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT document_links_comment_length_chk CHECK (comment IS NULL OR length(comment) <= 500),
      CONSTRAINT document_links_access_count_chk CHECK (access_count >= 0)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_links_token_hash
    ON grids.document_links(token_hash)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_links_run
    ON grids.document_links(document_run_id, created_at DESC)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_document_links_active
    ON grids.document_links(expires_at)
    WHERE revoked_at IS NULL
  `.simple();
  console.log("  ✓ grids.document_links");
};

const finalizeDocumentArtifacts = async (sql: SQL): Promise<void> => {
  await sql`
    DELETE FROM grids.document_runs
    WHERE artifact_file_id IS NULL
       OR artifact_mime_type IS NULL
       OR artifact_size_bytes IS NULL
       OR artifact_sha256 IS NULL
       OR renderer_version IS NULL
       OR template_revision IS NULL
  `.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN artifact_file_id SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN artifact_mime_type SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN artifact_size_bytes SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN artifact_sha256 SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN renderer_version SET NOT NULL`.simple();
  await sql`ALTER TABLE grids.document_runs ALTER COLUMN template_revision SET NOT NULL`.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_runs_artifact_complete_chk'
          AND connamespace = 'grids'::regnamespace
          AND pg_get_constraintdef(oid) LIKE '%artifact_file_id IS NULL%'
      ) THEN
        ALTER TABLE grids.document_runs DROP CONSTRAINT document_runs_artifact_complete_chk;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'document_runs_artifact_complete_chk' AND connamespace = 'grids'::regnamespace
      ) THEN
        ALTER TABLE grids.document_runs
        ADD CONSTRAINT document_runs_artifact_complete_chk CHECK (
          artifact_mime_type = 'application/pdf'
          AND artifact_size_bytes > 0
          AND artifact_sha256 ~ '^[a-f0-9]{64}$'
          AND length(renderer_version) > 0
          AND template_revision ~ '^[a-f0-9]{64}$'
        );
      END IF;
    END $$;
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_document_runs_artifact_file
    ON grids.document_runs(artifact_file_id)
  `.simple();
};

const migrateNumberSeries = async (sql: SQL): Promise<void> => {
  const allocateSeriesShortId = async (): Promise<string> => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = newShortId();
      const [used] = await sql<Array<{ used: boolean }>>`
        SELECT true AS used FROM grids.number_series WHERE short_id = ${candidate}
      `;
      if (!used) return candidate;
    }
    throw new Error("number series migration could not allocate a public id");
  };
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('field', 'document_template')),
      field_id UUID UNIQUE REFERENCES grids.fields(id) ON DELETE CASCADE,
      document_template_id UUID UNIQUE REFERENCES grids.document_templates(id) ON DELETE CASCADE,
      assignment TEXT NOT NULL DEFAULT 'creation' CHECK (assignment IN ('creation', 'finalization')),
      current_version INT NOT NULL DEFAULT 1 CHECK (current_version >= 1),
      baseline_floor BIGINT NOT NULL DEFAULT 0 CHECK (baseline_floor >= 0),
      migration_status TEXT NOT NULL DEFAULT 'native',
      migration_note TEXT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT number_series_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT number_series_owner_chk CHECK (
        (owner_kind = 'field' AND field_id IS NOT NULL AND document_template_id IS NULL)
        OR (owner_kind = 'document_template' AND document_template_id IS NOT NULL AND field_id IS NULL)
      )
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_number_series_short_id
    ON grids.number_series(short_id)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series_versions (
      series_id UUID NOT NULL REFERENCES grids.number_series(id) ON DELETE CASCADE,
      version INT NOT NULL CHECK (version >= 1),
      strategy TEXT NOT NULL CHECK (strategy IN ('sequence', 'date_sequence', 'document')),
      prefix TEXT NOT NULL DEFAULT '',
      padding INT NOT NULL DEFAULT 1 CHECK (padding BETWEEN 1 AND 16),
      period TEXT CHECK (period IN ('year', 'month', 'day')),
      number_template TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (series_id, version)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_series_scopes (
      series_id UUID NOT NULL REFERENCES grids.number_series(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      sequence_name TEXT NOT NULL UNIQUE,
      baseline BIGINT NOT NULL DEFAULT 0 CHECK (baseline >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (series_id, scope)
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.number_allocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      series_id UUID NOT NULL REFERENCES grids.number_series(id) ON DELETE CASCADE,
      version INT NOT NULL,
      scope TEXT NOT NULL,
      value BIGINT NOT NULL CHECK (value >= 1),
      rendered_value TEXT NOT NULL,
      consumer_kind TEXT CHECK (consumer_kind IN ('record', 'document_run')),
      consumer_id UUID,
      allocated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (series_id, version) REFERENCES grids.number_series_versions(series_id, version) ON DELETE CASCADE,
      CONSTRAINT number_allocations_consumer_chk CHECK (
        (consumer_kind IS NULL AND consumer_id IS NULL) OR (consumer_kind IS NOT NULL AND consumer_id IS NOT NULL)
      ),
      UNIQUE (series_id, scope, value),
      UNIQUE (series_id, rendered_value)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_number_allocations_consumer
    ON grids.number_allocations(consumer_kind, consumer_id)
    WHERE consumer_id IS NOT NULL
  `.simple();

  const fields = await sql<Array<{ id: string; config: Record<string, unknown>; deletedAt: Date | null }>>`
    SELECT id::text, config, deleted_at AS "deletedAt"
    FROM grids.fields
    WHERE type = 'id'
    ORDER BY id
  `;
  for (const field of fields) {
    const format = numberSeriesFormatForField(parseJsonbRow(field.config, {}));
    if (!format) continue;
    let [series] = await sql<Array<{ id: string }>>`
      SELECT id::text FROM grids.number_series WHERE field_id = ${field.id}::uuid
    `;
    if (!series) {
      const seriesId = Bun.randomUUIDv7();
      const seriesShortId = await allocateSeriesShortId();
      [series] = await sql<Array<{ id: string }>>`
        INSERT INTO grids.number_series (id, short_id, owner_kind, field_id, archived_at, migration_status)
        VALUES (${seriesId}::uuid, ${seriesShortId}, 'field', ${field.id}::uuid, ${field.deletedAt}, 'pending')
        RETURNING id::text
      `;
      await sql`
        INSERT INTO grids.number_series_versions (series_id, version, strategy, prefix, padding, period)
        VALUES (
          ${seriesId}::uuid,
          1,
          ${format.strategy},
          ${format.prefix ?? ""},
          ${format.padding ?? 1},
          ${format.period ?? null}
        )
      `;
    }
    if (!series) throw new Error(`number series migration could not create field series ${field.id}`);
    const [{ count: scopeCount } = { count: 0 }] = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM grids.number_series_scopes WHERE series_id = ${series.id}::uuid
    `;
    if (scopeCount > 0) continue;

    const legacyPrefix = `grids_id_${field.id.replaceAll("-", "")}`;
    const legacy = await sql<Array<{ sequenceName: string; lastValue: bigint | number | string | null }>>`
      SELECT sequencename AS "sequenceName", last_value AS "lastValue"
      FROM pg_sequences
      WHERE schemaname = 'grids' AND sequencename LIKE ${`${legacyPrefix}%`}
      ORDER BY sequencename
    `;
    let diagnostic = "active_sequence";
    let note: string | null = null;
    let conservativeFloor = 0;
    const scopes = new Map<string, number>();
    for (const row of legacy) {
      const suffix = row.sequenceName.slice(legacyPrefix.length).replace(/^_/, "");
      scopes.set(suffix || "global", Number(row.lastValue ?? 0));
      conservativeFloor = Math.max(conservativeFloor, Number(row.lastValue ?? 0));
    }
    const hasLegacySequences = scopes.size > 0;
    if (!hasLegacySequences) {
      const values = await sql<Array<{ value: string }>>`
        SELECT data->>${field.id} AS value
        FROM grids.records
        WHERE data ? ${field.id}
      `;
      const prefix = format.prefix ?? "";
      const paddingPattern = "([0-9]+)";
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matcher =
        format.strategy === "date_sequence"
          ? new RegExp(`^${escapedPrefix}([0-9]{4}|[0-9]{6}|[0-9]{8})-${paddingPattern}$`)
          : new RegExp(`^${escapedPrefix}${paddingPattern}$`);
      let ambiguous = false;
      for (const row of values) {
        const trailing = row.value.match(/([0-9]+)$/)?.[1];
        if (trailing) conservativeFloor = Math.max(conservativeFloor, Number(trailing));
        const match = row.value.match(matcher);
        if (!match) {
          ambiguous = true;
          continue;
        }
        const scope = format.strategy === "date_sequence" ? match[1]! : "global";
        const value = Number(match[format.strategy === "date_sequence" ? 2 : 1]);
        if (!Number.isSafeInteger(value) || value < 1) {
          ambiguous = true;
          continue;
        }
        scopes.set(scope, Math.max(scopes.get(scope) ?? 0, value));
      }
      if (scopes.size === 0) scopes.set("global", 0);
      diagnostic = ambiguous ? "inferred_with_unmatched_values" : values.length > 0 ? "inferred_from_values" : "inferred_empty";
      note = ambiguous ? "Some legacy values did not match the current format; matching high-water marks were preserved." : null;
    }
    for (const [scope, baseline] of scopes) {
      const safeBaseline = hasLegacySequences ? baseline : Math.max(baseline, conservativeFloor);
      const sequenceName = numberSeriesSequenceName(series.id, scope);
      await sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS grids.${sequenceName} AS BIGINT INCREMENT 1 MINVALUE 1`);
      if (safeBaseline > 0) await sql.unsafe(`SELECT setval('grids.${sequenceName}', $1, true)`, [safeBaseline]);
      await sql`
        INSERT INTO grids.number_series_scopes (series_id, scope, sequence_name, baseline)
        VALUES (${series.id}::uuid, ${scope}, ${sequenceName}, ${safeBaseline})
        ON CONFLICT (series_id, scope) DO NOTHING
      `;
    }
    await sql`
      UPDATE grids.number_series
      SET migration_status = ${diagnostic}, migration_note = ${note}, baseline_floor = ${conservativeFloor}, updated_at = now()
      WHERE id = ${series.id}::uuid
    `;
  }

  const templates = await sql<Array<{ id: string; numberTemplate: string; deletedAt: Date | null; runCount: number }>>`
    SELECT dt.id::text, dt.number_template AS "numberTemplate", dt.deleted_at AS "deletedAt", count(dr.id)::int AS "runCount"
    FROM grids.document_templates dt
    LEFT JOIN grids.document_runs dr ON dr.template_id = dt.id
    GROUP BY dt.id, dt.number_template, dt.deleted_at
    ORDER BY dt.id
  `;
  for (const template of templates) {
    let [series] = await sql<Array<{ id: string }>>`
      SELECT id::text FROM grids.number_series WHERE document_template_id = ${template.id}::uuid
    `;
    if (!series) {
      const seriesId = Bun.randomUUIDv7();
      const seriesShortId = await allocateSeriesShortId();
      [series] = await sql<Array<{ id: string }>>`
        INSERT INTO grids.number_series (
          id, short_id, owner_kind, document_template_id, archived_at, migration_status, migration_note
        )
        VALUES (
          ${seriesId}::uuid,
          ${seriesShortId},
          'document_template',
          ${template.id}::uuid,
          ${template.deletedAt},
          'inferred_from_document_runs',
          'Artifact-less alpha document runs did not store allocations; the run count is the conservative baseline.'
        )
        RETURNING id::text
      `;
      await sql`UPDATE grids.number_series SET baseline_floor = ${template.runCount} WHERE id = ${seriesId}::uuid`;
      await sql`
        INSERT INTO grids.number_series_versions (series_id, version, strategy, number_template)
        VALUES (${seriesId}::uuid, 1, 'document', ${template.numberTemplate})
      `;
    }
    if (!series) throw new Error(`number series migration could not create document series ${template.id}`);
    const [scope] = await sql<Array<{ exists: boolean }>>`
      SELECT true AS exists FROM grids.number_series_scopes WHERE series_id = ${series.id}::uuid AND scope = 'global'
    `;
    if (!scope) {
      const sequenceName = numberSeriesSequenceName(series.id, "global");
      await sql.unsafe(`CREATE SEQUENCE IF NOT EXISTS grids.${sequenceName} AS BIGINT INCREMENT 1 MINVALUE 1`);
      if (template.runCount > 0) await sql.unsafe(`SELECT setval('grids.${sequenceName}', $1, true)`, [template.runCount]);
      await sql`
        INSERT INTO grids.number_series_scopes (series_id, scope, sequence_name, baseline)
        VALUES (${series.id}::uuid, 'global', ${sequenceName}, ${template.runCount})
      `;
    }
  }

  await sql`ALTER TABLE grids.number_series ALTER COLUMN short_id SET NOT NULL`.simple();
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'grids.number_series'::regclass
          AND conname = 'number_series_short_id_format_chk'
      ) THEN
        ALTER TABLE grids.number_series
          ADD CONSTRAINT number_series_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$');
      END IF;
    END $$
  `.simple();

  const legacySequences = await sql<Array<{ sequenceName: string }>>`
    SELECT sequencename AS "sequenceName"
    FROM pg_sequences
    WHERE schemaname = 'grids' AND sequencename LIKE 'grids_id_%'
  `;
  for (const sequence of legacySequences) {
    if (!/^grids_id_[a-f0-9_]+$/i.test(sequence.sequenceName)) throw new Error("unsafe legacy number sequence name");
    await sql.unsafe(`DROP SEQUENCE grids.${sequence.sequenceName}`);
  }
  console.log("  ✓ grids durable number series");
};

// Intentional alpha hard cut: these surfaces predate canonical GQL views and
// HTML-only workflow email templates. They are removed instead of migrated so
// the runtime has one query and one email-template representation.
const cleanupAlphaSchema = async (sql: SQL): Promise<void> => {
  await sql`ALTER TABLE grids.views DROP COLUMN IF EXISTS query`.simple();
  await sql`ALTER TABLE grids.views DROP COLUMN IF EXISTS display_config`.simple();
  await sql`DROP TABLE IF EXISTS grids.gql_queries CASCADE`.simple();
  await sql`ALTER TABLE grids.email_templates DROP CONSTRAINT IF EXISTS email_templates_text_length_chk`.simple();
  await sql`ALTER TABLE grids.email_templates DROP COLUMN IF EXISTS text`.simple();
  console.log("  ✓ grids alpha schema cleanup");
};

const migrateFormsAndEvents = async (sql: SQL): Promise<void> => {
  // ──────────────────────────────────────────────────────────────────
  // forms — record-entry surface for internal users + optional public URLs
  // ──────────────────────────────────────────────────────────────────
  // The "default form" per table is virtual (computed from active fields)
  // and not stored here. Only user-customized forms live in grids.forms.
  // Public forms have a non-null `public_token` that anonymous callers
  // pass in the URL.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.forms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      public_token TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      owner_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      position INT NOT NULL DEFAULT 0,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT forms_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_forms_table_live ON grids.forms(table_id, position) WHERE deleted_at IS NULL`.simple();
  // Public-token lookup is the public form's hot path; partial index keeps
  // it scoped to forms that are actually public AND alive.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_forms_public_token ON grids.forms(public_token) WHERE public_token IS NOT NULL AND deleted_at IS NULL`.simple();
  console.log("  ✓ grids.forms");

  // ──────────────────────────────────────────────────────────────────
  // audit log
  // ──────────────────────────────────────────────────────────────────
  // No FK on record_id: audit history remains readable independently from
  // the record lifecycle.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID,
      table_id UUID,
      record_id UUID,
      user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      diff JSONB,
      context JSONB,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`ALTER TABLE grids.audit_log ADD COLUMN IF NOT EXISTS context JSONB`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_audit_record ON grids.audit_log(record_id, created_at DESC) WHERE record_id IS NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_audit_table ON grids.audit_log(table_id, created_at DESC) WHERE table_id IS NOT NULL`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_audit_table_records_page
    ON grids.audit_log(table_id, created_at DESC, id DESC)
    WHERE record_id IS NOT NULL
  `.simple();
  console.log("  ✓ grids.audit_log");

  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      record_id UUID NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      dead_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT record_event_outbox_status_check CHECK (status IN ('pending', 'failed', 'delivered', 'dead'))
    )
  `.simple();
  await sql`ALTER TABLE grids.record_event_outbox ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ`.simple();
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'record_event_outbox_status_check'
          AND connamespace = 'grids'::regnamespace
          AND pg_get_constraintdef(oid) NOT LIKE '%dead%'
      ) THEN
        ALTER TABLE grids.record_event_outbox DROP CONSTRAINT record_event_outbox_status_check;
        ALTER TABLE grids.record_event_outbox
          ADD CONSTRAINT record_event_outbox_status_check CHECK (status IN ('pending', 'failed', 'delivered', 'dead'));
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_pending
    ON grids.record_event_outbox(next_attempt_at, created_at)
    WHERE status IN ('pending', 'failed')
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_record_pending
    ON grids.record_event_outbox(record_id, created_at, id)
    WHERE status IN ('pending', 'failed')
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_delivered
    ON grids.record_event_outbox(delivered_at)
    WHERE status = 'delivered'
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_outbox_dead
    ON grids.record_event_outbox(dead_at)
    WHERE status = 'dead'
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_snapshots (
      id UUID PRIMARY KEY REFERENCES grids.record_event_outbox(id) ON DELETE CASCADE,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      record_id UUID NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('record.created', 'record.updated', 'record.deleted', 'record.restored', 'record.finalized', 'comment.created')),
      record_version INT NOT NULL CHECK (record_version > 0),
      data JSONB NOT NULL,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    DO $$
    DECLARE constraint_name text;
    BEGIN
      SELECT conname INTO constraint_name
      FROM pg_constraint
      WHERE conrelid = 'grids.record_event_snapshots'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%event_type%';
      IF constraint_name IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = 'grids.record_event_snapshots'::regclass
             AND conname = constraint_name
             AND pg_get_constraintdef(oid) LIKE '%record.finalized%'
         ) THEN
        EXECUTE format('ALTER TABLE grids.record_event_snapshots DROP CONSTRAINT %I', constraint_name);
        ALTER TABLE grids.record_event_snapshots
          ADD CONSTRAINT record_event_snapshots_event_type_check
          CHECK (event_type IN ('record.created', 'record.updated', 'record.deleted', 'record.restored', 'record.finalized', 'comment.created'));
      END IF;
    END $$
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_snapshots_record
    ON grids.record_event_snapshots(record_id, record_version, created_at DESC)
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_event_delivery_failures (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      consumer_group TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT,
      error TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
      status TEXT NOT NULL DEFAULT 'retrying' CHECK (status IN ('retrying', 'dead')),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dead_at TIMESTAMPTZ,
      UNIQUE (base_id, consumer_group, event_id),
      CHECK ((status = 'dead') = (dead_at IS NOT NULL))
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_event_delivery_failures_dead
    ON grids.record_event_delivery_failures(base_id, dead_at DESC)
    WHERE status = 'dead'
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.enqueue_record_event(p_table_id uuid, p_record_id uuid, p_payload jsonb)
    RETURNS uuid
    LANGUAGE plpgsql
    VOLATILE
    AS $$
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
    $$
  `.simple();
  console.log("  ✓ grids.record_event_outbox + delivery failures");
};

const migrateCustomApps = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.custom_apps (
      id UUID PRIMARY KEY,
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT,
      draft_definition JSONB NOT NULL,
      draft_capabilities JSONB NOT NULL,
      published_definition JSONB,
      published_capabilities JSONB,
      published_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT custom_apps_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`ALTER TABLE grids.custom_apps ALTER COLUMN draft_capabilities DROP NOT NULL`.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_custom_apps_base
    ON grids.custom_apps(base_id, name) WHERE deleted_at IS NULL
  `.simple();
  // v3 makes Records paging an explicit presentation concern and removes the
  // old author-facing execution cap. Rewrite stored JSON losslessly before
  // strict v3 parsing; no compatibility parser remains in the runtime.
  await sql`
    CREATE OR REPLACE FUNCTION grids.custom_app_definition_v3(value JSONB)
    RETURNS JSONB
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      result JSONB;
      legacy_page_size INTEGER;
    BEGIN
      IF jsonb_typeof(value) = 'array' THEN
        SELECT COALESCE(jsonb_agg(grids.custom_app_definition_v3(item)), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(value) AS entries(item);
      ELSIF jsonb_typeof(value) = 'object' THEN
        legacy_page_size := CASE
          WHEN value->>'type' = 'records' AND value#>>'{source,maxRows}' ~ '^[0-9]+$'
            THEN LEAST(100, GREATEST(5, (value#>>'{source,maxRows}')::integer))
          ELSE 100
        END;
        SELECT COALESCE(jsonb_object_agg(key, grids.custom_app_definition_v3(item)), '{}'::jsonb)
        INTO result
        FROM jsonb_each(value) AS entries(key, item)
        WHERE key <> 'maxRows';

        IF result->>'type' = 'records' THEN
          result := jsonb_build_object('searchable', false, 'pageSize', legacy_page_size) || result;
        END IF;
        IF result->>'kind' = 'grids.custom-app' AND result->>'schemaVersion' = '2' THEN
          result := jsonb_set(result, '{schemaVersion}', '3'::jsonb, false);
        END IF;
      ELSE
        result := value;
      END IF;
      RETURN result;
    END
    $$
  `.simple();
  await sql`
    UPDATE grids.custom_apps
    SET
      draft_definition = CASE
        WHEN draft_definition->>'schemaVersion' = '2' THEN grids.custom_app_definition_v3(draft_definition)
        ELSE draft_definition
      END,
      published_definition = CASE
        WHEN published_definition->>'schemaVersion' = '2' THEN grids.custom_app_definition_v3(published_definition)
        ELSE published_definition
      END
    WHERE draft_definition->>'schemaVersion' = '2'
       OR published_definition->>'schemaVersion' = '2'
  `.simple();
  await sql`DROP FUNCTION grids.custom_app_definition_v3(JSONB)`.simple();
  // v4 removes server-owned route identity and duplicate navigation ordering
  // from authoring JSON. Definitions using intentionally removed features stay
  // recoverable as raw drafts, but are unpublished instead of being changed
  // silently. Domain records are not part of this migration.
  await sql`
    CREATE OR REPLACE FUNCTION grids.custom_app_definition_v4_supported(value JSONB)
    RETURNS BOOLEAN
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      item JSONB;
    BEGIN
      IF jsonb_typeof(value) = 'array' THEN
        FOR item IN SELECT entry FROM jsonb_array_elements(value) AS entries(entry) LOOP
          IF NOT grids.custom_app_definition_v4_supported(item) THEN RETURN false; END IF;
        END LOOP;
      ELSIF jsonb_typeof(value) = 'object' THEN
        IF value->>'type' = 'chart' AND value->>'chartType' IN ('scatter', 'sparkline') THEN RETURN false; END IF;
        IF value ? 'bulkActions'
           AND jsonb_typeof(value->'bulkActions') = 'array'
           AND jsonb_array_length(value->'bulkActions') > 0 THEN
          RETURN false;
        END IF;
        IF value->>'kind' = 'grids.custom-app'
           AND jsonb_typeof(value#>'{sidebar,actions}') = 'array'
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(value#>'{sidebar,actions}') AS actions(action)
             WHERE action->>'kind' = 'workflow'
           ) THEN
          RETURN false;
        END IF;
        FOR item IN SELECT entry FROM jsonb_each(value) AS entries(key, entry) LOOP
          IF NOT grids.custom_app_definition_v4_supported(item) THEN RETURN false; END IF;
        END LOOP;
      END IF;
      RETURN true;
    END
    $$
  `.simple();
  await sql`
    CREATE OR REPLACE FUNCTION grids.custom_app_definition_v4(value JSONB)
    RETURNS JSONB
    LANGUAGE plpgsql
    IMMUTABLE
    AS $$
    DECLARE
      pages JSONB;
      result JSONB;
    BEGIN
      IF value->>'schemaVersion' <> '3' OR NOT grids.custom_app_definition_v4_supported(value) THEN RETURN NULL; END IF;
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN jsonb_typeof(page->'navigation') = 'object'
              THEN jsonb_set(page, '{navigation}', (page->'navigation') - 'order', false)
            ELSE page
          END
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      INTO pages
      FROM jsonb_array_elements(COALESCE(value->'pages', '[]'::jsonb)) WITH ORDINALITY AS entries(page, ordinal);
      result := jsonb_set((value - 'shortId'), '{schemaVersion}', '4'::jsonb, false);
      RETURN jsonb_set(result, '{pages}', pages, false);
    END
    $$
  `.simple();
  await sql`
    UPDATE grids.custom_apps
    SET
      draft_definition = CASE
        WHEN draft_definition->>'schemaVersion' = '3'
             AND NOT grids.custom_app_definition_v4_supported(draft_definition)
          THEN draft_definition
        ELSE published_definition
      END,
      draft_capabilities = NULL,
      published_definition = NULL,
      published_capabilities = NULL,
      published_at = NULL,
      updated_at = now()
    WHERE (draft_definition->>'schemaVersion' = '3' AND NOT grids.custom_app_definition_v4_supported(draft_definition))
       OR (published_definition->>'schemaVersion' = '3' AND NOT grids.custom_app_definition_v4_supported(published_definition))
  `.simple();
  await sql`
    UPDATE grids.custom_apps
    SET
      draft_definition = CASE
        WHEN draft_definition->>'schemaVersion' = '3' AND grids.custom_app_definition_v4_supported(draft_definition)
          THEN grids.custom_app_definition_v4(draft_definition)
        ELSE draft_definition
      END,
      published_definition = CASE
        WHEN published_definition->>'schemaVersion' = '3' AND grids.custom_app_definition_v4_supported(published_definition)
          THEN grids.custom_app_definition_v4(published_definition)
        ELSE published_definition
      END
    WHERE draft_definition->>'schemaVersion' = '3'
       OR published_definition->>'schemaVersion' = '3'
  `.simple();
  await sql`
    UPDATE grids.custom_apps
    SET
      draft_definition = CASE
        WHEN draft_definition->>'schemaVersion' = '4' THEN published_definition
        ELSE draft_definition
      END,
      draft_capabilities = NULL,
      published_definition = NULL,
      published_capabilities = NULL,
      published_at = NULL,
      updated_at = now()
    WHERE published_definition IS NOT NULL
      AND published_definition->>'schemaVersion' IS DISTINCT FROM '4'
  `.simple();
  await sql`DROP FUNCTION grids.custom_app_definition_v4(JSONB)`.simple();
  await sql`DROP FUNCTION grids.custom_app_definition_v4_supported(JSONB)`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.custom_app_access (
      custom_app_id UUID NOT NULL REFERENCES grids.custom_apps(id) ON DELETE CASCADE,
      access_id UUID NOT NULL REFERENCES auth.access(id) ON DELETE CASCADE,
      PRIMARY KEY (custom_app_id, access_id)
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_grids_custom_app_access_access ON grids.custom_app_access(access_id)`.simple();
  console.log("  ✓ grids.custom_apps + grids.custom_app_access");
};

const removeLegacyDashboards = async (sql: SQL): Promise<void> => {
  await sql`
    DROP TABLE IF EXISTS grids.dashboard_access;
    DROP TABLE IF EXISTS grids.dashboards;
    ALTER TABLE grids.bases DROP COLUMN IF EXISTS default_dashboard_id;
  `.simple();
  console.log("  ✓ removed legacy Grids dashboards");
};

const removeObsoleteAccess = async (sql: SQL): Promise<void> => {
  await sql`
    ALTER TABLE grids.base_access DROP CONSTRAINT IF EXISTS base_access_record_scope_chk;
    ALTER TABLE grids.base_access DROP COLUMN IF EXISTS record_scope;
    DROP TABLE IF EXISTS grids.table_access;
    DROP TABLE IF EXISTS grids.view_access;
    DROP TABLE IF EXISTS grids.form_access;
    DROP TABLE IF EXISTS grids.document_template_access;
    DROP TABLE IF EXISTS grids.workflow_access;
  `.simple();
  console.log("  ✓ removed obsolete Grids access metadata");
};

const migrateRecordScanCodes = async (sql: SQL): Promise<void> => {
  // Opaque scan codes are lazy-generated record lookup keys. A code does not
  // grant access; scanner workflows still resolve and run through permissions.
  await sql`
    CREATE TABLE IF NOT EXISTS grids.record_scan_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      table_id UUID NOT NULL REFERENCES grids.tables(id) ON DELETE CASCADE,
      record_id UUID NOT NULL REFERENCES grids.records(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      rotated_at TIMESTAMPTZ,
      CONSTRAINT record_scan_codes_code_length_chk CHECK (length(code) BETWEEN 16 AND 200)
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_scan_codes_code
    ON grids.record_scan_codes(code)
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_record_scan_codes_active_record
    ON grids.record_scan_codes(record_id) WHERE active = TRUE
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_record_scan_codes_table
    ON grids.record_scan_codes(table_id, record_id) WHERE active = TRUE
  `.simple();
  console.log("  ✓ grids.record_scan_codes");
};

const migrateEvidenceExports = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.evidence_exports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      table_id UUID REFERENCES grids.tables(id) ON DELETE RESTRICT,
      requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      requested_by_display_name TEXT,
      sections TEXT[] NOT NULL,
      range_from TIMESTAMPTZ,
      range_to TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt INT NOT NULL DEFAULT 1 CHECK (attempt >= 1),
      estimated_entries INT,
      processed_entries INT NOT NULL DEFAULT 0 CHECK (processed_entries >= 0),
      cut_at TIMESTAMPTZ,
      package_filename TEXT,
      package_size_bytes BIGINT,
      package_sha256 TEXT,
      manifest_sha256 TEXT,
      manifest JSONB,
      last_error TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      CONSTRAINT evidence_exports_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT evidence_exports_status_chk CHECK (
        status IN ('queued', 'running', 'cancel_requested', 'completed', 'failed', 'canceled', 'expired')
      ),
      CONSTRAINT evidence_exports_range_chk CHECK (range_from IS NULL OR range_to IS NULL OR range_from <= range_to),
      CONSTRAINT evidence_exports_package_chk CHECK (
        (status <> 'completed' AND package_filename IS NULL AND package_size_bytes IS NULL AND package_sha256 IS NULL AND manifest_sha256 IS NULL)
        OR (status = 'completed' AND package_filename IS NOT NULL AND package_size_bytes IS NOT NULL
          AND package_sha256 ~ '^[a-f0-9]{64}$' AND manifest_sha256 ~ '^[a-f0-9]{64}$' AND manifest IS NOT NULL)
      )
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_evidence_exports_short_id
    ON grids.evidence_exports(short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_evidence_exports_base_page
    ON grids.evidence_exports(base_id, requested_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.evidence_export_chunks (
      export_id UUID NOT NULL REFERENCES grids.evidence_exports(id) ON DELETE CASCADE,
      sequence INT NOT NULL CHECK (sequence >= 0),
      bytes BYTEA NOT NULL,
      PRIMARY KEY (export_id, sequence),
      CHECK (octet_length(bytes) BETWEEN 1 AND 1048576)
    )
  `.simple();
  console.log("  ✓ grids.evidence_exports");
};

const migrateRetentionPolicies = async (sql: SQL): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS grids.retention_policies (
      base_id UUID PRIMARY KEY REFERENCES grids.bases(id) ON DELETE CASCADE,
      minimum_days INT NOT NULL CHECK (minimum_days BETWEEN 1 AND 36500),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.file_retention_candidates (
      file_id UUID PRIMARY KEY REFERENCES grids.files(id) ON DELETE CASCADE,
      base_id UUID NOT NULL,
      table_id UUID,
      table_short_id TEXT,
      table_name TEXT,
      unreferenced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.simple();
  await sql`ALTER TABLE grids.file_retention_candidates ADD COLUMN IF NOT EXISTS table_id UUID`.simple();
  await sql`ALTER TABLE grids.file_retention_candidates ADD COLUMN IF NOT EXISTS table_short_id TEXT`.simple();
  await sql`ALTER TABLE grids.file_retention_candidates ADD COLUMN IF NOT EXISTS table_name TEXT`.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.preservation_holds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL DEFAULT 'base',
      table_id UUID,
      table_short_id TEXT,
      table_name TEXT,
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000 AND reason = btrim(reason)),
      created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_by_display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      release_reason TEXT CHECK (release_reason IS NULL OR (char_length(release_reason) BETWEEN 1 AND 1000 AND release_reason = btrim(release_reason))),
      released_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      released_by_display_name TEXT,
      released_at TIMESTAMPTZ,
      CONSTRAINT preservation_holds_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$'),
      CONSTRAINT preservation_holds_scope_chk CHECK (
        (scope_type = 'base' AND table_id IS NULL AND table_short_id IS NULL AND table_name IS NULL)
        OR (scope_type = 'table' AND table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL)
      ),
      CONSTRAINT preservation_holds_release_chk CHECK (
        (released_at IS NULL AND release_reason IS NULL AND released_by IS NULL AND released_by_display_name IS NULL)
        OR (released_at IS NOT NULL AND release_reason IS NOT NULL)
      )
    )
  `.simple();
  await sql`ALTER TABLE grids.preservation_holds ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'base'`.simple();
  await sql`ALTER TABLE grids.preservation_holds ADD COLUMN IF NOT EXISTS table_id UUID`.simple();
  await sql`ALTER TABLE grids.preservation_holds ADD COLUMN IF NOT EXISTS table_short_id TEXT`.simple();
  await sql`ALTER TABLE grids.preservation_holds ADD COLUMN IF NOT EXISTS table_name TEXT`.simple();
  await sql`
    UPDATE grids.preservation_holds hold
    SET table_short_id = table_info.short_id, table_name = table_info.name
    FROM grids.tables table_info
    WHERE hold.scope_type = 'table' AND hold.table_id = table_info.id
      AND (hold.table_short_id IS NULL OR hold.table_name IS NULL)
  `.simple();
  await sql`
    ALTER TABLE grids.preservation_holds
      DROP CONSTRAINT IF EXISTS preservation_holds_table_id_fkey,
      DROP CONSTRAINT IF EXISTS preservation_holds_scope_chk,
      ADD CONSTRAINT preservation_holds_scope_chk CHECK (
        (scope_type = 'base' AND table_id IS NULL AND table_short_id IS NULL AND table_name IS NULL)
        OR (scope_type = 'table' AND table_id IS NOT NULL AND table_short_id IS NOT NULL AND table_name IS NOT NULL)
      )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_preservation_holds_short_id
    ON grids.preservation_holds(short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_preservation_holds_active_base
    ON grids.preservation_holds(base_id, created_at DESC, id DESC) WHERE released_at IS NULL
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_preservation_holds_active_table
    ON grids.preservation_holds(base_id, table_id, created_at DESC, id DESC)
    WHERE released_at IS NULL AND scope_type = 'table'
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.controlled_destruction_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      short_id TEXT NOT NULL,
      base_id UUID NOT NULL REFERENCES grids.bases(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancel_requested', 'completed', 'partial', 'canceled', 'failed')),
      requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      requested_by_display_name TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      CONSTRAINT controlled_destruction_runs_short_id_format_chk CHECK (short_id ~ '^[A-Za-z0-9]{6}$')
    )
  `.simple();
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_grids_controlled_destruction_runs_short_id
    ON grids.controlled_destruction_runs(short_id)
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_controlled_destruction_runs_base
    ON grids.controlled_destruction_runs(base_id, requested_at DESC, id DESC)
  `.simple();
  await sql`
    CREATE TABLE IF NOT EXISTS grids.controlled_destruction_items (
      run_id UUID NOT NULL REFERENCES grids.controlled_destruction_runs(id) ON DELETE CASCADE,
      position INT NOT NULL,
      file_id UUID NOT NULL,
      file_short_id TEXT NOT NULL,
      table_id UUID NOT NULL,
      table_short_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'destroyed', 'skipped', 'failed')),
      message TEXT,
      processed_at TIMESTAMPTZ,
      PRIMARY KEY (run_id, position),
      UNIQUE (run_id, file_id)
    )
  `.simple();
  await sql`
    CREATE INDEX IF NOT EXISTS idx_grids_file_retention_candidates_base
    ON grids.file_retention_candidates(base_id, unreferenced_at, file_id)
  `.simple();
  console.log("  ✓ grids.retention_policies");
};

const assertWorkflowKernelReady = async (sql: SQL): Promise<void> => {
  /*
   * Public-reference migration and operational health read kernel tables that
   * app-core creates. Nothing declares an ordering between the app containers — they all
   * start at once and each migrates itself — so on an empty database Grids can
   * get here first, and Postgres would refuse the view with a bare "relation
   * does not exist" naming a table nobody would think to look for.
   *
   * Refusing loudly is right: the container restarts, and by then app-core has
   * been through. Creating the view without its workflow counters instead would
   * leave a Grids that reports its own health as fine while knowing nothing
   * about the runs it depends on.
   */
  const [kernel] = await sql<Array<{ run: string | null; version: string | null }>>`
    SELECT to_regclass('workflows.run')::text AS run,
           to_regclass('workflows.version')::text AS version
  `;
  if (!kernel?.run || !kernel.version) {
    throw new Error(
      "grids migration needs the workflows schema, which app-core has not migrated yet. " +
        "This is expected on a cold database: start app-core, or wait for this container's restart.",
    );
  }
};

const migrateOperationalHealth = async (sql: SQL): Promise<void> => {
  await assertWorkflowKernelReady(sql);

  await sql`
    CREATE OR REPLACE VIEW grids.operational_health AS
    WITH outbox AS (
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'dead')::int AS dead,
        COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status IN ('pending', 'failed')))), 0)::float AS oldest_active_age_seconds
      FROM grids.record_event_outbox
    ), workflow_runs AS (
      -- Runs live in the kernel, which serves every app, so everything below is
      -- narrowed to the Grids ones: this view reports on Grids alone.
      SELECT
        count(*) FILTER (WHERE state = 'queued')::int AS queued,
        count(*) FILTER (WHERE state = 'running')::int AS running,
        count(*) FILTER (WHERE state = 'waiting')::int AS waiting,
        count(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention,
        count(*) FILTER (WHERE state = 'needs_attention' AND finished_at >= now() - interval '24 hours')::int AS needs_attention_recent,
        count(*) FILTER (WHERE state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < now()))::int AS stale_running,
        COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE state = 'queued'))), 0)::float AS oldest_queued_age_seconds
      FROM workflows.run
      WHERE app_id = 'grids' AND mode = 'execute'
    ), effects AS (
      -- An effect is journaled on its own step row, and only from the moment it
      -- starts: there is no queue of intended effects to count, only ones in
      -- flight and ones that escaped without saying whether they landed.
      SELECT
        count(*) FILTER (WHERE s.effect_state = 'executing')::int AS executing,
        count(*) FILTER (WHERE s.effect_state = 'ambiguous')::int AS needs_attention,
        count(*) FILTER (
          WHERE s.effect_state = 'ambiguous' AND COALESCE(s.finished_at, s.effect_started_at) >= now() - interval '24 hours'
        )::int AS needs_attention_recent,
        COALESCE(
          EXTRACT(EPOCH FROM (now() - min(s.effect_started_at) FILTER (WHERE s.effect_state IN ('executing', 'ambiguous')))),
          0
        )::float AS oldest_active_age_seconds
      FROM workflows.step_outcome AS s
      JOIN workflows.run AS r ON r.id = s.run_id AND r.app_id = 'grids'
    ), federation AS (
      SELECT count(*) FILTER (WHERE status = 'degraded')::int AS degraded
      FROM grids.federated_table_revisions
    ), email_deliveries AS (
      SELECT count(*) FILTER (WHERE status = 'failed' AND created_at >= now() - interval '24 hours')::int AS failed_24h
      FROM grids.workflow_email_deliveries
    )
    SELECT
      -- Needs-attention is terminal and has no acknowledge path, so an unbounded
      -- count would pin the status to 'error' forever after a single incident.
      -- Recent ones raise 'error'; older unresolved ones stay visible as 'warn'
      -- and in the full counts below, which are the operator's worklist.
      CASE
        WHEN outbox.dead > 0 OR workflow_runs.needs_attention_recent > 0 OR workflow_runs.stale_running > 0
          OR effects.needs_attention_recent > 0
          THEN 'error'
        WHEN outbox.failed > 0 OR outbox.oldest_active_age_seconds > 60
          OR workflow_runs.oldest_queued_age_seconds > 60 OR effects.oldest_active_age_seconds > 300
          OR federation.degraded > 0 OR email_deliveries.failed_24h > 0
          OR workflow_runs.needs_attention > 0 OR effects.needs_attention > 0
          THEN 'warn'
        ELSE 'ok'
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
    FROM outbox, workflow_runs, effects, federation, email_deliveries
  `.simple();
  console.log("  ✓ grids.operational_health view");
};

export const migrate = async (sql: SQL = defaultSql): Promise<void> => {
  const connection = await sql.reserve();
  let locked = false;
  let transactionStarted = false;
  let migrationError: unknown;
  try {
    await connection`SELECT pg_advisory_lock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`;
    locked = true;
    await assertWorkflowKernelReady(connection);
    await assertNoDuplicateLiveTableNames(connection);
    await connection`BEGIN`.simple();
    transactionStarted = true;
    await migrateSchema(connection);
    await migrateSafeCastHelpers(connection);
    await migrateCoreRecords(connection);
    await migrateDurableHistory(connection);
    await migrateViews(connection);
    await migrateDocumentTemplates(connection);
    await migrateDocumentArtifacts(connection);
    await migrateNumberSeries(connection);
    await migrateRecordFinalization(connection);
    await finalizeDocumentArtifacts(connection);
    await migrateEvidenceExports(connection);
    await migrateRetentionPolicies(connection);
    await cleanupAlphaSchema(connection);
    await migrateFormsAndEvents(connection);
    await migrateCustomApps(connection);
    await removeLegacyDashboards(connection);
    await migrateGridsWorkflowTables(connection);
    await migratePublicIds(connection);
    await migrateCanonicalScalarStorage(connection);
    await removeObsoleteAccess(connection);
    await migrateRecordScanCodes(connection);
    await migrateOperationalHealth(connection);
    await connection`COMMIT`.simple();
    transactionStarted = false;
    console.log("  ✓ grids schema ready");
  } catch (error) {
    if (transactionStarted) await connection`ROLLBACK`.simple().catch(() => undefined);
    migrationError = error;
  } finally {
    if (locked) {
      await connection`SELECT pg_advisory_unlock(hashtextextended(${MIGRATION_LOCK_NAME}, 0))`.catch(() => undefined);
    }
    connection.release();
  }
  if (migrationError) throw migrationError;
};
