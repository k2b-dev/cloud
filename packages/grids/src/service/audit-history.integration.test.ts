import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { projectPublicWorkspaceRecordDetail } from "../frontend/_components/workspace/workspace-public-state";
import { loadRecordDetailData } from "../frontend/_components/workspace/workspace-record-detail-state";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { listByTable as listFields } from "./fields";
import { ALL_RECORD_ACCESS } from "./record-access";
import { get as getRecord } from "./record-read";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("record history storage boundary", () => {
  postgresTest("keeps Record events, omits operational events, and degrades unknown actions per entry", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const recordId = testUuid();
    const targetTableId = testUuid();
    const relationFieldId = testUuid();
    const labelFieldId = testUuid();
    const targetRecordId = testUuid();
    const targetRecordShortId = testShortId("R");
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Audit history')`;
    await sql`
      INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Records')
    `;
    await sql`
      INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${targetTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Cameras')
    `;
    await sql`
      INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
      VALUES
        (${relationFieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Camera', 'relation',
         ${{ targetTableId }}::jsonb, 0),
        (${labelFieldId}::uuid, ${testShortId("F")}, ${targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
    `;
    await sql`UPDATE grids.fields SET presentable = TRUE WHERE id = ${labelFieldId}::uuid`;
    await sql`
      INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${recordId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${targetRecordId}::uuid, ${targetRecordShortId}, ${targetTableId}::uuid, ${{ [labelFieldId]: "Camera" }}::jsonb)
    `;
    await sql`
      INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id, position)
      VALUES (${recordId}::uuid, ${relationFieldId}::uuid, ${targetRecordId}::uuid, 0)
    `;

    try {
      await sql`
        INSERT INTO grids.audit_log (base_id, table_id, record_id, action, diff, context)
        VALUES
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'record_snapshot.created',
           '{"snapshotId":{"old":null,"new":"snapshot"}}'::jsonb, NULL),
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'document.generated', NULL, NULL),
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'workflow.record.updated', NULL, NULL),
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'file.added', NULL, NULL),
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'future.record.event',
           '"invalid-diff"'::jsonb, '{"unexpected":true}'::jsonb)
      `;
      await sql`
        INSERT INTO grids.audit_log (base_id, table_id, record_id, action)
        SELECT ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'document_link.accessed'
        FROM generate_series(1, 60)
      `;

      const record = await getRecord(tableId, recordId, { recordAccess: ALL_RECORD_ACCESS });
      if (!record) throw new Error("Audit history fixture record missing");
      const fields = await listFields(tableId);
      const detail = await loadRecordDetailData({
        tableId,
        recordId,
        record,
        fields,
        viewer: { userId: null, userGroups: [], isAdmin: true },
      });
      expect(detail.auditEntries.map((entry) => entry.action).sort()).toEqual([
        "document.generated",
        "file.added",
        "record_snapshot.created",
        "unknown",
        "workflow.record.updated",
      ]);
      const futureEvent = detail.auditEntries.find((entry) => entry.action === "unknown");
      const snapshotEvent = detail.auditEntries.find((entry) => entry.action === "record_snapshot.created");
      expect(futureEvent?.diff).toBeNull();
      expect(futureEvent?.context).toBeNull();
      expect(snapshotEvent?.diff).toEqual({ snapshotId: { old: null, new: "snapshot" } });

      const payload = await projectPublicWorkspaceRecordDetail(detail, fields);
      expect(payload.recordId).toBe(record.shortId);
      expect(payload.relationLabels).toEqual({ [targetRecordShortId]: "Camera" });
      expect(payload.auditEntries.map((entry) => entry.action).sort()).toEqual([
        "document.generated",
        "file.added",
        "record_snapshot.created",
        "unknown",
        "workflow.record.updated",
      ]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
