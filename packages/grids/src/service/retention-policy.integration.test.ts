import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { get, getFileContent, listFiles, listRecords, preview, remove, update } from "./retention-policy";

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("Record retention policy integration", () => {
  postgresTest("keeps the default unchanged and derives bounded eligibility without deleting Records", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const schemaRevisionId = testUuid();
    const finalRevisionId = testUuid();
    const oldRecordId = testUuid();
    const recentRecordId = testUuid();
    const finalRecordId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const oldShortId = testShortId("O");
    const recentShortId = testShortId("R");
    const finalShortId = testShortId("F");
    const boundedPrefix = testShortId("X").slice(0, 2);
    const boundedFilePrefix = testShortId("L").slice(0, 2);
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Retention fixture')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')`;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, deleted_at) VALUES
          (${oldRecordId}::uuid, ${oldShortId}, ${tableId}::uuid, '{}'::jsonb, now() - interval '100 days'),
          (${recentRecordId}::uuid, ${recentShortId}, ${tableId}::uuid, '{}'::jsonb, now() - interval '10 days'),
          (${finalRecordId}::uuid, ${finalShortId}, ${tableId}::uuid, '{}'::jsonb, now() - interval '200 days')
      `;
      await sql`INSERT INTO grids.table_schema_revisions (id, table_id, schema_hash, fields) VALUES (${schemaRevisionId}::uuid, ${tableId}::uuid, ${"a".repeat(64)}, '{}'::jsonb)`;
      await sql`
        INSERT INTO grids.record_revisions (id, short_id, table_id, record_id, schema_revision_id, revision_no, action, record_version, data)
        VALUES (${finalRevisionId}::uuid, ${testShortId("V")}, ${tableId}::uuid, ${finalRecordId}::uuid, ${schemaRevisionId}::uuid, 1, 'finalized', 1, '{}'::jsonb)
      `;
      await sql`UPDATE grids.records SET finalized_at = now() - interval '200 days', final_revision_id = ${finalRevisionId}::uuid WHERE id = ${finalRecordId}::uuid`;

      expect(await get(baseId)).toBeNull();
      const saved = await update(baseId, { minimumDays: 30 }, null);
      expect(saved.minimumDays).toBe(30);
      const impact = await preview(baseId, { minimumDays: 30 });
      expect(impact.counts).toEqual({ trashedRecords: 3, floorReached: 1, retainedUntilLater: 1, protectedFinalized: 1 });
      expect(impact.files).toEqual({
        counts: { unreferenced: 0, floorReached: 0, retainedUntilLater: 0, sizeBytes: 0 },
        examples: [],
        truncated: false,
      });
      expect(impact.examples.map((item) => item.recordId)).toEqual([oldShortId, recentShortId]);
      expect(impact.examples.every((item) => item.tableId === tableShortId)).toBe(true);
      expect(impact.truncated).toBe(false);
      const recordPage = await listRecords(baseId, {
        minimumDays: 30,
        search: "Cases",
        status: "all",
        perPage: 2,
        offset: 0,
      });
      expect(recordPage.total).toBe(3);
      expect(recordPage.items).toHaveLength(2);
      expect(recordPage.items.map((item) => item.recordId)).toEqual([recentShortId, oldShortId]);
      expect(recordPage.items.every((item) => item.tableId === tableShortId && item.tableName === "Cases")).toBe(true);
      expect(recordPage.items.map((item) => item.status)).toEqual(["retained", "reached"]);
      const protectedRecords = await listRecords(baseId, {
        minimumDays: 30,
        search: finalShortId,
        status: "protected",
        perPage: 25,
        offset: 0,
      });
      expect(protectedRecords.items).toEqual([
        {
          recordId: finalShortId,
          tableId: tableShortId,
          tableName: "Cases",
          deletedAt: expect.any(String),
          notBefore: null,
          status: "protected",
        },
      ]);
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, deleted_at)
        SELECT gen_random_uuid(), ${boundedPrefix} || lpad(value::text, 4, '0'), ${tableId}::uuid, '{}'::jsonb, now() - interval '100 days'
        FROM generate_series(1, 101) value
      `;
      const bounded = await preview(baseId, { minimumDays: 30 });
      expect(bounded.examples).toHaveLength(100);
      expect(bounded.truncated).toBe(true);
      await sql`
        WITH inserted AS (
          INSERT INTO grids.files (short_id, filename, mime_type, size_bytes, sha256, bytes)
          SELECT ${boundedFilePrefix} || lpad(value::text, 4, '0'), 'retention-candidate-' || value || '.txt',
            'text/plain', 1, repeat('a', 64), decode('78', 'hex')
          FROM generate_series(1, 101) value
          RETURNING id
        )
        INSERT INTO grids.file_retention_candidates (file_id, base_id, unreferenced_at)
        SELECT id, ${baseId}::uuid, now() - interval '10 days' FROM inserted
      `;
      const fileImpact = await preview(baseId, { minimumDays: 30 });
      expect(fileImpact.files.counts).toEqual({ unreferenced: 101, floorReached: 0, retainedUntilLater: 101, sizeBytes: 101 });
      expect(fileImpact.files.examples).toHaveLength(100);
      expect(fileImpact.files.examples.every((item) => item.fileId.startsWith(boundedFilePrefix))).toBe(true);
      expect(fileImpact.files.truncated).toBe(true);
      await sql`
        UPDATE grids.file_retention_candidates candidate
        SET unreferenced_at = now() - interval '40 days'
        FROM grids.files file
        WHERE candidate.file_id = file.id AND candidate.base_id = ${baseId}::uuid AND file.filename = 'retention-candidate-1.txt'
      `;
      const firstPage = await listFiles(baseId, {
        minimumDays: 30,
        search: "retention-candidate",
        status: "all",
        perPage: 2,
        offset: 0,
      });
      expect(firstPage.total).toBe(101);
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.items[0]).toMatchObject({ filename: "retention-candidate-1.txt", status: "reached" });
      expect(firstPage.items[0]!.fileId).toMatch(/^[A-Za-z0-9]{6}$/);
      const retained = await listFiles(baseId, {
        minimumDays: 30,
        search: "candidate-2.txt",
        status: "retained",
        perPage: 25,
        offset: 0,
      });
      expect(retained.total).toBe(1);
      expect(retained.items[0]).toMatchObject({ filename: "retention-candidate-2.txt", status: "retained" });
      const [contentTarget] = await sql<Array<{ id: string }>>`
        SELECT id FROM grids.files WHERE filename = 'retention-candidate-1.txt'
      `;
      const content = await getFileContent(baseId, contentTarget!.id);
      expect(content.ok).toBe(true);
      if (content.ok) {
        expect(content.data.filename).toBe("retention-candidate-1.txt");
        expect(new TextDecoder().decode(content.data.bytes)).toBe("x");
      }
      expect((await getFileContent(testUuid(), contentTarget!.id)).ok).toBe(false);
      const [records] = await sql<
        Array<{ count: number }>
      >`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${tableId}::uuid`;
      expect(records?.count).toBe(104);
      expect(await remove(baseId, null)).toBe(true);
      expect(await remove(baseId, null)).toBe(false);
      expect(await get(baseId)).toBeNull();
      const audits = await sql<
        Array<{ action: string }>
      >`SELECT action FROM grids.audit_log WHERE base_id = ${baseId}::uuid ORDER BY created_at`;
      expect(audits.map((entry) => entry.action)).toEqual(["retention_policy.updated", "retention_policy.removed"]);
    } finally {
      await sql`DELETE FROM grids.file_retention_candidates WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.files WHERE filename LIKE 'retention-candidate-%'`;
      await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
      await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.record_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${tableId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
