import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { create, get, listAssignableUsers, setAssignees, setTags, update } from "./items";
import { canAccess, getPermission, list as listSpaces } from "./spaces";

type Fixture = {
  spaceId: string;
  columnId: string;
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
  tagIds: {
    first: string;
    second: string;
  };
  accessIds: string[];
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

const insertUser = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`spaces-assignee-${label}-${suffix}`}, 'local', 'user', ${`Spaces ${label}`}, ${`${label}.${suffix}@example.test`})
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (${`spaces-assignee-${label}-${suffix}`}, 'local', ${`Spaces ${label}`}, ${`Spaces ${label} test group`})
    RETURNING id
  `;
  return row!.id;
};

const grantUser = async (spaceId: string, userId: string) => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${userId}::uuid, 'write')
    RETURNING id
  `;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

const grantGroup = async (spaceId: string, groupId: string) => {
  const [access] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (group_id, permission)
    VALUES (${groupId}::uuid, 'admin')
    RETURNING id
  `;
  await sql`INSERT INTO spaces.space_access (space_id, access_id) VALUES (${spaceId}::uuid, ${access!.id}::uuid)`;
  return access!.id;
};

const insertTag = async (spaceId: string, suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO spaces.tags (short_id, space_id, name, color)
    VALUES (${newShortId()}, ${spaceId}::uuid, ${`Tag ${label} ${suffix}`}, '#3b82f6')
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

  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${groupUserId}::uuid, ${parentGroupId}::uuid)`;
  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedUserId}::uuid, ${childGroupId}::uuid)`;
  await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)`;

  const [space] = await sql<{ id: string }[]>`
    INSERT INTO spaces.spaces (short_id, name, description, color)
    VALUES (${newShortId()}, ${`Assignee Test ${suffix}`}, 'assignee access test', '#3b82f6')
    RETURNING id
  `;
  const [column] = await sql<{ id: string }[]>`
    INSERT INTO spaces.columns (short_id, space_id, name, rank)
    VALUES (${newShortId()}, ${space!.id}::uuid, 'To Do', 1024)
    RETURNING id
  `;
  const firstTagId = await insertTag(space!.id, suffix, "first");
  const secondTagId = await insertTag(space!.id, suffix, "second");

  const directAccessId = await grantUser(space!.id, directUserId);
  const groupAccessId = await grantGroup(space!.id, parentGroupId);

  return {
    spaceId: space!.id,
    columnId: column!.id,
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
    tagIds: {
      first: firstTagId,
      second: secondTagId,
    },
    accessIds: [directAccessId, groupAccessId],
  };
};

const cleanupFixture = async (fixture: Fixture) => {
  await sql`DELETE FROM spaces.spaces WHERE id = ${fixture.spaceId}::uuid`;
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
  for (const userId of Object.values(fixture.userIds)) {
    await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  }
};

suite("Spaces assignable users", () => {
  test("lists only users with effective space access and rejects invalid assignees", async () => {
    const fixture = await createFixture();
    try {
      const nestedSpaces = await listSpaces({ subject: { type: "user", userId: fixture.userIds.nested } });
      const outsideSpaces = await listSpaces({
        subject: { type: "user", userId: fixture.userIds.outside },
      });
      expect(nestedSpaces.map((space) => space.id)).toContain(fixture.spaceId);
      expect(outsideSpaces.map((space) => space.id)).not.toContain(fixture.spaceId);
      expect(
        await canAccess({
          spaceId: fixture.spaceId,
          subject: { type: "user", userId: fixture.userIds.nested },
          requiredLevel: "admin",
        }),
      ).toBe(true);
      expect(
        await getPermission({
          spaceId: fixture.spaceId,
          subject: { type: "user", userId: fixture.userIds.nested },
        }),
      ).toBe("admin");

      const users = await listAssignableUsers({ spaceId: fixture.spaceId, limit: 20 });
      const ids = users.map((user) => user.id);

      expect(ids).toContain(fixture.userIds.direct);
      expect(ids).toContain(fixture.userIds.group);
      expect(ids).toContain(fixture.userIds.nested);
      expect(ids).not.toContain(fixture.userIds.outside);

      const usersById = new Map(users.map((user) => [user.id, user]));
      expect(usersById.get(fixture.userIds.direct)?.description).toContain("direct access");
      expect(usersById.get(fixture.userIds.group)?.description).toContain("via Spaces parent");
      expect(usersById.get(fixture.userIds.nested)?.description).toContain("via Spaces parent");
      expect(usersById.get(fixture.userIds.nested)?.description).not.toContain("Spaces child");

      const nestedSearch = await listAssignableUsers({
        spaceId: fixture.spaceId,
        search: "nested",
        limit: 20,
      });
      expect(nestedSearch.map((user) => user.id)).toEqual([fixture.userIds.nested]);

      const groupPathSearch = await listAssignableUsers({
        spaceId: fixture.spaceId,
        search: "parent",
        limit: 20,
      });
      expect(groupPathSearch.map((user) => user.id)).toContain(fixture.userIds.nested);

      const invalid = await create({
        spaceId: fixture.spaceId,
        createdBy: fixture.userIds.direct,
        data: {
          columnId: fixture.columnId,
          title: "Invalid assignment",
          assigneeIds: [fixture.userIds.outside],
        },
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.status).toBe(400);
        expect(invalid.error).toContain("access to this space");
      }
    } finally {
      await cleanupFixture(fixture);
    }
  });

  test("keeps item assignees and tags consistent across create and replacement writes", async () => {
    const fixture = await createFixture();
    try {
      const created = await create({
        spaceId: fixture.spaceId,
        createdBy: fixture.userIds.direct,
        data: {
          columnId: fixture.columnId,
          title: "Relation consistency",
          assigneeIds: [fixture.userIds.direct],
          tagIds: [fixture.tagIds.first],
        },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error);

      expect(created.data.assignees?.map((assignee) => assignee.id)).toEqual([fixture.userIds.direct]);
      expect(created.data.tags?.map((tag) => tag.id)).toEqual([fixture.tagIds.first]);

      const invalidTagId = crypto.randomUUID();
      const invalidUpdate = await update({
        id: created.data.id,
        data: {
          assigneeIds: [fixture.userIds.group],
          tagIds: [invalidTagId],
        },
      });
      expect(invalidUpdate.ok).toBe(false);

      const afterInvalidUpdate = await get({ id: created.data.id });
      expect(afterInvalidUpdate?.assignees?.map((assignee) => assignee.id)).toEqual([fixture.userIds.direct]);
      expect(afterInvalidUpdate?.tags?.map((tag) => tag.id)).toEqual([fixture.tagIds.first]);

      const assignees = await setAssignees({
        id: created.data.id,
        userIds: [fixture.userIds.group, fixture.userIds.nested],
      });
      expect(assignees.ok).toBe(true);

      const tags = await setTags({
        id: created.data.id,
        tagIds: [fixture.tagIds.second],
      });
      expect(tags.ok).toBe(true);

      const finalItem = await get({ id: created.data.id });
      expect(finalItem?.assignees?.map((assignee) => assignee.id).sort()).toEqual([fixture.userIds.group, fixture.userIds.nested].sort());
      expect(finalItem?.tags?.map((tag) => tag.id)).toEqual([fixture.tagIds.second]);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
