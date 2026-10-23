import { expect, test } from "bun:test";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import {
  buildAccessPrincipalCondition,
  getEffectiveGroupIds,
  getEffectiveGroups,
  getEffectivePermission,
  getEffectivePermissions,
  recursiveServiceAccountGroupIdsSubquery,
} from "../index";

const suite = databaseSuite();

suite("authoritative local machine groups", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: helpers, permissions and SQL agree through nesting, revocation and status changes`, async () => {
      const db = sql;
      const accountIds: string[] = [];
      const userIds: string[] = [];
      const groupIds: string[] = [];
      const accessIds: string[] = [];
      try {
        const [account] = await db<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
            VALUES ('Group helper machine', ${kind}) RETURNING id`;
        if (account) accountIds.push(account.id);
        const [outside] = await db<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
          VALUES ('Unrelated group helper machine', ${kind}) RETURNING id`;
        if (outside) accountIds.push(outside.id);
        const [user] = await db<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
            VALUES (${`group-helper-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
        if (user) userIds.push(user.id);
        const groups = await db<{ id: string }[]>`INSERT INTO auth.groups (cn, name, provider)
            VALUES (${crypto.randomUUID()}, 'Child', 'local'), (${crypto.randomUUID()}, 'Parent', 'local'),
              (${crypto.randomUUID()}, 'Directory', 'ipa') RETURNING id`;
        groupIds.push(...groups.map((group) => group.id));
        const [child, parent, directory] = groups;
        if (!account || !outside || !user || !child || !parent || !directory) throw new Error("Missing group fixture");
        await db`INSERT INTO auth.service_account_groups (service_account_id, group_id)
            VALUES (${account.id}::uuid, ${child.id}::uuid), (${account.id}::uuid, ${directory.id}::uuid)`;
        await db`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user.id}::uuid, ${child.id}::uuid)`;
        await db`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
            VALUES (${parent.id}::uuid, ${child.id}::uuid)`;
        const crossProviderNesting = await db`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
            VALUES (${directory.id}::uuid, ${parent.id}::uuid)`.then(
          () => null,
          (error: unknown) => error,
        );
        expect(crossProviderNesting).toMatchObject({ errno: "P0001" });
        const [grant] = await db<{ id: string }[]>`INSERT INTO auth.access (group_id, permission)
            VALUES (${parent.id}::uuid, 'write') RETURNING id`;
        if (!grant) throw new Error("Missing group grant");
        accessIds.push(grant.id);
        const subject = { type: "service_account" as const, serviceAccountId: account.id };
        const expected = [
          { id: child.id, name: "Child" },
          { id: parent.id, name: "Parent" },
        ];
        expect(await getEffectiveGroups({ serviceAccountId: account.id }, db)).toEqual(expected);
        expect(await getEffectiveGroupIds({ serviceAccountId: account.id }, db)).toEqual([child.id, parent.id]);
        expect(await getEffectiveGroups({ userId: user.id }, db)).toEqual(expected);
        expect(await getEffectiveGroupIds({ serviceAccountId: null }, db)).toEqual([]);
        expect(await getEffectiveGroupIds({ userId: null }, db)).toEqual([]);
        const check = async (allowed: boolean) => {
          expect(await getEffectivePermission({ accessIds: [grant.id], subject }, db)).toBe(allowed ? "write" : "none");
          expect(await getEffectivePermissions({ accessIds: [grant.id], subjects: [subject] })).toEqual([allowed ? "write" : "none"]);
          const condition = buildAccessPrincipalCondition({
            subject,
            columns: {
              userId: sql`a.user_id`,
              groupId: sql`a.group_id`,
              serviceAccountId: sql`a.service_account_id`,
              authenticatedOnly: sql`a.authenticated_only`,
            },
          });
          const rows = await db<{ id: string }[]>`SELECT a.id FROM auth.access a WHERE a.id = ${grant.id}::uuid AND ${condition}`;
          expect(rows.map((row) => row.id)).toEqual(allowed ? [grant.id] : []);
          const ids = await db<{ group_id: string }[]>`${recursiveServiceAccountGroupIdsSubquery(account.id)}`;
          expect(ids.map((row) => row.group_id).sort()).toEqual(allowed ? [child.id, parent.id].sort() : []);
          // Accounts relation queries use this exact alias; the inner account lookup must not shadow it.
          const recipients = await db<{ id: string }[]>`SELECT sa.id FROM auth.service_accounts sa
            WHERE sa.id = ANY(${toPgUuidArray(accountIds)}::uuid[])
              AND ${parent.id}::uuid IN (${recursiveServiceAccountGroupIdsSubquery(sql`sa.id`)})`;
          expect(recipients.map((row) => row.id)).toEqual(allowed ? [account.id] : []);
        };
        await check(true);
        await db`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account.id}::uuid`;
        expect(await getEffectiveGroups({ serviceAccountId: account.id }, db)).toEqual([]);
        await check(false);
        await db`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${account.id}::uuid`;
        await check(true);
        // Even stale/corrupt membership rows cannot confer groups on bound or delegated identities.
        await db`UPDATE auth.service_accounts SET kind = 'resource_bound', app_id = 'test', resource_type = 'item', resource_id = 'one'
            WHERE id = ${account.id}::uuid`;
        await check(false);
        await db`UPDATE auth.service_accounts SET kind = 'user_delegated', app_id = NULL, resource_type = NULL, resource_id = NULL,
            delegated_user_id = ${user.id}::uuid WHERE id = ${account.id}::uuid`;
        await check(false);
        await db`UPDATE auth.service_accounts SET kind = ${kind}, delegated_user_id = NULL WHERE id = ${account.id}::uuid`;
        await db`DELETE FROM auth.service_account_groups WHERE service_account_id = ${account.id}::uuid AND group_id = ${child.id}::uuid`;
        await check(false);
      } finally {
        await db`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`;
        await db`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ANY(${toPgUuidArray(groupIds)}::uuid[])
          OR child_group_id = ANY(${toPgUuidArray(groupIds)}::uuid[])`;
        await db`DELETE FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(accountIds)}::uuid[])`;
        await db`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])`;
        await db`DELETE FROM auth.groups WHERE id = ANY(${toPgUuidArray(groupIds)}::uuid[])`;
      }
    });
  }
});
