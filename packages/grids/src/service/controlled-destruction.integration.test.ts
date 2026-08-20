import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { cancel, overview, processRun, start } from "./controlled-destruction";
import * as fields from "./fields";
import { protect, remove, upload } from "./files";
import { create as createHold } from "./preservation-holds";
import * as records from "./record-write";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const createFixture = async () => {
  const baseId = testUuid();
  const baseShortId = testShortId("B");
  const firstTableId = testUuid();
  const secondTableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Destruction fixture')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position) VALUES
      (${firstTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices', 0),
      (${secondTableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Cases', 1)
  `;
  await sql`INSERT INTO grids.retention_policies (base_id, minimum_days) VALUES (${baseId}::uuid, 30)`;
  return { baseId, baseShortId, firstTableId, secondTableId };
};

const createCandidate = async (baseId: string, tableId: string, name: string, ageDays: number) => {
  const field = await fields.create({ tableId, name: `${name} File`, type: "file", config: { maxFiles: 1 } }, null);
  if (!field.ok) throw field.error;
  const record = await records.create(tableId, {}, null, "direct");
  if (!record.ok) throw record.error;
  const file = await upload({
    tableId,
    recordId: record.data.id,
    fieldId: field.data.id,
    filename: `${name}.txt`,
    mimeType: "text/plain",
    bytes: new TextEncoder().encode(name),
    userId: null,
    origin: "direct",
  });
  if (!file.ok) throw file.error;
  const removed = await remove({
    tableId,
    recordId: record.data.id,
    fieldId: field.data.id,
    fileId: file.data.id,
    userId: null,
    origin: "direct",
  });
  if (!removed.ok) throw removed.error;
  await sql`
    UPDATE grids.file_retention_candidates SET unreferenced_at = now() - (${ageDays} * interval '1 day')
    WHERE file_id = ${file.data.id}::uuid
  `;
  return { fileId: file.data.id, fileShortId: file.data.shortId, recordId: record.data.id, fieldId: field.data.id };
};

const cleanup = async (baseId: string) => {
  await sql`DELETE FROM grids.controlled_destruction_runs WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.preservation_holds WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.file_retention_candidates WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  await sql`
    DELETE FROM grids.files file
    WHERE NOT EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = file.id)
  `;
};

describe("controlled File destruction", () => {
  postgresTest(
    "classifies bounded candidates and destroys only the exact eligible batch",
    async () => {
      const fixture = await createFixture();
      try {
        const eligible = await createCandidate(fixture.baseId, fixture.firstTableId, "eligible", 40);
        await createCandidate(fixture.baseId, fixture.firstTableId, "retained", 10);
        await createCandidate(fixture.baseId, fixture.secondTableId, "held", 40);
        const unknown = await createCandidate(fixture.baseId, fixture.firstTableId, "unknown", 40);
        await sql`
        UPDATE grids.file_retention_candidates
        SET table_id = NULL, table_short_id = NULL, table_name = NULL
        WHERE file_id = ${unknown.fileId}::uuid
      `;
        const hold = await createHold(
          fixture.baseId,
          { scope: { type: "table", tableId: fixture.secondTableId }, reason: "Case review" },
          { id: null, displayName: "Admin" },
        );
        expect(hold.ok).toBe(true);

        const before = await overview(fixture.baseId);
        expect(before.preview.counts).toMatchObject({ total: 4, eligible: 1, retained: 1, held: 1, unknown: 1 });
        expect(before.preview.items.map((item) => item.fileId)).toEqual([eligible.fileShortId]);
        const created = await start(
          fixture.baseId,
          {
            fileIds: before.preview.items.map((item) => item.fileId),
            confirmation: "Destruction fixture",
          },
          { id: null, displayName: "Admin" },
          async () => undefined,
        );
        if (!created.ok) throw created.error;
        const [run] = await sql<Array<{ id: string }>>`
        SELECT id::text FROM grids.controlled_destruction_runs WHERE short_id = ${created.data.id}
      `;
        if (!run) throw new Error("Missing destruction run");
        await processRun(run.id);
        await processRun(run.id);

        const completed = await overview(fixture.baseId);
        expect(completed.runs[0]).toMatchObject({ status: "completed", counts: { total: 1, destroyed: 1, skipped: 0, failed: 0 } });
        const [file] = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM grids.files WHERE id = ${eligible.fileId}::uuid) AS exists
      `;
        expect(file?.exists).toBe(false);
        const audits = await sql<Array<{ action: string; diff: Record<string, { old: unknown; new: unknown }> }>>`
        SELECT action, diff FROM grids.audit_log
        WHERE base_id = ${fixture.baseId}::uuid AND action LIKE 'controlled_destruction.%'
        ORDER BY created_at, id
      `;
        expect(audits.map((entry) => entry.action)).toEqual(["controlled_destruction.started", "controlled_destruction.file_destroyed"]);
        expect(JSON.stringify(audits)).not.toContain("bytes");
      } finally {
        await cleanup(fixture.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "rechecks floor drift and supports canceling an unprocessed durable run",
    async () => {
      const fixture = await createFixture();
      try {
        const first = await createCandidate(fixture.baseId, fixture.firstTableId, "first", 40);
        const second = await createCandidate(fixture.baseId, fixture.firstTableId, "second", 40);
        const preview = (await overview(fixture.baseId)).preview;
        const created = await start(
          fixture.baseId,
          { fileIds: preview.items.map((item) => item.fileId), confirmation: "Destruction fixture" },
          { id: null, displayName: "Admin" },
          async () => undefined,
        );
        if (!created.ok) throw created.error;
        await sql`UPDATE grids.retention_policies SET minimum_days = 365 WHERE base_id = ${fixture.baseId}::uuid`;
        const [run] = await sql<Array<{ id: string }>>`
        SELECT id::text FROM grids.controlled_destruction_runs WHERE short_id = ${created.data.id}
      `;
        if (!run) throw new Error("Missing destruction run");
        await processRun(run.id);
        const current = await overview(fixture.baseId);
        expect(current.runs[0]).toMatchObject({ status: "partial", counts: { destroyed: 0, skipped: 2 } });
        const [files] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.files WHERE id IN (${first.fileId}::uuid, ${second.fileId}::uuid)
      `;
        expect(files?.count).toBe(2);

        await sql`UPDATE grids.retention_policies SET minimum_days = 30 WHERE base_id = ${fixture.baseId}::uuid`;
        const cancelPreview = (await overview(fixture.baseId)).preview;
        const queued = await start(
          fixture.baseId,
          {
            fileIds: cancelPreview.items.map((item) => item.fileId),
            confirmation: "Destruction fixture",
          },
          { id: null, displayName: "Admin" },
          async () => undefined,
        );
        if (!queued.ok) throw queued.error;
        const canceled = await cancel(fixture.baseId, queued.data.id);
        expect(canceled.ok && canceled.data).toMatchObject({ status: "canceled", counts: { skipped: 2 } });
      } finally {
        await cleanup(fixture.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "skips Files that gain a reference or preservation hold after preview",
    async () => {
      const fixture = await createFixture();
      try {
        const reattached = await createCandidate(fixture.baseId, fixture.firstTableId, "reattached", 40);
        const newlyProtected = await createCandidate(fixture.baseId, fixture.firstTableId, "newly-protected", 40);
        const newlyHeld = await createCandidate(fixture.baseId, fixture.secondTableId, "newly-held", 40);
        const preview = (await overview(fixture.baseId)).preview;
        const created = await start(
          fixture.baseId,
          { fileIds: preview.items.map((item) => item.fileId), confirmation: "Destruction fixture" },
          { id: null, displayName: "Admin" },
          async () => undefined,
        );
        if (!created.ok) throw created.error;
        await sql`
        INSERT INTO grids.file_attachments (file_id, record_id, field_id)
        VALUES (${reattached.fileId}::uuid, ${reattached.recordId}::uuid, ${reattached.fieldId}::uuid)
      `;
        const protection = await protect({
          fileId: newlyProtected.fileId,
          ownerKind: "record_revision",
          ownerId: testUuid(),
          baseId: fixture.baseId,
          tableId: fixture.firstTableId,
          recordId: newlyProtected.recordId,
          userId: null,
        });
        if (!protection.ok) throw protection.error;
        const hold = await createHold(
          fixture.baseId,
          { scope: { type: "table", tableId: fixture.secondTableId }, reason: "Opened after preview" },
          { id: null, displayName: "Admin" },
        );
        if (!hold.ok) throw hold.error;
        const [run] = await sql<Array<{ id: string }>>`
        SELECT id::text FROM grids.controlled_destruction_runs WHERE short_id = ${created.data.id}
      `;
        if (!run) throw new Error("Missing destruction run");

        await processRun(run.id);

        const current = await overview(fixture.baseId);
        expect(current.runs[0]).toMatchObject({ status: "partial", counts: { destroyed: 0, skipped: 3, failed: 0 } });
        const [files] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.files
        WHERE id IN (${reattached.fileId}::uuid, ${newlyProtected.fileId}::uuid, ${newlyHeld.fileId}::uuid)
      `;
        expect(files?.count).toBe(3);
      } finally {
        await cleanup(fixture.baseId);
      }
    },
    15_000,
  );

  postgresTest(
    "rolls back a failed deletion and safely replays the same durable run",
    async () => {
      const fixture = await createFixture();
      const blockerTable = `controlled_destruction_blocker_${testUuid().replaceAll("-", "")}`;
      try {
        const candidate = await createCandidate(fixture.baseId, fixture.firstTableId, "retry", 40);
        const created = await start(
          fixture.baseId,
          { fileIds: [candidate.fileShortId], confirmation: "Destruction fixture" },
          { id: null, displayName: "Admin" },
          async () => undefined,
        );
        if (!created.ok) throw created.error;
        const [run] = await sql<Array<{ id: string }>>`
          SELECT id::text FROM grids.controlled_destruction_runs WHERE short_id = ${created.data.id}
        `;
        if (!run) throw new Error("Missing destruction run");
        await sql.unsafe(`CREATE TABLE grids."${blockerTable}" (file_id UUID PRIMARY KEY REFERENCES grids.files(id) ON DELETE RESTRICT)`);
        await sql.unsafe(`INSERT INTO grids."${blockerTable}" (file_id) VALUES ('${candidate.fileId}'::uuid)`);

        await expect(processRun(run.id)).rejects.toBeDefined();

        const failedAttempt = await overview(fixture.baseId);
        expect(failedAttempt.runs[0]).toMatchObject({ status: "running", counts: { processed: 0, destroyed: 0 } });
        const [retained] = await sql<Array<{ exists: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM grids.files WHERE id = ${candidate.fileId}::uuid) AS exists
        `;
        expect(retained?.exists).toBe(true);

        await sql.unsafe(`DROP TABLE grids."${blockerTable}"`);
        await processRun(run.id);
        const replayed = await overview(fixture.baseId);
        expect(replayed.runs[0]).toMatchObject({ status: "completed", counts: { destroyed: 1, failed: 0 } });
      } finally {
        await sql.unsafe(`DROP TABLE IF EXISTS grids."${blockerTable}"`);
        await cleanup(fixture.baseId);
      }
    },
    15_000,
  );
});
