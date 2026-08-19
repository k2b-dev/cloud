import { describe, expect, test } from "bun:test";
import { SQL, sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../core/src/migrate/core/workflows";
import { gridsPublicIdsReady, migrate } from "./migrate";
import { insertTestWorkflow, insertTestWorkflowRun } from "./service/workflow-test-fixture";
import { GRIDS_WORKFLOW_SCHEMA_VERSION } from "./workflows/migrate";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const allowArtifactlessAlphaDocumentRuns = async (database: SQL): Promise<void> => {
  await database`
    ALTER TABLE grids.document_runs DROP CONSTRAINT IF EXISTS document_runs_artifact_complete_chk;
    ALTER TABLE grids.document_runs ALTER COLUMN artifact_file_id DROP NOT NULL;
    ALTER TABLE grids.document_runs ALTER COLUMN artifact_mime_type DROP NOT NULL;
    ALTER TABLE grids.document_runs ALTER COLUMN artifact_size_bytes DROP NOT NULL;
    ALTER TABLE grids.document_runs ALTER COLUMN artifact_sha256 DROP NOT NULL;
    ALTER TABLE grids.document_runs ALTER COLUMN renderer_version DROP NOT NULL;
    ALTER TABLE grids.document_runs ALTER COLUMN template_revision DROP NOT NULL;
  `.simple();
};

const withIsolatedDatabase = async (run: (database: SQL) => Promise<void>) => {
  const sourceUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("DATABASE_URL is required for migration integration tests");
  const databaseName = `grids_migrate_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const databaseUrl = new URL(sourceUrl);
  databaseUrl.pathname = `/${databaseName}`;

  await sql.unsafe(`CREATE DATABASE "${databaseName}"`);
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
    "upgrades existing Base holds without changing their lifecycle",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        await database`DROP INDEX grids.idx_grids_preservation_holds_active_table`.simple();
        await database`
          ALTER TABLE grids.preservation_holds
            DROP CONSTRAINT preservation_holds_scope_chk,
            DROP COLUMN table_name,
            DROP COLUMN table_short_id,
            DROP COLUMN table_id,
            DROP COLUMN scope_type
        `.simple();
        const baseId = uuid();
        const activeHoldId = shortId("H");
        const releasedHoldId = shortId("R");
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Legacy hold fixture')`;
        await database`
          INSERT INTO grids.preservation_holds (short_id, base_id, reason)
          VALUES (${activeHoldId}, ${baseId}::uuid, 'Active legacy hold')
        `;
        await database`
          INSERT INTO grids.preservation_holds (short_id, base_id, reason, release_reason, released_at)
          VALUES (${releasedHoldId}, ${baseId}::uuid, 'Released legacy hold', 'Legacy review complete', '2026-01-02T03:04:05Z')
        `;

        await migrate(database);

        const rows = await database<
          Array<{
            shortId: string;
            scopeType: string;
            tableId: string | null;
            tableShortId: string | null;
            tableName: string | null;
            releaseReason: string | null;
            releasedAt: Date | string | null;
          }>
        >`
          SELECT short_id AS "shortId", scope_type AS "scopeType", table_id AS "tableId",
            table_short_id AS "tableShortId", table_name AS "tableName",
            release_reason AS "releaseReason", released_at AS "releasedAt"
          FROM grids.preservation_holds
          WHERE base_id = ${baseId}::uuid
          ORDER BY short_id
        `;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.scopeType === "base" && !row.tableId && !row.tableShortId && !row.tableName)).toBe(true);
        expect(rows.find((row) => row.shortId === activeHoldId)).toMatchObject({ releaseReason: null, releasedAt: null });
        expect(rows.find((row) => row.shortId === releasedHoldId)).toMatchObject({ releaseReason: "Legacy review complete" });
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
        expect((migrationError as Error).message).toContain("app-core has not migrated yet");
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
        await migrateCoreWorkflows(database);
        await migrate(database);
        expect(await gridsPublicIdsReady(database)).toBe(true);

        const [row] = await database<Array<{ tableCount: number }>>`
          SELECT count(*)::int AS "tableCount"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_type = 'BASE TABLE'
        `;
        // Durable History and the evidence lifecycle add explicit owners
        // without replacing the lightweight live rows.
        expect(row?.tableCount).toBe(45);
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
        const [cast] = await database<Array<{ value: number | string }>>`SELECT grids.try_numeric('12.5') AS value`;
        expect(String(cast?.value)).toBe("12.5");

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
    30_000,
  );

  postgresTest(
    "moves legacy file ownership into durable attachment rows without changing the asset",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableId = uuid();
        const fieldId = uuid();
        const recordId = uuid();
        const fileId = uuid();
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'File migration')`;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Records')
        `;
        await database`
          INSERT INTO grids.fields (id, short_id, table_id, name, type)
          VALUES (${fieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Attachment', 'file')
        `;
        await database`
          INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES (${recordId}::uuid, ${shortId("R")}, ${tableId}::uuid, '{}'::jsonb)
        `;
        await database`
          ALTER TABLE grids.files
            ADD COLUMN record_id UUID REFERENCES grids.records(id) ON DELETE CASCADE,
            ADD COLUMN field_id UUID REFERENCES grids.fields(id) ON DELETE CASCADE,
            ADD COLUMN position INT NOT NULL DEFAULT 0
        `.simple();
        const bytes = new TextEncoder().encode("legacy");
        await database`
          INSERT INTO grids.files (
            id, short_id, record_id, field_id, position, filename, mime_type, size_bytes, sha256, bytes
          ) VALUES (
            ${fileId}::uuid, ${shortId("A")}, ${recordId}::uuid, ${fieldId}::uuid, 4,
            'legacy.txt', 'text/plain', ${bytes.byteLength}, 'legacy-hash', ${bytes}
          )
        `;

        await migrate(database);

        const [attachment] = await database<Array<{ fileId: string; recordId: string; fieldId: string; position: number }>>`
          SELECT file_id::text AS "fileId", record_id::text AS "recordId", field_id::text AS "fieldId", position
          FROM grids.file_attachments
          WHERE file_id = ${fileId}::uuid
        `;
        expect(attachment).toEqual({ fileId, recordId, fieldId, position: 4 });
        const legacyColumns = await database`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'grids' AND table_name = 'files'
            AND column_name IN ('record_id', 'field_id', 'position')
        `;
        expect(legacyColumns).toHaveLength(0);
        const [asset] = await database<Array<{ filename: string; bytes: Uint8Array }>>`
          SELECT filename, bytes FROM grids.files WHERE id = ${fileId}::uuid
        `;
        expect(asset?.filename).toBe("legacy.txt");
        expect(new TextDecoder().decode(asset?.bytes)).toBe("legacy");
      });
    },
    30_000,
  );

  postgresTest(
    "migrates active sequence high-water marks and marks uncertain deleted fields conservatively",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableId = uuid();
        const activeFieldId = uuid();
        const deletedFieldId = uuid();
        await database`
          INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Series migration')
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Entries')
        `;
        await database`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, config, unique_constraint, deleted_at)
          VALUES
            (${activeFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Active number', 'id',
             ${JSON.stringify({ strategy: "sequence", prefix: "A-", padding: 4 })}::jsonb, TRUE, NULL),
            (${deletedFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Deleted number', 'id',
             ${JSON.stringify({ strategy: "sequence", prefix: "LEG-", padding: 4 })}::jsonb, TRUE, now())
        `;
        const legacyName = `grids_id_${activeFieldId.replaceAll("-", "")}`;
        await database.unsafe(`CREATE SEQUENCE grids.${legacyName} AS BIGINT INCREMENT 1 MINVALUE 1`);
        await database.unsafe(`SELECT setval('grids.${legacyName}', 41, true)`);
        await database`
          INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES
            (${uuid()}::uuid, ${shortId("R")}, ${tableId}::uuid,
             jsonb_build_object(${deletedFieldId}::text, 'LEG-0007')),
            (${uuid()}::uuid, ${shortId("R")}, ${tableId}::uuid,
             jsonb_build_object(${deletedFieldId}::text, 'legacy-manual-value'))
        `;

        await migrate(database);

        const series = await database<
          Array<{ fieldId: string; archived: boolean; migrationStatus: string; baseline: number; sequenceName: string }>
        >`
          SELECT ns.field_id::text AS "fieldId", ns.archived_at IS NOT NULL AS archived,
                 ns.migration_status AS "migrationStatus", scope.baseline::int, scope.sequence_name AS "sequenceName"
          FROM grids.number_series ns
          JOIN grids.number_series_scopes scope ON scope.series_id = ns.id
          WHERE ns.field_id IN (${activeFieldId}::uuid, ${deletedFieldId}::uuid)
          ORDER BY ns.field_id
        `;
        const active = series.find((row) => row.fieldId === activeFieldId)!;
        const deleted = series.find((row) => row.fieldId === deletedFieldId)!;
        expect(active).toMatchObject({ archived: false, migrationStatus: "active_sequence", baseline: 41 });
        expect(deleted).toMatchObject({ archived: true, migrationStatus: "inferred_with_unmatched_values", baseline: 7 });
        const [next] = await database.unsafe(`SELECT nextval('grids.${active.sequenceName}')::int AS next`);
        expect((next as { next: number }).next).toBe(42);
        const [legacy] = await database<Array<{ exists: boolean }>>`
          SELECT to_regclass(${`grids.${legacyName}`}) IS NOT NULL AS exists
        `;
        expect(legacy?.exists).toBe(false);
      });
    },
    30_000,
  );

  postgresTest(
    "rekeys legacy scoped IDs atomically and reserves tombstoned IDs globally",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);

        const baseId = uuid();
        const liveTableId = uuid();
        const deletedTableId = uuid();
        const deletedFieldId = uuid();
        const deletedViewId = uuid();
        const validTableId = uuid();
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Legacy IDs')`;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name, deleted_at) VALUES
            (${liveTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Live', NULL),
            (${deletedTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Deleted', now()),
            (${validTableId}::uuid, 'KEEP01', ${baseId}::uuid, 'Already migrated', NULL)
        `;
        await database`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, deleted_at)
          VALUES (${deletedFieldId}::uuid, 'FIELD1', ${deletedTableId}::uuid, 'Archived value', 'text', now())
        `;
        await database`
          INSERT INTO grids.views (id, short_id, table_id, name, source, deleted_at)
          VALUES (
            ${deletedViewId}::uuid,
            'VIEW01',
            ${deletedTableId}::uuid,
            'Archived view',
            ${`from table {${deletedTableId}}\nselect {${deletedFieldId}}`},
            now()
          )
        `;

        await database`ALTER TABLE grids.tables DROP CONSTRAINT tables_short_id_format_chk`.simple();
        await database`DROP INDEX grids.idx_grids_tables_short_id`.simple();
        await database`UPDATE grids.tables SET short_id = 'OLD01' WHERE id IN (${liveTableId}::uuid, ${deletedTableId}::uuid)`;
        await database`
          CREATE UNIQUE INDEX idx_grids_tables_short_id
          ON grids.tables(base_id, short_id) WHERE deleted_at IS NULL
        `.simple();

        await migrate(database);

        const rows = await database<Array<{ shortId: string }>>`
          SELECT short_id AS "shortId"
          FROM grids.tables
          WHERE id IN (${liveTableId}::uuid, ${deletedTableId}::uuid)
          ORDER BY id
        `;
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => /^[A-Za-z0-9]{6}$/.test(row.shortId))).toBe(true);
        expect(new Set(rows.map((row) => row.shortId)).size).toBe(2);
        expect(rows.some((row) => row.shortId === "OLD01")).toBe(false);
        const [preserved] = await database<Array<{ shortId: string }>>`
          SELECT short_id AS "shortId" FROM grids.tables WHERE id = ${validTableId}::uuid
        `;
        expect(preserved?.shortId).toBe("KEEP01");
        const [deletedSource] = await database<Array<{ tableShortId: string; fieldShortId: string; source: string }>>`
          SELECT table_.short_id AS "tableShortId", field.short_id AS "fieldShortId", view_.source
          FROM grids.views view_
          JOIN grids.tables table_ ON table_.id = view_.table_id
          JOIN grids.fields field ON field.table_id = table_.id
          WHERE view_.id = ${deletedViewId}::uuid AND field.id = ${deletedFieldId}::uuid
        `;
        expect(deletedSource?.source).toBe(`from table {${deletedSource?.tableShortId}}\nselect {${deletedSource?.fieldShortId}}`);
        expect(await gridsPublicIdsReady(database)).toBe(true);

        let reuseError: unknown;
        try {
          await database`INSERT INTO grids.tables (short_id, base_id, name) VALUES (${rows[1]!.shortId}, ${baseId}::uuid, 'Reuse tombstone')`;
        } catch (error) {
          reuseError = error;
        }
        expect(reuseError).toMatchObject({ errno: "23505", constraint: "idx_grids_tables_short_id" });
      });
    },
    30_000,
  );

  postgresTest(
    "migrates stored Grids App v2 definitions through v5 in one idempotent run",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableId = uuid();
        const appId = uuid();
        const baseShortId = shortId("B");
        const tableShortId = shortId("T");
        const appShortId = shortId("A");
        const definition = {
          schemaVersion: 2,
          kind: "grids.custom-app",
          id: appId,
          baseId,
          shortId: "OLD01",
          name: "Paged app",
          startPageId: "home",
          pages: [
            {
              id: "home",
              title: "Home",
              navigation: { visible: true, order: 12 },
              parameters: {},
              rows: [
                {
                  id: "main",
                  columns: [
                    {
                      id: "content",
                      span: 12,
                      blocks: [
                        {
                          id: "records",
                          type: "records",
                          source: { kind: "gql", query: "from table Items\nlimit 40", maxRows: 25 },
                          display: { kind: "table", columnIds: [] },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        };
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Apps')`;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Items')
        `;
        await database`
          INSERT INTO grids.custom_apps (
            id, short_id, base_id, name, draft_definition, draft_capabilities, published_definition, published_capabilities
          ) VALUES (
            ${appId}::uuid,
            ${appShortId},
            ${baseId}::uuid,
            'Paged app',
            ${definition}::jsonb,
            '{}'::jsonb,
            ${definition}::jsonb,
            '{}'::jsonb
          )
        `;
        // Simulate the pre-v1 schema: a finalized six-character index means
        // the atomic public-ID/source migration has already completed.
        await database`DROP INDEX grids.idx_grids_custom_apps_short_id`.simple();

        await migrate(database);
        const [migrated] = await database<Array<{ draft: typeof definition; published: typeof definition }>>`
          SELECT draft_definition AS draft, published_definition AS published
          FROM grids.custom_apps WHERE id = ${appId}::uuid
        `;
        expect(migrated?.draft).toEqual(migrated?.published);
        expect(migrated?.draft.schemaVersion).toBe(5);
        expect(migrated?.draft.id).toBe(appShortId);
        expect(migrated?.draft.baseId).toBe(baseShortId);
        expect(migrated?.draft).not.toHaveProperty("shortId");
        expect(migrated?.draft.pages[0]?.navigation as unknown).toEqual({ visible: true });
        const records = migrated?.draft.pages[0]?.rows[0]?.columns[0]?.blocks[0] as Record<string, unknown> | undefined;
        expect(records).toMatchObject({ searchable: false, pageSize: 25 });
        expect((records?.source as Record<string, unknown> | undefined)?.query).toBe(`from table {${tableShortId}}\nlimit 40`);
        expect(records?.source).not.toHaveProperty("maxRows");

        const once = JSON.stringify(migrated?.draft);
        // Simulate an installation that completed the Custom App v5 hard cut
        // before number_series became a public-ID resource. The incremental
        // resource migration must not replay the one-shot v4 -> v5 migration.
        await database`ALTER TABLE grids.number_series DROP CONSTRAINT number_series_short_id_format_chk`.simple();
        await database`ALTER TABLE grids.number_series ALTER COLUMN short_id DROP NOT NULL`.simple();
        await migrate(database);
        const [rerun] = await database<Array<{ draft: unknown }>>`
          SELECT draft_definition AS draft FROM grids.custom_apps WHERE id = ${appId}::uuid
        `;
        expect(JSON.stringify(rerun?.draft)).toBe(once);
        expect(await gridsPublicIdsReady(database)).toBe(true);
      });
    },
    30_000,
  );

  postgresTest(
    "rolls back the hard cut when unsupported legacy Grids Apps cannot migrate",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableId = uuid();
        const recordId = uuid();
        const supportedId = uuid();
        const unsupportedId = uuid();
        const legacyId = uuid();
        const definition = (id: string) => ({
          schemaVersion: 3,
          kind: "grids.custom-app",
          id,
          baseId,
          shortId: "OLD01",
          name: "Migrated app",
          startPageId: "home",
          pages: [
            {
              id: "home",
              title: "Home",
              navigation: { visible: true, order: 9 },
              parameters: {},
              rows: [
                {
                  id: "main",
                  columns: [{ id: "content", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Hello" }] }],
                },
              ],
            },
          ],
        });
        const unsupported = definition(unsupportedId);
        unsupported.pages[0]!.rows[0]!.columns[0]!.blocks = [
          {
            id: "records",
            type: "records",
            source: { kind: "gql", query: "from table Items" },
            display: { kind: "table", columnIds: [] },
            bulkActions: [{ id: "run", label: "Run", launcherId: uuid() }],
          } as never,
        ];
        await database`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Apps')`;
        await database`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Items')`;
        await database`
          INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES (${recordId}::uuid, ${shortId("R")}, ${tableId}::uuid, ${{ keep: true }}::jsonb)
        `;
        await database`
          INSERT INTO grids.custom_apps (
            id, short_id, base_id, name, draft_definition, draft_capabilities,
            published_definition, published_capabilities, published_at
          ) VALUES
            (${supportedId}::uuid, ${shortId("A")}, ${baseId}::uuid, 'Supported', ${definition(supportedId)}::jsonb, '{}'::jsonb, ${definition(supportedId)}::jsonb, '{}'::jsonb, now()),
            (${unsupportedId}::uuid, ${shortId("A")}, ${baseId}::uuid, 'Unsupported', ${unsupported}::jsonb, '{}'::jsonb, ${unsupported}::jsonb, '{}'::jsonb, now()),
            (${legacyId}::uuid, ${shortId("A")}, ${baseId}::uuid, 'Legacy', ${{ ...definition(legacyId), schemaVersion: 1 }}::jsonb, '{}'::jsonb, ${{ ...definition(legacyId), schemaVersion: 1 }}::jsonb, '{}'::jsonb, now())
        `;
        await database`DROP INDEX grids.idx_grids_custom_apps_short_id`.simple();

        let migrationError: unknown;
        try {
          await migrate(database);
        } catch (error) {
          migrationError = error;
        }
        expect((migrationError as Error).message).toContain("cannot migrate custom app");
        const rows = await database<
          Array<{ id: string; draft: Record<string, unknown>; published: Record<string, unknown> | null; publishedAt: string | null }>
        >`
          SELECT id::text, draft_definition AS draft, published_definition AS published, published_at::text AS "publishedAt"
          FROM grids.custom_apps
          WHERE id IN (${supportedId}::uuid, ${unsupportedId}::uuid, ${legacyId}::uuid)
          ORDER BY id
        `;
        const supported = rows.find((row) => row.id === supportedId)!;
        expect(supported.draft).toEqual(definition(supportedId));
        expect(supported.published).toEqual(definition(supportedId));
        expect(supported.publishedAt).not.toBeNull();
        const retained = rows.find((row) => row.id === unsupportedId)!;
        expect(retained.draft).toEqual(unsupported);
        expect(retained.published).toEqual(unsupported);
        expect(retained.publishedAt).not.toBeNull();
        const legacy = rows.find((row) => row.id === legacyId)!;
        const legacyDefinition = { ...definition(legacyId), schemaVersion: 1 };
        expect(legacy.draft).toEqual(legacyDefinition);
        expect(legacy.published).toEqual(legacyDefinition);
        expect(legacy.publishedAt).not.toBeNull();
        const [record] = await database<Array<{ data: unknown }>>`SELECT data FROM grids.records WHERE id = ${recordId}::uuid`;
        expect(record?.data).toEqual({ keep: true });
        expect(await gridsPublicIdsReady(database)).toBe(false);
      });
    },
    30_000,
  );

  postgresTest(
    "drops obsolete access metadata and artifact-less alpha documents without changing supported domain rows or grants",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        await allowArtifactlessAlphaDocumentRuns(database);
        expect(GRIDS_WORKFLOW_SCHEMA_VERSION).toBe(8);

        const userId = uuid();
        const serviceAccountId = uuid();
        const baseId = uuid();
        const tableId = uuid();
        const fieldId = uuid();
        const recordId = uuid();
        const viewId = uuid();
        const formId = uuid();
        const documentTemplateId = uuid();
        const snapshotId = uuid();
        const documentRunId = uuid();
        const customAppId = uuid();
        const workflowId = uuid();
        const workflowLauncherId = uuid();
        const workflowRunId = uuid();
        const baseAccessId = uuid();
        const appAccessId = uuid();
        const obsoleteAccessId = uuid();
        const draftDefinition = {
          schemaVersion: 4,
          kind: "grids.custom-app",
          id: customAppId,
          baseId,
          name: "Draft kept byte-for-byte as JSON",
          startPageId: "draft",
          pages: [
            {
              id: "draft",
              title: "Draft",
              navigation: { visible: true },
              parameters: {},
              rows: [
                { id: "main", columns: [{ id: "content", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Draft" }] }] },
              ],
            },
          ],
        };
        const publishedDefinition = {
          ...draftDefinition,
          name: "Published kept byte-for-byte as JSON",
          startPageId: "published",
          pages: [
            {
              id: "published",
              title: "Published",
              navigation: { visible: true },
              parameters: {},
              rows: [
                { id: "main", columns: [{ id: "content", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Published" }] }] },
              ],
            },
          ],
        };
        const draftCapabilities = { schemaVersion: 1, tableIds: [tableId], marker: "draft" };
        const publishedCapabilities = { schemaVersion: 1, tableIds: [tableId], marker: "published" };

        await database`INSERT INTO auth.users (id) VALUES (${userId}::uuid)`;
        await database`INSERT INTO auth.service_accounts (id) VALUES (${serviceAccountId}::uuid)`;
        await database`
          INSERT INTO auth.access (id) VALUES
            (${baseAccessId}::uuid), (${appAccessId}::uuid), (${obsoleteAccessId}::uuid)
        `;
        await database`
          INSERT INTO grids.bases (id, short_id, name, description, document_profile, created_by)
          VALUES (
            ${baseId}::uuid,
            ${shortId("B")},
            'Preserved',
            'Must survive the permission hard cut',
            '{"locale":"de-DE"}'::jsonb,
            ${userId}::uuid
          )
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name, description, columns, display_config, audit_policy, position)
          VALUES (
            ${tableId}::uuid,
            ${shortId("T")},
            ${baseId}::uuid,
            'Preserved table',
            'Stable table data',
            '["primary"]'::jsonb,
            '{"mode":"cards"}'::jsonb,
            '{"recordChanges":true}'::jsonb,
            7
          )
        `;
        await database`
          INSERT INTO grids.fields (
            id, short_id, table_id, name, description, type, config, position, required, default_value, indexed, presentable
          ) VALUES (
            ${fieldId}::uuid,
            ${shortId("F")},
            ${tableId}::uuid,
            'Preserved field',
            'Stable field data',
            'text',
            '{"maxLength":120}'::jsonb,
            3,
            TRUE,
            '"fallback"'::jsonb,
            TRUE,
            TRUE
          )
        `;
        await database`
          INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by)
          VALUES (
            ${recordId}::uuid,
            ${shortId("R")},
            ${tableId}::uuid,
            ${{ [fieldId]: "preserved value" }}::jsonb,
            ${userId}::uuid,
            ${userId}::uuid
          )
        `;
        await database`
          INSERT INTO grids.views (id, short_id, table_id, name, description, source, ui, owner_user_id, position)
          VALUES (
            ${viewId}::uuid,
            ${shortId("V")},
            ${tableId}::uuid,
            'Preserved view',
            'Stable view data',
            'from table "Preserved table"',
            '{"density":"compact"}'::jsonb,
            ${userId}::uuid,
            4
          )
        `;
        await database`
          INSERT INTO grids.forms (id, short_id, table_id, name, config, public_token, owner_user_id, position)
          VALUES (
            ${formId}::uuid,
            ${shortId("O")},
            ${tableId}::uuid,
            'Preserved form',
            ${{ fields: [{ fieldId, required: true }] }}::jsonb,
            'preserved-public-token',
            ${userId}::uuid,
            5
          )
        `;
        await database`
          INSERT INTO grids.document_templates (
            id, short_id, table_id, name, description, source, html, header_html, footer_html, page_css,
            number_template, filename_template, enabled, position, created_by, updated_by
          ) VALUES (
            ${documentTemplateId}::uuid,
            ${shortId("D")},
            ${tableId}::uuid,
            'Preserved document template',
            'Stable template data',
            'from table "Preserved table"',
            '<main>{{ record.name }}</main>',
            '<header>Kept</header>',
            '<footer>Kept</footer>',
            '@page { size: A4; }',
            'DOC-{{ run.id }}',
            '{{ document.number }}.pdf',
            TRUE,
            6,
            ${userId}::uuid,
            ${userId}::uuid
          )
        `;
        await database`
          INSERT INTO grids.custom_apps (
            id, short_id, base_id, name, icon, draft_definition, draft_capabilities,
            published_definition, published_capabilities, published_at
          ) VALUES (
            ${customAppId}::uuid,
            ${shortId("C")},
            ${baseId}::uuid,
            'Preserved Grids App',
            'app-window',
            ${draftDefinition}::jsonb,
            ${draftCapabilities}::jsonb,
            ${publishedDefinition}::jsonb,
            ${publishedCapabilities}::jsonb,
            '2026-08-10T10:00:00Z'::timestamptz
          )
        `;
        await insertTestWorkflow({
          db: database,
          id: workflowId,
          baseId,
          name: "Preserved workflow",
          shortId: shortId("W"),
          source: "steps: [] # preserved",
          enabled: true,
          position: 8,
          ownerUserId: userId,
        });
        await database`
          INSERT INTO grids.workflow_launchers (
            id, short_id, base_id, workflow_id, name, kind, config, enabled, validated_revision, diagnostics
          ) VALUES (
            ${workflowLauncherId}::uuid,
            ${shortId("L")},
            ${baseId}::uuid,
            ${workflowId}::uuid,
            'Preserved launcher',
            'customApp',
            '{"button":"Run"}'::jsonb,
            TRUE,
            1,
            '[{"level":"info","message":"kept"}]'::jsonb
          )
        `;
        await insertTestWorkflowRun({
          db: database,
          id: workflowRunId,
          workflowId,
          baseId,
          state: "succeeded",
          launcherId: workflowLauncherId,
          actorUserId: userId,
          serviceAccountId,
          authorization: { kind: "preserved" },
          idempotencyKey: "preserved-run",
          occurredAt: new Date("2026-08-10T10:01:00Z"),
          createdAt: new Date("2026-08-10T10:01:00Z"),
          startedAt: new Date("2026-08-10T10:01:01Z"),
          finishedAt: new Date("2026-08-10T10:01:02Z"),
        });
        await database`
          INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph, created_by)
          VALUES (
            ${snapshotId}::uuid,
            ${shortId("S")},
            ${baseId}::uuid,
            ${tableId}::uuid,
            ${recordId}::uuid,
            ${{ recordId, data: { [fieldId]: "preserved value" } }}::jsonb,
            ${{ records: [recordId] }}::jsonb,
            ${userId}::uuid
          )
        `;
        await database`
          INSERT INTO grids.document_runs (
            id, short_id, template_id, workflow_run_id, snapshot_id, base_id, table_id, record_id,
            document_number, filename, tags, template_snapshot, render_data, generated_by
          ) VALUES (
            ${documentRunId}::uuid,
            ${shortId("R")},
            ${documentTemplateId}::uuid,
            ${workflowRunId}::uuid,
            ${snapshotId}::uuid,
            ${baseId}::uuid,
            ${tableId}::uuid,
            ${recordId}::uuid,
            'PRESERVED-DOC-1',
            'preserved.pdf',
            ARRAY['preserved', 'migration'],
            '{"html":"<main>kept</main>"}'::jsonb,
            '{"record":{"name":"kept"}}'::jsonb,
            ${userId}::uuid
          )
        `;
        await database`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${baseAccessId}::uuid)`;
        await database`
          INSERT INTO grids.custom_app_access (custom_app_id, access_id)
          VALUES (${customAppId}::uuid, ${appAccessId}::uuid)
        `;
        await database`
          ALTER TABLE grids.base_access ADD COLUMN record_scope JSONB NOT NULL DEFAULT '{"kind":"all"}'::jsonb;
          CREATE TABLE grids.table_access (table_id UUID, access_id UUID, record_scope JSONB);
          CREATE TABLE grids.view_access (view_id UUID, access_id UUID, record_scope JSONB);
          CREATE TABLE grids.form_access (form_id UUID, access_id UUID);
          CREATE TABLE grids.document_template_access (template_id UUID, access_id UUID);
          CREATE TABLE grids.workflow_access (workflow_id UUID, access_id UUID);
        `.simple();
        await database`
          INSERT INTO grids.table_access
          VALUES (${tableId}::uuid, ${obsoleteAccessId}::uuid, '{"kind":"all"}'::jsonb)
        `;
        await database`
          INSERT INTO grids.view_access
          VALUES (${viewId}::uuid, ${obsoleteAccessId}::uuid, '{"kind":"all"}'::jsonb)
        `;
        await database`INSERT INTO grids.form_access VALUES (${formId}::uuid, ${obsoleteAccessId}::uuid)`;
        await database`
          INSERT INTO grids.document_template_access VALUES (${documentTemplateId}::uuid, ${obsoleteAccessId}::uuid)
        `;
        await database`INSERT INTO grids.workflow_access VALUES (${workflowId}::uuid, ${obsoleteAccessId}::uuid)`;

        type SnapshotRow = { entity: string; entityId: string; value: Record<string, unknown> };
        const readPreservedRows = () => database<Array<SnapshotRow>>`
          SELECT entity, entity_id AS "entityId", value
          FROM (
            SELECT 'auth.access' AS entity, id::text AS entity_id, jsonb_build_object('id', id::text) AS value
            FROM auth.access WHERE id IN (${baseAccessId}::uuid, ${appAccessId}::uuid, ${obsoleteAccessId}::uuid)
            UNION ALL
            SELECT 'auth.service_accounts', id::text, jsonb_build_object('id', id::text)
            FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid
            UNION ALL
            SELECT 'auth.users', id::text, jsonb_build_object('id', id::text)
            FROM auth.users WHERE id = ${userId}::uuid
            UNION ALL
            SELECT 'grids.base_access', base_id::text || ':' || access_id::text,
              jsonb_build_object('baseId', base_id::text, 'accessId', access_id::text)
            FROM grids.base_access WHERE base_id = ${baseId}::uuid
            UNION ALL
            SELECT 'grids.bases', id::text,
              jsonb_build_object(
                'shortId', short_id, 'name', name, 'description', description,
                'documentProfile', document_profile, 'createdBy', created_by::text, 'deletedAt', deleted_at
              )
            FROM grids.bases WHERE id = ${baseId}::uuid
            UNION ALL
            SELECT 'grids.custom_app_access', custom_app_id::text || ':' || access_id::text,
              jsonb_build_object('customAppId', custom_app_id::text, 'accessId', access_id::text)
            FROM grids.custom_app_access WHERE custom_app_id = ${customAppId}::uuid
            UNION ALL
            SELECT 'grids.custom_apps', id::text,
              jsonb_build_object(
                'shortId', short_id, 'baseId', base_id::text, 'name', name, 'icon', icon,
                'draftDefinition', draft_definition, 'draftCapabilities', draft_capabilities,
                'publishedDefinition', published_definition, 'publishedCapabilities', published_capabilities,
                'publishedAt', published_at, 'deletedAt', deleted_at
              )
            FROM grids.custom_apps WHERE id = ${customAppId}::uuid
            UNION ALL
            SELECT 'grids.document_runs', id::text,
              jsonb_build_object(
                'shortId', short_id, 'templateId', template_id::text, 'workflowRunId', workflow_run_id::text,
                'snapshotId', snapshot_id::text, 'baseId', base_id::text, 'tableId', table_id::text,
                'recordId', record_id::text, 'documentNumber', document_number, 'filename', filename,
                'tags', tags, 'templateSnapshot', template_snapshot, 'renderData', render_data,
                'generatedBy', generated_by::text
              )
            FROM grids.document_runs WHERE id = ${documentRunId}::uuid
            UNION ALL
            SELECT 'grids.document_templates', id::text,
              jsonb_build_object(
                'shortId', short_id, 'tableId', table_id::text, 'name', name, 'description', description,
                'source', source, 'html', html, 'headerHtml', header_html, 'footerHtml', footer_html,
                'pageCss', page_css, 'numberTemplate', number_template, 'filenameTemplate', filename_template,
                'enabled', enabled, 'position', position, 'createdBy', created_by::text, 'updatedBy', updated_by::text,
                'deletedAt', deleted_at
              )
            FROM grids.document_templates WHERE id = ${documentTemplateId}::uuid
            UNION ALL
            SELECT 'grids.fields', id::text,
              jsonb_build_object(
                'shortId', short_id, 'tableId', table_id::text, 'name', name, 'description', description,
                'type', type, 'config', config, 'position', position, 'required', required,
                'defaultValue', default_value, 'indexed', indexed, 'unique', unique_constraint,
                'presentable', presentable, 'hideInTable', hide_in_table, 'deletedAt', deleted_at
              )
            FROM grids.fields WHERE id = ${fieldId}::uuid
            UNION ALL
            SELECT 'grids.forms', id::text,
              jsonb_build_object(
                'shortId', short_id, 'tableId', table_id::text, 'name', name, 'config', config,
                'publicToken', public_token, 'isActive', is_active, 'ownerUserId', owner_user_id::text,
                'position', position, 'deletedAt', deleted_at
              )
            FROM grids.forms WHERE id = ${formId}::uuid
            UNION ALL
            SELECT 'grids.record_snapshots', id::text,
              jsonb_build_object(
                'baseId', base_id::text, 'tableId', table_id::text, 'recordId', record_id::text,
                'root', root, 'graph', graph, 'createdBy', created_by::text
              )
            FROM grids.record_snapshots WHERE id = ${snapshotId}::uuid
            UNION ALL
            SELECT 'grids.records', id::text,
              jsonb_build_object(
                'tableId', table_id::text, 'data', data, 'version', version, 'deletedAt', deleted_at,
                'createdBy', created_by::text, 'updatedBy', updated_by::text
              )
            FROM grids.records WHERE id = ${recordId}::uuid
            UNION ALL
            SELECT 'grids.tables', id::text,
              jsonb_build_object(
                'shortId', short_id, 'baseId', base_id::text, 'kind', kind, 'name', name,
                'description', description, 'columns', columns, 'displayConfig', display_config,
                'auditPolicy', audit_policy, 'position', position, 'disableDirectInsert', disable_direct_insert,
                'deletedAt', deleted_at
              )
            FROM grids.tables WHERE id = ${tableId}::uuid
            UNION ALL
            SELECT 'grids.views', id::text,
              jsonb_build_object(
                'shortId', short_id, 'tableId', table_id::text, 'baseId', base_id::text,
                'name', name, 'description', description, 'source', source, 'ui', ui,
                'ownerUserId', owner_user_id::text, 'position', position, 'deletedAt', deleted_at
              )
            FROM grids.views WHERE id = ${viewId}::uuid
            UNION ALL
            SELECT 'grids.workflow_launchers', id::text,
              jsonb_build_object(
                'shortId', short_id, 'baseId', base_id::text, 'workflowId', workflow_id::text,
                'name', name, 'kind', kind, 'config', config, 'enabled', enabled,
                'validatedRevision', validated_revision, 'diagnostics', diagnostics, 'deletedAt', deleted_at
              )
            FROM grids.workflow_launchers WHERE id = ${workflowLauncherId}::uuid
            UNION ALL
            SELECT 'grids.workflow_profile', id::text,
              jsonb_build_object(
                'baseId', base_id::text, 'shortId', short_id, 'position', position,
                'ownerUserId', owner_user_id::text, 'enabled', enabled,
                'recordEventActiveSince', record_event_active_since, 'deletedAt', deleted_at
              )
            FROM grids.workflow_profile WHERE id = ${workflowId}::uuid
            UNION ALL
            SELECT 'grids.workflow_run_profile', run_id::text,
              jsonb_build_object(
                'baseId', base_id::text, 'workflowId', workflow_id::text, 'launcherId', launcher_id::text,
                'launcherKind', launcher_kind, 'channel', channel, 'actorUserId', actor_user_id::text,
                'serviceAccountId', service_account_id::text, 'requestFingerprint', request_fingerprint
              )
            FROM grids.workflow_run_profile WHERE run_id = ${workflowRunId}::uuid
            UNION ALL
            SELECT 'workflows.run', id::text,
              jsonb_build_object(
                'appId', app_id, 'scopeId', scope_id, 'workflowId', workflow_id::text,
                'workflowVersionId', workflow_version_id::text, 'mode', mode, 'state', state,
                'inputs', inputs, 'context', context, 'authorizationSnapshot', authorization_snapshot,
                'idempotencyKey', idempotency_key, 'occurredAt', occurred_at,
                'startedAt', started_at, 'finishedAt', finished_at
              )
            FROM workflows.run WHERE id = ${workflowRunId}::uuid
            UNION ALL
            SELECT 'workflows.workflow', id::text,
              jsonb_build_object(
                'appId', app_id, 'scopeId', scope_id, 'key', key, 'name', name,
                'description', description, 'activeVersionId', active_version_id::text,
                'createdByKind', created_by_kind, 'createdById', created_by_id::text
              )
            FROM workflows.workflow WHERE id = ${workflowId}::uuid
          ) AS preserved
          ORDER BY entity, entity_id
        `;
        const readWorkflowMigrationVersions = () => database<Array<{ version: number }>>`
          SELECT version FROM grids.workflow_migrations ORDER BY version
        `;

        const before = await readPreservedRows();
        const afterHardCut = before.filter((row) => row.entity !== "grids.document_runs");
        const workflowMigrationVersions = await readWorkflowMigrationVersions();
        expect(before).toHaveLength(22);

        await migrateCoreWorkflows(database);
        await migrate(database);
        expect(await readPreservedRows()).toEqual(afterHardCut);
        expect(await readWorkflowMigrationVersions()).toEqual(workflowMigrationVersions);

        await migrateCoreWorkflows(database);
        await migrate(database);
        expect(await readPreservedRows()).toEqual(afterHardCut);
        expect(await readWorkflowMigrationVersions()).toEqual(workflowMigrationVersions);

        const obsoleteTables = await database<Array<{ tableName: string }>>`
          SELECT table_name AS "tableName"
          FROM information_schema.tables
          WHERE table_schema = 'grids'
            AND table_name IN (
              'table_access', 'view_access', 'form_access', 'document_template_access', 'workflow_access'
            )
          ORDER BY table_name
        `;
        expect(obsoleteTables).toEqual([]);
        const [recordScope] = await database<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'grids' AND table_name = 'base_access' AND column_name = 'record_scope'
          ) AS exists
        `;
        expect(recordScope?.exists).toBe(false);
      });
    },
    30_000,
  );

  /*
   * The workflow revision trigger is gone. Revisions are published versions in
   * the kernel now, not a side effect of any UPDATE — which is why renaming a
   * workflow no longer produces one.
   */

  postgresTest(
    "backfills legacy email preview data once without replacing later edits",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const templateId = uuid();
        await database`
          INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${shortId("B")}, 'Email preview data migration')
        `;
        await database`
          INSERT INTO grids.email_templates (id, short_id, base_id, name, subject, html)
          VALUES (
            ${templateId}::uuid,
            ${shortId("E")},
            ${baseId}::uuid,
            'Loan agreement ready',
            'Agreement ready',
            '<p>{{ data.requesterName }}</p><a href="{{ data.agreement.url }}">Download</a>'
          )
        `;
        await database`ALTER TABLE grids.email_templates ALTER COLUMN sample_data DROP NOT NULL`.simple();
        await database`UPDATE grids.email_templates SET sample_data = NULL WHERE id = ${templateId}::uuid`;

        await migrateCoreWorkflows(database);
        await migrate(database);
        const [backfilled] = await database<Array<{ sampleData: Record<string, unknown> }>>`
          SELECT sample_data AS "sampleData"
          FROM grids.email_templates
          WHERE id = ${templateId}::uuid
        `;
        expect(backfilled?.sampleData).toEqual({
          requesterName: "Alex Morgan",
          loanNumber: "LOAN-2026-0001",
          dueDate: "31 July 2026",
          agreement: { url: "https://cloud.example.org/share/grids/documents/example" },
        });

        await database`UPDATE grids.email_templates SET sample_data = '{}'::jsonb WHERE id = ${templateId}::uuid`;
        await migrateCoreWorkflows(database);
        await migrate(database);
        const [preserved] = await database<Array<{ sampleData: Record<string, unknown> }>>`
          SELECT sample_data AS "sampleData"
          FROM grids.email_templates
          WHERE id = ${templateId}::uuid
        `;
        expect(preserved?.sampleData).toEqual({});
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
    "removes artifact-less alpha documents after preserving their number-series floor",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        await allowArtifactlessAlphaDocumentRuns(database);

        const baseId = uuid();
        const workflowId = uuid();
        const workflowRunId = uuid();
        const tableId = uuid();
        const recordId = uuid();
        const templateId = uuid();
        const templateShortId = shortId("T");
        const snapshotId = uuid();
        const documentRunId = uuid();
        await database`
          INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${shortId("B")}, 'Workflow reset artifacts')
        `;
        await database`
          INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Documents')
        `;
        await database`
          INSERT INTO grids.document_templates (id, short_id, table_id, name, source, html)
          VALUES (${templateId}::uuid, ${templateShortId}, ${tableId}::uuid, 'Document', 'from table Documents', '<main>Document</main>')
        `;
        await insertTestWorkflow({ db: database, id: workflowId, baseId, name: "Old workflow", shortId: shortId("W") });
        await database`
          INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
          VALUES (${snapshotId}::uuid, ${shortId("S")}, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, '{}'::jsonb, '{}'::jsonb)
        `;
        await database`
          INSERT INTO grids.document_runs (
            id, short_id, template_id, workflow_run_id, snapshot_id, base_id, table_id, record_id, document_number, filename,
            template_snapshot, render_data
          ) VALUES (
            ${documentRunId}::uuid, ${shortId("D")}, ${templateId}::uuid, ${workflowRunId}::uuid, ${snapshotId}::uuid, ${baseId}::uuid,
            ${tableId}::uuid, ${recordId}::uuid, 'DOC-1', 'DOC-1.pdf', ${{ id: templateShortId }}::jsonb, '{}'::jsonb
          )
        `;

        await database`DELETE FROM grids.workflow_migrations WHERE version = ${GRIDS_WORKFLOW_SCHEMA_VERSION}`;
        await migrateCoreWorkflows(database);
        await migrate(database);

        const [surviving] = await database<Array<{ count: number }>>`
          SELECT count(*)::int AS count FROM grids.document_runs WHERE id = ${documentRunId}::uuid
        `;
        const [series] = await database<Array<{ baselineFloor: number }>>`
          SELECT baseline_floor::int AS "baselineFloor"
          FROM grids.number_series
          WHERE document_template_id = ${templateId}::uuid
        `;
        expect(surviving).toEqual({ count: 0 });
        expect(series?.baselineFloor).toBe(1);
        await expect(
          (async () => {
            await database`
              INSERT INTO grids.document_runs (
                id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
                document_number, filename, template_snapshot, render_data
              ) VALUES (
                ${uuid()}::uuid, ${shortId("D")}, ${templateId}::uuid, ${snapshotId}::uuid,
                ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid,
                'DOC-2', 'DOC-2.pdf', '{}'::jsonb, '{}'::jsonb
              )
            `;
          })(),
        ).rejects.toThrow("artifact_file_id");
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

  postgresTest(
    "fails clearly when legacy data already contains ambiguous names",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        await database`DROP INDEX grids.idx_grids_tables_live_name`.simple();
        await database`
          INSERT INTO grids.bases (id, short_id, name)
          VALUES (${baseId}::uuid, ${shortId("B")}, 'Legacy duplicates')
        `;
        await database`
          INSERT INTO grids.tables (short_id, base_id, name)
          VALUES
            ('TD0001', ${baseId}::uuid, 'Orders'),
            ('TD0002', ${baseId}::uuid, ' orders ')
        `;

        let migrationError: unknown;
        try {
          await migrateCoreWorkflows(database);
          await migrate(database);
        } catch (error) {
          migrationError = error;
        }
        expect((migrationError as Error).message).toContain(
          `cannot enforce unique table names: grid ${baseId} contains multiple live tables named "orders"`,
        );
      });
    },
    30_000,
  );

  postgresTest(
    "removes intentional alpha-only schema surfaces",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        await database`ALTER TABLE grids.views ADD COLUMN IF NOT EXISTS query JSONB`.simple();
        await database`ALTER TABLE grids.views ADD COLUMN IF NOT EXISTS display_config JSONB`.simple();
        await database`CREATE TABLE IF NOT EXISTS grids.gql_queries (id UUID PRIMARY KEY)`.simple();
        await database`ALTER TABLE grids.email_templates ADD COLUMN IF NOT EXISTS text TEXT`.simple();

        await migrate(database);

        const legacyColumns = await database`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'grids'
        AND (
          (table_name = 'views' AND column_name IN ('query', 'display_config'))
          OR (table_name = 'email_templates' AND column_name = 'text')
        )
    `;
        const [legacyTable] = await database<Array<{ tableName: string | null }>>`
      SELECT to_regclass('grids.gql_queries')::text AS "tableName"
    `;
        expect(legacyColumns).toHaveLength(0);
        expect(legacyTable?.tableName).toBeNull();
      });
    },
    30_000,
  );

  postgresTest(
    "normalizes legacy number scale config to decimalPlaces",
    async () => {
      await withIsolatedDatabase(async (database) => {
        await migrateCoreWorkflows(database);
        await migrate(database);
        const baseId = uuid();
        const tableId = uuid();
        const fieldId = uuid();
        await database`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${shortId("B")}, 'Migration integration')
      `;
        await database`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Numbers', 0)
      `;
        await database`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, 'NUM001', ${tableId}::uuid, 'Amount', 'number', '{"scale":2}'::jsonb, 0)
      `;

        await migrate(database);

        const [row] = await database<Array<{ config: { decimalPlaces?: number; scale?: number } }>>`
        SELECT config
        FROM grids.fields
        WHERE id = ${fieldId}::uuid
      `;

        expect(row?.config).toEqual({ decimalPlaces: 2 });
      });
    },
    30_000,
  );
});
