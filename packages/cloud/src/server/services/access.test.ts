import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import {
  createAccess,
  deleteAccess,
  getEffectiveGroupIds,
  getEffectiveGroups,
  getEffectivePermission,
  listUsersWithAccess,
} from "./access";

type Fixture = {
  accessIds: string[];
  groupAccessId: string;
  publicAccessId: string;
  authenticatedAccessId: string;
  userIds: {
    direct: string;
    group: string;
    nested: string;
    outside: string;
  };
  groupIds: {
    parent: string;
    child: string;
  };
  serviceAccountId: string;
};

const suite = databaseSuite();

const insertUser = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`access-helper-${label}-${suffix}`}, 'local', 'user', ${`Access ${label}`}, ${`${label}.${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${`access-helper-${label}-${suffix}`}, 'local', ${`Access ${label}`}, ${`Access ${label} test group`})
    RETURNING id
  `;
  return row!.id;
};

const createFixture = async (): Promise<Fixture> => {
  const suffix = crypto.randomUUID();
  const directUserId = await insertUser(suffix, "direct");
  const groupUserId = await insertUser(suffix, "group");
  const nestedUserId = await insertUser(suffix, "nested");
  const outsideUserId = await insertUser(suffix, "outside");
  const parentGroupId = await insertGroup(suffix, "parent");
  const childGroupId = await insertGroup(suffix, "child");
  const [serviceAccount] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (${`Access service ${suffix}`}, 'resource_bound', 'access-test', 'fixture', ${suffix})
    RETURNING id
  `;

  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${groupUserId}::uuid, ${parentGroupId}::uuid)`;
  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedUserId}::uuid, ${childGroupId}::uuid)`;
  await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)`;

  const [directAccess] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${directUserId}::uuid, 'read')
    RETURNING id
  `;
  const [groupAccess] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (group_id, permission)
    VALUES (${parentGroupId}::uuid, 'write')
    RETURNING id
  `;
  const [publicAccess] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (permission)
    VALUES ('admin')
    RETURNING id
  `;
  const [authenticatedAccess] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (authenticated_only, permission)
    VALUES (TRUE, 'admin')
    RETURNING id
  `;

  return {
    accessIds: [directAccess!.id, groupAccess!.id, publicAccess!.id, authenticatedAccess!.id],
    groupAccessId: groupAccess!.id,
    publicAccessId: publicAccess!.id,
    authenticatedAccessId: authenticatedAccess!.id,
    userIds: {
      direct: directUserId,
      group: groupUserId,
      nested: nestedUserId,
      outside: outsideUserId,
    },
    groupIds: {
      parent: parentGroupId,
      child: childGroupId,
    },
    serviceAccountId: serviceAccount!.id,
  };
};

