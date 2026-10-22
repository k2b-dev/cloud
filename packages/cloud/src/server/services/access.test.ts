import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { toPgUuidArray } from "../../services/postgres";
import "../../../../../scripts/fixtures/authorization-preload";
import {
  createAccess,
  deleteAccess,
  getEffectiveGroupIds,
  getEffectiveGroups,
  getEffectivePermission,
  getEffectivePermissions,
  listUsersWithAccess,
  resolveDisplayNames,
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
  test("prioritizes exact search matches before limiting by name order", async () => {
    const fixture = await createFixture();
    try {
      const query = `access-exact-${fixture.userIds.direct}`;
      await sql`UPDATE auth.users SET uid = ${query}, display_name = 'Zulu' WHERE id = ${fixture.userIds.direct}::uuid`;
      await sql`UPDATE auth.users SET display_name = ${`Aardvark ${query}`} WHERE id = ${fixture.userIds.group}::uuid`;
      await sql`UPDATE auth.users SET display_name = ${query} WHERE id = ${fixture.userIds.nested}::uuid`;

      // Name-only ordering would hide the exact login-name match behind the earlier substring match at this limit.
      const users = await listUsersWithAccess({ accessIds: fixture.accessIds, search: ` ${query.toUpperCase()} `, limit: 1 });
      expect(users.map((user) => user.id)).toEqual([fixture.userIds.direct]);

      const displayNameMatches = await listUsersWithAccess({
        accessIds: fixture.accessIds,
        search: query,
        excludeUserIds: [fixture.userIds.direct],
        limit: 1,
      });
      expect(displayNameMatches.map((user) => user.id)).toEqual([fixture.userIds.nested]);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);

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

  test("decides many subjects in one query exactly like one subject at a time", async () => {
    const fixture = await createFixture();
    try {
      const serviceAccountAccess = await createAccess({
        principal: { type: "service_account", serviceAccountId: fixture.serviceAccountId },
        permission: "write",
      });
      if (!serviceAccountAccess.ok) throw new Error(serviceAccountAccess.error.message);
      fixture.accessIds.push(serviceAccountAccess.data.id);
      const [directAccessId, groupAccessId, publicAccessId, authenticatedAccessId] = fixture.accessIds;
      const subjects = [
        ...Object.values(fixture.userIds).map((userId) => ({ type: "user" as const, userId })),
        { type: "user" as const, userId: fixture.userIds.outside, delegatedByServiceAccountId: fixture.serviceAccountId },
        { type: "service_account" as const, serviceAccountId: fixture.serviceAccountId },
      ];
      const grantSets = [
        [],
        [directAccessId!],
        [groupAccessId!],
        [directAccessId!, groupAccessId!],
        [publicAccessId!],
        [authenticatedAccessId!],
        [serviceAccountAccess.data.id],
        fixture.accessIds,
      ];
      for (const accessIds of grantSets) {
        const one = await Promise.all(subjects.map((subject) => getEffectivePermission({ accessIds, subject })));
        expect(await getEffectivePermissions({ accessIds, subjects })).toEqual(one);
        expect(
          await getEffectivePermissions({
            accessIds: sql`SELECT id FROM auth.access WHERE id = ANY(${toPgUuidArray(accessIds)}::uuid[])`,
            subjects,
          }),
        ).toEqual(one);
      }
      expect(await getEffectivePermissions({ accessIds: fixture.accessIds, subjects: [] })).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);
});

suite("resolveDisplayNames", () => {
  test("missing principals and audiences carry no invented display name", async () => {
    const missing = "11111111-1111-4111-8111-111111111111";
    const entries = await resolveDisplayNames([
      { principal: { type: "user" as const, userId: missing }, displayName: "stale" },
      { principal: { type: "group" as const, groupId: missing } },
      { principal: { type: "service_account" as const, serviceAccountId: missing } },
      { principal: { type: "authenticated" as const } },
      { principal: { type: "public" as const } },
    ]);
    expect(entries.map((entry) => entry.displayName)).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test("adds the service-account kind to service-account principals only", async () => {
    const fixture = await createFixture();
    const agentName = `Access agent ${crypto.randomUUID()}`;
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${agentName}, 'agent') RETURNING id
    `;
    try {
      const resolved = await resolveDisplayNames([
        { principal: { type: "service_account" as const, serviceAccountId: agent!.id } },
        { principal: { type: "service_account" as const, serviceAccountId: fixture.serviceAccountId } },
        { principal: { type: "user" as const, userId: fixture.userIds.direct } },
      ]);

      expect(resolved.map((entry) => entry.serviceAccountKind)).toEqual(["agent", "resource_bound", undefined]);
      expect(resolved.map((entry) => entry.displayName)).toEqual([agentName, expect.stringMatching(/^Access service /), "Access direct"]);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${agent!.id}::uuid`;
      await cleanupFixture(fixture);
    }
  }, 30_000);
});

// Isolate the SQL fixture from other suites, as in the account-lifecycle tests.
test("resolveDisplayNames batches each kind once and leaves missing names absent", async () => {
  const script = `
    import { strict as assert } from "node:assert";
    const calls = [];
    globalThis.principalDisplaySql = async (parts) => {
      const query = parts.join("?");
      const kind = query.includes("FROM auth.users") ? "user" : query.includes("FROM auth.groups") ? "group" : query.includes("FROM auth.service_accounts") ? "service_account" : null;
      assert.ok(kind, query);
      calls.push(kind);
      if (kind === "user") return [{ id: "11111111-1111-4111-8111-111111111111", display_name: "", uid: "ada.example", avatar_hash: "picture" }];
      if (kind === "group") return [{ id: "11111111-1111-4111-8111-111111111111", name: "research" }];
      return [{ id: "11111111-1111-4111-8111-111111111111", name: "Research agent", kind: "agent" }];
    };
    Bun.plugin({ name: "principal-display-sql-fixture", setup(build) {
      build.onLoad({ filter: /server\\/services\\/access[.]ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replace('import { type SQLQuery, sql } from "bun";', 'const sql = globalThis.principalDisplaySql;'),
        loader: "ts",
      }));
    } });
    const { resolveDisplayNames } = await import(${JSON.stringify(new URL("./access.ts", import.meta.url).pathname)});
    const present = "11111111-1111-4111-8111-111111111111", missing = "22222222-2222-4222-8222-222222222222";
    const entries = [
      { principal: { type: "user", userId: present } },
      { principal: { type: "user", userId: missing }, displayName: "stale name" },
      { principal: { type: "group", groupId: present } },
      { principal: { type: "group", groupId: missing } },
      { principal: { type: "service_account", serviceAccountId: present } },
      { principal: { type: "service_account", serviceAccountId: missing } },
      { principal: { type: "authenticated" }, displayName: "Old English audience" },
      { principal: { type: "public" } },
    ];
    const result = await resolveDisplayNames(entries);
    assert.deepEqual(calls, ["user", "group", "service_account"]);
    assert.deepEqual(result.map(entry => entry.displayName), ["ada.example", undefined, "research", undefined, "Research agent", undefined, undefined, undefined]);
    assert.equal(result[0].avatarHash, "picture");
    assert.equal(result[4].serviceAccountKind, "agent");
    assert.equal(entries[1].displayName, "stale name");
    calls.length = 0;
    assert.deepEqual(await resolveDisplayNames([]), []);
    await resolveDisplayNames([{ principal: { type: "public" } }]);
    assert.deepEqual(calls, []);
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH, DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});
