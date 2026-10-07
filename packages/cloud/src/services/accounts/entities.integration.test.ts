import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { createAccess, getEffectivePermissions } from "../../server/services/access";
import { accountsAppService } from "./app";
import type { AccountsActor } from "./authz";

const suite = databaseSuite();

const insertUser = async (suffix: string, label: string, profile: "user" | "guest") => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (
      ${`entity-visibility-${label}-${suffix}`},
      'local',
      ${profile},
      ${`Entity ${label}`},
      ${`entity-${label}-${suffix}@example.test`}
    )
    RETURNING id
  `;
  return row!.id;
};

const insertGroup = async (suffix: string, label: string) => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name, description)
    VALUES (
      ${`entity-visibility-${label}-${suffix}`},
      'local',
      ${`Entity ${label} ${suffix}`},
      ${`Entity ${label} ${suffix} group`}
    )
    RETURNING id
  `;
  return row!.id;
};

suite("accounts entity visibility (integration)", () => {
  test("limits guests to themselves and their effective groups before filtering and pagination", async () => {
    const suffix = crypto.randomUUID();
    const guestId = await insertUser(suffix, "guest", "guest");
    const fellowGuestId = await insertUser(suffix, "fellow", "guest");
    const outsideUserId = await insertUser(suffix, "outside", "user");
    const childGroupId = await insertGroup(suffix, "child");
    const parentGroupId = await insertGroup(suffix, "parent");
    const unrelatedGroupId = await insertGroup(suffix, "unrelated");
    const [serviceAccount] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES (${`Entity service ${suffix}`}, 'resource_bound', 'entity-test', 'fixture', ${suffix})
      RETURNING id
    `;

    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${guestId}::uuid, ${childGroupId}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${fellowGuestId}::uuid, ${childGroupId}::uuid)`;
    await sql`
      INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
      VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)
    `;

    const guestActor: AccountsActor = {
      userId: guestId,
      uid: `entity-visibility-guest-${suffix}`,
      roles: ["guest", "local", "local/guest"],
      provider: "local",
    };
    const fullUserActor: AccountsActor = {
      userId: outsideUserId,
      uid: `entity-visibility-outside-${suffix}`,
      roles: ["user", "local", "local/user"],
      provider: "local",
    };
    const cleanup = async () => {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccount!.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${childGroupId}::uuid, ${parentGroupId}::uuid, ${unrelatedGroupId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${guestId}::uuid, ${fellowGuestId}::uuid, ${outsideUserId}::uuid)`;
    };

    try {
      const visible = await accountsAppService.entity.list({
        actor: guestActor,
        search: suffix,
        pagination: { page: 1, perPage: 10 },
      });
      expect(visible.total).toBe(3);
      expect(
        visible.items.map((item) => (item.kind === "user" ? item.user.id : item.kind === "group" ? item.group.id : item.serviceAccount.id)),
      ).toEqual(expect.arrayContaining([childGroupId, parentGroupId, guestId]));

      const users = await accountsAppService.entity.list({ actor: guestActor, kinds: ["user"] });
      expect(users.total).toBe(1);
      expect(users.items).toMatchObject([{ kind: "user", user: { id: guestId } }]);

      const groups = await accountsAppService.entity.list({ actor: guestActor, kinds: ["group"] });
      expect(groups.total).toBe(2);
      expect(groups.items).toMatchObject([
        { kind: "group", group: { id: childGroupId } },
        { kind: "group", group: { id: parentGroupId } },
      ]);

      const secondPage = await accountsAppService.entity.list({
        actor: guestActor,
        pagination: { page: 2, perPage: 2 },
      });
      expect(secondPage.total).toBe(3);
      expect(secondPage.items).toHaveLength(1);

      const excluded = await accountsAppService.entity.list({
        actor: guestActor,
        excludeUserIds: [guestId],
        excludeGroupIds: [childGroupId],
      });
      expect(excluded.total).toBe(1);
      expect(excluded.items).toMatchObject([{ kind: "group", group: { id: parentGroupId } }]);

      const exactVisible = await accountsAppService.entity.list({
        actor: guestActor,
        userIds: [guestId, fellowGuestId],
        groupIds: [parentGroupId, unrelatedGroupId],
      });
      expect(exactVisible.total).toBe(2);
      expect(exactVisible.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "user", user: expect.objectContaining({ id: guestId }) }),
          expect.objectContaining({ kind: "group", group: expect.objectContaining({ id: parentGroupId }) }),
        ]),
      );

      const serviceAccounts = await accountsAppService.entity.list({ actor: guestActor, kinds: ["service_account"] });
      expect(serviceAccounts).toMatchObject({ total: 0, items: [] });

      expect(await accountsAppService.entity.list({ actor: guestActor, profile: "user" })).toMatchObject({
        total: 2,
        items: [{ kind: "group" }, { kind: "group" }],
      });
      expect(await accountsAppService.entity.list({ actor: guestActor, provider: "ipa" })).toMatchObject({ total: 0, items: [] });
      expect(await accountsAppService.entity.list({ actor: guestActor, search: "outside" })).toMatchObject({ total: 0, items: [] });

      await expect(
        accountsAppService.entity.list({
          actor: guestActor,
          managedByUserId: outsideUserId,
        }),
      ).rejects.toThrow("Guest accounts cannot use entity relation filters");

      const directory = await accountsAppService.entity.list({
        actor: fullUserActor,
        search: suffix,
        pagination: { page: 1, perPage: 20 },
      });
      const directoryIds = directory.items.map((item) =>
        item.kind === "user" ? item.user.id : item.kind === "group" ? item.group.id : item.serviceAccount.id,
      );
      expect(directoryIds).toEqual(
        expect.arrayContaining([guestId, fellowGuestId, outsideUserId, childGroupId, parentGroupId, unrelatedGroupId, serviceAccount!.id]),
      );
    } finally {
      await cleanup();
    }
  });

  // The shared access editor counts and lists a group grant's reach with exactly this query.
  test("lists a group's members as access resolution reaches them, and only for full accounts", async () => {
    const suffix = crypto.randomUUID();
    const directId = await insertUser(suffix, "direct", "guest");
    const nestedId = await insertUser(suffix, "nested", "user");
    const outsideId = await insertUser(suffix, "outside", "user");
    const parentGroupId = await insertGroup(suffix, "granted");
    const childGroupId = await insertGroup(suffix, "nested-team");
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${directId}::uuid, ${parentGroupId}::uuid)`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${nestedId}::uuid, ${childGroupId}::uuid)`;
    await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
    const grant = await createAccess({ principal: { type: "group", groupId: parentGroupId }, permission: "read" });
    if (!grant.ok) throw new Error(grant.error.message);
    const actor = (userId: string, profile: "user" | "guest"): AccountsActor => ({
      userId,
      uid: `entity-visibility-${profile}-${suffix}`,
      roles: [profile, "local", `local/${profile}`],
      provider: "local",
    });

    try {
      const coverage = await accountsAppService.entity.list({
        actor: actor(outsideId, "user"),
        kinds: ["user"],
        memberOfGroupId: parentGroupId,
        recursive: true,
        pagination: { page: 1, perPage: 20 },
      });
      const covered = coverage.items.map((item) => (item.kind === "user" ? item.user.id : null));
      expect(coverage.total).toBe(2);
      expect(covered).toEqual(expect.arrayContaining([directId, nestedId]));

      const candidates = [directId, nestedId, outsideId];
      const permissions = await getEffectivePermissions({
        accessIds: [grant.data.id],
        subjects: candidates.map((userId) => ({ type: "user", userId })),
      });
      expect(candidates.filter((_, index) => permissions[index] !== "none")).toEqual(
        candidates.filter((userId) => covered.includes(userId)),
      );

      // A guest who belongs to the group still may not read who else does.
      await expect(
        accountsAppService.entity.list({
          actor: actor(directId, "guest"),
          kinds: ["user"],
          memberOfGroupId: parentGroupId,
          recursive: true,
        }),
      ).rejects.toThrow("Guest accounts cannot use entity relation filters");
    } finally {
      await sql`DELETE FROM auth.access WHERE id = ${grant.data.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${parentGroupId}::uuid, ${childGroupId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${directId}::uuid, ${nestedId}::uuid, ${outsideId}::uuid)`;
    }
  });
});
