import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { previewDslQuery } from "../query-dsl/preview";
import { resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { exportRecords } from "./export";
import { lockFinalizedSchema } from "./finalized-schema";
import { enrichRecordsWithHtmlTemplates } from "./html-template-fields";
import { checkHtmlTemplate } from "./html-template-preview";
import { refreshLocalCalculations } from "./local-calculation-storage";
import { createReader } from "./record-read";
import { list } from "./records";

// Raw SQL fixtures must materialize the same stored calculations as normal writes.
const materialize = (tableId: string) =>
  sql.begin(async (tx) => {
    await lockFinalizedSchema(tx, tableId);
    await refreshLocalCalculations(tx, tableId);
  });

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("HTML template field integration", () => {
  postgresTest("renders after formulas with stable public record and field IDs", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const nameFieldId = testUuid();
    const formulaFieldId = testUuid();
    const htmlFieldId = testUuid();
    const otherHtmlFieldId = testUuid();
    const thirdHtmlFieldId = testUuid();
    const fourthHtmlFieldId = testUuid();
    const recordId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const recordShortId = testShortId("R");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'HTML templates')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Products', 0)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${nameFieldId}::uuid, 'NAME01', ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
          (${formulaFieldId}::uuid, 'LABEL1', ${tableId}::uuid, 'Label', 'formula', ${{ expression: "CONCAT(Name, ' offer')" }}::jsonb, 1),
          (${htmlFieldId}::uuid, 'HTML01', ${tableId}::uuid, 'HTML', 'html_template', ${{ template: '<p class="title">{{ record.id }} {{ record.data.LABEL1 }}</p>', css: ".title { color: red; }" }}::jsonb, 2),
          (${otherHtmlFieldId}::uuid, 'HTML02', ${tableId}::uuid, 'Other HTML', 'html_template', ${{ template: "<p>Other</p>", css: "" }}::jsonb, 3),
          (${thirdHtmlFieldId}::uuid, 'HTML03', ${tableId}::uuid, 'Third HTML', 'html_template', ${{ template: "<p>Third</p>", css: "" }}::jsonb, 4),
          (${fourthHtmlFieldId}::uuid, 'HTML04', ${tableId}::uuid, 'Fourth HTML', 'html_template', ${{ template: "<p>Fourth</p>", css: "" }}::jsonb, 5)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [nameFieldId]: "Camera" }}::jsonb)
      `;

      await materialize(tableId);
      const result = await list({ tableId, limit: 1 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.items[0]?.data[formulaFieldId]).toBe("Camera offer");
        expect(result.data.items[0]?.data[htmlFieldId]).toContain(`${recordShortId} Camera offer`);
        expect(result.data.items[0]?.data[htmlFieldId]).toContain('style="color: red;"');
        expect(result.data.items[0]?.data[htmlFieldId]).not.toContain(recordId);

        const selectedReader = await createReader(tableId, {
          fields: result.data.fields,
          htmlTemplateFieldIds: [htmlFieldId],
        });
        const selectedRecord = await selectedReader.get(recordId);
        expect(selectedRecord?.data[htmlFieldId]).toContain(`${recordShortId} Camera offer`);
        expect(selectedRecord?.data[otherHtmlFieldId]).toBeUndefined();

        const parsed = parseGridsQueryDsl(`from table ${tableShortId}\nselect HTML01 as rendered_html`);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const table = { kind: "table" as const, id: tableId, shortId: tableShortId, name: "Products" };
        const resolved = resolveDslQueryToQueryPlan(parsed.ast, {
          currentTable: table,
          tables: [table],
          views: [],
          fieldsByTableId: { [tableId]: result.data.fields },
        });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        const preview = await previewDslQuery(resolved.plan, { fieldsByTableId: { [tableId]: result.data.fields }, limit: 5 });
        expect(preview.ok).toBe(true);
        if (preview.ok) {
          expect(preview.data.rows[0]?.values.q_col_0).toContain(`${recordShortId} Camera offer`);
          expect(preview.data.rows[0]?.values.q_col_0).not.toContain(recordId);
        }

        const latestRecordId = testUuid();
        const latestRecordShortId = testShortId("L");
        await sql`
          INSERT INTO grids.records (id, short_id, table_id, data, created_at, updated_at)
          VALUES (${latestRecordId}::uuid, ${latestRecordShortId}, ${tableId}::uuid, ${{ [nameFieldId]: "Tripod" }}::jsonb, '2030-01-01', '2030-01-01')
        `;
        await materialize(tableId);
        const latest = await checkHtmlTemplate({
          tableId,
          fieldId: htmlFieldId,
          template: "<p>{{ record.id }}</p>",
          css: "",
        });
        expect(latest.ok).toBe(true);
        if (latest.ok) expect(latest.data.rows[0]?.recordId).toBe(latestRecordShortId);

        await sql`
          INSERT INTO grids.records (id, short_id, table_id, data)
          SELECT gen_random_uuid(), 'E' || lpad(sequence::text, 5, '0'), ${tableId}::uuid,
                 jsonb_build_object(${nameFieldId}::text, 'Product ' || sequence::text)
          FROM generate_series(1, 500) sequence
        `;
        await materialize(tableId);
        const exported = await exportRecords({
          tableId,
          format: "csv",
          query: { limit: 502 },
          fields: [htmlFieldId, otherHtmlFieldId, thirdHtmlFieldId, fourthHtmlFieldId].map((fieldId) => ({ fieldId })),
        });
        expect(exported.ok).toBe(true);
        if (exported.ok) {
          const body = await new Response(exported.data.body).text();
          expect(body).toContain("#TEMPLATE_ERROR!");
        }
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("isolates shared context failures to the rendered cell", async () => {
    const tableId = testUuid();
    const fieldId = testUuid();
    const record = {
      id: testUuid(),
      shortId: testShortId("R"),
      tableId,
      data: {} as Record<string, unknown>,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const field = {
      id: fieldId,
      shortId: testShortId("H"),
      tableId,
      name: "HTML",
      description: null,
      type: "html_template" as const,
      config: { template: "<p>Hello</p>", css: "" },
      position: 0,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: false,
      uniqueConstraint: false,
      deletedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await enrichRecordsWithHtmlTemplates([record], [field]);

    expect(record.data[fieldId]).toBe("#TEMPLATE_ERROR!");
  });
});
