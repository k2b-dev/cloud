import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { listAssigneePrincipalsWithAccess, listServiceAccountsWithAccess } from "./items";

const suite = databaseSuite();

suite("Spaces local-group machine assignees", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: named group recipients stay bounded through search and revocation`, async () => {
      const rollback = new Error("rollback Spaces fixture");
      try {
        await sql.begin(async (db) => {
          const [space] = await db<{ id: string }[]>`INSERT INTO spaces.spaces (short_id, name)
            VALUES (${newShortId()}, 'Group eligibility') RETURNING id`;
          const [account, outside] = await db<{ id: string; name: string }[]>`INSERT INTO auth.service_accounts (name, kind)
            VALUES ('Named recipient', ${kind}), ('Outside recipient', ${kind}) RETURNING id, name`;
          const [child, parent] = await db<{ id: string; name: string }[]>`INSERT INTO auth.groups (cn, name, provider)
            VALUES (${crypto.randomUUID()}, 'Child', 'local'), (${crypto.randomUUID()}, 'Space group', 'local') RETURNING id, name`;
          const [user] = await db<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
            VALUES (${`spaces-group-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
          if (!space || !account || !outside || !child || !parent || !user) throw new Error("Missing Spaces fixture");
          await db`INSERT INTO auth.service_account_groups (service_account_id, group_id) VALUES (${account.id}::uuid, ${child.id}::uuid)`;
          await db`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user.id}::uuid, ${child.id}::uuid)`;
          await db`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent.id}::uuid, ${child.id}::uuid)`;
          const grants = await db<{ id: string }[]>`INSERT INTO auth.access (group_id, authenticated_only, permission)
            VALUES (${parent.id}::uuid, false, 'read'), (NULL, false, 'admin'), (NULL, true, 'admin') RETURNING id`;
          for (const grant of grants)
            await db`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${grant.id}::uuid)`;
          const params = { spaceId: space.id, ids: [account.id, outside.id], db };
          const list = () => listServiceAccountsWithAccess(params);
          expect(await list()).toEqual([
            expect.objectContaining({
              id: account.id,
              kind: "service_account",
              serviceAccountKind: kind,
              displayName: account.name,
              description: `${kind === "agent" ? "agent" : "service account"} · via ${parent.name}`,
            }),
          ]);
          expect(
            (await listAssigneePrincipalsWithAccess(space.id, [account.id, outside.id, user.id], db)).map((row) => row.id).sort(),
          ).toEqual([account.id, user.id].sort());
          expect(await listServiceAccountsWithAccess({ ...params, search: parent.name })).toHaveLength(1);
          expect(await listServiceAccountsWithAccess({ ...params, search: "no match" })).toEqual([]);
          expect(await listServiceAccountsWithAccess({ ...params, ids: [] })).toEqual([]);
          expect(await listServiceAccountsWithAccess({ ...params, excludeIds: [account.id] })).toEqual([]);
          await db`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account.id}::uuid`;
          expect(await list()).toEqual([]);
          await db`UPDATE auth.service_accounts SET status = 'active', kind = 'resource_bound', app_id = 'spaces', resource_type = 'space',
            resource_id = ${space.id} WHERE id = ${account.id}::uuid`;
          expect(await list()).toEqual([]);
          const [direct] = await db<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
            VALUES (${account.id}::uuid, 'read') RETURNING id`;
          if (!direct) throw new Error("Missing direct grant");
          await db`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${space.id}::uuid, ${direct.id}::uuid)`;
          expect(await list()).toEqual([expect.objectContaining({ id: account.id, description: "Space API key · direct access" })]);
          await db`UPDATE auth.service_accounts SET resource_id = 'another-space' WHERE id = ${account.id}::uuid`;
          expect(await list()).toEqual([]);
          await db`UPDATE auth.service_accounts SET kind = 'user_delegated', app_id = NULL, resource_type = NULL, resource_id = NULL,
            delegated_user_id = ${user.id}::uuid WHERE id = ${account.id}::uuid`;
          expect(await list()).toEqual([]);
          await db`UPDATE auth.service_accounts SET kind = ${kind}, delegated_user_id = NULL WHERE id = ${account.id}::uuid`;
          // Direct and inherited access can coexist without duplicates or misleading provenance.
          expect(await list()).toEqual([
            expect.objectContaining({ id: account.id, description: `${kind === "agent" ? "agent" : "service account"} · direct access` }),
          ]);
          expect(await listServiceAccountsWithAccess({ ...params, search: parent.name })).toHaveLength(1);
          await db`DELETE FROM auth.access WHERE id = ${direct.id}::uuid`;
          await db`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${parent.id}::uuid AND child_group_id = ${child.id}::uuid`;
          expect(await list()).toEqual([]);
          expect(await listAssigneePrincipalsWithAccess(space.id, [account.id], db)).toEqual([]);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    });
  }
});
