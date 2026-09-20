import { lockFinalizedSchema } from "./finalized-schema";
import { refreshLocalCalculations } from "./local-calculation-storage";
import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listByTable } from "./fields";
import { createReader } from "./record-read";
import { attachRelationExpansion } from "./relation-expansion";
import { lookupRecords } from "./relation-labels";
import type { GridRecord } from "./types";

// Raw SQL fixtures must materialize the same stored calculations as normal writes.
const materialize = (tableId: string) =>
  sql.begin(async (tx) => {
    await lockFinalizedSchema(tx, tableId);
    await refreshLocalCalculations(tx, tableId);
  });

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("relation expansion integration", () => {
  postgresTest("exposes every relation label in a readable Base and denies it without Base read access", async () => {
    const userId = testUuid();
    const baseId = testUuid();
    const sourceTableId = testUuid();
    const targetTableId = testUuid();
    const relationFieldId = testUuid();
    const lookupFieldId = testUuid();
    const nameFieldId = testUuid();
    const labelFieldId = testUuid();
    const sourceRecordId = testUuid();
    const targetRecordId = testUuid();
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${userId}::uuid, ${`expansion-${userId}`}, 'local', 'user', 'Expansion User', 'Expansion', 'User')
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Relation expansion')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
          (${sourceTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Source', 0),
          (${targetTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Target', 1)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position, presentable) VALUES
          (${relationFieldId}::uuid, ${testShortId("F")}, ${sourceTableId}::uuid, 'Target', 'relation', ${{ targetTableId }}::jsonb, 0, FALSE),
          (${lookupFieldId}::uuid, ${testShortId("F")}, ${sourceTableId}::uuid, 'Target name', 'lookup', ${{ relationFieldId, targetFieldId: labelFieldId }}::jsonb, 1, FALSE),
          (${nameFieldId}::uuid, ${testShortId("F")}, ${targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0, FALSE),
          (${labelFieldId}::uuid, ${testShortId("F")}, ${targetTableId}::uuid, 'Display name', 'formula', ${{ expression: 'IFEMPTY("Name", "Name")' }}::jsonb, 1, TRUE)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data) VALUES
          (${sourceRecordId}::uuid, ${testShortId("R")}, ${sourceTableId}::uuid, ${{ [relationFieldId]: [targetRecordId] }}::jsonb),
          (${targetRecordId}::uuid, ${testShortId("R")}, ${targetTableId}::uuid, ${{ [nameFieldId]: "Secret target" }}::jsonb)
      `;
      await sql`
        INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
        VALUES (${sourceRecordId}::uuid, ${relationFieldId}::uuid, ${targetRecordId}::uuid, 0)
      `;

      await materialize(targetTableId);
      const sourceFields = await listByTable(sourceTableId);
      const record = (): GridRecord => ({
        id: sourceRecordId,
        shortId: testShortId("R"),
        tableId: sourceTableId,
        data: { [relationFieldId]: [targetRecordId] },
        version: 1,
        deletedAt: null,
        createdBy: null,
        updatedBy: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const denied = record();
      await attachRelationExpansion([denied], sourceFields, { userId, userGroups: [] });
      expect(denied.expanded).toBeUndefined();
      const deniedRead = await (await createReader(sourceTableId, { fields: sourceFields, viewer: { userId, userGroups: [] } })).get(
        sourceRecordId,
      );
      expect(deniedRead?.data[lookupFieldId]).toBeUndefined();

      const accessId = testUuid();
      await sql`
        INSERT INTO auth.access (id, user_id, permission)
        VALUES (${accessId}::uuid, ${userId}::uuid, 'read'::auth.permission_level)
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${accessId}::uuid)`;
      const readable = record();
      await attachRelationExpansion([readable], sourceFields, { userId, userGroups: [] });
      expect(readable.expanded).toEqual({ [targetRecordId]: { [labelFieldId]: "Secret target" } });
      expect((await lookupRecords({ targetTableId })).items).toEqual([{ id: targetRecordId, label: "Secret target" }]);
      expect((await lookupRecords({ targetTableId, q: "secret" })).items).toEqual([{ id: targetRecordId, label: "Secret target" }]);
      expect((await lookupRecords({ targetTableId, q: "missing" })).items).toEqual([]);
      const readableRead = await (await createReader(sourceTableId, { fields: sourceFields, viewer: { userId, userGroups: [] } })).get(
        sourceRecordId,
      );
      expect(readableRead?.data[lookupFieldId]).toBe("Secret target");

      await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${targetRecordId}::uuid`;
      const deleted = record();
      await attachRelationExpansion([deleted], sourceFields, { userId, userGroups: [] });
      expect(deleted.expanded).toBeUndefined();
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
