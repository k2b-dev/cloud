import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { migrateCodeAccountHandles } from "../migrate/core/code-account-handles";
import * as handles from "./service-account";
import { createCodeServiceAccount } from "./service-account";

const suite = databaseSuite();
suite("Code account handles", () => {
  test("backfills in place, keeps UUID grants, and leaves existing handles stable", async () => {
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile) VALUES('a2-handle-owner','local','user') RETURNING id`;
    const [legacy] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name,kind) VALUES('code:app:a2-legacy','code') RETURNING id`;
    const [grant] = await sql<
      { id: string }[]
    >`INSERT INTO auth.access(service_account_id,permission) VALUES(${legacy!.id}::uuid,'read') RETURNING id`;
    await sql`INSERT INTO auth.service_accounts(name,kind,handle) VALUES('code:app:a2-occupied','code','code-0000000000')`;
    let sequence = 0;
    const random = spyOn(handles, "createCodeAccountHandle").mockImplementation(() => `code-${String(sequence++).padStart(10, "0")}`);
    try {
      await migrateCodeAccountHandles();
      random.mockRestore();
      const [first] = await sql<
        { handle: string; app_id: string | null; resource_type: string | null; resource_id: string | null }[]
      >`SELECT handle,app_id,resource_type,resource_id FROM auth.service_accounts WHERE id=${legacy!.id}::uuid`;
      expect(first!.handle).toMatch(/^code-[0123456789abcdefghjkmnpqrstvwxyz]{10}$/);
      expect([first!.app_id, first!.resource_type, first!.resource_id]).toEqual([null, null, null]);
      await migrateCodeAccountHandles();
      expect((await sql`SELECT handle FROM auth.service_accounts WHERE id=${legacy!.id}::uuid`)[0]!.handle).toBe(first!.handle);
      expect((await sql`SELECT service_account_id FROM auth.access WHERE id=${grant!.id}::uuid`)[0]!.service_account_id).toBe(legacy!.id);
      const created = await sql.begin((tx) =>
        createCodeServiceAccount(tx, { name: "code:app:a2-created", title: "Werkstatt", createdBy: user!.id }),
      );
      expect(created.handle).toMatch(/^code-[0123456789abcdefghjkmnpqrstvwxyz]{10}$/);
      const [account] = await sql`SELECT title,app_id,resource_type,resource_id FROM auth.service_accounts WHERE id=${created.id}::uuid`;
      expect(account).toEqual({ title: "Werkstatt", app_id: null, resource_type: null, resource_id: null });
    } finally {
      random.mockRestore();
      await sql`DELETE FROM auth.access WHERE id=${grant!.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE name IN ('code:app:a2-legacy','code:app:a2-created','code:app:a2-occupied')`;
      await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    }
  });
});
