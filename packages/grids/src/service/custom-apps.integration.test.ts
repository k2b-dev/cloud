import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import { projectPublishedRecords } from "../api/custom-app-public-dto";
import { type CustomAppDefinition, CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { customAppViewSourceHash } from "../custom-apps/insight-source";
import { canonicalCustomAppQueryContext } from "../custom-apps/query-plan-hash";
import { customAppScannerConfigHash } from "../custom-apps/scanner-capability";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { grantAccess } from "./access";
import { executePublishedCustomAppRecords } from "./custom-app-records-query";
import {
  apply,
  compile,
  createBlank,
  get,
  getPublishedByShortId,
  listSummariesByBase,
  plan,
  publish,
  remove,
  restoreDraft,
  saveDraft,
  unpublish,
} from "./custom-apps";
import { canExecuteWorkflow } from "./workflow-action-scope";
import { getWorkflow } from "./workflow-definitions";
import { createLauncher } from "./workflow-launchers";
import { deleteTestWorkflowScope, insertTestWorkflow } from "./workflow-test-fixture";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") {
    await migrateCoreWorkflows();
    await migrate();
  }
});

describe("Grids App lifecycle", () => {
  postgresTest("compiles referenced records through the pinned record query capability", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const customerTableId = testUuid();
    const customerTableShortId = testShortId("C");
    const customerNameId = testUuid();
    const customerNameShortId = testShortId("N");
    const orderTableId = testUuid();
    const orderTableShortId = testShortId("O");
    const orderNumberId = testUuid();
    const orderNumberShortId = testShortId("F");
    const customerRelationId = testUuid();
    const customerRelationShortId = testShortId("R");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Referenced records App')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES
          (${customerTableId}::uuid, ${customerTableShortId}, ${baseId}::uuid, 'Customers'),
          (${orderTableId}::uuid, ${orderTableShortId}, ${baseId}::uuid, 'Orders')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${customerNameId}::uuid, ${customerNameShortId}, ${customerTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
          (${orderNumberId}::uuid, ${orderNumberShortId}, ${orderTableId}::uuid, 'Number', 'text', '{}'::jsonb, 0),
          (${customerRelationId}::uuid, ${customerRelationShortId}, ${orderTableId}::uuid, 'Customer', 'relation', ${{ targetTableId: customerTableId, cardinality: "single" }}::jsonb, 1)
      `;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: baseShortId,
        name: "Customers",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [{ id: "intro", columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Home" }] }] }],
          },
          {
            id: "customer",
            title: "Customer",
            navigation: { visible: false },
            parameters: { customer_id: { type: "record", tableId: customerTableShortId, required: true } },
            record: { tableId: customerTableShortId, id: { source: "PARAMS", path: "customer_id" } },
            rows: [
              {
                id: "detail",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "customer-details", type: "record", fieldIds: [customerNameShortId], editableFieldIds: [] },
                      {
                        id: "orders",
                        type: "referenced_records",
                        sourceTableId: orderTableShortId,
                        relationFieldId: customerRelationShortId,
                        fieldIds: [orderNumberShortId],
                        display: { kind: "table" },
                        searchable: true,
                        pageSize: 25,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const originalDefinition = structuredClone(definition);
      const compiled = await compile(definition);
      if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message ?? "Compilation failed");
      expect(compiled.ok).toBe(true);
      expect(definition).toEqual(originalDefinition);
      expect(compiled.compiled.definition).toEqual(CustomAppDefinitionSchema.parse(originalDefinition));
      expect(compiled.compiled.bindings).toEqual({ appId: null, baseId });
      expect(compiled.compiled.capabilities.records).toEqual([
        expect.objectContaining({ pageId: "customer", tableId: customerTableId, fieldIds: [customerNameId] }),
      ]);
      expect(compiled.compiled.capabilities.recordQueries).toEqual([
        expect.objectContaining({ pageId: "customer", blockId: "orders", primaryTableId: orderTableId, tableIds: [orderTableId] }),
      ]);

      const customerRecordId = testUuid();
      const customerRecordShortId = testShortId("R");
      const orderRecordId = testUuid();
      const orderRecordShortId = testShortId("R");
      await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES
        (${customerRecordId}::uuid, ${customerRecordShortId}, ${customerTableId}::uuid, ${{ [customerNameId]: "Customer" }}::jsonb),
        (${orderRecordId}::uuid, ${orderRecordShortId}, ${orderTableId}::uuid, ${{ [orderNumberId]: "Needle" }}::jsonb)`;
      await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
        VALUES (${orderRecordId}::uuid, ${customerRelationId}::uuid, ${customerRecordId}::uuid)`;
      const page = definition.pages[1]!;
      const referencedBlock = page.rows[0]!.columns[0]!.blocks[1]!;
      if (referencedBlock.type !== "referenced_records") throw new Error("Expected referenced records fixture");
      const runtime = {
        baseId,
        customAppId: testUuid(),
        publishedAt: "2026-09-08T00:00:00.000Z",
        page,
        pageParams: { customer_id: customerRecordId },
        block: referencedBlock,
        capabilities: compiled.compiled.capabilities,
        context: { ...canonicalCustomAppQueryContext({}), "params.customer_id": customerRecordShortId },
        signal: new AbortController().signal,
        timeZone: "UTC",
        viewer: { userId: null, userGroups: [], isAdmin: true },
        viewerUserId: null,
        viewerServiceAccountId: null,
      };
      const searched = await executePublishedCustomAppRecords({ ...runtime, search: "Needle" });
      expect(searched?.response.ok).toBe(true);
      if (!searched?.response.ok) throw new Error("Referenced records search failed");
      expect(searched.response.rows.map((row) => row.recordId)).toEqual([orderRecordId]);
      const noMatch = await executePublishedCustomAppRecords({ ...runtime, search: "Absent" });
      expect(noMatch?.response.ok && noMatch.response.rows).toEqual([]);

      const navigable = structuredClone(definition);
      navigable.pages[0]!.rows[0]!.columns[0]!.blocks = [
        {
          id: "orders",
          type: "records",
          searchable: true,
          pageSize: 25,
          source: { kind: "gql", query: `from table {${orderTableShortId}}\nselect {${orderNumberShortId}}, {${customerRelationShortId}}` },
          display: { kind: "table", columnIds: [orderNumberShortId] },
          rowNavigate: {
            kind: "navigate",
            pageId: "customer",
            history: "push",
            params: {
              customer_id: { source: "ROW", path: "relation", fieldId: customerRelationShortId },
            },
          },
        },
      ];
      const navigationCompiled = await compile(navigable);
      if (!navigationCompiled.ok) throw new Error(navigationCompiled.diagnostics.map((item) => item.message).join("; "));
      const navigationPage = navigable.pages[0]!;
      const navigationBlock = navigationPage.rows[0]!.columns[0]!.blocks[0]!;
      if (navigationBlock.type !== "records") throw new Error("Expected navigable records fixture");
      const navigated = await executePublishedCustomAppRecords({
        ...runtime,
        page: navigationPage,
        pageParams: {},
        block: navigationBlock,
        capabilities: navigationCompiled.compiled.capabilities,
      });
      expect(navigated?.rowNavigationParams).toEqual({ [orderRecordId]: { customer_id: customerRecordId } });
      if (!navigated) throw new Error("Relation navigation failed");
      const projected = await projectPublishedRecords(navigated);
      expect(projected.rowNavigationParams).toEqual({ [orderRecordShortId]: { customer_id: customerRecordShortId } });
      expect(projected.ok && projected.rows[0]?.recordId).toBe(orderRecordShortId);

      // Public references must be resolved in the owning Base, never passed on
      // to a UUID query or accepted merely because the ShortID exists globally.
      const foreignBaseId = testUuid();
      const foreignTableId = testUuid();
      const foreignTableShortId = testShortId("T");
      try {
        await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${foreignBaseId}::uuid, ${testShortId("B")}, 'Foreign App base')`;
        await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
          VALUES (${foreignTableId}::uuid, ${foreignTableShortId}, ${foreignBaseId}::uuid, 'Foreign customers')`;
        for (const tableShortId of [testShortId("Z"), foreignTableShortId]) {
          const invalid = structuredClone(definition);
          invalid.pages[1]!.parameters.customer_id!.tableId = tableShortId;
          const before = structuredClone(invalid);
          const result = await compile(invalid);
          expect(result.ok).toBe(false);
          expect(invalid).toEqual(before);
          if (!result.ok) {
            expect(result.diagnostics.some((item) => item.path.includes("tableId"))).toBe(true);
          }
        }
      } finally {
        await sql`DELETE FROM grids.bases WHERE id = ${foreignBaseId}::uuid`;
      }
      await sql`UPDATE grids.fields SET deleted_at = NOW() WHERE id = ${customerNameId}::uuid`;
      const deletedField = await compile(definition);
      expect(deletedField.ok).toBe(false);
      if (!deletedField.ok) expect(deletedField.diagnostics.some((item) => item.path.includes("fieldIds"))).toBe(true);
      await sql`UPDATE grids.fields SET deleted_at = NULL WHERE id = ${customerNameId}::uuid`;

      await sql`
        UPDATE grids.fields
        SET config = ${{ targetTableId: orderTableId, cardinality: "single" }}::jsonb
        WHERE id = ${customerRelationId}::uuid
      `;
      const rejected = await compile({ ...definition, id: testShortId("X") });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.diagnostics.some((item) => item.path.includes("relationFieldId"))).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("pins one HTML template field for a record-page Rendered HTML block", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const tableId = testUuid();
    const tableShortId = testShortId("T");
    const htmlFieldId = testUuid();
    const htmlFieldShortId = testShortId("H");
    const textFieldId = testUuid();
    const textFieldShortId = testShortId("F");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Rendered HTML App')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Equipment')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${htmlFieldId}::uuid, ${htmlFieldShortId}, ${tableId}::uuid, 'Equipment card', 'html_template', ${{ template: "<p>Equipment</p>", css: "" }}::jsonb, 0),
          (${textFieldId}::uuid, ${textFieldShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 1)
      `;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: baseShortId,
        name: "Equipment cards",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [{ id: "intro", columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Home" }] }] }],
          },
          {
            id: "equipment",
            title: "Equipment",
            navigation: { visible: false },
            parameters: { equipment_id: { type: "record", tableId: tableShortId, required: true } },
            record: { tableId: tableShortId, id: { source: "PARAMS", path: "equipment_id" } },
            rows: [
              {
                id: "card-row",
                columns: [
                  {
                    id: "card-column",
                    span: 12,
                    blocks: [{ id: "equipment-card", type: "html", fieldId: htmlFieldShortId, height: "normal" }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const compiled = await compile(definition);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) throw new Error(compiled.diagnostics[0]?.message ?? "Compilation failed");
      expect(compiled.compiled.capabilities.records).toEqual([
        { pageId: "equipment", tableId, fieldIds: [htmlFieldId], editableFieldIds: [], relationLabels: [] },
      ]);

      const wrongType = structuredClone(definition);
      const block = wrongType.pages[1]!.rows[0]!.columns[0]!.blocks[0]!;
      if (block.type !== "html") throw new Error("Expected Rendered HTML block");
      block.fieldId = textFieldShortId;
      const rejected = await compile(wrongType);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.diagnostics).toContainEqual({
          code: "html_field.type",
          path: ["pages", 1, "rows", 0, "columns", 0, "blocks", 0, "fieldId"],
          message: `Field ${textFieldShortId} is not an HTML template field.`,
        });
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("keeps legacy definitions stored without rewriting and fails published lookup closed", async () => {
    const baseId = testUuid();
    const appId = testUuid();
    const shortId = testShortId("A");
    const legacyDefinition = {
      schemaVersion: 1,
      kind: "grids.custom-app",
      id: appId,
      baseId,
      name: "Legacy app",
      startPageId: "home",
      pages: [{ id: "home", title: "Home", rows: [] }],
    };
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Legacy app base')`;
      await sql`
        INSERT INTO grids.custom_apps (
          id, short_id, base_id, name, draft_definition, draft_capabilities, published_definition, published_capabilities, published_at
        ) VALUES (
          ${appId}::uuid, ${shortId}, ${baseId}::uuid, 'Legacy app', ${legacyDefinition}::jsonb, '{}'::jsonb,
          ${legacyDefinition}::jsonb, '{}'::jsonb, now()
        )
      `;

      const app = await get(appId);
      expect(app).not.toBeNull();
      expect(app?.draftDefinitionRaw).toEqual(legacyDefinition);
      expect(app?.publishedDefinitionRaw).toEqual(legacyDefinition);
      expect(app?.draftDefinition).toBeNull();
      expect(app?.publishedDefinition).toBeNull();
      expect(app?.draftValid).toBe(false);
      expect(app?.publishedValid).toBe(false);
      expect(app?.draftDiagnostics[0]).toEqual({
        path: ["draft", "schemaVersion"],
        message: "Stored draft is not a valid Grids App schemaVersion 5 definition.",
      });
      expect((await listSummariesByBase(baseId))[0]?.publishedValid).toBe(false);
      expect(await getPublishedByShortId(shortId)).toBeNull();
      expect((await publish(appId)).ok).toBe(false);

      const [stored] = await sql<Array<{ draft_definition: unknown; published_definition: unknown }>>`
        SELECT draft_definition, published_definition FROM grids.custom_apps WHERE id = ${appId}::uuid
      `;
      expect(stored?.draft_definition).toEqual(legacyDefinition);
      expect(stored?.published_definition).toEqual(legacyDefinition);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("autosaves invalid referenced drafts and restores the live snapshot", async () => {
    const baseId = testUuid();
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Draft lifecycle')`;
      const created = await createBlank(baseId, "Draft app");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      if (!created.data.draftDefinition) throw new Error("New Grids App draft must be valid");
      const published = await publish(created.data.id);
      expect(published.ok).toBe(true);

      const invalidDefinition: CustomAppDefinition = {
        ...created.data.draftDefinition,
        pages: created.data.draftDefinition.pages.map((page) => ({
          ...page,
          rows: page.rows.map((row) => ({
            ...row,
            columns: row.columns.map((column) => ({
              ...column,
              blocks: [
                {
                  id: "missing-view",
                  type: "records",
                  searchable: true,
                  pageSize: 25,
                  source: { kind: "view", viewId: testShortId("V") },
                  display: { kind: "table", columnIds: [testShortId("F")] },
                },
              ],
            })),
          })),
        })),
      };
      const saved = await saveDraft(created.data.id, invalidDefinition);
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.data.valid).toBe(false);
      expect(saved.data.app.draftCapabilities).toBeNull();
      expect(saved.data.app.hasUnpublishedChanges).toBe(true);

      const restored = await restoreDraft(created.data.id);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.data.draftValid).toBe(true);
      expect(restored.data.hasUnpublishedChanges).toBe(false);
      expect(restored.data.publishedDefinition).not.toBeNull();
      if (restored.data.publishedDefinition) {
        expect(restored.data.draftDefinition).toEqual(restored.data.publishedDefinition);
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("compiles references and keeps draft changes isolated until publish", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const viewId = testUuid();
    const metricViewId = testUuid();
    const fieldId = testUuid();
    const computedFieldId = testUuid();
    const htmlFieldId = testUuid();
    const relationFieldId = testUuid();
    const formId = testUuid();
    const documentTemplateId = testUuid();
    const otherDocumentTemplateId = testUuid();
    const otherTableId = testUuid();
    const otherFieldId = testUuid();
    let appId = testUuid();
    const requestRecordId = testUuid();
    const requestRecordShortId = testShortId("R");
    const workflowId = testUuid();
    const bulkWorkflowId = testUuid();
    const accessIds: string[] = [];
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Grids Apps')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Requests')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Title', 'text', '{}'::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${computedFieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Summary', 'formula', ${{ expression: "LEN(Title)" }}::jsonb, 1)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (
          ${htmlFieldId}::uuid,
          ${testShortId("F")},
          ${tableId}::uuid,
          'Request card',
          'html_template',
          ${{ template: "<p>{{ record.data.Title }}</p>", css: "" }}::jsonb,
          2
        )
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (
          ${relationFieldId}::uuid,
          ${testShortId("F")},
          ${tableId}::uuid,
          'Parent request',
          'relation',
          ${JSON.stringify({ targetTableId: tableId, cardinality: "single" })}::jsonb,
          1
        )
      `;
      await sql`
        INSERT INTO grids.forms (id, short_id, table_id, name, config, is_active, position)
        VALUES (
          ${formId}::uuid,
          ${testShortId("M")},
          ${tableId}::uuid,
          'Request form',
          ${JSON.stringify({
            title: "Apply",
            fields: [
              { kind: "user_input", fieldId },
              { kind: "user_input", fieldId: relationFieldId },
            ],
          })}::jsonb,
          true,
          0
        )
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${otherTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Other records')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${otherFieldId}::uuid, ${testShortId("F")}, ${otherTableId}::uuid, 'Title', 'text', '{}'::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.document_templates (id, short_id, table_id, name, renderer_kind, source, html, number_template, filename_template)
        VALUES
          (${documentTemplateId}::uuid, ${testShortId("D")}, ${tableId}::uuid, 'Certificate', 'html', 'from table Requests', '<p>Certificate</p>', 'CERT-{{ document.id }}', '{{ document.number }}.pdf'),
          (${otherDocumentTemplateId}::uuid, ${testShortId("D")}, ${otherTableId}::uuid, 'Other document', 'html', 'from table Other', '<p>Other</p>', 'OTHER-{{ document.id }}', '{{ document.number }}.pdf')
      `;
      await sql`
        INSERT INTO grids.views (id, short_id, table_id, name, source)
        VALUES
          (${viewId}::uuid, ${testShortId("V")}, ${tableId}::uuid, 'My requests', ${`from table {${tableId}}`}),
          (${metricViewId}::uuid, ${testShortId("V")}, ${tableId}::uuid, 'Request count', ${`from table {${tableId}}\naggregate count(*) as requests`})
      `;
      await insertTestWorkflow({
        baseId,
        id: workflowId,
        enabled: true,
        plan: {
          schemaVersion: 2,
          languageId: "grids",
          languageVersion: 1,
          sourceHash: "a".repeat(64),
          manifestHash: "b".repeat(64),
          catalogHash: "c".repeat(64),
          actionPolicies: {},
          inputs: [{ name: "request", type: "record", config: { required: true } }],
          triggers: [],
          steps: [],
          bindings: { "inputs.request.table": tableId },
        },
      });
      const workflow = await getWorkflow(workflowId);
      if (!workflow) throw new Error("Grids App workflow fixture is missing");
      const launcherResult = await createLauncher(
        workflow,
        { name: "Approve request", config: { kind: "customApp", inputMode: "prompt" }, enabled: true },
        null,
      );
      if (!launcherResult.ok) throw new Error(launcherResult.error.message);
      const launcherId = launcherResult.data.id;
      await insertTestWorkflow({
        baseId,
        id: bulkWorkflowId,
        enabled: true,
        plan: {
          schemaVersion: 2,
          languageId: "grids",
          languageVersion: 1,
          sourceHash: "d".repeat(64),
          manifestHash: "e".repeat(64),
          catalogHash: "f".repeat(64),
          actionPolicies: {},
          inputs: [{ name: "requests", type: "recordList", config: { required: true } }],
          triggers: [],
          steps: [],
          bindings: { "inputs.requests.table": tableId },
        },
      });
      const bulkWorkflow = await getWorkflow(bulkWorkflowId);
      if (!bulkWorkflow) throw new Error("Grids App bulk workflow fixture is missing");
      const bulkLauncherResult = await createLauncher(
        bulkWorkflow,
        { name: "Approve selected", config: { kind: "bulk", input: "requests" }, enabled: true },
        null,
      );
      if (!bulkLauncherResult.ok) throw new Error(bulkLauncherResult.error.message);
      const bulkLauncherId = bulkLauncherResult.data.id;
      const scannerLauncherResult = await createLauncher(
        workflow,
        { name: "Scan request", config: { kind: "scanner", input: "request", resolve: { by: "scanCode" } }, enabled: true },
        null,
      );
      if (!scannerLauncherResult.ok) throw new Error(scannerLauncherResult.error.message);
      const scannerLauncherId = scannerLauncherResult.data.id;

      const publicIds = new Map(
        (
          await sql<Array<{ id: string; shortId: string }>>`
            SELECT id::text AS id, short_id AS "shortId" FROM grids.bases WHERE id = ${baseId}::uuid
            UNION ALL SELECT id::text, short_id FROM grids.tables WHERE id IN (${tableId}::uuid, ${otherTableId}::uuid)
            UNION ALL SELECT id::text, short_id FROM grids.fields WHERE id IN (${fieldId}::uuid, ${computedFieldId}::uuid, ${htmlFieldId}::uuid, ${relationFieldId}::uuid, ${otherFieldId}::uuid)
            UNION ALL SELECT id::text, short_id FROM grids.views WHERE id IN (${viewId}::uuid, ${metricViewId}::uuid)
            UNION ALL SELECT id::text, short_id FROM grids.forms WHERE id = ${formId}::uuid
            UNION ALL SELECT id::text, short_id FROM grids.document_templates WHERE id IN (${documentTemplateId}::uuid, ${otherDocumentTemplateId}::uuid)
          `
        ).map((row) => [row.id, row.shortId]),
      );
      const publicId = (id: string): string => {
        const value = publicIds.get(id);
        if (!value) throw new Error(`missing public fixture id for ${id}`);
        return value;
      };
      await sql`
        UPDATE grids.views
        SET source = CASE id
          WHEN ${viewId}::uuid THEN ${`from table {${publicId(tableId)}}`}
          WHEN ${metricViewId}::uuid THEN ${`from table {${publicId(tableId)}}\naggregate count(*) as requests`}
          ELSE source
        END
        WHERE id IN (${viewId}::uuid, ${metricViewId}::uuid)
      `;

      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: publicId(baseId),
        name: "Request portal",
        startPageId: "home",
        sidebar: {
          actions: [
            {
              id: "create-request",
              kind: "form",
              label: "New request",
              tone: "success",
              formId: publicId(formId),
              fixedValues: { [publicId(fieldId)]: { source: "LITERAL", value: "New request" } },
              onSuccessNavigate: {
                kind: "navigate",
                pageId: "request",
                params: { request_id: { source: "RESULT", path: "recordId" } },
              },
              availableWhen: { query: `from table {${publicId(tableId)}}\nwhere {${publicId(fieldId)}} = @auth.id\nlimit 1` },
            },
          ],
        },
        pages: [
          {
            id: "home",
            title: "My requests",
            navigation: { visible: true },
            parameters: {},
            availableWhen: { query: `from table {${publicId(tableId)}}\nwhere record.id = '${requestRecordShortId}'\nlimit 1` },
            rows: [
              {
                id: "content",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "intro",
                        type: "markdown",
                        markdown: "Welcome",
                        availableWhen: { query: `from table {${publicId(tableId)}}\nwhere record.id = @base.id\nlimit 1` },
                      },
                      {
                        id: "request-count",
                        type: "metrics",
                        source: { kind: "view", viewId: publicId(metricViewId) },
                      },
                      {
                        id: "requests-by-title",
                        type: "chart",
                        chartType: "bar",
                        source: {
                          kind: "gql",
                          query: `from table {${publicId(tableId)}}\ngroup by {${publicId(fieldId)}}\naggregate count(*) as requests`,
                        },
                        limit: 10,
                      },
                      {
                        id: "requests",
                        type: "records",
                        searchable: true,
                        pageSize: 25,
                        source: { kind: "view", viewId: publicId(viewId) },
                        display: { kind: "table", columnIds: [publicId(fieldId)] },
                        rowNavigate: {
                          kind: "navigate",
                          pageId: "request",
                          history: "push",
                          params: { request_id: { source: "ROW", path: "id" } },
                        },
                        rowActions: [
                          {
                            id: "approve-row",
                            label: "Approve row",
                            icon: "check",
                            showLabel: false,
                            kind: "workflow",
                            launcherId: launcherResult.data.shortId,
                            inputs: { request: { source: "ROW", path: "id" } },
                          },
                        ],
                      },
                      {
                        id: "apply",
                        type: "form",
                        formId: publicId(formId),
                        fixedValues: {},
                        onSuccessNavigate: {
                          kind: "navigate",
                          pageId: "request",
                          params: { request_id: { source: "RESULT", path: "recordId" } },
                        },
                      },
                      { id: "scan-request", type: "scanner", launcherId: scannerLauncherResult.data.shortId },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: "request",
            title: "Request detail",
            navigation: { visible: false },
            parameters: { request_id: { type: "record", tableId: publicId(tableId), required: true } },
            record: { tableId: publicId(tableId), id: { source: "PARAMS", path: "request_id" } },
            rows: [
              {
                id: "detail",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      {
                        id: "request-details",
                        type: "record",
                        fieldIds: [publicId(fieldId), publicId(relationFieldId)],
                        editableFieldIds: [publicId(fieldId)],
                        documents: { templateIds: [publicId(documentTemplateId)] },
                      },
                      { id: "request-card", type: "html", fieldId: publicId(htmlFieldId), height: "normal" },
                      { id: "discussion", type: "comments", title: "Updates" },
                      {
                        id: "actions",
                        type: "actions",
                        actions: [
                          {
                            id: "approve",
                            label: "Approve",
                            kind: "workflow",
                            launcherId: launcherResult.data.shortId,
                            inputs: { request: { source: "RECORD", path: "id" } },
                            availableWhen: { query: `from table {${publicId(tableId)}}\nwhere record.id = @params.request_id\nlimit 1` },
                          },
                        ],
                      },
                      {
                        id: "follow-up",
                        type: "form",
                        formId: publicId(formId),
                        fixedValues: { [publicId(relationFieldId)]: { source: "PARAMS", path: "request_id" } },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const originalDefinition = structuredClone(definition);
      const compiled = await compile(definition);
      if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("; "));
      expect(definition).toEqual(originalDefinition);
      expect(compiled.compiled.definition).toEqual(CustomAppDefinitionSchema.parse(originalDefinition));
      expect(compiled.compiled.bindings).toEqual({ appId: null, baseId });

      const parameterAction = structuredClone(definition);
      const actions = parameterAction.pages[1]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "actions");
      if (!actions || actions.type !== "actions") throw new Error("Missing action fixture");
      const workflowAction = actions.actions.find((action) => action.kind === "workflow");
      if (!workflowAction || workflowAction.kind !== "workflow") throw new Error("Missing workflow action fixture");
      workflowAction.inputs.request = { source: "PARAMS", path: "request_id" };
      const parameterCompiled = await compile(parameterAction);
      if (!parameterCompiled.ok) throw new Error(parameterCompiled.diagnostics.map((item) => item.message).join("; "));
      expect(parameterCompiled.compiled.capabilities.workflowLaunchers).toEqual(compiled.compiled.capabilities.workflowLaunchers);
      const isolatedPage = structuredClone(parameterAction.pages[1]!);
      isolatedPage.id = "parameter-binding";
      isolatedPage.parameters.other_request = { type: "record", tableId: publicId(otherTableId), required: true };
      const isolatedActions = isolatedPage.rows[0]!.columns[0]!.blocks.find((block) => block.type === "actions");
      if (!isolatedActions || isolatedActions.type !== "actions") throw new Error("Missing isolated action fixture");
      delete isolatedPage.record;
      isolatedPage.rows[0]!.columns[0]!.blocks = [isolatedActions];
      const isolatedWorkflowAction = isolatedActions.actions.find((action) => action.kind === "workflow");
      if (!isolatedWorkflowAction || isolatedWorkflowAction.kind !== "workflow")
        throw new Error("Missing isolated workflow action fixture");
      isolatedWorkflowAction.inputs.request = { source: "PARAMS", path: "other_request" };
      parameterAction.pages.push(isolatedPage);
      const wrongParameterBinding = await compile(parameterAction);
      expect(wrongParameterBinding.ok).toBe(false);
      if (!wrongParameterBinding.ok) {
        expect(wrongParameterBinding.diagnostics.some((item) => item.path.includes("inputs"))).toBe(true);
      }

      const created = await apply(definition);
      expect(created.ok, created.ok ? undefined : created.error.message).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      appId = created.data.id;
      if (!created.data.draftDefinition) throw new Error("Applied Grids App draft must be valid");
      expect(created.data.shortId).toHaveLength(6);
      expect(created.data.publishedDefinition).toBeNull();
      const capabilities = created.data.draftCapabilities;
      if (!capabilities) throw new Error("Applied Grids App capabilities must be valid");
      expect(definition).toEqual(originalDefinition);
      expect(created.data.draftDefinition).toEqual(CustomAppDefinitionSchema.parse(originalDefinition));
      expect(capabilities).toEqual(compiled.compiled.capabilities);
      const planHashes = [
        ...capabilities.availability.map((capability) => capability.planHash),
        ...capabilities.views.map((capability) => capability.planHash),
        ...capabilities.insights.map((capability) => capability.source.planHash),
        ...capabilities.recordQueries.map((capability) => capability.planHash),
      ];
      expect(planHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
      expect(new Set(capabilities.forms.map((capability) => capability.fieldHash)).size).toBe(1);
      expect(new Set(capabilities.forms.map((capability) => capability.formSecurityHash)).size).toBe(1);
      expect({
        ...capabilities,
        availability: capabilities.availability.map(({ planHash: _, ...capability }) => capability),
        views: capabilities.views.map(({ planHash: _, ...capability }) => capability),
        insights: capabilities.insights.map((capability) => ({
          ...capability,
          source: (({ planHash: _, ...source }) => source)(capability.source),
        })),
        recordQueries: capabilities.recordQueries.map(({ planHash: _, ...capability }) => capability),
        forms: capabilities.forms.map(({ fieldHash: _, formSecurityHash: __, ...capability }) => capability),
      }).toEqual({
        availability: [
          {
            target: "sidebarAction",
            actionId: "create-request",
            sourceHash: customAppViewSourceHash(
              baseId,
              `from table {${publicId(tableId)}}\nwhere {${publicId(fieldId)}} = @auth.id\nlimit 1`,
            ),
            tableIds: [tableId],
          },
          {
            target: "page",
            pageId: "home",
            sourceHash: customAppViewSourceHash(
              baseId,
              `from table {${publicId(tableId)}}\nwhere record.id = '${requestRecordShortId}'\nlimit 1`,
            ),
            tableIds: [tableId],
          },
          {
            target: "block",
            pageId: "home",
            blockId: "intro",
            sourceHash: customAppViewSourceHash(baseId, `from table {${publicId(tableId)}}\nwhere record.id = @base.id\nlimit 1`),
            tableIds: [tableId],
          },
          {
            target: "action",
            pageId: "request",
            blockId: "actions",
            actionId: "approve",
            sourceHash: customAppViewSourceHash(baseId, `from table {${publicId(tableId)}}\nwhere record.id = @params.request_id\nlimit 1`),
            tableIds: [tableId],
          },
        ],
        views: [
          {
            viewId,
            tableId,
            sourceHash: customAppViewSourceHash(tableId, `from table {${publicId(tableId)}}`),
            tableIds: [tableId],
          },
        ],
        insights: [
          {
            pageId: "home",
            blockId: "request-count",
            blockType: "metrics",
            source: {
              kind: "view",
              viewId: metricViewId,
              sourceHash: customAppViewSourceHash(tableId, `from table {${publicId(tableId)}}\naggregate count(*) as requests`),
              tableIds: [tableId],
            },
          },
          {
            pageId: "home",
            blockId: "requests-by-title",
            blockType: "chart",
            source: { kind: "gql", tableIds: [tableId] },
          },
        ],
        recordQueries: [],
        records: [
          {
            pageId: "request",
            tableId,
            fieldIds: [fieldId, htmlFieldId, relationFieldId].sort(),
            editableFieldIds: [fieldId],
            relationLabels: [{ fieldId: relationFieldId, targetTableId: tableId, labelFieldIds: [fieldId] }],
          },
        ],
        comments: [{ pageId: "request", blockId: "discussion", tableId }],
        documents: [{ pageId: "request", blockId: "request-details", tableId, templateIds: [documentTemplateId] }],
        forms: [
          {
            sidebarActionId: "create-request",
            formId,
            tableId,
            userInputFieldIds: [fieldId, relationFieldId].sort(),
            fixedFieldIds: [fieldId],
          },
          {
            pageId: "home",
            blockId: "apply",
            formId,
            tableId,
            userInputFieldIds: [fieldId, relationFieldId].sort(),
            fixedFieldIds: [],
          },
          {
            pageId: "request",
            blockId: "follow-up",
            formId,
            tableId,
            userInputFieldIds: [fieldId, relationFieldId].sort(),
            fixedFieldIds: [relationFieldId],
          },
        ],
        workflowLaunchers: [
          { pageId: "home", blockId: "requests", actionId: "approve-row", launcherId, workflowId, revision: 1 },
          { pageId: "request", blockId: "actions", actionId: "approve", launcherId, workflowId, revision: 1 },
        ],
        scannerLaunchers: [
          {
            pageId: "home",
            blockId: "scan-request",
            launcherId: scannerLauncherId,
            workflowId,
            revision: 1,
            configHash: customAppScannerConfigHash({ kind: "scanner", input: "request", resolve: { by: "scanCode" } }),
          },
        ],
      });
      expect((await plan(definition)).action).toBe("noop");

      const exportedYaml = Bun.YAML.stringify(created.data.draftDefinition);
      const roundTripped = CustomAppDefinitionSchema.parse(Bun.YAML.parse(exportedYaml));
      expect(roundTripped).toEqual(created.data.draftDefinition);
      expect((await plan(roundTripped)).action).toBe("noop");

      const wrongHtmlField = structuredClone(definition);
      const htmlBlock = wrongHtmlField.pages[1]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "html")!;
      if (htmlBlock.type !== "html") throw new Error("Expected Rendered HTML block");
      htmlBlock.fieldId = publicId(fieldId);
      const wrongHtmlResult = await compile({ ...wrongHtmlField, id: testShortId("A") });
      expect(wrongHtmlResult.ok).toBe(false);
      if (!wrongHtmlResult.ok) {
        expect(wrongHtmlResult.diagnostics.some((diagnostic) => diagnostic.message.includes("not an HTML template field"))).toBe(true);
      }

      const reapplied = await apply(roundTripped);
      expect(reapplied.ok).toBe(true);
      if (!reapplied.ok) return;
      expect(reapplied.data.updatedAt).toBe(created.data.updatedAt);
      const [storedCount] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.custom_apps WHERE id = ${appId}::uuid
      `;
      expect(storedCount?.count).toBe(1);

      const firstPublish = await publish(appId);
      expect(firstPublish.ok).toBe(true);
      if (!firstPublish.ok) return;
      expect(firstPublish.data.publishedDefinition?.name).toBe("Request portal");
      expect((await listSummariesByBase(baseId)).find((app) => app.id === appId)?.publishedValid).toBe(true);

      const [authUser] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
      if (!authUser) throw new Error("Grids App lifecycle test needs one auth user");
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${requestRecordId}::uuid, ${requestRecordShortId}, ${tableId}::uuid, ${JSON.stringify({ [fieldId]: authUser.id })}::jsonb)
      `;
      const publishedAt = firstPublish.data.publishedAt!;
      const appGrant = await grantAccess({
        resourceType: "customApp",
        resourceId: appId,
        permission: "read",
        principal: { type: "user", userId: authUser.id },
      });
      expect(appGrant.ok).toBe(true);
      if (!appGrant.ok) throw new Error(appGrant.error.message);
      accessIds.push(appGrant.data.accessId);
      const executionClaim = {
        baseId,
        workflowId,
        principal: { userId: authUser.id, groupIds: [], serviceAccountId: null },
        authorization: {
          kind: "custom-app-action" as const,
          customAppId: appId,
          publishedAt,
          pageId: "request",
          pageParams: { request_id: requestRecordId },
          timeZone: "UTC",
          blockId: "actions",
          actionId: "approve",
          revision: 1,
        },
        launcherId,
      };
      expect(await canExecuteWorkflow(executionClaim)).toBe(true);
      const bulkExecutionClaim = {
        baseId,
        workflowId: bulkWorkflowId,
        principal: executionClaim.principal,
        authorization: {
          kind: "custom-app-bulk-action" as const,
          customAppId: appId,
          publishedAt,
          pageId: "home",
          pageParams: {},
          timeZone: "UTC",
          blockId: "requests",
          actionId: "approve-selected",
          recordIds: [requestRecordId],
          revision: 1,
        },
        launcherId: bulkLauncherId,
      };
      expect(await canExecuteWorkflow(bulkExecutionClaim)).toBe(false);
      expect(
        await canExecuteWorkflow({
          ...executionClaim,
          authorization: {
            kind: "custom-app-sidebar-action",
            customAppId: appId,
            publishedAt,
            timeZone: "UTC",
            actionId: "approve-global",
            revision: 1,
          },
        }),
      ).toBe(false);
      const scannerExecutionClaim = {
        baseId,
        workflowId,
        principal: executionClaim.principal,
        authorization: {
          kind: "custom-app-scanner" as const,
          customAppId: appId,
          publishedAt,
          pageId: "home",
          pageParams: {},
          timeZone: "UTC",
          blockId: "scan-request",
          revision: 1,
          configHash: customAppScannerConfigHash({ kind: "scanner", input: "request", resolve: { by: "scanCode" } }),
        },
        launcherId: scannerLauncherId,
      };
      expect(await canExecuteWorkflow(scannerExecutionClaim)).toBe(true);
      await sql`UPDATE grids.workflow_launchers SET config = ${JSON.stringify({
        kind: "scanner",
        input: "request",
        resolve: { by: "field", field: "Title" },
      })}::jsonb WHERE id = ${scannerLauncherId}::uuid`;
      expect(await canExecuteWorkflow(scannerExecutionClaim)).toBe(false);
      await sql`
        UPDATE grids.records
        SET deleted_at = now()
        WHERE id = ${requestRecordId}::uuid
      `;
      expect(await canExecuteWorkflow(executionClaim)).toBe(false);
      expect(await canExecuteWorkflow(bulkExecutionClaim)).toBe(false);
      await sql`
        UPDATE grids.records
        SET deleted_at = NULL
        WHERE id = ${requestRecordId}::uuid
      `;
      expect(await canExecuteWorkflow(executionClaim)).toBe(true);
      await sql`UPDATE grids.workflow_launchers SET enabled = FALSE WHERE id = ${launcherId}::uuid`;
      expect(await canExecuteWorkflow(executionClaim)).toBe(false);
      await sql`UPDATE grids.workflow_launchers SET enabled = TRUE WHERE id = ${launcherId}::uuid`;

      const updated = await apply({ ...definition, name: "Updated draft" });
      expect(updated.ok).toBe(true);
      expect((await get(appId))?.publishedDefinition?.name).toBe("Request portal");

      const secondPublish = await publish(appId);
      expect(secondPublish.ok).toBe(true);
      if (secondPublish.ok) expect(secondPublish.data.publishedDefinition?.name).toBe("Updated draft");
      expect(await canExecuteWorkflow(executionClaim)).toBe(false);

      const invalid = await compile({
        ...definition,
        id: testShortId("A"),
        pages: [
          {
            ...definition.pages[0],
            rows: [
              {
                ...definition.pages[0]!.rows[0],
                columns: [
                  {
                    ...definition.pages[0]!.rows[0]!.columns[0],
                    blocks: [
                      {
                        id: "invalid",
                        type: "records",
                        searchable: true,
                        pageSize: 25,
                        source: { kind: "view", viewId: publicId(viewId) },
                        display: { kind: "table", columnIds: [testShortId("F")] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(invalid.ok).toBe(false);

      const invalidGlobalContext = structuredClone(definition);
      invalidGlobalContext.sidebar!.actions[0]!.availableWhen = {
        query: `from table {${publicId(tableId)}}\nwhere {${publicId(fieldId)}} = @page.id\nlimit 1`,
      };
      const invalidGlobalContextResult = await compile({ ...invalidGlobalContext, id: testShortId("A") });
      expect(invalidGlobalContextResult.ok).toBe(false);
      if (!invalidGlobalContextResult.ok) {
        expect(invalidGlobalContextResult.diagnostics.some((diagnostic) => diagnostic.message.includes("@page.id"))).toBe(true);
      }

      const computedEdit = structuredClone(definition);
      const computedRecord = computedEdit.pages[1]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "record")!;
      if (computedRecord.type !== "record") throw new Error("Expected Record block");
      computedRecord.fieldIds.push(publicId(computedFieldId));
      computedRecord.editableFieldIds = [publicId(computedFieldId)];
      const computedEditResult = await compile({ ...computedEdit, id: testShortId("A") });
      expect(computedEditResult.ok).toBe(false);
      if (!computedEditResult.ok) {
        expect(computedEditResult.diagnostics.some((diagnostic) => diagnostic.message.includes("not a writable record field"))).toBe(true);
      }

      const rawMetric = structuredClone(definition);
      const metricBlock = rawMetric.pages[0]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "metrics")!;
      if (metricBlock.type !== "metrics") throw new Error("Expected Metrics block");
      metricBlock.source = { kind: "gql", query: `from table {${publicId(tableId)}}` };
      const rawMetricResult = await compile({ ...rawMetric, id: testShortId("A") });
      expect(rawMetricResult.ok).toBe(false);
      if (!rawMetricResult.ok) {
        expect(rawMetricResult.diagnostics.some((diagnostic) => diagnostic.message.includes("ungrouped scalar aggregations"))).toBe(true);
      }

      const ungroupedChart = structuredClone(definition);
      const chartBlock = ungroupedChart.pages[0]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "chart")!;
      if (chartBlock.type !== "chart") throw new Error("Expected Chart block");
      chartBlock.source = {
        kind: "gql",
        query: `from table {${publicId(tableId)}}\naggregate count(*) as requests`,
      };
      const ungroupedChartResult = await compile({ ...ungroupedChart, id: testShortId("A") });
      expect(ungroupedChartResult.ok).toBe(false);
      if (!ungroupedChartResult.ok) {
        expect(ungroupedChartResult.diagnostics.some((diagnostic) => diagnostic.message.includes("must group rows"))).toBe(true);
      }

      const wrongDocumentTemplate = structuredClone(definition);
      const documentRecord = wrongDocumentTemplate.pages[1]!.rows[0]!.columns[0]!.blocks.find((block) => block.type === "record")!;
      if (documentRecord.type !== "record") throw new Error("Expected Record block");
      documentRecord.documents = { templateIds: [publicId(otherDocumentTemplateId)] };
      const wrongDocumentResult = await compile({ ...wrongDocumentTemplate, id: testShortId("A") });
      expect(wrongDocumentResult.ok).toBe(false);
      if (!wrongDocumentResult.ok) {
        expect(wrongDocumentResult.diagnostics.some((diagnostic) => diagnostic.message.includes("another table"))).toBe(true);
      }

      const relationRowTarget = structuredClone(definition);
      const relationRecords = relationRowTarget.pages[0]!.rows[0]!.columns[0]!.blocks.find(
        (block) => block.type === "records" && block.id === "requests",
      );
      if (!relationRecords || relationRecords.type !== "records" || !relationRecords.rowNavigate) {
        throw new Error("Expected navigable Records block");
      }
      relationRecords.rowNavigate.params.request_id = { source: "ROW", path: "relation", fieldId: publicId(relationFieldId) };
      expect((await compile({ ...relationRowTarget, id: testShortId("A") })).ok).toBe(true);

      relationRecords.source = { kind: "gql", query: `from table {${publicId(tableId)}}\nselect {${publicId(fieldId)}}` };
      const unselectedRelationTarget = await compile({ ...relationRowTarget, id: testShortId("A") });
      expect(unselectedRelationTarget.ok).toBe(false);
      if (!unselectedRelationTarget.ok) {
        expect(unselectedRelationTarget.diagnostics.some((diagnostic) => diagnostic.message.includes("selected single relation"))).toBe(
          true,
        );
      }

      const wrongRowTarget = await compile({
        ...definition,
        id: testShortId("A"),
        pages: [
          definition.pages[0],
          {
            ...definition.pages[1],
            parameters: { request_id: { type: "record", tableId: publicId(otherTableId), required: true } },
            record: { tableId: publicId(otherTableId), id: { source: "PARAMS", path: "request_id" } },
            rows: [
              {
                id: "detail",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [{ id: "request-details", type: "record", fieldIds: [publicId(otherFieldId)], editableFieldIds: [] }],
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(wrongRowTarget.ok).toBe(false);
      if (!wrongRowTarget.ok) {
        expect(wrongRowTarget.diagnostics.some((diagnostic) => diagnostic.message.includes("source table"))).toBe(true);
      }

      const wrongFixedTarget = await compile({
        ...definition,
        id: testShortId("A"),
        pages: [
          {
            ...definition.pages[0],
            rows: [
              {
                id: "home",
                columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Welcome" }] }],
              },
            ],
          },
          {
            ...definition.pages[1],
            parameters: { request_id: { type: "record", tableId: publicId(otherTableId), required: true } },
            record: { tableId: publicId(otherTableId), id: { source: "PARAMS", path: "request_id" } },
            rows: [
              {
                id: "detail",
                columns: [
                  {
                    id: "main",
                    span: 12,
                    blocks: [
                      { id: "request-details", type: "record", fieldIds: [publicId(otherFieldId)], editableFieldIds: [] },
                      {
                        id: "follow-up",
                        type: "form",
                        formId: publicId(formId),
                        fixedValues: { [publicId(relationFieldId)]: { source: "PARAMS", path: "request_id" } },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(wrongFixedTarget.ok).toBe(false);
      if (!wrongFixedTarget.ok) {
        expect(wrongFixedTarget.diagnostics.some((diagnostic) => diagnostic.message.includes("same table"))).toBe(true);
      }

      const unpublished = await unpublish(appId, authUser.id);
      expect(unpublished.ok).toBe(true);
      if (!unpublished.ok) return;
      expect(unpublished.data.publishedDefinition).toBeNull();
      expect(await getPublishedByShortId(created.data.shortId)).toBeNull();
      expect((await unpublish(appId, authUser.id)).ok).toBe(true);

      const republished = await publish(appId, authUser.id);
      expect(republished.ok).toBe(true);
      expect(await getPublishedByShortId(created.data.shortId)).not.toBeNull();

      expect((await remove(appId, authUser.id)).ok).toBe(true);
      expect(await get(appId)).toBeNull();
      expect(await getPublishedByShortId(created.data.shortId)).toBeNull();
      expect((await remove(appId, authUser.id)).ok).toBe(false);
    } finally {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });
});
