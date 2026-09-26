import { expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { createBlank, saveDraft } from "./custom-apps";
import { createInTransaction } from "./record-write";
import { loadWorkspaceRevision } from "./workspace-revision";

postgresTest("workspace revision changes for structure, not record writes, and isolates Bases", async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  const tableShortId = testShortId("T");
  const fieldId = testUuid();
  const recordId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Live revision test')`;
  try {
    const empty = await loadWorkspaceRevision(baseId);
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Items')`;
    const created = await loadWorkspaceRevision(baseId);
    expect(created.revision).not.toBe(empty.revision);
    expect(created.resources[`table:${tableShortId}`]).toBeString();
    await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
    await sql`UPDATE grids.records SET data = '{"name":"changed"}'::jsonb WHERE id = ${recordId}::uuid`;
    expect(await loadWorkspaceRevision(baseId)).toEqual(created);
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb)`;
    const fieldAdded = await loadWorkspaceRevision(baseId);
    expect(fieldAdded.resources[`table:${tableShortId}`]).not.toBe(created.resources[`table:${tableShortId}`]);
    await sql`UPDATE grids.fields SET config = '{"maxLength":100}'::jsonb WHERE id = ${fieldId}::uuid`;
    expect((await loadWorkspaceRevision(baseId)).revision).not.toBe(fieldAdded.revision);
    expect(await loadWorkspaceRevision(testUuid())).toEqual({ revision: "d41d8cd98f00b204e9800998ecf8427e", resources: {} });
    await sql`UPDATE grids.tables SET deleted_at = now() WHERE id = ${tableId}::uuid`;
    expect((await loadWorkspaceRevision(baseId)).resources[`table:${tableShortId}`]).toBeUndefined();
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("presentation, ordering, and policy writes leave the structure revision alone", async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  const tableShortId = testShortId("T");
  const viewShortId = testShortId("V");
  const fieldId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Presentation revision test')`;
  try {
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Items')`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb)`;
    await sql`INSERT INTO grids.views (short_id, table_id, base_id, name, source) VALUES (${viewShortId}, ${tableId}::uuid, ${baseId}::uuid, 'All', 'from Items')`;
    const baseline = await loadWorkspaceRevision(baseId);
    const table = () => loadWorkspaceRevision(baseId).then((r) => r.resources[`table:${tableShortId}`]);
    const view = () => loadWorkspaceRevision(baseId).then((r) => r.resources[`view:${viewShortId}`]);

    // The same tab writes these while resizing columns, switching the display mode, or reordering fields.
    await sql`UPDATE grids.tables SET columns = ${JSON.stringify([{ fieldId, width: 320 }])}::jsonb, display_config = '{"mode":"cards"}'::jsonb,
      mutation_policy = '{"mode":"none"}'::jsonb, description = 'Renamed', icon = 'ti ti-box', position = 7, updated_at = now() WHERE id = ${tableId}::uuid`;
    await sql`UPDATE grids.fields SET position = 3, description = 'Help', icon = 'ti ti-abc', hide_in_table = true, indexed = true, updated_at = now() WHERE id = ${fieldId}::uuid`;
    await sql`UPDATE grids.views SET ui = '{"columns":[]}'::jsonb, name = 'Renamed view', position = 2, updated_at = now() WHERE short_id = ${viewShortId}`;
    expect(await loadWorkspaceRevision(baseId)).toEqual(baseline);

    await sql`UPDATE grids.tables SET name = 'Products' WHERE id = ${tableId}::uuid`;
    const renamed = await table();
    expect(renamed).not.toBe(baseline.resources[`table:${tableShortId}`]);
    await sql`UPDATE grids.fields SET required = true WHERE id = ${fieldId}::uuid`;
    const required = await table();
    expect(required).not.toBe(renamed);
    await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fieldId}::uuid`;
    expect(await table()).not.toBe(required);
    expect(await view()).toBe(baseline.resources[`view:${viewShortId}`]);
    await sql`UPDATE grids.views SET source = 'from Items limit 5' WHERE short_id = ${viewShortId}`;
    expect(await view()).not.toBe(baseline.resources[`view:${viewShortId}`]);
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("a record write against a deleted field fails on the server", async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  const fieldId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Deleted field test')`;
  try {
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Items')`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config) VALUES (${fieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb)`;
    await sql`UPDATE grids.fields SET deleted_at = now() WHERE id = ${fieldId}::uuid`;
    const result = await sql.begin((tx) => createInTransaction(tx, tableId, { [fieldId]: "stale" }, null, "direct"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 400, message: "The request contains an unknown field." });
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});

postgresTest("draft save acknowledges exactly its own committed row, not a later competing edit", async () => {
  const baseId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Draft revision test')`;
  try {
    const created = await createBlank(baseId, "Editor");
    if (!created.ok || !created.data.draftDefinition) throw Error("Could not create fixture app");
    const saved = await saveDraft(created.data.id, created.data.draftDefinition);
    if (!saved.ok) throw Error(saved.error.message);
    expect((await loadWorkspaceRevision(baseId)).resources[`app:${created.data.shortId}`]).toBe(saved.data.workspaceRevision);
    await sql`UPDATE grids.custom_apps SET name = 'Other edit' WHERE id = ${created.data.id}::uuid`;
    expect((await loadWorkspaceRevision(baseId)).resources[`app:${created.data.shortId}`]).not.toBe(saved.data.workspaceRevision);
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
});
