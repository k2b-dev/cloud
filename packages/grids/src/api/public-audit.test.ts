import { describe, expect, test } from "bun:test";
import type { Field } from "../contracts";
import type { CombinedAuditPage } from "../service/combined-audit";
import type { projectPublicIds } from "../service/public-resources";
import type { RecordHistoryAction, RecordHistoryEntry } from "../service/record-history";
import { PublicRecordHistoryEntrySchema, toPublicAuditEntries, toPublicCombinedAuditPage } from "./public-audit";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const textFieldId = "44444444-4444-4444-8444-444444444444";
const relationFieldId = "55555555-5555-4555-8555-555555555555";
const deletedFieldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const oldRelatedRecordId = "66666666-6666-4666-8666-666666666666";
const newRelatedRecordId = "77777777-7777-4777-8777-777777777777";
const removedRelatedRecordId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const auditEntryId = "88888888-8888-4888-8888-888888888888";
const actorUserId = "99999999-9999-4999-8999-999999999999";
const now = "2026-08-15T12:00:00.000Z";

const field = (id: string, shortId: string, type: string): Field => ({
  id,
  shortId,
  tableId,
  name: shortId,
  description: null,
  type,
  config: {},
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});

const fields = [field(textFieldId, "TEXT01", "text"), field(relationFieldId, "RELA01", "relation")];
const publicIds = new Map([
  [baseId, "BASE01"],
  [tableId, "TABL01"],
  [recordId, "RECD01"],
  [oldRelatedRecordId, "RECD02"],
  [newRelatedRecordId, "RECD03"],
]);
const projectIds: typeof projectPublicIds = async (_type, ids) =>
  new Map(ids.map((id) => [id, publicIds.get(id)]).filter((entry): entry is [string, string] => entry[1] !== undefined));

const storedEntry: RecordHistoryEntry = {
  id: auditEntryId,
  baseId,
  tableId,
  recordId,
  userId: actorUserId,
  action: "updated",
  diff: {
    [textFieldId]: { old: "before", new: "after" },
    [relationFieldId]: { old: [oldRelatedRecordId, removedRelatedRecordId], new: newRelatedRecordId },
    [deletedFieldId]: { old: "legacy", new: null },
  },
  context: null,
  ip: null,
  userAgent: null,
  createdAt: now,
  userDisplayName: "Audit actor",
  userAvatarHash: null,
};

describe("public record audit boundary", () => {
  test("projects nested Grids references while retaining audit and actor UUIDs", async () => {
    const [entry] = await toPublicAuditEntries([storedEntry], fields, projectIds);

    expect(entry?.id).toBe(auditEntryId);
    expect(entry?.userId).toBe(actorUserId);
    expect(entry?.baseId).toBe("BASE01");
    expect(entry?.tableId).toBe("TABL01");
    expect(entry?.recordId).toBe("RECD01");
    expect(entry?.diff).toEqual({
      TEXT01: { old: "before", new: "after" },
      RELA01: { old: ["RECD02"], new: "RECD03" },
    });
    const serialized = JSON.stringify(entry);
    for (const internalId of [
      baseId,
      tableId,
      recordId,
      textFieldId,
      relationFieldId,
      deletedFieldId,
      oldRelatedRecordId,
      newRelatedRecordId,
      removedRelatedRecordId,
    ]) {
      expect(serialized).not.toContain(internalId);
    }
    expect(serialized).toContain(auditEntryId);
    expect(serialized).toContain(actorUserId);
  });

  test("keeps history readable when referenced resources no longer exist", async () => {
    const projectWithoutEntryResources: typeof projectPublicIds = async (type, ids) => {
      const projected = await projectIds(type, ids);
      projected.delete(baseId);
      projected.delete(tableId);
      projected.delete(recordId);
      return projected;
    };

    const [entry] = await toPublicAuditEntries([storedEntry], fields, projectWithoutEntryResources);
    expect(entry).toMatchObject({ baseId: null, tableId: null, recordId: null });
    expect(entry?.diff?.RELA01).toEqual({ old: ["RECD02"], new: "RECD03" });
  });

  test("keeps audited file metadata under the public field ID", async () => {
    const metadata = { id: "FILE01", filename: "evidence.pdf", mimeType: "application/pdf", sizeBytes: 42, sha256: "abc" };
    const [entry] = await toPublicAuditEntries(
      [{ ...storedEntry, action: "file.replaced", diff: { [textFieldId]: { old: metadata, new: { ...metadata, id: "FILE02" } } } }],
      fields,
      projectIds,
    );

    expect(entry).toMatchObject({
      action: "file.replaced",
      diff: { TEXT01: { old: metadata, new: { ...metadata, id: "FILE02" } } },
    });
  });

  test("projects every supported record event through the bounded public action contract", async () => {
    const actions: RecordHistoryAction[] = ["record_snapshot.created", "document.created", "workflow.record.updated", "file.added"];
    const projected = await toPublicAuditEntries(
      actions.map((action, index) => ({
        ...storedEntry,
        id: `88888888-8888-4888-8888-${String(index).padStart(12, "0")}`,
        action,
        diff: { snapshotId: { old: null, new: "internal-metadata" } },
      })) as RecordHistoryEntry[],
      fields,
      projectIds,
    );

    expect(projected.map((entry) => entry.action)).toEqual(actions);
    expect(projected.every((entry) => entry.diff && Object.keys(entry.diff).length === 0)).toBe(true);
  });

  test("projects Combined pages through the same nested boundary", async () => {
    const page: CombinedAuditPage = {
      items: [
        {
          ...storedEntry,
          context: {
            operation: "update",
            answers: [{ label: "Reason", type: "text", required: true, value: "Correction" }],
          },
          source: { ref: "source-1", baseName: "Source", tableName: "Items" },
          recordDeletedAt: null,
        },
      ],
      sources: [{ ref: "source-1", baseName: "Source", tableName: "Items" }],
      nextCursor: "opaque-cursor",
    };

    const projected = await toPublicCombinedAuditPage(page, fields, projectIds);
    expect(projected.items[0]?.diff?.RELA01).toEqual({ old: ["RECD02"], new: "RECD03" });
    expect(projected.sources).toEqual(page.sources);
    expect(projected.nextCursor).toBe("opaque-cursor");
  });

  test("rejects internal or malformed field ids in the public DTO", () => {
    const publicEntry = {
      ...storedEntry,
      baseId: "BASE01",
      tableId: "TABL01",
      recordId: "RECD01",
      diff: { TEXT01: { old: null, new: "ok" } },
    };
    expect(PublicRecordHistoryEntrySchema.safeParse(publicEntry).success).toBe(true);
    expect(PublicRecordHistoryEntrySchema.safeParse({ ...publicEntry, diff: { [textFieldId]: { old: null, new: "leak" } } }).success).toBe(
      false,
    );
    expect(PublicRecordHistoryEntrySchema.safeParse({ ...publicEntry, baseId: "SHORT" }).success).toBe(false);
    expect(PublicRecordHistoryEntrySchema.safeParse({ ...publicEntry, action: "unknown", diff: null, context: null }).success).toBe(true);
    expect(PublicRecordHistoryEntrySchema.safeParse({ ...publicEntry, action: "future.record.event" }).success).toBe(false);
  });
});
