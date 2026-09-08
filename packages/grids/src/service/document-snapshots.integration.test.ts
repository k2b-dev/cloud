import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { createRecordSnapshot, filterSnapshotRelatedRecords } from "./document-snapshots";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record snapshot relation access", () => {
  postgresTest("rejects a snapshot base that does not own the root table", async () => {
    const baseId = uuid();
    const wrongBaseId = uuid();
    const tableId = uuid();
    const recordId = uuid();
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES
          (${baseId}::uuid, ${shortId("B")}, 'Snapshot owner'),
          (${wrongBaseId}::uuid, ${shortId("B")}, 'Wrong snapshot owner')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Root', 0)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${recordId}::uuid, ${shortId("R")}, ${tableId}::uuid, '{}'::jsonb)
      `;

      const snapshot = await createRecordSnapshot({
        baseId: wrongBaseId,
        tableId,
        recordId,
        actorId: null,
        canReadTable: async () => true,
      });

      expect(snapshot.ok).toBe(false);
      if (snapshot.ok) throw new Error("Expected mismatched base rejection");
      expect(snapshot.error.message).toBe("The record does not belong to this base.");
      const [count] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM grids.record_snapshots WHERE record_id = ${recordId}::uuid
      `;
      expect(count?.count).toBe(0);
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id IN (${baseId}::uuid, ${wrongBaseId}::uuid)`;
      await sql`DELETE FROM grids.record_snapshots WHERE base_id IN (${baseId}::uuid, ${wrongBaseId}::uuid)`;
      await sql`DELETE FROM grids.bases WHERE id IN (${baseId}::uuid, ${wrongBaseId}::uuid)`;
    }
  });

  postgresTest("captures readable relation branches and omits denied branches", async () => {
    const baseId = uuid();
    const rootTableId = uuid();
    const readableTableId = uuid();
    const deniedTableId = uuid();
    const rootRecordId = uuid();
    const readableRecordId = uuid();
    const deniedRecordId = uuid();
    const readableRelationFieldId = uuid();
    const deniedRelationFieldId = uuid();
    const checkedTargets: string[] = [];

    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Snapshot ACL integration')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES
          (${rootTableId}::uuid, ${shortId("R")}, ${baseId}::uuid, 'Root', 0),
          (${readableTableId}::uuid, ${shortId("A")}, ${baseId}::uuid, 'Readable', 1),
          (${deniedTableId}::uuid, ${shortId("D")}, ${baseId}::uuid, 'Denied', 2)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${readableRelationFieldId}::uuid, ${shortId("L")}, ${rootTableId}::uuid, 'Readable link', 'relation', ${{ targetTableId: readableTableId }}::jsonb, 0),
          (${deniedRelationFieldId}::uuid, ${shortId("L")}, ${rootTableId}::uuid, 'Denied link', 'relation', ${{ targetTableId: deniedTableId }}::jsonb, 1),
          (${uuid()}::uuid, ${shortId("F")}, ${readableTableId}::uuid, 'Readable value', 'text', '{}'::jsonb, 0),
          (${uuid()}::uuid, ${shortId("F")}, ${deniedTableId}::uuid, 'Secret value', 'text', '{}'::jsonb, 0)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES
          (${rootRecordId}::uuid, ${shortId("R")}, ${rootTableId}::uuid, '{}'::jsonb),
          (${readableRecordId}::uuid, ${shortId("R")}, ${readableTableId}::uuid, '{}'::jsonb),
          (${deniedRecordId}::uuid, ${shortId("R")}, ${deniedTableId}::uuid, '{}'::jsonb)
      `;
      await sql`
        INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
        VALUES
          (${rootRecordId}::uuid, ${readableRelationFieldId}::uuid, ${readableRecordId}::uuid),
          (${rootRecordId}::uuid, ${deniedRelationFieldId}::uuid, ${deniedRecordId}::uuid)
      `;

      const snapshot = await createRecordSnapshot({
        baseId,
        tableId: rootTableId,
        recordId: rootRecordId,
        actorId: null,
        canReadTable: async (target) => {
          checkedTargets.push(target.tableId);
          return target.tableId === rootTableId || target.tableId === readableTableId ? true : false;
        },
      });

      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const graph = snapshot.data.graph as { records: Record<string, unknown> };
      expect(new Set(checkedTargets)).toEqual(new Set([rootTableId, readableTableId, deniedTableId]));
      expect(Object.keys(graph.records).sort()).toEqual(
        [`${rootTableId}:${rootRecordId}`, `${readableTableId}:${readableRecordId}`].sort(),
      );
      expect(graph.records[`${deniedTableId}:${deniedRecordId}`]).toBeUndefined();

      const completeSnapshot = await createRecordSnapshot({
        baseId,
        tableId: rootTableId,
        recordId: rootRecordId,
        actorId: null,
        canReadTable: async () => true,
      });
      if (!completeSnapshot.ok) throw new Error(completeSnapshot.error.message);
      const filtered = await filterSnapshotRelatedRecords(
        {
          ...completeSnapshot.data,
          graph: { ...completeSnapshot.data.graph, documentData: { secret: "must not escape" } },
        },
        async (target) => (target.tableId === readableTableId ? true : false),
      );
      const filteredGraph = filtered.graph as { records: Record<string, unknown> };
      expect(Object.keys(filtered.graph).sort()).toEqual(["records", "rootId"]);
      expect(Object.keys(filteredGraph.records).sort()).toEqual(
        [`${rootTableId}:${rootRecordId}`, `${readableTableId}:${readableRecordId}`].sort(),
      );
      expect(filteredGraph.records[`${deniedTableId}:${deniedRecordId}`]).toBeUndefined();
    } finally {
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.record_snapshots WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest(
    "captures a cyclic graph at the 500-record limit without repeated table authorization",
    async () => {
      const baseId = uuid();
      const tableId = uuid();
      const relationFieldId = uuid();
      const nameFieldId = uuid();
      const formulaFieldId = uuid();
      const lookupFieldId = uuid();
      const recordIds = Array.from({ length: 500 }, uuid);
      const recordShortIdPrefix = Math.random().toString(36).slice(2, 5).padEnd(3, "0");
      const recordShortIds = recordIds.map((_, index) => `R${recordShortIdPrefix}${index.toString(36).padStart(2, "0")}`);
      const relatedIds = recordIds.slice(1);
      const fromIds = [...relatedIds.map(() => recordIds[0]!), ...relatedIds];
      const targetIds = [...relatedIds, ...relatedIds.map(() => recordIds[0]!)];
      let permissionChecks = 0;
      try {
        await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Snapshot cycle')`;
        await sql`
          INSERT INTO grids.tables (id, short_id, base_id, name, position)
          VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Cycle', 0)
        `;
        await sql`
          INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
          VALUES
            (${relationFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Next', 'relation', ${{ targetTableId: tableId }}::jsonb, 0),
            (${nameFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 1),
            (${formulaFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Name length', 'formula', ${{ expression: "LEN(Name)" }}::jsonb, 2),
            (${lookupFieldId}::uuid, ${shortId("F")}, ${tableId}::uuid, 'Next name length', 'lookup', ${{ relationFieldId, targetFieldId: formulaFieldId }}::jsonb, 3)
        `;
        await sql`
          INSERT INTO grids.records (id, short_id, table_id, data)
          SELECT ids.id, ids.short_id, ${tableId}::uuid, jsonb_build_object(${nameFieldId}::text, 'Node')
          FROM unnest(
            ${sql.array(recordIds, "UUID")}::uuid[],
            ${sql.array(recordShortIds, "TEXT")}::text[]
          ) AS ids(id, short_id)
        `;
        await sql`
          INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
          SELECT links.from_id, ${relationFieldId}::uuid, links.to_id
          FROM unnest(
            ${sql.array(fromIds, "UUID")}::uuid[],
            ${sql.array(targetIds, "UUID")}::uuid[]
          ) AS links(from_id, to_id)
        `;

        const snapshot = await createRecordSnapshot({
          baseId,
          tableId,
          recordId: recordIds[0]!,
          actorId: null,
          canReadTable: async () => {
            permissionChecks += 1;
            return true;
          },
        });

        expect(snapshot.ok).toBe(true);
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        const graph = snapshot.data.graph as { records: Record<string, { data: Record<string, unknown> }> };
        expect(Object.keys(graph.records)).toHaveLength(500);
        expect(graph.records[`${tableId}:${recordIds[0]}`]?.data[lookupFieldId]).toBe("4");
        expect(permissionChecks).toBe(1);
      } finally {
        await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.record_snapshots WHERE base_id = ${baseId}::uuid`;
        await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      }
    },
    30_000,
  );
});
