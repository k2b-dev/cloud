import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { accountsAppService } from "./app";
import type { AccountsActor } from "./authz";

const suite = databaseSuite();

const groupIds = (items: Awaited<ReturnType<typeof accountsAppService.entity.list>>["items"]) =>
  items.flatMap((item) => (item.kind === "group" ? [item.group.id] : []));

suite("personal Linux groups in group lists and search (integration)", () => {
  test("are flagged with their owner and left out of browsing and search unless requested", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const number = 1_500_000 + Math.floor(Math.random() * 400_000);
    const [owner] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`pg${suffix}`}, 'local', 'user', 'Quinn Personal', ${`pg-${suffix}@example.test`})
      RETURNING id
    `;
    const [personal] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, gid_number)
      VALUES (${`local:pg${suffix}`}, 'local', ${`pg${suffix}`}, ${number})
      RETURNING id
    `;
    const [team] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name, description)
      VALUES (${`local:pg${suffix}-team`}, 'local', ${`pg${suffix}-team`}, 'Real team')
      RETURNING id
    `;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${owner!.id}::uuid, ${personal!.id}::uuid), (${owner!.id}::uuid, ${team!.id}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${team!.id}::uuid, ${personal!.id}::uuid)`;
    await sql`
      INSERT INTO auth.user_posix (user_id, managed_by, uid_number, primary_gid_number, primary_group_id, home_directory, login_shell)
      VALUES (${owner!.id}::uuid, 'local', ${number}, ${number}, ${personal!.id}::uuid, ${`/home/pg${suffix}`}, '/bin/bash')
    `;
    const actor: AccountsActor = { userId: owner!.id, uid: `pg${suffix}`, roles: ["user", "local", "local/user"], provider: "local" };
    const expectedOwner = { id: owner!.id, uid: `pg${suffix}`, displayName: "Quinn Personal" };

    try {
      const hidden = await accountsAppService.group.list({ filter: { search: `pg${suffix}` }, scope: { mode: "all" } });
      expect(hidden.total).toBe(1);
      expect(hidden.items).toEqual([expect.objectContaining({ id: team!.id, personalOwner: null })]);

      const shown = await accountsAppService.group.list({
        filter: { search: `pg${suffix}`, includePersonal: true },
        scope: { mode: "all" },
      });
      expect(shown.total).toBe(2);
      expect(shown.items.find((group) => group.id === personal!.id)?.personalOwner).toEqual(expectedOwner);

      const member = await accountsAppService.group.list({ scope: { userId: owner!.id, mode: "member" } });
      expect(member.items.map((group) => group.id)).toEqual([team!.id]);

      const exact = await accountsAppService.group.list({ scope: { ids: [personal!.id] } });
      expect(exact.items).toEqual([expect.objectContaining({ id: personal!.id, personalOwner: expectedOwner })]);
      expect((await accountsAppService.group.get({ id: personal!.id }))?.personalOwner).toEqual(expectedOwner);

      const search = await accountsAppService.entity.list({ actor, search: `pg${suffix}`, kinds: ["user", "group"] });
      expect(search.total).toBe(2);
      expect(groupIds(search.items)).toEqual([team!.id]);

      const searchWithPersonal = await accountsAppService.entity.list({
        actor,
        search: `pg${suffix}`,
        kinds: ["group"],
        includePersonal: true,
      });
      expect(searchWithPersonal.total).toBe(2);
      expect(searchWithPersonal.items).toContainEqual(
        expect.objectContaining({ kind: "group", group: expect.objectContaining({ id: personal!.id, personalOwner: expectedOwner }) }),
      );

      const lookup = await accountsAppService.entity.list({ actor, kinds: ["group"], groupIds: [personal!.id] });
      expect(groupIds(lookup.items)).toEqual([personal!.id]);

      const members = await accountsAppService.entity.list({ actor, kinds: ["group"], memberOfGroupId: team!.id });
      expect(groupIds(members.items)).toEqual([personal!.id]);
    } finally {
      await sql`DELETE FROM auth.user_posix WHERE user_id = ${owner!.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${personal!.id}::uuid, ${team!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${owner!.id}::uuid`;
    }
  });
});
