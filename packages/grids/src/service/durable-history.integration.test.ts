import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { toPublicRecordRevisions } from "../api/durable-history";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { continueActivation, enable, getRevisionFileContent, getStatus, listRecordRevisions } from "./durable-history";
import * as fields from "./fields";
import * as files from "./files";
import * as records from "./record-write";
import * as tables from "./tables";

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const fixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  const targetTableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Durable history')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES
      (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Assets'),
      (${targetTableId}::uuid, ${testShortId("U")}, ${baseId}::uuid, 'Categories')
  `;
  const name = await fields.create({ tableId, name: "Name", type: "text", presentable: true }, null);
  const attachment = await fields.create({ tableId, name: "Attachment", type: "file", config: { maxFiles: 2 } }, null);
  const relation = await fields.create(
    { tableId, name: "Category", type: "relation", config: { targetTableId, cardinality: "single" } },
    null,
  );
  const targetName = await fields.create({ tableId: targetTableId, name: "Name", type: "text", presentable: true }, null);
  if (!name.ok || !attachment.ok || !relation.ok || !targetName.ok) throw new Error("fixture field creation failed");
  const target = await records.create(targetTableId, { [targetName.data.id]: "Camera" }, null, "direct");
  const record = await records.create(tableId, { [name.data.id]: "FX3" }, null, "direct");
  if (!target.ok || !record.ok) throw new Error("fixture record creation failed");
  return {
    baseId,
    tableId,
    targetTableId,
    nameFieldId: name.data.id,
    nameFieldShortId: name.data.shortId,
    fileFieldId: attachment.data.id,
    relationFieldId: relation.data.id,
    targetRecordId: target.data.id,
    targetRecordShortId: target.data.shortId,
    recordId: record.data.id,
  };
};

const destroy = async (baseId: string) => {
  await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.record_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id IN (SELECT id FROM grids.tables WHERE base_id = ${baseId}::uuid)`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  await sql`
    DELETE FROM grids.files file
    WHERE NOT EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM grids.file_protected_references protection WHERE protection.file_id = file.id)
  `;
};

const recordMutationState = async (recordId: string) => {
  const [state] = await sql<Array<{ version: number; revisions: number; audits: number; events: number }>>`
    SELECT
      record.version,
      (SELECT count(*)::int FROM grids.record_revisions WHERE record_id = record.id) AS revisions,
      (SELECT count(*)::int FROM grids.audit_log WHERE record_id = record.id) AS audits,
      (SELECT count(*)::int FROM grids.record_event_outbox WHERE record_id = record.id) AS events
    FROM grids.records record
    WHERE record.id = ${recordId}::uuid
  `;
  if (!state) throw new Error("Durable history mutation fixture record missing");
  return state;
};

