import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { currentEligibleAssigneeIds, listEligibleAssignees } from "./collaborators";

const suite = databaseSuite();

suite("Mail local-group machine assignees", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: inherited eligibility preserves scope, active state and binding`, async () => {
      const rollback = new Error("rollback Mail fixture");
      try {
        await sql.begin(async (db) => {
          const [mailbox] = await db<{ id: string }[]>`INSERT INTO mail.mailboxes (short_id, name)
            VALUES (${newShortId()}, 'Group eligibility') RETURNING id`;
          const [account, outside] = await db<{ id: string; name: string }[]>`INSERT INTO auth.service_accounts (name, kind)
            VALUES ('Named recipient', ${kind}), ('Outside recipient', ${kind}) RETURNING id, name`;
          const [child, parent, assigned] = await db<{ id: string; name: string }[]>`INSERT INTO auth.groups (cn, name, provider)
            VALUES (${crypto.randomUUID()}, 'Child', 'local'), (${crypto.randomUUID()}, 'Mailbox group', 'local'),
              (${crypto.randomUUID()}, 'Assigned group', 'local') RETURNING id, name`;
          const [user] = await db<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
            VALUES (${`mail-group-${crypto.randomUUID()}`}, 'local', 'user') RETURNING id`;
          if (!mailbox || !account || !outside || !child || !parent || !assigned || !user) throw new Error("Missing Mail fixture");
          await db`INSERT INTO auth.service_account_groups (service_account_id, group_id)
            VALUES (${account.id}::uuid, ${child.id}::uuid), (${account.id}::uuid, ${assigned.id}::uuid)`;
          await db`INSERT INTO auth.user_groups_v2 (user_id, group_id)
            VALUES (${user.id}::uuid, ${child.id}::uuid), (${user.id}::uuid, ${assigned.id}::uuid)`;
          await db`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent.id}::uuid, ${child.id}::uuid)`;
          const [mailboxGrant, assignedGrant, publicGrant, authenticatedGrant] = await db<{ id: string }[]>`
            INSERT INTO auth.access (group_id, authenticated_only, permission)
            VALUES (${parent.id}::uuid, false, 'write'), (${assigned.id}::uuid, false, 'read'),
              (NULL, false, 'admin'), (NULL, true, 'admin') RETURNING id`;
          if (!mailboxGrant || !assignedGrant || !publicGrant || !authenticatedGrant) throw new Error("Missing Mail grants");
          await db`INSERT INTO mail.mailbox_access (mailbox_id, access_id)
            VALUES (${mailbox.id}::uuid, ${mailboxGrant.id}::uuid), (${mailbox.id}::uuid, ${publicGrant.id}::uuid),
              (${mailbox.id}::uuid, ${authenticatedGrant.id}::uuid)`;
          await db`INSERT INTO mail.mailbox_assigned_access (mailbox_id, access_id) VALUES (${mailbox.id}::uuid, ${assignedGrant.id}::uuid)`;
          const params = { mailboxId: mailbox.id, userIds: [account.id, outside.id, user.id], db };
          const list = () => listEligibleAssignees(params);
          const found = await list();
          expect(found.map((row) => row.id).sort()).toEqual([account.id, user.id].sort());
          expect(found.find((row) => row.id === account.id)).toMatchObject({
            displayName: account.name,
            type: "service_account",
            serviceAccountKind: kind,
            scope: "mailbox",
            permission: "write",
            source: { type: "group", groupId: parent.id, groupName: parent.name },
          });
          const searched = await listEligibleAssignees({ ...params, search: assigned.name });
          expect(searched).toHaveLength(2);
          for (const row of searched) expect(row.scope).toBe("mailbox");
          expect(await listEligibleAssignees({ ...params, userIds: [] })).toEqual([]);
          await db`UPDATE auth.access SET permission = 'read' WHERE id = ${mailboxGrant.id}::uuid`;
          for (const row of await list()) expect(row.scope).toBe("assigned");
          await db`DELETE FROM auth.service_account_groups WHERE service_account_id = ${account.id}::uuid AND group_id = ${assigned.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          await db`UPDATE auth.access SET permission = 'admin' WHERE id = ${mailboxGrant.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(true);
          await db`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          await db`UPDATE auth.service_accounts SET status = 'active', kind = 'resource_bound', app_id = 'mail', resource_type = 'mailbox',
            resource_id = ${mailbox.id} WHERE id = ${account.id}::uuid`;
          // A bound identity cannot inherit groups, even with a stale membership row.
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          const [direct] = await db<{ id: string }[]>`INSERT INTO auth.access (service_account_id, permission)
            VALUES (${account.id}::uuid, 'write') RETURNING id`;
          if (!direct) throw new Error("Missing direct grant");
          await db`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailbox.id}::uuid, ${direct.id}::uuid)`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(true);
          await db`UPDATE auth.service_accounts SET resource_id = 'another-mailbox' WHERE id = ${account.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          await db`UPDATE auth.service_accounts SET kind = 'user_delegated', app_id = NULL, resource_type = NULL, resource_id = NULL,
            delegated_user_id = ${user.id}::uuid WHERE id = ${account.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          await db`UPDATE auth.service_accounts SET kind = ${kind}, delegated_user_id = NULL WHERE id = ${account.id}::uuid`;
          await db`DELETE FROM auth.access WHERE id = ${direct.id}::uuid`;
          await db`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${parent.id}::uuid AND child_group_id = ${child.id}::uuid`;
          expect((await currentEligibleAssigneeIds(params)).has(account.id)).toBe(false);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    });
  }
});
