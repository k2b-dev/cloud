import { expect, test } from "bun:test";
import { FieldSchema, GridRecordSchema } from "../contracts";
import type { projectPublicIds } from "../service/public-resources";
import { projectGridRecord, projectPublishedRecords } from "./custom-app-public-dto";

const tableId = "11111111-1111-4111-8111-111111111111";
const fieldId = "22222222-2222-4222-8222-222222222222";
const recordId = "33333333-3333-4333-8333-333333333333";
const userId = "44444444-4444-4444-8444-444444444444";
const now = "2026-09-15T12:00:00.000Z";
const field = FieldSchema.parse({
  id: fieldId,
  shortId: "FILD01",
  tableId,
  name: "Customer",
  description: null,
  type: "relation",
  config: { targetTableId: tableId, cardinality: "single" },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: recordId,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
});
const projectIds: typeof projectPublicIds = async (type, ids) => {
  const mapping = type === "table" ? [tableId, "TABL01"] : type === "field" ? [fieldId, "FILD01"] : [recordId, "RECD01"];
  return new Map(ids.flatMap((id) => (id === mapping[0] ? [[id, mapping[1]!]] : [])));
};

test("Custom App field defaults use public relation IDs and preserve ordinary UUID text", async () => {
  const text = { ...field, type: "text", config: {}, defaultValue: userId };
  const result = await projectPublishedRecords(
    {
      primaryTableId: tableId,
      response: { ok: false, diagnostics: [] },
      presentation: { fields: [field, text] },
    },
    projectIds,
  );
  expect(result.presentation?.fields.map((item) => item.defaultValue)).toEqual(["RECD01", userId]);
  expect(result.presentation?.fields[0]?.config.targetTableId).toBe("TABL01");
});

test("Custom App records never fall back to private relation or field IDs", async () => {
  const record = GridRecordSchema.parse({
    id: recordId,
    shortId: "RECD01",
    tableId,
    data: { [fieldId]: recordId },
    version: 1,
    deletedAt: null,
    createdBy: userId,
    updatedBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  expect(await projectGridRecord(record, [field], projectIds)).toMatchObject({
    id: "RECD01",
    tableId: "TABL01",
    data: { FILD01: "RECD01" },
    createdBy: userId,
  });
  await expect(projectGridRecord({ ...record, data: { [fieldId]: userId } }, [field], projectIds)).rejects.toThrow(
    "Missing public id for Grids record",
  );
  await expect(projectGridRecord({ ...record, data: { [userId]: "text" } }, [field], projectIds)).rejects.toThrow(
    "Missing public id for Grids field",
  );
  expect((await projectGridRecord(record, [{ ...field, type: "text" }], projectIds)).data).toEqual({ FILD01: recordId });
});

test("Custom App query relations and aggregate keys are public without presentation metadata", async () => {
  const result = await projectPublishedRecords(
    {
      primaryTableId: tableId,
      response: {
        ok: true,
        mode: "rows",
        limit: 100,
        columns: [
          { key: fieldId, label: "Customer", tableId, fieldId, type: "relation", sqlType: "uuid[]" },
          { key: `${fieldId}__count`, label: "Count", tableId, fieldId, type: "number", sqlType: "numeric" },
        ],
        rows: [{ recordId, tableId, values: { [fieldId]: [recordId], [`${fieldId}__count`]: 1, note: recordId } }],
      },
    },
    projectIds,
  );
  expect(result).toMatchObject({
    columns: [{ key: "FILD01", tableId: "TABL01", fieldId: "FILD01" }, { key: "FILD01__count" }],
    rows: [{ recordId: "RECD01", tableId: "TABL01", values: { FILD01: ["RECD01"], FILD01__count: 1, note: recordId } }],
  });
});
