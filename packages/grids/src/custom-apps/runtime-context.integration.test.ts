import { expect, test } from "bun:test";
import { toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { loadCustomAppAuthSubjectIds } from "./runtime-context";

const suite = databaseSuite();

suite("Grids App authoritative machine subjects", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: subject context includes local ancestors and loses revoked membership`, async () => {
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES ('Runtime machine', ${kind}) RETURNING id`;
      if (!account) throw new Error("Missing account fixture");
      const groups: { id: string }[] = [];
      try {
        groups.push(
          ...(await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, name, provider)
          VALUES (${crypto.randomUUID()}, 'Child', 'local'), (${crypto.randomUUID()}, 'Parent', 'local') RETURNING id`),
        );
        const [child, parent] = groups;
        if (!child || !parent) throw new Error("Missing group fixture");
        await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id) VALUES (${account.id}::uuid, ${child.id}::uuid)`;
        await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent.id}::uuid, ${child.id}::uuid)`;
        const access = { actor: undefined, accessSubject: { type: "service_account" as const, serviceAccountId: account.id } };
        expect(await loadCustomAppAuthSubjectIds(access)).toEqual([account.id, child.id, parent.id]);
        await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account.id}::uuid`;
        expect(await loadCustomAppAuthSubjectIds(access)).toEqual([account.id]);
        await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${account.id}::uuid`;
        await sql`DELETE FROM auth.service_account_groups WHERE service_account_id = ${account.id}::uuid`;
        expect(await loadCustomAppAuthSubjectIds(access)).toEqual([account.id]);
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
        await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ANY(${toPgUuidArray(groups.map((group) => group.id))}::uuid[])
          OR child_group_id = ANY(${toPgUuidArray(groups.map((group) => group.id))}::uuid[])`;
        await sql`DELETE FROM auth.groups WHERE id = ANY(${toPgUuidArray(groups.map((group) => group.id))}::uuid[])`;
      }
    });
  }
});
