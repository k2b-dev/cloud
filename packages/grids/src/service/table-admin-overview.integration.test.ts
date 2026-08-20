import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { enable as enableDurableHistory } from "./durable-history";
import { list } from "./table-admin-overview";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Table administration overview", () => {
  postgresTest("returns bounded Table metadata and filters it in SQL", async () => {
    const baseId = testUuid();
    const storedId = testUuid();
    const combinedId = testUuid();
    const groupId = testUuid();
    const groupName = `Final reviewers ${groupId}`;
    try {
      await sql`INSERT INTO auth.groups (id, cn, provider, name) VALUES (${groupId}::uuid, ${`overview-${groupId}`}, 'local', ${groupName})`;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Overview')`;
      await sql`
      INSERT INTO grids.tables (id, short_id, base_id, kind, name, position, disable_direct_insert, mutation_policy) VALUES
        (${storedId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'stored', 'Cases', 0, FALSE, '{"mode":"selected","sources":["direct"]}'::jsonb),
        (${combinedId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'federated', 'Combined cases', 1, TRUE, '{"mode":"all"}'::jsonb)
    `;
      await sql`
      INSERT INTO grids.fields (id, short_id, table_id, name, type, indexed, unique_constraint, position) VALUES
        (${testUuid()}::uuid, ${testShortId("F")}, ${storedId}::uuid, 'Name', 'text', TRUE, FALSE, 0),
        (${testUuid()}::uuid, ${testShortId("F")}, ${storedId}::uuid, 'Case ID', 'text', FALSE, TRUE, 1)
    `;
      const history = await enableDurableHistory(storedId, null);
      if (!history.ok) throw history.error;
      await sql`
      INSERT INTO grids.table_finalization_activations (table_id, mode, approver_group_id)
      VALUES (${storedId}::uuid, 'four_eyes', ${groupId}::uuid)
    `;

      const page = await list(baseId, { page: 1, perPage: 1 });
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);

      const filtered = await list(baseId, { kind: "stored", history: "active", finalization: "fourEyes" });
      expect(filtered.items).toEqual([
        expect.objectContaining({
          id: storedId,
          name: "Cases",
          kind: "stored",
          fieldCount: 2,
          indexedFieldCount: 1,
          uniqueFieldCount: 1,
          durableHistory: "active",
          finalizationMode: "fourEyes",
          approverGroupId: groupId,
          approverGroupName: groupName,
          mutationPolicy: { mode: "selected", sources: ["direct"] },
        }),
      ]);
      expect((await list(baseId, { q: "Combined", kind: "combined", finalization: "off" })).items).toHaveLength(1);
    } finally {
      await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${storedId}::uuid`;
      await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${storedId}::uuid`;
      await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${storedId}::uuid`;
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });
});
