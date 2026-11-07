import { beforeAll, describe, expect, spyOn } from "bun:test";
import { sql } from "@k2b/cloud";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { projectPublicWorkspaceRecordDetail } from "../frontend/_components/workspace/workspace-public-state";
import { loadRecordDetailData } from "../frontend/_components/workspace/workspace-record-detail-state";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { gridsService } from ".";
import { listByTable as listFields } from "./fields";
import { get as getRecord } from "./record-read";

beforeAll(async () => {
  if (testInfra.database) await migrate();
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
    const targetRecordShortId = testShortId();
    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId()}, 'Audit history')`;
    await sql`
      INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${tableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Records')
    `;
    await sql`
      INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${targetTableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Cameras')
    `;
    await sql`
      INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
      VALUES
        (${relationFieldId}::uuid, ${testShortId()}, ${tableId}::uuid, 'Camera', 'relation',
         ${{ targetTableId }}::jsonb, 0),
        (${labelFieldId}::uuid, ${testShortId()}, ${targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
    `;
    await sql`UPDATE grids.fields SET presentable = TRUE WHERE id = ${labelFieldId}::uuid`;
    await sql`
      INSERT INTO grids.records (id, short_id, table_id, data)
      VALUES (${recordId}::uuid, ${testShortId()}, ${tableId}::uuid, '{}'::jsonb)
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
          (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'document.created', NULL, NULL),
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

      const record = await getRecord(tableId, recordId);
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
        "document.created",
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
        "document.created",
        "file.added",
        "record_snapshot.created",
        "unknown",
        "workflow.record.updated",
      ]);

      // The referenced record's detail brings the first page of its reverse relations, with short IDs only, so its
      // Links section shows both directions in the first paint.
      const target = await getRecord(targetTableId, targetRecordId);
      if (!target) throw new Error("Audit history fixture target missing");
      const targetDetail = await loadRecordDetailData({
        tableId: targetTableId,
        recordId: targetRecordId,
        record: target,
        fields: await listFields(targetTableId),
        viewer: { userId: null, userGroups: [], isAdmin: true },
      });
      expect(targetDetail.referencedBy?.items).toHaveLength(1);
      const targetPayload = await projectPublicWorkspaceRecordDetail(targetDetail, await listFields(targetTableId));
      expect(targetPayload.referencedBy).toEqual({
        items: [expect.objectContaining({ sourceRecordId: record.shortId, relationFieldName: "Camera" })],
        nextCursor: null,
      });
      expect(JSON.stringify(targetPayload.referencedBy)).not.toContain(recordId);

      // A reverse lookup that throws leaves the page to the browser; the rest of the detail still loads.
      const failing = spyOn(gridsService.record, "listReferencedBy").mockRejectedValueOnce(new Error("statement timeout"));
      try {
        const degraded = await loadRecordDetailData({
          tableId: targetTableId,
          recordId: targetRecordId,
          record: target,
          fields: await listFields(targetTableId),
          viewer: { userId: null, userGroups: [], isAdmin: true },
        });
        expect(degraded.referencedBy).toBeNull();
        expect(degraded.recordId).toBe(targetRecordId);
      } finally {
        failing.mockRestore();
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
