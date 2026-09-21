import { beforeAll, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { customAppDocumentPreviewFingerprint } from "./custom-app-document-preview";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const withPreview = async (
  run: (fixture: {
    baseId: string;
    tableId: string;
    fieldId: string;
    templateId: string;
    userId: string;
    source: string;
    fingerprint: () => Promise<string | null>;
  }) => Promise<void>,
) => {
  const baseId = testUuid(),
    tableId = testUuid(),
    fieldId = testUuid(),
    templateId = testUuid(),
    userId = testUuid();
  const table = testShortId("T"),
    field = testShortId("F");
  const source = `from table {${table}}\nselect {${field}}\nwhere record.id = '{{ record.id }}'\nlimit 1`;
  try {
    await sql`INSERT INTO auth.users (id, uid, provider, profile, display_name)
      VALUES (${userId}::uuid, ${`preview-${userId}`}, 'local', 'user', 'Preview owner')`;
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Preview fingerprint')`;
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${tableId}::uuid, ${table}, ${baseId}::uuid, 'Drafts')`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type)
      VALUES (${fieldId}::uuid, ${field}, ${tableId}::uuid, 'Subject', 'text')`;
    await sql`INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
      VALUES (${templateId}::uuid, ${testShortId("D")}, ${tableId}::uuid, 'Preview', ${source}, 'html', '<p>Preview</p>', 'PREVIEW', 'preview.pdf')`;
    await run({
      baseId,
      tableId,
      fieldId,
      templateId,
      userId,
      source,
      fingerprint: () => customAppDocumentPreviewFingerprint(sql, baseId, tableId, templateId),
    });
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
};

postgresTest("table-backed preview ignores personal views and cosmetic schema edits but pins read semantics", async () => {
  await withPreview(async ({ baseId, tableId, fieldId, userId, fingerprint }) => {
    const original = await fingerprint();
    expect(original).toBeString();
    const unrelated = testUuid();
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${unrelated}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Unrelated')`;
    await sql`INSERT INTO grids.fields (short_id, table_id, name, type) VALUES (${testShortId("F")}, ${unrelated}::uuid, 'Other', 'text')`;
    expect(await fingerprint()).toBe(original);
    await sql`UPDATE grids.tables SET name = 'Renamed unrelated' WHERE id = ${unrelated}::uuid`;
    expect(await fingerprint()).toBe(original);
    const viewId = testUuid();
    await sql`INSERT INTO grids.views (id, short_id, base_id, table_id, name, source, owner_user_id)
      VALUES (${viewId}::uuid, ${testShortId("V")}, ${baseId}::uuid, ${tableId}::uuid,
        'My drafts', 'from table Drafts', ${userId}::uuid)`;
    expect(await fingerprint()).toBe(original);
    await sql`UPDATE grids.views SET name = 'My filtered drafts', source = 'from table Drafts limit 2',
      position = 7, ui = '{"hiddenFieldIds": []}'::jsonb WHERE id = ${viewId}::uuid`;
    expect(await fingerprint()).toBe(original);
    await sql`DELETE FROM grids.views WHERE id = ${viewId}::uuid`;
    await sql`UPDATE grids.tables SET position = 8, icon = 'ti ti-file', description = 'Cosmetic',
      display_config = '{"mode":"cards"}'::jsonb WHERE id = ${tableId}::uuid`;
    await sql`UPDATE grids.fields SET hide_in_table = true, description = 'Cosmetic', icon = 'ti ti-pencil'
      WHERE id = ${fieldId}::uuid`;
    expect(await fingerprint()).toBe(original);

    await sql`UPDATE grids.fields SET name = 'Renamed subject' WHERE id = ${fieldId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.fields SET name = 'Subject', config = '{"maxLength":10}'::jsonb WHERE id = ${fieldId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.fields SET config = '{}'::jsonb, required = true WHERE id = ${fieldId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.fields SET required = false WHERE id = ${fieldId}::uuid`;
    await sql`UPDATE grids.tables SET name = 'Renamed drafts' WHERE id = ${tableId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.tables SET name = 'Drafts' WHERE id = ${tableId}::uuid`;
    expect(await fingerprint()).toBe(original);
    await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fieldId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
  });
});

postgresTest("view-backed preview retains shared and personal view semantics but ignores view presentation", async () => {
  await withPreview(async ({ baseId, tableId, templateId, userId, fingerprint }) => {
    const viewId = testUuid(),
      view = testShortId("V");
    await sql`INSERT INTO grids.views (id, short_id, base_id, table_id, name, source)
      VALUES (${viewId}::uuid, ${view}, ${baseId}::uuid, ${tableId}::uuid, 'Saved drafts', 'from table Drafts')`;
    await sql`UPDATE grids.document_templates SET source = ${`from view {${view}}\nwhere record.id = '{{ record.id }}'\nlimit 1`}
      WHERE id = ${templateId}::uuid`;
    const original = await fingerprint();
    expect(original).toBeString();
    await sql`UPDATE grids.views SET position = 9, description = 'Cosmetic', icon = 'ti ti-file', ui = '{}'::jsonb
      WHERE id = ${viewId}::uuid`;
    expect(await fingerprint()).toBe(original);
    await sql`UPDATE grids.views SET source = 'from table Drafts limit 2' WHERE id = ${viewId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.views SET source = 'from table Drafts', name = 'Renamed drafts' WHERE id = ${viewId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
    await sql`UPDATE grids.views SET name = 'Saved drafts', owner_user_id = ${userId}::uuid WHERE id = ${viewId}::uuid`;
    // The trusted document resolver can read personal Views. Ownership alone
    // does not change this source, but its query remains a pinned dependency.
    expect(await fingerprint()).toBe(original);
    await sql`UPDATE grids.views SET source = 'from table Drafts limit 3' WHERE id = ${viewId}::uuid`;
    expect(await fingerprint()).not.toBe(original);
  });
});
