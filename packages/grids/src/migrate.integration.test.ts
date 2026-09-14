import { describe, expect, test } from "bun:test";
import { SQL, sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../core/src/migrate/core/workflows";
import { migrate } from "./migrate";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const schemaSnapshot = async (db: SQL) => db`
  SELECT 'column' AS kind, table_name || '.' || column_name AS name,
    jsonb_build_array(data_type, is_nullable, column_default)::text AS definition
  FROM information_schema.columns WHERE table_schema = 'grids'
  UNION ALL SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
    FROM pg_constraint WHERE connamespace = 'grids'::regnamespace
  UNION ALL SELECT 'index', indexname, indexdef FROM pg_indexes WHERE schemaname = 'grids'
  UNION ALL SELECT 'function', proname, pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace = 'grids'::regnamespace
  UNION ALL SELECT 'trigger', tgname, pg_get_triggerdef(oid) FROM pg_trigger
    WHERE tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'grids'::regnamespace) AND NOT tgisinternal
  UNION ALL SELECT 'view', viewname, definition FROM pg_views WHERE schemaname = 'grids'
  ORDER BY 1, 2, 3
`;

const withIsolatedDatabase = async (run: (database: SQL) => Promise<void>) => {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required for migration integration tests");
  const databaseName = `grids_migrate_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const databaseUrl = new URL(sourceUrl);
  databaseUrl.pathname = `/${databaseName}`;

  await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
  console.info(`[grids:migration-test] Isolated database: ${databaseName}`);
  const database = new SQL(databaseUrl);
  try {
    await database`CREATE SCHEMA auth`.simple();
    await database`CREATE TABLE auth.users (id UUID PRIMARY KEY)`.simple();
    await database`CREATE TABLE auth.access (id UUID PRIMARY KEY)`.simple();
    await database`CREATE TABLE auth.service_accounts (id UUID PRIMARY KEY)`.simple();
    await run(database);
  } finally {
    await database.close({ timeout: 5 });
    await sql.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
};

describe("grids schema migration", () => {
  postgresTest(
    "defines table-scoped Direct and Four-eyes Finalization storage",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const columns = await database<Array<{ name: string; nullable: string; defaultValue: string | null }>>`
          SELECT column_name AS name, is_nullable AS nullable, column_default AS "defaultValue"
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'table_finalization_activations'
            AND column_name IN ('mode', 'approver_group_id', 'policy_revision')
          ORDER BY column_name
        `;
        expect(columns).toEqual([
          { name: "approver_group_id", nullable: "YES", defaultValue: null },
          { name: "mode", nullable: "NO", defaultValue: "'direct'::text" },
          { name: "policy_revision", nullable: "NO", defaultValue: "1" },
        ]);
        const [tablePolicyRevision] = await database<Array<{ nullable: string; defaultValue: string | null }>>`
          SELECT is_nullable AS nullable, column_default AS "defaultValue"
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'tables' AND column_name = 'finalization_policy_revision'
        `;
        expect(tablePolicyRevision).toEqual({ nullable: "NO", defaultValue: "0" });
        const [policyConstraint] = await database<Array<{ definition: string }>>`
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = 'grids.table_finalization_activations'::regclass
            AND conname = 'table_finalization_activations_policy_chk'
        `;
        expect(policyConstraint?.definition).toContain("mode = 'four_eyes'::text");
        const [pendingIndex] = await database<Array<{ definition: string }>>`
          SELECT indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = 'grids' AND indexname = 'idx_grids_record_finalization_requests_pending'
        `;
        expect(pendingIndex?.definition).toContain("WHERE (status = 'pending'::text)");
        const [pendingTableIndex] = await database<Array<{ definition: string }>>`
          SELECT indexdef AS definition
          FROM pg_indexes
          WHERE schemaname = 'grids' AND indexname = 'idx_grids_record_finalization_requests_pending_table'
        `;
        expect(pendingTableIndex?.definition).toContain("(table_id, record_id, record_version, policy_revision)");
        expect(pendingTableIndex?.definition).toContain("WHERE (status = 'pending'::text)");
        const [requestPublicId] = await database<Array<{ nullable: string; indexReady: boolean }>>`
          SELECT column_info.is_nullable AS nullable,
            EXISTS (
              SELECT 1 FROM pg_indexes
              WHERE schemaname = 'grids'
                AND indexname = 'idx_grids_record_finalization_requests_short_id'
                AND indexdef LIKE 'CREATE UNIQUE INDEX%'
            ) AS "indexReady"
          FROM information_schema.columns column_info
          WHERE column_info.table_schema = 'grids'
            AND column_info.table_name = 'record_finalization_requests'
            AND column_info.column_name = 'short_id'
        `;
        expect(requestPublicId).toEqual({ nullable: "NO", indexReady: true });
        const workflowConstraints = await database<Array<{ name: string; definition: string }>>`
          SELECT conname AS name, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conname IN ('workflow_launchers_kind_check', 'workflow_run_profile_launcher_kind_check', 'workflow_run_profile_channel_check')
          ORDER BY conname
        `;
        expect(workflowConstraints).toHaveLength(3);
        for (const constraint of workflowConstraints) expect(constraint.definition).toContain("'record'::text");
      });
    },
    120_000,
  );

  postgresTest(
    "defines a non-null allow-all mutation policy default",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const [mutationPolicyColumn] = await database<Array<{ nullable: string; defaultValue: string | null }>>`
          SELECT is_nullable AS nullable, column_default AS "defaultValue"
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'tables' AND column_name = 'mutation_policy'
        `;
        expect(mutationPolicyColumn?.nullable).toBe("NO");
        expect(mutationPolicyColumn?.defaultValue).toContain('"mode": "all"');
      });
    },
    30_000,
  );

  postgresTest(
    "defines scoped preservation hold storage",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const columns = await database<Array<{ name: string; nullable: string; defaultValue: string | null }>>`
          SELECT column_name AS name, is_nullable AS nullable, column_default AS "defaultValue"
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'preservation_holds'
            AND column_name IN ('scope_type', 'table_id', 'table_name', 'table_short_id')
          ORDER BY column_name
        `;
        expect(columns).toEqual([
          { name: "scope_type", nullable: "NO", defaultValue: "'base'::text" },
          { name: "table_id", nullable: "YES", defaultValue: null },
          { name: "table_name", nullable: "YES", defaultValue: null },
          { name: "table_short_id", nullable: "YES", defaultValue: null },
        ]);
        const [constraint] = await database<Array<{ definition: string }>>`
          SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
          WHERE conrelid = 'grids.preservation_holds'::regclass AND conname = 'preservation_holds_scope_chk'
        `;
        expect(constraint?.definition).toContain("scope_type = 'table'::text");
        expect(constraint?.definition).toContain("table_short_id IS NOT NULL");
        const [tableForeignKey] = await database<Array<{ name: string }>>`
          SELECT conname AS name FROM pg_constraint
          WHERE conrelid = 'grids.preservation_holds'::regclass AND contype = 'f'
            AND pg_get_constraintdef(oid) LIKE '%table_id%'
        `;
        expect(tableForeignKey).toBeUndefined();
      });
    },
    30_000,
  );

  postgresTest(
    "says which container has not run yet when the kernel schema is missing",
    async () => {
      await withIsolatedDatabase(async (database) => {
        // Nothing declares an ordering between the app containers, so on an
        // empty database Grids can migrate before app-core. Postgres would
        // refuse the health view naming a table nobody would think to look for.
        let migrationError: unknown;
        try {
          await migrate(database);
        } catch (error) {
          migrationError = error;
        }
        expect((migrationError as Error).message).toContain("Start Core before Grids");
      });
    },
    30_000,
  );

  postgresTest(
    "rejects an incomplete kernel before creating Grids objects",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await database`CREATE SCHEMA workflows`.simple();
        await database`CREATE TABLE workflows.run (id UUID PRIMARY KEY)`.simple();
        await database`CREATE TABLE workflows.version (id UUID PRIMARY KEY)`.simple();
        await expect(migrate(database)).rejects.toThrow("Start Core before Grids");
        const [row] = await database`SELECT to_regnamespace('grids') AS schema`;
        expect(row.schema).toBeNull();
      });
    },
    30_000,
  );

  postgresTest(
    "serializes concurrent setup and remains idempotent",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await Promise.all([migrate(database), migrate(database)]);
        const schemaBefore = await schemaSnapshot(database);
        await migrate(database);
        expect(await schemaSnapshot(database)).toEqual(schemaBefore);

        const [row] = await database<Array<{ tableCount: number }>>`
          SELECT count(*)::int AS "tableCount"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_type = 'BASE TABLE'
        `;
        // Durable History, frozen workflow query data, external Record identity, Form retry receipts and the evidence lifecycle
        // add explicit owners without replacing the lightweight live rows.
        expect(row?.tableCount).toBe(56);
        const historyTables = await database<Array<{ tableName: string }>>`
          SELECT table_name AS "tableName"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_name IN ('durable_history_activations', 'record_revisions', 'table_schema_revisions')
          ORDER BY table_name
        `;
        expect(historyTables.map((item) => item.tableName)).toEqual([
          "durable_history_activations",
          "record_revisions",
          "table_schema_revisions",
        ]);
        const documentIssuanceTables = await database<Array<{ tableName: string }>>`
          SELECT table_name AS "tableName"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_name IN ('document_artifacts', 'document_issuances', 'document_profile_counters')
          ORDER BY table_name
        `;
        expect(documentIssuanceTables.map((item) => item.tableName)).toEqual([
          "document_artifacts",
          "document_issuances",
          "document_profile_counters",
        ]);
        const immutableTriggers = await database<Array<{ tableName: string }>>`
          SELECT DISTINCT event_object_table AS "tableName"
          FROM information_schema.triggers
          WHERE trigger_schema = 'grids' AND trigger_name IN (
            'documents_immutable',
            'document_artifacts_immutable',
            'document_issuances_guard'
          )
          ORDER BY event_object_table
        `;
        expect(immutableTriggers.map((item) => item.tableName)).toEqual(["document_artifacts", "document_issuances", "documents"]);
        const constraints = await database<Array<{ name: string }>>`
          SELECT conname AS name
          FROM pg_constraint
          WHERE conrelid = 'grids.record_external_bindings'::regclass
            AND conname = 'record_external_bindings_record_table_fkey'
        `;
        expect(constraints).toEqual([{ name: "record_external_bindings_record_table_fkey" }]);
        const receiptIndexes = await database<Array<{ name: string }>>`
          SELECT indexname AS name
          FROM pg_indexes
          WHERE schemaname = 'grids'
            AND indexname IN (
              'uq_grids_record_external_operations_scope_key',
              'idx_grids_record_external_operations_created'
            )
          ORDER BY indexname
        `;
        expect(receiptIndexes.map((item) => item.name)).toEqual([
          "idx_grids_record_external_operations_created",
          "uq_grids_record_external_operations_scope_key",
        ]);
        const changeFeedIndexes = await database<Array<{ name: string }>>`
          SELECT indexname AS name
          FROM pg_indexes
          WHERE schemaname = 'grids'
            AND indexname IN (
              'idx_grids_record_event_outbox_feed_base',
              'idx_grids_record_event_outbox_feed_table'
            )
          ORDER BY indexname
        `;
        expect(changeFeedIndexes.map((item) => item.name)).toEqual([
          "idx_grids_record_event_outbox_feed_base",
          "idx_grids_record_event_outbox_feed_table",
        ]);
        const [cast] = await database<Array<{ value: number | string }>>`SELECT grids.canonical_numeric('12.5') AS value`;
        expect(String(cast?.value)).toBe("12.5");
        const [invalidFormulaCoercion] = await database<Array<{ value: number | null }>>`
          SELECT grids.try_numeric('not a number') AS value
        `;
        expect(invalidFormulaCoercion?.value).toBeNull();
        const [powers] = await database<Array<{ overflow: null; invalid: null; missing: null; valid: string }>>`
          SELECT grids.try_numeric_power(2, 2147483647) AS overflow,
            grids.try_numeric_power(-1, 0.5) AS invalid,
            grids.try_numeric_power(NULL, 2) AS missing,
            trim_scale(grids.try_numeric_power(1.01, 37))::text AS valid
        `;
        expect(powers).toEqual({ overflow: null, invalid: null, missing: null, valid: "1.4450764714274963" });
        const functions = await database<Array<{ name: string; parallel: string; volatility: string; language: string }>>`
          SELECT p.proname AS name, p.proparallel AS parallel, p.provolatile AS volatility, l.lanname AS language
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'grids'
            AND p.proname IN ('canonical_boolean', 'canonical_date', 'canonical_numeric', 'canonical_timestamptz')
          ORDER BY p.proname
        `;
        expect(functions).toEqual([
          { name: "canonical_boolean", parallel: "s", volatility: "i", language: "sql" },
          { name: "canonical_date", parallel: "s", volatility: "i", language: "sql" },
          { name: "canonical_numeric", parallel: "s", volatility: "i", language: "sql" },
          { name: "canonical_timestamptz", parallel: "s", volatility: "i", language: "sql" },
        ]);

        const indexes = await database<Array<{ indexName: string }>>`
          SELECT indexname AS "indexName"
          FROM pg_indexes
          WHERE schemaname = 'grids'
            AND indexname IN (
              'idx_grids_tables_live_name',
              'idx_grids_fields_live_name',
              'idx_grids_views_live_name'
            )
          ORDER BY indexname
        `;
        expect(indexes.map((index) => index.indexName)).toEqual([
          "idx_grids_fields_live_name",
          "idx_grids_tables_live_name",
          "idx_grids_views_live_name",
        ]);
        const obsoleteTables = await database<Array<{ tableName: string }>>`
          SELECT table_name AS "tableName"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_name IN ('table_access', 'view_access', 'form_access', 'document_template_access', 'workflow_access')
          ORDER BY table_name
        `;
        expect(obsoleteTables).toEqual([]);
        const [recordScope] = await database<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'grids' AND table_name = 'base_access' AND column_name = 'record_scope'
          ) AS exists
        `;
        expect(recordScope?.exists).toBe(false);

        const accessIdIndexes = await database<Array<{ indexName: string }>>`
          SELECT indexname AS "indexName"
          FROM pg_indexes
          WHERE schemaname = 'grids'
            AND indexname IN (
              'idx_grids_base_access_access',
              'idx_grids_custom_app_access_access'
            )
          ORDER BY indexname
        `;
        expect(accessIdIndexes.map((index) => index.indexName)).toEqual([
          "idx_grids_base_access_access",
          "idx_grids_custom_app_access_access",
        ]);
        const [health] = await database<Array<{ status: string; outboxPending: number }>>`
          SELECT status, outbox_pending::int AS "outboxPending"
          FROM grids.operational_health
        `;
        expect(health).toEqual({ status: "ok", outboxPending: 0 });
      });
    },
    // Three full migrations (two concurrent) plus isolated database setup and
    // cleanup need the same budget as the other full migration regressions.
    120_000,
  );

  postgresTest(
    "defines one bound Document, artifact, number, and issuance invariant",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);

        const artifactColumns = await database<Array<{ name: string }>>`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'document_artifacts'
          ORDER BY column_name
        `;
        expect(artifactColumns.map((column) => column.name)).toEqual(["artifact_key", "created_at", "document_id", "file_id"]);
        const documentColumns = await database<Array<{ name: string }>>`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'documents'
            AND (column_name LIKE 'artifact_%' OR column_name IN ('operation_key_hash', 'request_hash'))
        `;
        expect(documentColumns).toEqual([]);
        const documentLinkColumns = await database<Array<{ name: string }>>`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'document_links'
          ORDER BY column_name
        `;
        expect(documentLinkColumns.map((column) => column.name)).toEqual([
          "access_count",
          "base_id",
          "comment",
          "created_at",
          "created_by",
          "document_id",
          "expires_at",
          "id",
          "last_accessed_at",
          "record_id",
          "revoked_at",
          "revoked_by",
          "short_id",
          "table_id",
          "token_hash",
        ]);
        const documentShortIdIndexes = await database<Array<{ name: string }>>`
          SELECT indexname AS name
          FROM pg_indexes
          WHERE schemaname = 'grids'
            AND indexname IN (
              'idx_grids_document_templates_short_id',
              'idx_grids_record_snapshots_short_id',
              'idx_grids_documents_short_id',
              'idx_grids_document_links_short_id'
            )
          ORDER BY indexname
        `;
        expect(documentShortIdIndexes.map((index) => index.name)).toEqual([
          "idx_grids_document_links_short_id",
          "idx_grids_document_templates_short_id",
          "idx_grids_documents_short_id",
          "idx_grids_record_snapshots_short_id",
        ]);
        const profileCounterColumns = await database<Array<{ name: string }>>`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'document_profile_counters'
          ORDER BY ordinal_position
        `;
        expect(profileCounterColumns.map((column) => column.name)).toEqual(["base_id", "profile_id", "next_value"]);
        const removedDocumentColumns = await database<Array<{ name: string }>>`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'documents'
            AND column_name IN ('source', 'source_revision', 'relationship_kind', 'predecessor_id')
        `;
        expect(removedDocumentColumns).toEqual([]);

        const baseA = uuid();
        const baseB = uuid();
        const tableA = uuid();
        const tableB = uuid();
        const recordA = uuid();
        const recordB = uuid();
        const templateA = uuid();
        const templateB = uuid();
        const snapshotA = uuid();
        const snapshotB = uuid();
        const documentA = uuid();
        const documentB = uuid();
        const documentAShortId = shortId("F");
        const documentBShortId = shortId("G");
        const mismatchedDocumentShortId = shortId("H");
        const fileA = uuid();
        const ordinaryFile = uuid();
        await database`
          INSERT INTO grids.bases (id, short_id, name) VALUES
            (${baseA}::uuid, ${shortId("A")}, 'A'),
            (${baseB}::uuid, ${shortId("B")}, 'B')
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name) VALUES
            (${tableA}::uuid, ${shortId("T")}, ${baseA}::uuid, 'A'),
            (${tableB}::uuid, ${shortId("U")}, ${baseB}::uuid, 'B')
        `;
        await database`
          INSERT INTO grids.records (id, short_id, table_id) VALUES
            (${recordA}::uuid, ${shortId("R")}, ${tableA}::uuid),
            (${recordB}::uuid, ${shortId("S")}, ${tableB}::uuid)
        `;
        await database`
          INSERT INTO grids.document_templates (
            id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template
          ) VALUES
            (${templateA}::uuid, ${shortId("D")}, ${tableA}::uuid, 'A', 'from table A', 'html', '<p>A</p>', 'INV-{{ series.value }}', '{{ document.number }}.pdf'),
            (${templateB}::uuid, ${shortId("E")}, ${tableB}::uuid, 'B', 'from table B', 'html', '<p>B</p>', 'INV-{{ series.value }}', '{{ document.number }}.pdf')
        `;
        await database`
          INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph) VALUES
            (${snapshotA}::uuid, ${shortId("N")}, ${baseA}::uuid, ${tableA}::uuid, ${recordA}::uuid, '{}'::jsonb, '{}'::jsonb),
            (${snapshotB}::uuid, ${shortId("O")}, ${baseB}::uuid, ${tableB}::uuid, ${recordB}::uuid, '{}'::jsonb, '{}'::jsonb)
        `;
        await database`
          INSERT INTO grids.documents (primary_artifact_key,
            id, short_id, template_id, snapshot_id, base_id, table_id, record_id, document_number, filename,
            template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor
          ) VALUES
            ('pdf', ${documentA}::uuid, ${documentAShortId}, ${templateA}::uuid, ${snapshotA}::uuid, ${baseA}::uuid, ${tableA}::uuid,
              ${recordA}::uuid, 'INV-1', 'INV-1.pdf', '{}'::jsonb, '{}'::jsonb, 'html', 'html-v1', ${"a".repeat(64)}, '{"kind":"system"}'::jsonb),
            ('pdf', ${documentB}::uuid, ${documentBShortId}, ${templateB}::uuid, ${snapshotB}::uuid, ${baseB}::uuid, ${tableB}::uuid,
              ${recordB}::uuid, 'INV-1', 'INV-1.pdf', '{}'::jsonb, '{}'::jsonb, 'html', 'html-v1', ${"b".repeat(64)}, '{"kind":"system"}'::jsonb)
        `;
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.documents (primary_artifact_key,
                id, short_id, template_id, snapshot_id, base_id, table_id, record_id, document_number, filename,
                template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor
              ) VALUES ('pdf',
                ${uuid()}::uuid, ${shortId("H")}, ${templateA}::uuid, ${snapshotA}::uuid, ${baseA}::uuid, ${tableA}::uuid,
                ${recordA}::uuid, 'INV-1', 'duplicate.pdf', '{}'::jsonb, '{}'::jsonb, 'html', 'html-v1', ${"c".repeat(64)}, '{"kind":"system"}'::jsonb
              )
            `;
          })(),
        ).rejects.toThrow("documents_base_id_document_number_key");
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.documents (primary_artifact_key,
                id, short_id, template_id, workflow_run_id, snapshot_id, base_id, table_id, record_id, document_number, filename,
                template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor
              ) VALUES ('pdf',
                ${uuid()}::uuid, ${shortId("I")}, ${templateA}::uuid, ${uuid()}::uuid, ${snapshotA}::uuid, ${baseA}::uuid,
                ${tableA}::uuid, ${recordA}::uuid, 'INV-2', 'INV-2.pdf', '{}'::jsonb, '{}'::jsonb, 'html', 'html-v1', ${"d".repeat(64)}, '{"kind":"system"}'::jsonb
              )
            `;
          })(),
        ).rejects.toThrow("documents_workflow_pair_chk");
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_templates (
                id, short_id, table_id, name, source, renderer_kind, profile_id, profile_version, profile_input_template,
                number_template
              ) VALUES (
                ${uuid()}::uuid, ${shortId("P")}, ${tableA}::uuid, 'Invalid profile', 'from table A', 'profile',
                'test.profile', 1, '{}', 'ignored'
              )
            `;
          })(),
        ).rejects.toThrow("document_templates_renderer_chk");
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_templates (
                id, short_id, table_id, name, source, renderer_kind, html, header_html, number_template, filename_template
              ) VALUES (
                ${uuid()}::uuid, ${shortId("V")}, ${tableA}::uuid, 'Empty header', 'from table A', 'html',
                '<p>A</p>', '', 'INV-{{ series.value }}', '{{ document.number }}.pdf'
              )
            `;
          })(),
        ).rejects.toThrow("document_templates_header_html_length_chk");
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_templates (
                id, short_id, table_id, name, source, renderer_kind, html, footer_html, number_template, filename_template
              ) VALUES (
                ${uuid()}::uuid, ${shortId("W")}, ${tableA}::uuid, 'Empty footer', 'from table A', 'html',
                '<p>A</p>', '', 'INV-{{ series.value }}', '{{ document.number }}.pdf'
              )
            `;
          })(),
        ).rejects.toThrow("document_templates_footer_html_length_chk");
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_templates (
                id, short_id, table_id, name, source, renderer_kind, html, page_css, number_template, filename_template
              ) VALUES (
                ${uuid()}::uuid, ${shortId("X")}, ${tableA}::uuid, 'Empty CSS', 'from table A', 'html',
                '<p>A</p>', '', 'INV-{{ series.value }}', '{{ document.number }}.pdf'
              )
            `;
          })(),
        ).rejects.toThrow("document_templates_page_css_length_chk");

        await database`
          INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
          VALUES (${fileA}::uuid, ${shortId("J")}, 'INV-1.pdf', 'application/pdf', 4, ${"e".repeat(64)}, ${new TextEncoder().encode("%PDF")})
        `;
        await database`
          INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
          VALUES (${ordinaryFile}::uuid, ${shortId("K")}, 'draft.txt', 'text/plain', 5, ${"3".repeat(64)}, ${new TextEncoder().encode("draft")})
        `;
        await database`
          INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
          VALUES (
            ${fileA}::uuid, 'document_artifact', ${documentA}::uuid,
            ${baseA}::uuid, ${tableA}::uuid, ${recordA}::uuid
          )
        `;
        await database`
          INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
          VALUES (${documentA}::uuid, 'pdf', ${fileA}::uuid)
        `;
        await expect(
          (async () => {
            await database`
              UPDATE grids.file_protected_references
              SET owner_id = ${uuid()}::uuid
              WHERE file_id = ${fileA}::uuid AND owner_kind = 'document_artifact'
            `;
          })(),
        ).rejects.toThrow("Document artifact protection is immutable");
        await expect(
          (async () => {
            await database`
              DELETE FROM grids.file_protected_references
              WHERE file_id = ${fileA}::uuid AND owner_kind = 'document_artifact'
            `;
          })(),
        ).rejects.toThrow("Document artifact protection is immutable");
        const revisionOwnerId = uuid();
        await database`
          INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
          VALUES (
            ${ordinaryFile}::uuid, 'record_revision', ${revisionOwnerId}::uuid,
            ${baseA}::uuid, ${tableA}::uuid, ${recordA}::uuid
          )
        `;
        await expect(
          (async () => {
            await database`
              UPDATE grids.file_protected_references
              SET owner_kind = 'document_artifact'
              WHERE file_id = ${ordinaryFile}::uuid
                AND owner_kind = 'record_revision'
                AND owner_id = ${revisionOwnerId}::uuid
            `;
          })(),
        ).rejects.toThrow("Document artifact protection is immutable");
        await database`
          DELETE FROM grids.file_protected_references
          WHERE file_id = ${ordinaryFile}::uuid AND owner_kind = 'record_revision' AND owner_id = ${revisionOwnerId}::uuid
        `;
        const [releasedRevisionProtection] = await database<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM grids.file_protected_references
            WHERE file_id = ${ordinaryFile}::uuid AND owner_kind = 'record_revision'
          ) AS exists
        `;
        expect(releasedRevisionProtection?.exists).toBe(false);
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_issuances (
                base_id, document_short_id, operation_key_hash, request_hash, frozen_request
              ) VALUES (
                ${baseA}::uuid, 'invalid', ${"8".repeat(64)}, ${"9".repeat(64)}, '{}'::jsonb
              )
            `;
          })(),
        ).rejects.toThrow("document_issuances_short_id_format_chk");
        await database`
          INSERT INTO grids.document_issuances (base_id, document_short_id, operation_key_hash, request_hash, frozen_request)
          VALUES (${baseA}::uuid, ${documentAShortId}, ${"f".repeat(64)}, ${"1".repeat(64)}, '{"record":"A"}'::jsonb)
        `;
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_issuances (
                base_id, document_short_id, operation_key_hash, request_hash, frozen_request
              ) VALUES (
                ${baseB}::uuid, ${documentAShortId}, ${"6".repeat(64)}, ${"7".repeat(64)}, '{}'::jsonb
              )
            `;
          })(),
        ).rejects.toThrow("document_issuances_document_short_id_key");
        await database`
          INSERT INTO grids.document_issuances (base_id, document_short_id, operation_key_hash, request_hash, frozen_request)
          VALUES (${baseB}::uuid, ${mismatchedDocumentShortId}, ${"6".repeat(64)}, ${"7".repeat(64)}, '{}'::jsonb)
        `;
        await expect(
          (async () => {
            await database`
              UPDATE grids.document_issuances
              SET document_id = ${documentB}::uuid, completed_at = now(), frozen_request = NULL
              WHERE base_id = ${baseB}::uuid AND operation_key_hash = ${"6".repeat(64)}
            `;
          })(),
        ).rejects.toThrow("document_issuances_document_base_fkey");
        await database`
          UPDATE grids.document_issuances
          SET document_id = ${documentA}::uuid, completed_at = now(), frozen_request = NULL
          WHERE base_id = ${baseA}::uuid AND operation_key_hash = ${"f".repeat(64)}
        `;
        const [completedIssuance] = await database<Array<{ documentShortId: string }>>`
          SELECT document_short_id AS "documentShortId"
          FROM grids.document_issuances
          WHERE base_id = ${baseA}::uuid AND operation_key_hash = ${"f".repeat(64)}
        `;
        expect(completedIssuance?.documentShortId).toBe(documentAShortId);
        await expect(
          (async () => {
            await database`
              UPDATE grids.document_issuances SET request_hash = ${"2".repeat(64)}
              WHERE base_id = ${baseA}::uuid AND operation_key_hash = ${"f".repeat(64)}
            `;
          })(),
        ).rejects.toThrow("immutable");
        await expect(
          (async () => {
            await database`DELETE FROM grids.document_artifacts WHERE document_id = ${documentA}::uuid`;
          })(),
        ).rejects.toThrow("immutable");
        await expect(
          (async () => {
            await database`DELETE FROM grids.documents WHERE id = ${documentA}::uuid`;
          })(),
        ).rejects.toThrow("immutable");
        await expect(
          (async () => {
            await database`UPDATE grids.files SET bytes = ${new TextEncoder().encode("evil")} WHERE id = ${fileA}::uuid`;
          })(),
        ).rejects.toThrow("immutable");
        await database`
          UPDATE grids.files
          SET filename = 'final.txt', size_bytes = 5, sha256 = ${"4".repeat(64)}, bytes = ${new TextEncoder().encode("final")}
          WHERE id = ${ordinaryFile}::uuid
        `;
        const [updatedOrdinaryFile] = await database<Array<{ filename: string }>>`
          SELECT filename FROM grids.files WHERE id = ${ordinaryFile}::uuid
        `;
        expect(updatedOrdinaryFile?.filename).toBe("final.txt");
        await database`
          UPDATE grids.document_templates
          SET renderer_kind = 'profile',
              html = NULL,
              number_template = NULL,
              filename_template = NULL,
              profile_id = 'test.invoice',
              profile_version = 1,
              profile_input_template = '{}'
          WHERE id = ${templateA}::uuid
        `;
        const [unchangedDocument] = await database<Array<{ rendererKind: string; templateSnapshot: Record<string, unknown> }>>`
          SELECT renderer_kind AS "rendererKind", template_snapshot AS "templateSnapshot"
          FROM grids.documents
          WHERE id = ${documentA}::uuid
        `;
        expect(unchangedDocument).toEqual({ rendererKind: "html", templateSnapshot: {} });
        const [currentConstraint] = await database`
          SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_renderer_chk'
        `;
        const documentsBefore = await database`SELECT * FROM grids.documents ORDER BY id`;
        const artifactsBefore = await database`SELECT * FROM grids.document_artifacts ORDER BY document_id, artifact_key`;
        const filesBefore = await database`SELECT * FROM grids.files ORDER BY id`;

        await migrate(database);
        await migrate(database);
        expect(await database`SELECT * FROM grids.documents ORDER BY id`).toEqual(documentsBefore);
        expect(await database`SELECT * FROM grids.document_artifacts ORDER BY document_id, artifact_key`).toEqual(artifactsBefore);
        expect(await database`SELECT * FROM grids.files ORDER BY id`).toEqual(filesBefore);
        const [primaryColumn] = await database`
          SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'documents' AND column_name = 'primary_artifact_key'
        `;
        expect(primaryColumn).toEqual({ is_nullable: "NO", column_default: null });
        const [upgradedConstraint] = await database`
          SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = 'grids.documents'::regclass AND conname = 'documents_renderer_chk'
        `;
        expect(upgradedConstraint).toEqual(currentConstraint);
        await expect(
          (async () => {
            await database`UPDATE grids.documents SET filename = 'changed.pdf' WHERE id = ${documentA}::uuid`;
          })(),
        ).rejects.toThrow("immutable");
      });
    },
    30_000,
  );

  postgresTest(
    "rejects external bindings whose Record belongs to another Table",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableA = uuid();
        const tableB = uuid();
        const recordId = uuid();
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("b")}, 'External invariant')`;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableA}::uuid, ${shortId("a")}, ${baseId}::uuid, 'A'), (${tableB}::uuid, ${shortId("t")}, ${baseId}::uuid, 'B')
        `;
        await database`INSERT INTO grids.records (id, short_id, table_id) VALUES (${recordId}::uuid, ${shortId("r")}, ${tableB}::uuid)`;
        let mismatchRejected = false;
        try {
          await database.begin(
            (transaction) => transaction`
            INSERT INTO grids.record_external_bindings (
              provider, provider_account, resource_kind, external_id, table_id, record_id
            ) VALUES ('test', 'main', 'row', 'mismatch', ${tableA}::uuid, ${recordId}::uuid)
          `,
          );
        } catch {
          mismatchRejected = true;
        }
        expect(mismatchRejected).toBe(true);
      });
    },
    30_000,
  );

  postgresTest(
    "enforces combined table revision, source, mapping, and read-only invariants",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const storedTableId = uuid();
        const combinedTableId = uuid();
        const storedFieldId = uuid();
        const combinedFieldId = uuid();
        const revisionId = uuid();
        await database`
          INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${shortId("B")}, 'Combined schema invariants')
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, kind, name, disable_direct_insert)
          VALUES
            (${storedTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'stored', 'Stored', FALSE),
            (${combinedTableId}::uuid, ${shortId("C")}, ${baseId}::uuid, 'federated', 'Combined', TRUE)
        `;
        await database`
          INSERT INTO grids.fields (id, short_id, table_id, name, type)
          VALUES
            (${storedFieldId}::uuid, ${shortId("F")}, ${storedTableId}::uuid, 'Stored field', 'text'),
            (${combinedFieldId}::uuid, ${shortId("F")}, ${combinedTableId}::uuid, 'Canonical field', 'text')
        `;
        await database`
          INSERT INTO grids.federated_table_revisions (id, table_id, revision, status)
          VALUES (${revisionId}::uuid, ${combinedTableId}::uuid, 1, 'draft')
        `;
        await database`
          INSERT INTO grids.federated_table_sources (revision_id, source_table_id)
          VALUES (${revisionId}::uuid, ${storedTableId}::uuid)
        `;
        await database`
          INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id)
          VALUES (${revisionId}::uuid, ${combinedFieldId}::uuid, ${storedTableId}::uuid, ${storedFieldId}::uuid)
        `;

        await expect(
          (async () => {
            await database`
            INSERT INTO grids.federated_table_revisions (table_id, revision)
            VALUES (${storedTableId}::uuid, 1)
            `;
          })(),
        ).rejects.toThrow("revision target must be a combined table");
        await expect(
          (async () => {
            await database`
            INSERT INTO grids.federated_table_sources (revision_id, source_table_id)
            VALUES (${revisionId}::uuid, ${combinedTableId}::uuid)
            `;
          })(),
        ).rejects.toThrow("source must be a distinct stored table");
        await expect(
          (async () => {
            await database`
            INSERT INTO grids.federated_field_mappings (revision_id, target_field_id, source_table_id, source_field_id)
            VALUES (${revisionId}::uuid, ${storedFieldId}::uuid, ${storedTableId}::uuid, ${storedFieldId}::uuid)
            `;
          })(),
        ).rejects.toThrow("mapping fields must belong to their declared tables");
        await expect(
          (async () => {
            await database`
            UPDATE grids.tables
            SET disable_direct_insert = FALSE
            WHERE id = ${combinedTableId}::uuid
            `;
          })(),
        ).rejects.toThrow("tables_federated_read_only_chk");
      });
    },
    30_000,
  );

  postgresTest(
    "derives a view base id and enforces base-wide live names",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const firstTableId = uuid();
        const secondTableId = uuid();

        await database`
          INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${shortId("B")}, 'View names')
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES
            (${firstTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'First'),
            (${secondTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Second')
        `;
        const [view] = await database<Array<{ baseId: string }>>`
          INSERT INTO grids.views (short_id, table_id, name, source)
          VALUES (${shortId("V")}, ${firstTableId}::uuid, 'Open items', 'from table First')
          RETURNING base_id::text AS "baseId"
        `;
        expect(view?.baseId).toBe(baseId);

        let conflict: unknown;
        try {
          await database`
            INSERT INTO grids.views (short_id, table_id, name, source)
            VALUES (${shortId("V")}, ${secondTableId}::uuid, ' open ITEMS ', 'from table Second')
          `;
        } catch (error) {
          conflict = error;
        }
        const pgError = conflict as { errno?: string; constraint?: string };
        expect(pgError.errno).toBe("23505");
        expect(pgError.constraint).toBe("idx_grids_views_live_name");
      });
    },
    30_000,
  );
});