describe("durable record history Postgres integration", () => {
  postgresTest("does not advance an activating baseline for a normalized no-op patch", async () => {
    const item = await fixture();
    try {
      const activated = await enable(item.tableId, null);
      expect(activated.ok).toBe(true);
      await sql`DELETE FROM grids.record_revisions WHERE record_id = ${item.recordId}::uuid`;
      await sql`
        UPDATE grids.durable_history_activations
        SET status = 'activating', baseline_completed_at = NULL
        WHERE table_id = ${item.tableId}::uuid
      `;
      const beforeNoop = await recordMutationState(item.recordId);

      const noop = await records.update(item.tableId, item.recordId, { [item.nameFieldId]: "FX3" }, null, "direct", beforeNoop.version);

      expect(noop.ok && noop.data.version).toBe(beforeNoop.version);
      expect(await recordMutationState(item.recordId)).toEqual(beforeNoop);

      const competing = await Promise.all([
        records.update(item.tableId, item.recordId, { [item.nameFieldId]: "FX4" }, null, "direct", beforeNoop.version),
        records.update(item.tableId, item.recordId, { [item.nameFieldId]: "FX5" }, null, "direct", beforeNoop.version),
      ]);
      expect(competing.filter((result) => result.ok)).toHaveLength(1);
      expect(competing.filter((result) => !result.ok && result.error.status === 409)).toHaveLength(1);
      expect(competing.find((result) => result.ok)?.data.version).toBe(beforeNoop.version + 1);
      expect((await recordMutationState(item.recordId)).revisions).toBe(2);
    } finally {
      await destroy(item.baseId);
    }
  });

  postgresTest("keeps defaults unchanged and captures exact record, relation, schema, and file states after opt-in", async () => {
    const item = await fixture();
    const actorId = testUuid();
    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${actorId}::uuid, ${`durable-actor-${actorId}`}, 'local', 'user', 'Original actor', 'Original', 'Actor')
      `;
      const initialStatus = await getStatus(item.tableId);
      expect(initialStatus.ok && initialStatus.data).toEqual({ enabled: false });
      expect((await records.update(item.tableId, item.recordId, { [item.nameFieldId]: "FX3 II" }, null, "direct")).ok).toBe(true);
      expect(
        (
          await sql<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM grids.record_revisions WHERE record_id = ${item.recordId}::uuid
          `
        )[0]?.count,
      ).toBe(0);

      const activated = await enable(item.tableId, actorId);
      expect(activated.ok && activated.data.enabled && activated.data.status).toBe("active");
      await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
      const createdAfterActivation = await records.create(item.tableId, { [item.nameFieldId]: "FX9" }, null, "direct");
      if (!createdAfterActivation.ok) throw createdAfterActivation.error;
      const createdHistory = await listRecordRevisions({
        tableId: item.tableId,
        recordId: createdAfterActivation.data.id,
      });
      expect(createdHistory.ok && createdHistory.data.items.map((revision) => revision.action)).toEqual(["created"]);
      const [activationAudit] = await sql<Array<{ action: string; diff: unknown }>>`
        SELECT action, diff
        FROM grids.audit_log
        WHERE table_id = ${item.tableId}::uuid AND action = 'durable_history.enabled'
      `;
      expect(activationAudit?.action).toBe("durable_history.enabled");
      expect(activationAudit?.diff).toMatchObject({ durableHistory: { old: false, new: { enabled: true } } });
      expect(
        (await records.update(item.tableId, item.recordId, { [item.relationFieldId]: [item.targetRecordId] }, null, "direct")).ok,
      ).toBe(true);
      const beforeNoop = await recordMutationState(item.recordId);
      const noop = await records.update(
        item.tableId,
        item.recordId,
        { [item.nameFieldId]: "FX3 II", [item.relationFieldId]: [item.targetRecordId] },
        null,
        "direct",
        beforeNoop.version,
      );
      expect(noop.ok && noop.data.version).toBe(beforeNoop.version);
      expect(await recordMutationState(item.recordId)).toEqual(beforeNoop);

      const stale = await records.update(
        item.tableId,
        item.recordId,
        { [item.nameFieldId]: "Must not land" },
        null,
        "direct",
        beforeNoop.version - 1,
      );
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.status).toBe(409);
      expect(await recordMutationState(item.recordId)).toEqual(beforeNoop);
      expect((await fields.update(item.nameFieldId, { name: "Asset name" }, null)).ok).toBe(true);
      expect((await records.update(item.tableId, item.recordId, { [item.nameFieldId]: "FX6" }, null, "direct")).ok).toBe(true);

      const added = await files.upload({
        tableId: item.tableId,
        recordId: item.recordId,
        fieldId: item.fileFieldId,
        filename: "manual.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("exact manual"),
        userId: null,
        origin: "direct",
      });
      if (!added.ok) throw added.error;
      const replaced = await files.replace({
        tableId: item.tableId,
        recordId: item.recordId,
        fieldId: item.fileFieldId,
        fileId: added.data.id,
        filename: "manual-v2.txt",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("exact manual v2"),
        userId: null,
        origin: "direct",
      });
      if (!replaced.ok) throw replaced.error;
      expect(
        (await files.remove({ ...item, fieldId: item.fileFieldId, fileId: replaced.data.id, userId: null, origin: "direct" })).ok,
      ).toBe(true);
      expect((await records.softDelete(item.tableId, item.recordId, null, "direct")).ok).toBe(true);
      expect((await records.restore(item.tableId, item.recordId, null, "direct")).ok).toBe(true);
      expect((await fields.softDelete(item.nameFieldId, null)).ok).toBe(true);
      expect((await records.softDelete(item.targetTableId, item.targetRecordId, null, "direct")).ok).toBe(true);

      const page = await listRecordRevisions({ tableId: item.tableId, recordId: item.recordId, limit: 20 });
      if (!page.ok) throw page.error;
      expect(
        page.data.items
          .map((revision) => revision.action)
          .sort()
          .join(","),
      ).toBe(["baseline", "updated", "updated", "file.added", "file.replaced", "file.removed", "deleted", "restored"].sort().join(","));
      const baseline = page.data.items.find((revision) => revision.action === "baseline")!;
      expect(baseline.data[item.nameFieldId]).toBe("FX3 II");
      expect(baseline.actorDisplayName).toBe("Original actor");
      const relationRevision = page.data.items.find(
        (revision) =>
          revision.action === "updated" &&
          revision.data[item.nameFieldId] === "FX3 II" &&
          revision.relations[item.relationFieldId]?.length === 1,
      )!;
      expect(relationRevision.relations[item.relationFieldId]).toEqual([item.targetRecordId]);
      expect(relationRevision.changedFieldIds).toEqual([item.relationFieldId]);
      const renamedRevision = page.data.items.find(
        (revision) => revision.action === "updated" && revision.data[item.nameFieldId] === "FX6",
      )!;
      expect(renamedRevision.schema.fields.find((field) => field.id === item.nameFieldId)?.name).toBe("Asset name");
      expect(renamedRevision.changedFieldIds).toEqual([item.nameFieldId]);

      const fileRevision = page.data.items.find((revision) => revision.action === "file.added")!;
      const content = await getRevisionFileContent({
        tableId: item.tableId,
        recordId: item.recordId,
        revisionShortId: fileRevision.shortId,
        fileId: added.data.id,
      });
      expect(content.ok && new TextDecoder().decode(content.data.bytes)).toBe("exact manual");
      const replacementRevision = page.data.items.find((revision) => revision.action === "file.replaced")!;
      const replacementContent = await getRevisionFileContent({
        tableId: item.tableId,
        recordId: item.recordId,
        revisionShortId: replacementRevision.shortId,
        fileId: replaced.data.id,
      });
      expect(replacementContent.ok && new TextDecoder().decode(replacementContent.data.bytes)).toBe("exact manual v2");

      const projected = await toPublicRecordRevisions(page.data.items);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain(item.nameFieldId);
      expect(serialized).not.toContain(item.relationFieldId);
      expect(serialized).not.toContain(item.targetRecordId);
      expect(projected.find((revision) => revision.action === "file.added")?.files[0]?.id).toBe(added.data.shortId);
      expect(
        projected.some((revision) => revision.fields.some((field) => field.id === item.nameFieldShortId && field.name === "Asset name")),
      ).toBe(true);
      expect(
        projected.some((revision) =>
          Object.values(revision.data).some((value) => Array.isArray(value) && value.includes(item.targetRecordShortId)),
        ),
      ).toBe(true);

      await sql`
        UPDATE grids.record_revisions
        SET created_at = '2026-08-18T12:00:00.123456Z'::timestamptz
        WHERE table_id = ${item.tableId}::uuid AND record_id = ${item.recordId}::uuid
      `;
      const pagedIds: string[] = [];
      let cursor: string | null = null;
      do {
        const paged = await listRecordRevisions({ tableId: item.tableId, recordId: item.recordId, limit: 2, cursor });
        if (!paged.ok) throw paged.error;
        pagedIds.push(...paged.data.items.map((revision) => revision.id));
        cursor = paged.data.nextCursor;
      } while (cursor);
      expect(pagedIds).toHaveLength(page.data.items.length);
      expect(new Set(pagedIds).size).toBe(pagedIds.length);

      expect((await tables.remove(item.tableId, null)).ok).toBe(true);
      expect((await tables.restore(item.tableId, null)).ok).toBe(true);
      const afterRestore = await listRecordRevisions({ tableId: item.tableId, recordId: item.recordId, limit: 20 });
      expect(afterRestore.ok && afterRestore.data.items).toHaveLength(page.data.items.length);
    } finally {
      await destroy(item.baseId);
      await sql`DELETE FROM auth.users WHERE id = ${actorId}::uuid`;
    }
  });

  postgresTest("finishes a resumable baseline without duplicates while a record changes concurrently", async () => {
    const item = await fixture();
    try {
      const rows = Array.from({ length: 130 }, (_, index) => ({ id: testUuid(), shortId: testShortId("R"), name: `Asset ${index}` }));
      for (const row of rows) {
        await sql`
          INSERT INTO grids.records (id, short_id, table_id, data)
          VALUES (${row.id}::uuid, ${row.shortId}, ${item.tableId}::uuid, ${{ [item.nameFieldId]: row.name }}::jsonb)
        `;
      }
      const first = await enable(item.tableId, null);
      expect(first.ok && first.data.enabled && first.data.status).toBe("activating");
      if (!first.ok || !first.data.enabled) throw new Error("activation failed");
      expect(first.data.baseline.captured).toBe(100);

      const [pending] = await sql<Array<{ id: string }>>`
        SELECT record.id::text AS id
        FROM grids.records record
        WHERE record.table_id = ${item.tableId}::uuid
          AND NOT EXISTS (SELECT 1 FROM grids.record_revisions revision WHERE revision.record_id = record.id AND revision.action = 'baseline')
        LIMIT 1
      `;
      if (!pending) throw new Error("missing pending baseline record");
      const [updated, completed] = await Promise.all([
        records.update(item.tableId, pending.id, { [item.nameFieldId]: "Changed during activation" }, null, "direct"),
        continueActivation(item.tableId),
      ]);
      expect(updated.ok).toBe(true);
      expect(completed.ok).toBe(true);
      const final = await continueActivation(item.tableId);
      expect(final.ok && final.data.enabled && final.data.status).toBe("active");
      if (!final.ok || !final.data.enabled) throw new Error("activation did not complete");
      expect(final.data.baseline).toEqual({ captured: 131, total: 131 });
      const [counts] = await sql<Array<{ baselines: number; distinct_records: number }>>`
        SELECT count(*)::int AS baselines, count(DISTINCT record_id)::int AS distinct_records
        FROM grids.record_revisions
        WHERE table_id = ${item.tableId}::uuid AND action = 'baseline'
      `;
      expect(counts).toEqual({ baselines: 131, distinct_records: 131 });
    } finally {
      await destroy(item.baseId);
    }
  });

  postgresTest("rolls back a record update when its required revision cannot be persisted", async () => {
    const item = await fixture();
    const functionName = `reject_revision_${item.recordId.replaceAll("-", "")}`;
    try {
      const activated = await enable(item.tableId, null);
      if (!activated.ok) throw activated.error;
      await sql.unsafe(`
        CREATE FUNCTION grids.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.record_id = '${item.recordId}'::uuid AND NEW.action = 'updated' THEN
            RAISE EXCEPTION 'intentional revision failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER ${functionName}
        BEFORE INSERT ON grids.record_revisions
        FOR EACH ROW EXECUTE FUNCTION grids.${functionName}()
      `);
      await expect(records.update(item.tableId, item.recordId, { [item.nameFieldId]: "Must roll back" }, null, "direct")).rejects.toThrow(
        "intentional revision failure",
      );
      const [record] = await sql<Array<{ data: Record<string, unknown> }>>`
        SELECT data FROM grids.records WHERE id = ${item.recordId}::uuid
      `;
      expect(record?.data[item.nameFieldId]).toBe("FX3");
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${functionName} ON grids.record_revisions`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS grids.${functionName}()`);
      await destroy(item.baseId);
    }
  });
});
