import { describe, expect, test } from "bun:test";
import type { DslQueryPreviewResponse } from "../contracts";
import { fromPublicGqlScope, PublicDslQueryExecuteBodySchema, PublicDslQueryPreviewBodySchema, toPublicGqlResponse } from "./gql-public";

const baseId = "11111111-1111-4111-8111-111111111111";
const tableId = "22222222-2222-4222-8222-222222222222";
const fieldId = "33333333-3333-4333-8333-333333333333";
const recordId = "44444444-4444-4444-8444-444444444444";
const relatedRecordId = "55555555-5555-4555-8555-555555555555";

describe("GQL public ID boundary", () => {
  test("rejects UUID and five-character scope ids", () => {
    for (const id of [tableId, "TABL1"]) {
      expect(PublicDslQueryPreviewBodySchema.safeParse({ query: "from table Items", currentTableId: id }).success).toBe(false);
      expect(PublicDslQueryExecuteBodySchema.safeParse({ query: "from table Items", filePreviewFieldIds: [id] }).success).toBe(false);
    }
  });

  test("resolves public table and field scope to internal ids", async () => {
    const resolved = await fromPublicGqlScope(
      baseId,
      { currentTableId: "TABL01", currentSource: { kind: "table", tableId: "TABL01" }, filePreviewFieldIds: ["FILD01"] },
      {
        getTableByShortId: async () => ({ id: tableId, baseId }) as never,
        listFields: async () => [{ id: fieldId, shortId: "FILD01" }] as never,
      },
    );

    expect(resolved).toEqual({
      ok: true,
      data: { currentTableId: tableId, currentSource: { kind: "table", tableId }, filePreviewFieldIds: [fieldId] },
    });
  });

  test("projects row, column, and relation resource ids", async () => {
    const response: DslQueryPreviewResponse = {
      ok: true,
      mode: "rows",
      columns: [{ key: fieldId, label: "Customer", tableId, fieldId, type: "relation", sqlType: "uuid[]" }],
      rows: [{ recordId, tableId, values: { [fieldId]: [relatedRecordId] } }],
      limit: 100,
    };
    const ids = new Map([
      [tableId, "TABL01"],
      [fieldId, "FILD01"],
      [recordId, "RECD01"],
      [relatedRecordId, "RECD02"],
    ]);
    const projected = await toPublicGqlResponse(response, {
      projectIds: async (_type, internalIds) => new Map(internalIds.flatMap((id) => (ids.has(id) ? [[id, ids.get(id)!]] : []))),
    });

    expect(projected).toMatchObject({
      columns: [{ key: "FILD01", tableId: "TABL01", fieldId: "FILD01" }],
      rows: [{ recordId: "RECD01", tableId: "TABL01", values: { FILD01: ["RECD02"] } }],
    });
  });

  test("preserves relation labels in grouped results", async () => {
    const response: DslQueryPreviewResponse = {
      ok: true,
      mode: "groups",
      columns: [{ key: "gk_0", label: "Customer", tableId, fieldId, type: "relation", sqlType: "text" }],
      rows: [{ values: { gk_0: "Cameras" } }],
      limit: 100,
    };
    const projected = await toPublicGqlResponse(response, {
      projectIds: async (type, internalIds) => {
        if (type === "record") expect(internalIds).toEqual([]);
        return new Map(internalIds.map((id) => [id, id === tableId ? "TABL01" : "FILD01"]));
      },
    });

    expect(projected).toMatchObject({ rows: [{ values: { gk_0: "Cameras" } }] });
  });
});
