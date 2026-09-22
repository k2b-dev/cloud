import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../../scripts/fixtures/test-infra";
import { accountsAppService } from "../../accounts/app";

const suite = databaseSuite();

const insertLocalUser = async (uid: string, options: { admin?: boolean; profile?: "user" | "guest" } = {}) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, admin)
    VALUES (${uid}, 'local', ${options.profile ?? "guest"}, ${uid}, ${`${uid}@example.test`}, ${options.admin ?? false})
    RETURNING id
  `;
  return row!.id;
};

suite("local user removal", () => {
  test("deletes the row, records the deletion and resolves without a session revoke failure", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const adminUid = `remove-admin-${suffix}`;
    const targetUid = `remove-target-${suffix}`;
    const adminId = await insertLocalUser(adminUid, { admin: true, profile: "user" });
    const targetId = await insertLocalUser(targetUid);
    try {
      const result = await accountsAppService.user.remove({
        id: targetId,
        actor: { userId: adminId, uid: adminUid, roles: ["admin"], provider: "local" },
      });
      expect(result).toEqual({ ok: true, data: undefined });
      expect(await sql`SELECT id FROM auth.users WHERE id = ${targetId}::uuid`).toHaveLength(0);
      const audit = await sql<{ reason: string }[]>`SELECT reason FROM auth.deleted_accounts WHERE deleted_user_id = ${targetId}::uuid`;
      expect(audit.map((row) => row.reason)).toEqual(["manual_delete"]);
      const again = await accountsAppService.user.remove({
        id: targetId,
        actor: { userId: adminId, uid: adminUid, roles: ["admin"], provider: "local" },
      });
      expect(again.ok).toBe(false);
    } finally {
      await sql`DELETE FROM auth.deleted_accounts WHERE deleted_user_id = ${targetId}::uuid`;
      await sql`DELETE FROM auth.users WHERE uid IN (${adminUid}, ${targetUid})`;
    }
  });
});
