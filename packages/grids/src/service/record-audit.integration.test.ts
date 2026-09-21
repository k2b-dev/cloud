import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import type { TableAuditPolicy } from "../contracts";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { get } from "./record-read";
import { create, restore, softDelete, update } from "./record-write";
import { update as updateTable } from "./tables";

const postgresTest = testFor("database");
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("record audit requirements Postgres integration", () => {
  postgresTest("rejects protected writes atomically and stores accepted answer snapshots", async () => {
    const baseId = Bun.randomUUIDv7();
    const tableId = Bun.randomUUIDv7();
    const updateQuestionId = Bun.randomUUIDv7();
    const deleteQuestionId = Bun.randomUUIDv7();
    const restoreQuestionId = Bun.randomUUIDv7();

    await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Audit requirements')`;
    await sql`
      INSERT INTO grids.tables (id, short_id, base_id, name)
      VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Assets')
    `;

    try {
      const createdField = await fields.create({ tableId, name: "Status", type: "text" }, null);
      if (!createdField.ok) throw new Error(createdField.error.message);
      const fieldId = createdField.data.id;
      const policy: TableAuditPolicy = {
        update: {
          enabled: true,
          scope: "selected",
          fieldIds: [fieldId],
          questions: [{ id: updateQuestionId, label: "Change reason", type: "longtext", required: true }],
        },
        delete: {
          enabled: true,
          questions: [{ id: deleteQuestionId, label: "Deletion reason", type: "text", required: true }],
        },
        restore: {
          enabled: true,
          questions: [{ id: restoreQuestionId, label: "Restore reason", type: "text", required: true }],
        },
      };
      await sql`UPDATE grids.tables SET audit_policy = ${policy}::jsonb WHERE id = ${tableId}::uuid`;

      const blockedFieldDelete = await fields.softDelete(fieldId, null);
      expect(blockedFieldDelete.ok).toBe(false);
      if (!blockedFieldDelete.ok) expect(blockedFieldDelete.error.status).toBe(409);
      expect((await fields.get(fieldId))?.deletedAt).toBeNull();

      const created = await create(tableId, { [fieldId]: "Available" }, null, "direct");
      if (!created.ok) throw new Error(created.error.message);
      const recordId = created.data.id;

      expect((await update(tableId, recordId, { [fieldId]: "Available" }, null, "direct")).ok).toBe(true);
      expect((await update(tableId, recordId, { [fieldId]: "Retired" }, null, "direct")).ok).toBe(false);
      expect((await get(tableId, recordId))?.data[fieldId]).toBe("Available");

      const updated = await update(tableId, recordId, { [fieldId]: "Retired" }, null, "direct", undefined, {
        audit: { answers: { [updateQuestionId]: "Annual inventory review" } },
      });
      expect(updated.ok).toBe(true);

      expect((await softDelete(tableId, recordId, null, "direct")).ok).toBe(false);
      expect((await get(tableId, recordId))?.deletedAt).toBeNull();
      expect((await softDelete(tableId, recordId, null, "direct", { answers: { [deleteQuestionId]: "Decommissioned" } })).ok).toBe(true);

      expect((await restore(tableId, recordId, null, "direct")).ok).toBe(false);
      const [deletedRecord] = await sql<{ deleted_at: Date | null }[]>`
        SELECT deleted_at
        FROM grids.records
        WHERE table_id = ${tableId}::uuid AND id = ${recordId}::uuid
      `;
      expect(deletedRecord?.deleted_at).not.toBeNull();
      expect((await restore(tableId, recordId, null, "direct", { answers: { [restoreQuestionId]: "Returned to service" } })).ok).toBe(true);

      const renamedPolicy: TableAuditPolicy = {
        update: {
          ...policy.update!,
          questions: [{ ...policy.update!.questions[0]!, label: "Renamed change reason" }],
        },
        delete: {
          ...policy.delete!,
          questions: [{ ...policy.delete!.questions[0]!, label: "Renamed deletion reason" }],
        },
        restore: {
          ...policy.restore!,
          questions: [{ ...policy.restore!.questions[0]!, label: "Renamed restore reason" }],
        },
      };
      expect((await updateTable(tableId, { auditPolicy: renamedPolicy }, null)).ok).toBe(true);

      const rows = await sql<
        Array<{
          action: string;
          context: {
            questions: Array<{ label: string }>;
            answers: Array<{ label: string; value: string }>;
          } | null;
        }>
      >`
        SELECT action, context
        FROM grids.audit_log
        WHERE table_id = ${tableId}::uuid AND record_id = ${recordId}::uuid AND context IS NOT NULL
        ORDER BY created_at
      `;
      expect(rows.map((row) => [row.action, row.context?.answers[0]?.label, row.context?.answers[0]?.value])).toEqual([
        ["updated", "Change reason", "Annual inventory review"],
        ["deleted", "Deletion reason", "Decommissioned"],
        ["restored", "Restore reason", "Returned to service"],
      ]);
      expect(rows.map((row) => row.context?.questions[0]?.label)).toEqual(["Change reason", "Deletion reason", "Restore reason"]);

      const disabledUpdatePolicy: TableAuditPolicy = {
        update: { ...policy.update!, enabled: false },
      };
      expect((await updateTable(tableId, { auditPolicy: disabledUpdatePolicy }, null)).ok).toBe(true);
      expect((await fields.softDelete(fieldId, null)).ok).toBe(true);
      expect((await updateTable(tableId, { description: "Policy remains editable" }, null)).ok).toBe(true);
      expect((await updateTable(tableId, { auditPolicy: { update: policy.update } }, null)).ok).toBe(false);

      const concurrentField = await fields.create({ tableId, name: "Concurrent status", type: "text" }, null);
      if (!concurrentField.ok) throw new Error(concurrentField.error.message);
      const concurrentPolicy: TableAuditPolicy = {
        update: {
          enabled: true,
          scope: "selected",
          fieldIds: [concurrentField.data.id],
          questions: [{ id: Bun.randomUUIDv7(), label: "Concurrent reason", type: "text", required: true }],
        },
      };
      const [policyUpdate, fieldDelete] = await Promise.all([
        updateTable(tableId, { auditPolicy: concurrentPolicy }, null),
        fields.softDelete(concurrentField.data.id, null),
      ]);
      expect(Number(policyUpdate.ok) + Number(fieldDelete.ok)).toBe(1);

      const finalField = await fields.get(concurrentField.data.id);
      const [finalTable] = await sql<Array<{ audit_policy: TableAuditPolicy }>>`
        SELECT audit_policy
        FROM grids.tables
        WHERE id = ${tableId}::uuid
      `;
      if (policyUpdate.ok) {
        expect(fieldDelete.ok).toBe(false);
        expect(finalField?.deletedAt).toBeNull();
        expect(finalTable?.audit_policy).toEqual(concurrentPolicy);
      } else {
        expect(fieldDelete.ok).toBe(true);
        expect(finalField?.deletedAt).not.toBeNull();
        expect(finalTable?.audit_policy.update?.enabled).toBe(false);
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
