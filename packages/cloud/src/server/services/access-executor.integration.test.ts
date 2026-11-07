import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { sql } from "../../runtime/clients";
import { type AccessSubject, getEffectivePermission, getEffectivePermissions } from "../index";

databaseSuite()("batch permission transaction", () => {
  test("reads uncommitted grants, junctions and nested memberships without caching or leaking after rollback", async () => {
    const userId = "00000000-0000-4000-8000-000000000011";
    const childId = "00000000-0000-4000-8000-000000000012";
    const parentId = "00000000-0000-4000-8000-000000000013";
    const grantId = "00000000-0000-4000-8000-000000000014";
    const subjects: AccessSubject[] = [
      { type: "user", userId },
      { type: "service_account", serviceAccountId: "00000000-0000-4000-8000-000000000015" },
    ];
    const params = { accessIds: [grantId], subjects };
    const rollback = new Error("rollback permission fixture");
    await expect(
      sql.begin(async (tx) => {
        await tx`INSERT INTO auth.users (id, uid, provider, profile) VALUES (${userId}::uuid, 'batch-executor-user', 'local', 'user')`;
        await tx`INSERT INTO auth.groups (id, cn, name, provider) VALUES
        (${childId}::uuid, 'batch-executor-child', 'Child', 'local'), (${parentId}::uuid, 'batch-executor-parent', 'Parent', 'local')`;
        await tx`INSERT INTO auth.access (id, group_id, permission) VALUES (${grantId}::uuid, ${parentId}::uuid, 'write')`;
        await tx`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${childId}::uuid)`;
        await tx`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentId}::uuid, ${childId}::uuid)`;
        expect(await getEffectivePermissions(params, tx)).toEqual(["write", "none"]);
        expect(await getEffectivePermissions(params)).toEqual(["none", "none"]);
        await tx`CREATE TEMP TABLE executor_resource_access (access_id uuid) ON COMMIT DROP`;
        await tx`INSERT INTO executor_resource_access VALUES (${grantId}::uuid)`;
        const subquery = sql`SELECT access_id FROM executor_resource_access`;
        expect(await getEffectivePermissions({ accessIds: subquery, subjects }, tx)).toEqual(["write", "none"]);
        expect(await getEffectivePermissions(params, tx)).toEqual(
          await Promise.all(subjects.map((subject) => getEffectivePermission({ accessIds: [grantId], subject }, tx))),
        );
        await tx`UPDATE auth.access SET permission = 'read' WHERE id = ${grantId}::uuid`;
        expect(await getEffectivePermissions(params, tx)).toEqual(["read", "none"]);
        await tx`DELETE FROM auth.user_groups_v2 WHERE user_id = ${userId}::uuid`;
        expect(await getEffectivePermissions(params, tx)).toEqual(["none", "none"]);
        expect(await getEffectivePermissions({ accessIds: [], subjects }, tx)).toEqual(["none", "none"]);
        expect(await getEffectivePermissions({ accessIds: [grantId], subjects: [] }, tx)).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await getEffectivePermissions(params)).toEqual(["none", "none"]);
  });
});
