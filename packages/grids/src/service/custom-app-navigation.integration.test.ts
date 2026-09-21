import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import type { CustomAppDefinition } from "../custom-apps/contracts";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { compile } from "./custom-apps";

beforeAll(async () => {
  if (testInfra.database) {
    await migrateCoreWorkflows();
    await migrate();
  }
});

describe("custom app navigation publication", () => {
  postgresTest("accepts a live bound record and rejects missing, deleted, or other-table targets", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const tableId = testUuid();
    const tableShortId = testShortId("T");
    const otherTableId = testUuid();
    const fieldId = testUuid();
    const fieldShortId = testShortId("F");
    const recordId = testUuid();
    const recordShortId = testShortId("R");
    const otherRecordShortId = testShortId("R");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Navigation')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES
        (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Settings'),
        (${otherTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Other')`;
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES
        (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [fieldId]: "Company" }}::jsonb),
        (${testUuid()}::uuid, ${otherRecordShortId}, ${otherTableId}::uuid, '{}'::jsonb)`;
      const definition: CustomAppDefinition = {
        schemaVersion: 5,
        kind: "grids.custom-app",
        id: testShortId("A"),
        baseId: baseShortId,
        name: "Settings",
        startPageId: "home",
        pages: [
          {
            id: "home",
            title: "Home",
            navigation: { visible: true },
            parameters: {},
            rows: [{ id: "home", columns: [{ id: "home", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "Home" }] }] }],
          },
          {
            id: "settings",
            title: "Settings",
            navigation: { visible: true, recordId: recordShortId },
            parameters: { settings_id: { type: "record", tableId: tableShortId, required: true } },
            record: { tableId: tableShortId, id: { source: "PARAMS", path: "settings_id" } },
            rows: [
              {
                id: "settings",
                columns: [
                  { id: "settings", span: 12, blocks: [{ id: "details", type: "record", fieldIds: [fieldShortId], editableFieldIds: [] }] },
                ],
              },
            ],
          },
        ],
      };
      const valid = await compile(definition);
      expect(valid.ok).toBe(true);
      const formId = testUuid();
      const formShortId = testShortId("M");
      await sql`INSERT INTO grids.forms (id, short_id, table_id, name, config)
        VALUES (${formId}::uuid, ${formShortId}, ${tableId}::uuid, 'Company settings',
          ${{ fields: [{ kind: "user_input", fieldId }] }}::jsonb)`;
      definition.pages[1]!.rows[0]!.columns[0]!.blocks = [{ id: "edit", type: "form", formId: formShortId, mode: "edit", fixedValues: {} }];
      const editOnly = await compile(definition);
      expect(editOnly.ok).toBe(true);
      if (editOnly.ok) {
        expect(editOnly.compiled.capabilities.records[0]?.fieldIds).toEqual([]);
        expect(editOnly.compiled.capabilities.forms[0]?.formId).toBe(formId);
      }
      for (const invalidId of [testShortId("R"), otherRecordShortId]) {
        definition.pages[1]!.navigation.recordId = invalidId;
        const invalid = await compile(definition);
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) expect(invalid.diagnostics.some((issue) => issue.code === "navigation.record_invalid")).toBe(true);
      }
      definition.pages[1]!.navigation.recordId = recordShortId;
      await sql`UPDATE grids.records SET deleted_at = NOW() WHERE id = ${recordId}::uuid`;
      const deleted = await compile(definition);
      expect(deleted.ok).toBe(false);
      if (!deleted.ok) expect(deleted.diagnostics.some((issue) => issue.code === "navigation.record_invalid")).toBe(true);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
