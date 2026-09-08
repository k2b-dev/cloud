import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mapFieldRow } from "./field-read";
import { queryInternalResourceIds, queryPublicResourceIds } from "./public-resource-ids";
import { fromPublicRelationValues } from "./public-resources";

const database = (rows: unknown[], calls: Array<{ query: string; parameters: unknown[] }>): SQL =>
  ({
    unsafe: async (query: string, parameters: unknown[]) => {
      calls.push({ query, parameters });
      return rows;
    },
  }) as unknown as SQL;

describe("public resource ID batches", () => {
  test("converts only relation values on the supplied database handle", async () => {
    const relation = mapFieldRow({ id: "relation", type: "relation", created_at: new Date(), updated_at: new Date() });
    const principal = { ...relation, id: "principal", type: "principal" };
    const text = { ...relation, id: "text", type: "text" };
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const user = [{ type: "user", id: "11111111-1111-4111-8111-111111111111" }];
    const internalId = "22222222-2222-4222-8222-222222222222";
    const db = database([{ publicId: "REC001", internalId }], calls);
    expect(
      await fromPublicRelationValues([relation, principal, text], { relation: ["REC001"], principal: user, text: "REC001" }, {}, db),
    ).toEqual({ ok: true, data: { relation: [internalId], principal: user, text: "REC001" } });
    expect(calls).toHaveLength(1);
    expect(await fromPublicRelationValues([relation], { relation: "REC001" }, {}, db)).toEqual({
      ok: true,
      data: { relation: internalId },
    });
    expect(await fromPublicRelationValues([relation], { relation: null }, {}, db)).toEqual({ ok: true, data: { relation: null } });
  });

  test("rejects labels, internal UUIDs, typed references and missing public relations", async () => {
    const field = mapFieldRow({ id: "relation", type: "relation", created_at: new Date(), updated_at: new Date() });
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const db = database([], calls);
    for (const value of ["Camera label", "11111111-1111-4111-8111-111111111111", { kind: "record", recordId: "REC001" }]) {
      expect((await fromPublicRelationValues([field], { relation: value }, {}, db)).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
    expect((await fromPublicRelationValues([field], { relation: "REC001" }, {}, db)).ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect((await fromPublicRelationValues([field], { relation: "tmp_1" }, {}, db)).ok).toBe(false);
    expect(await fromPublicRelationValues([field], { relation: ["tmp_1"] }, { allowTemporaryRelationIds: true }, db)).toEqual({
      ok: true,
      data: { relation: ["tmp_1"] },
    });
  });

  test("binds public IDs as one Postgres text array", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const ids = await queryPublicResourceIds(
      "base",
      ["8yMtTb", "Ab12Cd", "8yMtTb"],
      database(
        [
          { publicId: "8yMtTb", internalId: "11111111-1111-4111-8111-111111111111" },
          { publicId: "Ab12Cd", internalId: "22222222-2222-4222-8222-222222222222" },
        ],
        calls,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("ANY($1::text[])");
    expect(calls[0]?.parameters).toEqual(['{"8yMtTb","Ab12Cd"}']);
    expect(ids.get("8yMtTb")).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("binds internal IDs as one Postgres UUID array", async () => {
    const calls: Array<{ query: string; parameters: unknown[] }> = [];
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const ids = await queryInternalResourceIds(
      "base",
      [first, second, first],
      database(
        [
          { internalId: first, publicId: "8yMtTb" },
          { internalId: second, publicId: "Ab12Cd" },
        ],
        calls,
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toContain("ANY($1::uuid[])");
    expect(calls[0]?.parameters).toEqual([`{${first},${second}}`]);
    expect(ids.get(first)).toBe("8yMtTb");
  });
});