const cleanupFixture = async (fixture: Fixture) => {
  for (const accessId of fixture.accessIds) {
    await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
  }
  for (const groupId of Object.values(fixture.groupIds)) {
    await sql`DELETE FROM auth.group_groups_v2 WHERE parent_group_id = ${groupId}::uuid OR child_group_id = ${groupId}::uuid`;
    await sql`DELETE FROM auth.user_groups_v2 WHERE group_id = ${groupId}::uuid`;
  }
  for (const groupId of Object.values(fixture.groupIds)) {
    await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
  }
  await sql`DELETE FROM auth.service_accounts WHERE id = ${fixture.serviceAccountId}::uuid`;
  for (const userId of Object.values(fixture.userIds)) {
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
};

suite("listUsersWithAccess", () => {
  test("expands direct and recursive group access without exposing mail", async () => {
    const fixture = await createFixture();
    try {
      const users = await listUsersWithAccess({ accessIds: fixture.accessIds, limit: 20 });
      const byId = new Map(users.map((user) => [user.id, user]));

      expect(byId.has(fixture.userIds.direct)).toBe(true);
      expect(byId.has(fixture.userIds.group)).toBe(true);
      expect(byId.has(fixture.userIds.nested)).toBe(true);
      expect(byId.has(fixture.userIds.outside)).toBe(false);

      expect(byId.get(fixture.userIds.direct)?.source).toEqual({ type: "direct" });
      expect(byId.get(fixture.userIds.nested)?.source).toEqual({
        type: "group",
        groupId: fixture.groupIds.parent,
        groupName: "Access parent",
      });
      expect(byId.get(fixture.userIds.nested)?.permission).toBe("write");
      expect("mail" in byId.get(fixture.userIds.nested)!).toBe(false);

      const groupSearch = await listUsersWithAccess({ accessIds: fixture.accessIds, search: "parent", limit: 20 });
      expect(groupSearch.map((user) => user.id)).toContain(fixture.userIds.nested);

      const explicitUsers = await listUsersWithAccess({
        accessIds: fixture.accessIds,
        userIds: [fixture.userIds.nested, fixture.userIds.outside],
      });
      expect(explicitUsers.map((user) => user.id)).toEqual([fixture.userIds.nested]);

      const writers = await listUsersWithAccess({ accessIds: fixture.accessIds, minimumPermission: "write", limit: 20 });
      expect(writers.map((user) => user.id)).not.toContain(fixture.userIds.direct);
      expect(writers.map((user) => user.id)).toContain(fixture.userIds.group);

      const transactionalUsers = await sql.begin((tx) => listUsersWithAccess({ accessIds: fixture.accessIds, limit: 20, db: tx }));
      expect(transactionalUsers.map((user) => user.id)).toEqual(users.map((user) => user.id));

      const serviceAccountPublicPermission = await getEffectivePermission({
        accessIds: [fixture.publicAccessId],
        subject: { type: "service_account", serviceAccountId: fixture.serviceAccountId },
      });
      expect(serviceAccountPublicPermission).toBe("admin");

      const serviceAccountAuthenticatedPermission = await getEffectivePermission({
        accessIds: [fixture.authenticatedAccessId],
        subject: { type: "service_account", serviceAccountId: fixture.serviceAccountId },
      });
      expect(serviceAccountAuthenticatedPermission).toBe("admin");

      const anonymousPublicPermission = await getEffectivePermission({
        accessIds: [fixture.publicAccessId],
        subject: null,
      });
      expect(anonymousPublicPermission).toBe("admin");

      const anonymousAuthenticatedPermission = await getEffectivePermission({
        accessIds: [fixture.authenticatedAccessId],
        subject: null,
      });
      expect(anonymousAuthenticatedPermission).toBe("none");

      const serviceAccountAccess = await createAccess({
        principal: { type: "service_account", serviceAccountId: fixture.serviceAccountId },
        permission: "write",
      });
      expect(serviceAccountAccess.ok).toBe(true);
      if (!serviceAccountAccess.ok) return;
      fixture.accessIds.push(serviceAccountAccess.data.id);

      const serviceAccountPermission = await getEffectivePermission({
        accessIds: [serviceAccountAccess.data.id],
        subject: { type: "service_account", serviceAccountId: fixture.serviceAccountId },
      });
      expect(serviceAccountPermission).toBe("write");

      expect(
        await getEffectivePermission({
          accessIds: [fixture.publicAccessId, fixture.authenticatedAccessId],
          serviceAccountId: fixture.serviceAccountId,
        }),
      ).toBe("none");
      expect(
        await getEffectivePermission({
          accessIds: [serviceAccountAccess.data.id],
          serviceAccountId: fixture.serviceAccountId,
        }),
      ).toBe("write");

      const delegatedPermission = await getEffectivePermission({
        accessIds: [serviceAccountAccess.data.id],
        subject: {
          type: "user",
          userId: fixture.userIds.outside,
          delegatedByServiceAccountId: fixture.serviceAccountId,
        },
      });
      expect(delegatedPermission).toBe("none");

      const serviceAccountUsers = await listUsersWithAccess({ accessIds: [serviceAccountAccess.data.id], limit: 20 });
      expect(serviceAccountUsers).toEqual([]);

      const deleteResult = await deleteAccess({ id: serviceAccountAccess.data.id });
      expect(deleteResult.ok).toBe(true);
      fixture.accessIds = fixture.accessIds.filter((id) => id !== serviceAccountAccess.data.id);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);
});

suite("effective access", () => {
  test("resolves nested groups from the database and rejects caller-supplied group escalation", async () => {
    const fixture = await createFixture();
    try {
      const nestedGroups = await getEffectiveGroupIds({ userId: fixture.userIds.nested });
      expect(nestedGroups).toContain(fixture.groupIds.child);
      expect(nestedGroups).toContain(fixture.groupIds.parent);

      const effectiveGroups = await getEffectiveGroups({ userId: fixture.userIds.nested });
      expect(effectiveGroups).toEqual([
        { id: fixture.groupIds.child, name: "Access child" },
        { id: fixture.groupIds.parent, name: "Access parent" },
      ]);

      const nestedPermission = await getEffectivePermission({
        accessIds: [fixture.groupAccessId],
        subject: { type: "user", userId: fixture.userIds.nested },
      });
      expect(nestedPermission).toBe("write");

      const directGroupPermission = await getEffectivePermission({
        accessIds: [fixture.groupAccessId],
        subject: { type: "user", userId: fixture.userIds.group },
      });
      expect(directGroupPermission).toBe("write");

      const spoofedPermission = await getEffectivePermission({
        accessIds: [fixture.groupAccessId],
        userId: fixture.userIds.outside,
        userGroups: [fixture.groupIds.parent],
      });
      expect(spoofedPermission).toBe("none");
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);
});
