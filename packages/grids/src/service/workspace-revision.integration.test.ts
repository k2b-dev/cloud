import { expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { createBlank, saveDraft } from "./custom-apps";
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
