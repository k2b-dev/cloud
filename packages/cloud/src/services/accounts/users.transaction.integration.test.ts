import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { databaseSuite, requireDatabaseUrl } from "../../../../../scripts/fixtures/test-infra";
import { encryptValue } from "../settings/crypto";
import { get } from "./users";

const suite = databaseSuite();
let db: SQL;
suite("user reads on a reserved authorization connection", () => {
  beforeAll(() => {
    db = new SQL(requireDatabaseUrl(), { max: 1 });
  });
  afterAll(async () => {
    await db?.close();
  });
  test("a one-connection transaction reads its own uncommitted account and role settings", async () => {
    const rollback = new Error("fixture rollback");
    const id = "cf220000-0000-4000-8000-000000000001";
    await expect(
      db.begin(async (tx) => {
        await tx`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${id}::uuid,'app-pwa-user-tx','local','user',true)`;
        const user = await get({ id }, { db: tx });
        expect(user?.id).toBe(id);
        expect(user?.roles).toContain("admin");
        expect(user?.profile).toBe("user");
        await tx`UPDATE auth.users SET provider='ipa',admin=false WHERE id=${id}::uuid`;
        await tx`INSERT INTO auth.ipa_user_effective_groups VALUES(${id}::uuid,'pwa-transaction-admins')`;
        await tx`INSERT INTO settings.entries(key,value) VALUES('freeipa.groups.admin',${await encryptValue(["pwa-transaction-admins"])})
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
        expect((await get({ id }, { db: tx }))?.roles).toContain("admin");
        await tx`UPDATE settings.entries SET value=${await encryptValue(["different-admins"])} WHERE key='freeipa.groups.admin'`;
        expect((await get({ id }, { db: tx }))?.roles).not.toContain("admin");
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await get({ id }, { db })).toBeNull();
  });
});
