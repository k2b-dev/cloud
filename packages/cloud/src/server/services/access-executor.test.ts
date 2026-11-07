import { expect, test } from "bun:test";
import { SQL } from "bun";
import { getEffectivePermissions } from "./access";

test("empty batch and empty grants do not open the supplied pool", async () => {
  const db = new SQL("postgres://test:test@127.0.0.1:1/unused_test");
  try {
    const subjects = [{ type: "user" as const, userId: "00000000-0000-4000-8000-000000000011" }];
    expect(await getEffectivePermissions({ accessIds: [], subjects }, db)).toEqual(["none"]);
    expect(await getEffectivePermissions({ accessIds: ["00000000-0000-4000-8000-000000000014"], subjects: [] }, db)).toEqual([]);
  } finally {
    await db.close();
  }
});
