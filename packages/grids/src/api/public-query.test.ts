import { describe, expect, test } from "bun:test";
import {
  fromPublicExportBody,
  fromPublicRecordQuery,
  PublicExportBodySchema,
  PublicRecordQuerySchema,
  toPublicRecordQuery,
} from "./public-query";

const tableId = "11111111-1111-4111-8111-111111111111";
const fieldId = "22222222-2222-4222-8222-222222222222";
const relationFieldId = "33333333-3333-4333-8333-333333333333";
const targetTableId = "44444444-4444-4444-8444-444444444444";
const targetFieldId = "55555555-5555-4555-8555-555555555555";
const relatedRecordId = "66666666-6666-4666-8666-666666666666";

const fields = [
  { id: fieldId, shortId: "FILD01", tableId, type: "text", config: {} },
  { id: relationFieldId, shortId: "REL001", tableId, type: "relation", config: { targetTableId } },
];
const targetFields = [{ id: targetFieldId, shortId: "TRGF01", tableId: targetTableId, type: "text", config: {} }];
const listFields = async (requestedTableId: string) => (requestedTableId === tableId ? fields : targetFields) as never;

describe("structured query public ID boundary", () => {
  test("rejects UUID and five-character field and record ids", () => {
    for (const id of [fieldId, "FILD1"]) {
      expect(PublicRecordQuerySchema.safeParse({ filter: { fieldId: id, op: "equals", value: "x" } }).success).toBe(false);
      expect(PublicExportBodySchema.safeParse({ query: {}, fields: [{ fieldId: id }] }).success).toBe(false);
    }
  });

  test("resolves field, record, and relation ids into the internal query", async () => {
    const converted = await fromPublicRecordQuery(
      tableId,
      {
        filter: { fieldId: "REL001", op: "containsAny", value: ["RECD01"] },
        recordMeta: { ids: ["RECD01"], finalizationStates: ["awaitingReview"] },
        sort: [{ fieldId: "FILD01", direction: "asc" }],
        columns: [{ fieldId: "FILD01" }],
      },
      {
        listFields,
        resolveIds: async (_type, ids) => new Map(ids.map((id) => [id, relatedRecordId])),
      },
    );

    expect(converted).toMatchObject({
      ok: true,
      data: {
        filter: { fieldId: relationFieldId, value: [relatedRecordId] },
        recordMeta: { ids: [relatedRecordId], finalizationStates: ["awaitingReview"] },
        sort: [{ fieldId, direction: "asc" }],
        columns: [{ fieldId }],
      },
    });
  });

  test("round-trips grouped presentation keys without exposing UUIDs", async () => {
    const internal = {
      groupBy: [{ fieldId, granularity: "year" as const }],
      aggregations: [{ fieldId, agg: "sum" as const }],
      groupedColumnOrder: [`group:0:${fieldId}:year`, `agg:0:${fieldId}:sum`, "agg:1:*:count"],
      hiddenGroupedColumns: [`agg:0:${fieldId}:sum`],
    };
    const projected = await toPublicRecordQuery(internal, fields as never);
    expect(projected.groupedColumnOrder).toEqual(["group:0:FILD01:year", "agg:0:FILD01:sum", "agg:1:*:count"]);
    expect(projected.hiddenGroupedColumns).toEqual(["agg:0:FILD01:sum"]);
    expect(await fromPublicRecordQuery(tableId, projected, { listFields })).toEqual({ ok: true, data: internal });
  });

  test("resolves export selection and relation target fields", async () => {
    const converted = await fromPublicExportBody(
      tableId,
      {
        format: "json",
        query: {},
        fields: [{ fieldId: "REL001", relation: { mode: "fields", fieldIds: ["TRGF01"] } }],
        csv: { delimiter: "," },
        markdown: "raw",
      },
      { listFields },
    );

    expect(converted).toMatchObject({
      ok: true,
      data: { fields: [{ fieldId: relationFieldId, relation: { mode: "fields", fieldIds: [targetFieldId] } }] },
    });
  });
});
