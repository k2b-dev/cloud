import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { createAccountsEntitiesRoutes } from "../../api/accounts-entities";
import { accountsAppService } from "./app";
import type { AccountsActor } from "./authz";
import * as localGroups from "./local-groups";
import * as users from "./users";

const suite = databaseSuite();

const groupIds = (items: Awaited<ReturnType<typeof accountsAppService.entity.list>>["items"]) =>
  items.flatMap((item) => (item.kind === "group" ? [item.group.id] : []));

suite("personal Linux groups in group lists and search (integration)", () => {
  test("ordinary local and FreeIPA groups sharing a username stay exported", async () => {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,display_name,mail)
      VALUES('ordinary-name','local','user','Ordinary name','ordinary-name@example.test') RETURNING id`;
    const groups = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,provider,name)
      VALUES('local:ordinary-name','local','ordinary-name'),('ipa:ordinary-name','ipa','ordinary-name') RETURNING id`;
    try {
      const result = await accountsAppService.group.list({ scope: { ids: groups.map((group) => group.id) } });
      expect(result.items.map((group) => group.id).sort()).toEqual(groups.map((group) => group.id).sort());
      const local = await localGroups.list({ search: "ordinary-name" });
      expect(local.groups.map((group) => group.id)).toEqual([groups[0]!.id]);
    } finally {
      await sql`DELETE FROM auth.groups WHERE id IN (${groups[0]!.id}::uuid,${groups[1]!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
    }
  });
  test("are excluded from all group exports, including exact IDs and relations", async () => {
    const baseline = await accountsAppService.dashboard.get();
    const suffix = "fixture";
    const number = 1_500_000;
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
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${owner!.id}::uuid, ${personal!.id}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${team!.id}::uuid, ${personal!.id}::uuid)`;
    await sql`
      INSERT INTO auth.user_posix (user_id, managed_by, uid_number, primary_gid_number, primary_group_id, home_directory, login_shell)
      VALUES (${owner!.id}::uuid, 'local', ${number}, ${number}, ${personal!.id}::uuid, ${`/home/pg${suffix}`}, '/bin/bash')
    `;
    const actor: AccountsActor = { userId: owner!.id, uid: `pg${suffix}`, roles: ["user", "local", "local/user"], provider: "local" };

    try {
      expect(await localGroups.addMember({ id: team!.id, group: personal!.id })).toMatchObject({
        ok: false,
        status: 409,
        error: "Personal Linux groups cannot be used in group relationships",
      });
      expect(await localGroups.addManager({ id: team!.id, group: personal!.id })).toMatchObject({
        ok: false,
        status: 409,
        error: "Personal Linux groups cannot be used in group relationships",
      });
      for (const principal of [{ user: owner!.id }, { group: team!.id }]) {
        expect(await localGroups.addMember({ id: personal!.id, ...principal })).toMatchObject({
          ok: false,
          status: 409,
          error: "Personal Linux groups cannot be used in group relationships",
        });
        expect(await localGroups.addManager({ id: personal!.id, ...principal })).toMatchObject({
          ok: false,
          status: 409,
          error: "Personal Linux groups cannot be used in group relationships",
        });
      }
      const summary = await accountsAppService.dashboard.get();
      expect(summary.groupsTotal).toBe(baseline.groupsTotal + 1);
      expect(summary.localGroupsTotal).toBe(baseline.localGroupsTotal + 1);
      expect(summary.ipaGroupsTotal).toBe(baseline.ipaGroupsTotal);

      const hidden = await accountsAppService.group.list({ filter: { search: `pg${suffix}` }, scope: { mode: "all" } });
      expect(hidden.total).toBe(1);
      expect(hidden.items).toEqual([expect.objectContaining({ id: team!.id, personalOwner: null })]);

      for (const recursive of [false, true]) {
        const names = await accountsAppService.user.group.list({ userId: owner!.id, recursive });
        expect(names.items).toEqual(recursive ? [`pg${suffix}-team`] : []);
      }
      const ids = await accountsAppService.user.groupId.list({ userId: owner!.id, recursive: false });
      expect(ids).toContain(personal!.id);
      expect(ids).not.toContain(team!.id);
      expect(await users.getGroups({ id: owner!.id, recursive: true })).toEqual([`pg${suffix}-team`]);
      await sql`DELETE FROM auth.user_posix WHERE user_id=${owner!.id}::uuid`;
      expect((await accountsAppService.dashboard.get()).groupsTotal).toBe(baseline.groupsTotal + 1);
      expect((await accountsAppService.group.list({ scope: { ids: [personal!.id] } })).items).toEqual([]);

      const member = await accountsAppService.group.list({ scope: { userId: owner!.id, mode: "member" } });
      expect(member.items.map((group) => group.id)).toEqual([team!.id]);

      const exact = await accountsAppService.group.list({ scope: { ids: [personal!.id] } });
      expect(exact.items).toEqual([]);
      expect(await accountsAppService.group.get({ id: personal!.id })).toBeNull();

      const search = await accountsAppService.entity.list({ actor, search: `pg${suffix}`, kinds: ["user", "group"] });
      expect(search.total).toBe(2);
      expect(groupIds(search.items)).toEqual([team!.id]);

      const routes = createAccountsEntitiesRoutes({
        authenticate: async (c, next) => {
          const user = await users.get({ id: owner!.id });
          if (!user) throw new Error("Missing export fixture");
          c.set("actor", { kind: "user", user });
          c.set("accessSubject", { type: "user", userId: user.id });
          c.set("user", user);
          await next();
        },
      });
      for (const query of [
        `group_ids=${personal!.id}`,
        `search=pg${suffix}&include_personal=true`,
        `member_of_group_id=${team!.id}&kinds=group`,
      ]) {
        const response = await routes.request(`/entities?${query}`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items.some((item: { group?: { id: string } }) => item.group?.id === personal!.id)).toBe(false);
      }

      const lookup = await accountsAppService.entity.list({ actor, kinds: ["group"], groupIds: [personal!.id] });
      expect(groupIds(lookup.items)).toEqual([]);

      const members = await accountsAppService.entity.list({ actor, kinds: ["group"], memberOfGroupId: team!.id });
      expect(groupIds(members.items)).toEqual([]);
      for (const recursive of [false, true]) {
        const relation = await accountsAppService.group.member.list({ id: team!.id, recursive, filter: { type: "group" } });
        expect(relation.items).toEqual([]);
      }
    } finally {
      await sql`DELETE FROM auth.user_posix WHERE user_id = ${owner!.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${personal!.id}::uuid, ${team!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${owner!.id}::uuid`;
    }
  });
});
