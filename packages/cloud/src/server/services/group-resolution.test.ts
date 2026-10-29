import { expect, test } from "bun:test";
import { getEffectiveGroupIds, getEffectiveGroups } from "../index";

test("null user and machine group lookups need no directory or database access", async () => {
  for (const params of [{ userId: null }, { serviceAccountId: null }]) {
    expect(await getEffectiveGroups(params)).toEqual([]);
    expect(await getEffectiveGroupIds(params)).toEqual([]);
  }
});
