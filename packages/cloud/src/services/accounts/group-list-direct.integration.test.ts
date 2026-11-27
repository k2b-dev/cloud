import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { sql } from "../../runtime/clients";
import { accountsAppService } from "./app";

const suite = databaseSuite();

suite("a user's direct groups in one read (integration)", () => {
  test("scope direct lists the groups a user is in directly, without inherited ones, with their total", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${`direct-${tag}`}, 'local', 'user', 'Direct') RETURNING id`;
    const [team, staff, other] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`local:team-${tag}`}, 'local', ${`team-${tag}`}),
             (${`local:staff-${tag}`}, 'local', ${`staff-${tag}`}),
             (${`local:other-${tag}`}, 'local', ${`other-${tag}`})
      RETURNING id`;
    try {
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user!.id}::uuid, ${team!.id}::uuid)`;
      // the team is in the staff group: the user is in staff only through the team
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${staff!.id}::uuid, ${team!.id}::uuid)`;
      const list = (mode: "direct" | "member") =>
        accountsAppService.group.list({ pagination: { page: 1, perPage: 100 }, scope: { userId: user!.id, mode } });
      const direct = await list("direct");
      expect(direct.items.map((group) => group.id)).toEqual([team!.id]);
      expect(direct.total).toBe(1);
      expect((await list("member")).items.map((group) => group.id).sort()).toEqual([team!.id, staff!.id].sort());
      // the same rows the direct group ids read, in one statement with the groups themselves
      expect(await accountsAppService.user.groupId.list({ userId: user!.id, recursive: false })).toEqual([team!.id]);
      expect(other).toBeDefined();
    } finally {
      await sql`DELETE FROM auth.groups WHERE id IN (${team!.id}::uuid, ${staff!.id}::uuid, ${other!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
