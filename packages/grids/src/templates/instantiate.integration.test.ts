import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { CustomAppCapabilitiesSchema, CustomAppDefinitionSchema } from "../custom-apps/contracts";
import { migrate } from "../migrate";
import { buildLiveRenderData, renderDocumentHtml } from "../service/document-rendering";
import { getTemplate as getDocumentTemplate } from "../service/document-templates";
import { get as getRecord } from "../service/records";
import { get as getTable } from "../service/tables";
import { instantiate } from "../service/templates";
import { deleteTestWorkflowScope } from "../service/workflow-test-fixture";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

type CustomAppRow = { published_definition: unknown; published_capabilities: unknown };
type DocumentTemplateRow = { id: string; table_id: string; name: string };

const verifyRuntimeSurfaces = async (baseId: string, withSampleData: boolean) => {
  const apps = await sql<CustomAppRow[]>`
    SELECT published_definition, published_capabilities
    FROM grids.custom_apps
    WHERE base_id = ${baseId}::uuid AND deleted_at IS NULL
  `;
  expect(apps.length).toBeGreaterThan(0);
  for (const app of apps) {
    expect(CustomAppDefinitionSchema.safeParse(app.published_definition).success).toBe(true);
    expect(CustomAppCapabilitiesSchema.safeParse(app.published_capabilities).success).toBe(true);
  }

  const documentRows = await sql<DocumentTemplateRow[]>`
    SELECT dt.id::text AS id, dt.table_id::text AS table_id, dt.name
    FROM grids.document_templates dt
    JOIN grids.tables t ON t.id = dt.table_id AND t.deleted_at IS NULL
    WHERE t.base_id = ${baseId}::uuid AND dt.deleted_at IS NULL
    ORDER BY dt.created_at, dt.id
  `;
  expect(documentRows.length).toBeGreaterThan(0);
  const exposedDocuments = apps.flatMap((app) => CustomAppCapabilitiesSchema.parse(app.published_capabilities).documents);
  for (const document of documentRows) {
    expect(
      exposedDocuments.some((surface) => surface.tableId === document.table_id && surface.templateIds.includes(document.id)),
      `${document.name} App document access`,
    ).toBe(true);
  }
  if (!withSampleData) return;

  for (const documentRow of documentRows) {
    const [recordRow] = await sql<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM grids.records
      WHERE table_id = ${documentRow.table_id}::uuid AND deleted_at IS NULL
      ORDER BY created_at, id
      LIMIT 1
    `;
    expect(recordRow, `${documentRow.name} sample record`).toBeDefined();
    if (!recordRow) continue;

    const [documentTemplate, table, record] = await Promise.all([
      getDocumentTemplate(documentRow.id),
      getTable(documentRow.table_id),
      getRecord(documentRow.table_id, recordRow.id),
    ]);
    expect(documentTemplate, `${documentRow.name} template`).toBeDefined();
    expect(table, `${documentRow.name} table`).toBeDefined();
    expect(record, `${documentRow.name} record`).toBeDefined();
    if (!documentTemplate || !table || !record) continue;

    const live = await buildLiveRenderData({ template: documentTemplate, table, record });
    expect(live.ok, `${documentRow.name} render data`).toBe(true);
    if (!live.ok) continue;
    const html = await renderDocumentHtml(documentTemplate, live.data.data);
    expect(html.ok, `${documentRow.name} HTML`).toBe(true);
    if (html.ok) expect(html.data.length).toBeGreaterThan(1_000);
    if (documentRow.name === "Order invoice") expect(live.data.rows.length).toBeGreaterThan(1);
  }
};

describe("built-in template instantiation", () => {
  postgresTest(
    "publishes German templates with document and workflow bindings",
    async () => {
      await migrate();
      for (const templateId of ["bookshop", "finance", "inventory"]) {
        const created = await instantiate(
          templateId,
          { name: `German template integration ${Bun.randomUUIDv7()}`, withSampleData: false },
          null,
          "de",
        );
        expect(created.ok, `${templateId} German instantiation`).toBe(true);
        if (!created.ok) throw new Error(created.error.message);
        try {
          await verifyRuntimeSurfaces(created.data.id, false);
        } finally {
          await deleteTestWorkflowScope(created.data.id);
          await sql`DELETE FROM grids.bases WHERE id = ${created.data.id}::uuid`;
        }
      }
    },
    90_000,
  );
  postgresTest(
    "creates complete product resources through production services",
    async () => {
      await migrate();
      const expectations = [
        {
          templateId: "bookshop",
          documentNames: ["Order invoice"],
          emailName: "Order invoice ready",
          workflows: [{ name: "Send order invoice", steps: 10 }],
          launchers: ["Choose order to send invoice"],
          workflowCapabilities: 2,
          scannerCapabilities: 0,
        },
        {
          templateId: "finance",
          documentNames: ["Transaction receipt"],
          emailName: "Transaction receipt ready",
          workflows: [{ name: "Clear and send receipt", steps: 10 }],
          launchers: ["Choose transaction to process receipt"],
          workflowCapabilities: 2,
          scannerCapabilities: 0,
        },
        {
          templateId: "inventory",
          documentNames: ["Asset label", "Loan agreement"],
          emailName: "Loan agreement ready",
          workflows: [
            { name: "Cancel requested loan", steps: 3 },
            { name: "Approve equipment loan", steps: 5 },
            { name: "Send approved loan agreement", steps: 12 },
            { name: "Report damaged item", steps: 3 },
            { name: "Mark loan item as returned", steps: 4 },
            { name: "Issue loan position", steps: 4 },
            { name: "Close returned loan", steps: 2 },
            { name: "Add loan position", steps: 2 },
          ],
          launchers: [
            "Cancel requested loan",
            "Approve equipment loan",
            "Choose loan to send agreement",
            "Scan damaged inventory item",
            "Scan returned inventory item",
            "Issue loan position",
            "Close returned loan",
            "Add loan position",
          ],
          workflowCapabilities: 6,
          scannerCapabilities: 2,
        },
      ];

      for (const expected of expectations) {
        const created = await instantiate(
          expected.templateId,
          { name: `${expected.templateId} integration ${Bun.randomUUIDv7()}`, withSampleData: true },
          null,
        );
        expect(created.ok, `${expected.templateId} instantiation`).toBe(true);
        if (!created.ok) throw new Error(created.error.message);

        try {
          const documentTemplates = await sql<Array<{ name: string; source: string }>>`
            SELECT dt.name, dt.source
            FROM grids.document_templates dt
            JOIN grids.tables t ON t.id = dt.table_id
            WHERE t.base_id = ${created.data.id}::uuid AND dt.deleted_at IS NULL
          `;
          const [emailTemplate] = await sql<Array<{ name: string; subject: string }>>`
            SELECT name, subject
            FROM grids.email_templates
            WHERE base_id = ${created.data.id}::uuid AND deleted_at IS NULL
          `;
          const workflows = await sql<Array<{ name: string; enabled: boolean; plan: { steps?: unknown[] } }>>`
            SELECT definition.name, profile.enabled, version.plan
            FROM grids.workflow_profile AS profile
            JOIN workflows.workflow AS definition ON definition.id = profile.id
            CROSS JOIN LATERAL (
              SELECT plan FROM workflows.version WHERE workflow_id = profile.id ORDER BY revision DESC LIMIT 1
            ) AS version
            WHERE profile.base_id = ${created.data.id}::uuid AND profile.deleted_at IS NULL
          `;
          const launchers = await sql<Array<{ name: string; enabled: boolean; diagnostics: unknown[] }>>`
            SELECT name, enabled, diagnostics
            FROM grids.workflow_launchers
            WHERE base_id = ${created.data.id}::uuid AND deleted_at IS NULL
          `;
          const customApps = await sql<Array<{ published_definition: unknown; published_capabilities: unknown }>>`
            SELECT published_definition, published_capabilities
            FROM grids.custom_apps
            WHERE base_id = ${created.data.id}::uuid AND deleted_at IS NULL
          `;
          const [documentAudit] = await sql<Array<{ action: string }>>`
            SELECT action
            FROM grids.audit_log
            WHERE base_id = ${created.data.id}::uuid AND action = 'document_template.created'
          `;
          const [sampleData] = await sql<Array<{ record_count: number }>>`
            SELECT COUNT(*)::int AS record_count
            FROM grids.records r
            JOIN grids.tables t ON t.id = r.table_id
            WHERE t.base_id = ${created.data.id}::uuid AND r.deleted_at IS NULL
          `;

          const definitions = customApps.map((app) => CustomAppDefinitionSchema.parse(app.published_definition));
          const capabilities = customApps.map((app) => CustomAppCapabilitiesSchema.parse(app.published_capabilities));
          const blocks = definitions.flatMap((definition) =>
            definition.pages.flatMap((page) => page.rows.flatMap((row) => row.columns.flatMap((column) => column.blocks))),
          );
          expect(sampleData?.record_count).toBeGreaterThan(0);
          expect(documentTemplates.map((item) => item.name).sort()).toEqual([...expected.documentNames].sort());
          for (const documentTemplate of documentTemplates) {
            expect(documentTemplate.source).toContain("from table ");
            expect(documentTemplate.source).not.toMatch(/\{[0-9a-f-]{36}\}/i);
          }
          expect(emailTemplate?.name).toBe(expected.emailName);
          expect(emailTemplate?.subject).toContain("{{");
          expect(workflows).toHaveLength(expected.workflows.length);
          for (const expectedWorkflow of expected.workflows) {
            const workflow = workflows.find((item) => item.name === expectedWorkflow.name);
            expect(workflow).toMatchObject({ name: expectedWorkflow.name, enabled: true });
            expect(workflow?.plan.steps).toHaveLength(expectedWorkflow.steps);
          }
          expect(launchers).toHaveLength(expected.launchers.length);
          for (const launcherName of expected.launchers) {
            expect(launchers.find((item) => item.name === launcherName)).toMatchObject({
              name: launcherName,
              enabled: true,
              diagnostics: [],
            });
          }
          expect(
            blocks.some((block) => "source" in block && block.source?.kind === "gql"),
            `${expected.templateId} direct Grids App GQL block`,
          ).toBe(true);
          expect(
            blocks.some((block) => block.type === "actions"),
            `${expected.templateId} workflow actions`,
          ).toBe(true);
          expect(capabilities.flatMap((item) => item.workflowLaunchers)).toHaveLength(expected.workflowCapabilities);
          expect(capabilities.flatMap((item) => item.scannerLaunchers)).toHaveLength(expected.scannerCapabilities);
          expect(documentAudit?.action).toBe("document_template.created");
          await verifyRuntimeSurfaces(created.data.id, true);
        } finally {
          await deleteTestWorkflowScope(created.data.id);
          await sql`DELETE FROM grids.bases WHERE id = ${created.data.id}::uuid`;
        }

        const empty = await instantiate(
          expected.templateId,
          { name: `${expected.templateId} empty integration ${Bun.randomUUIDv7()}`, withSampleData: false },
          null,
        );
        expect(empty.ok, `${expected.templateId} empty instantiation`).toBe(true);
        if (!empty.ok) throw new Error(empty.error.message);
        try {
          await verifyRuntimeSurfaces(empty.data.id, false);
        } finally {
          await deleteTestWorkflowScope(empty.data.id);
          await sql`DELETE FROM grids.bases WHERE id = ${empty.data.id}::uuid`;
        }
      }
    },
    90_000,
  );
});
