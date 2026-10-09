import { afterEach, beforeAll, describe, expect } from "bun:test";
import type { PermissionLevel, Principal } from "@k2b/cloud/server";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import { type BaseAdminAuthorization, grantAccess, listAccessForBaseTree, listBaseAccess, revokeAccess, updateAccessLevel } from "./access";

const postgresTest = testFor("database");
const AVATAR_HASH = "a".repeat(64);

const created = { bases: [] as string[], users: [] as string[], groups: [] as string[], serviceAccounts: [] as string[] };

afterEach(async () => {
  if (!testInfra.database) return;
  for (const baseId of created.bases.splice(0)) {
    await sql`
      DELETE FROM auth.access WHERE id IN (
        SELECT access_id FROM grids.base_access WHERE base_id = ${baseId}::uuid
        UNION SELECT caa.access_id FROM grids.custom_app_access caa JOIN grids.custom_apps app ON app.id = caa.custom_app_id
        WHERE app.base_id = ${baseId}::uuid
      )
    `;
    await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
    await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  }
  for (const id of created.serviceAccounts.splice(0)) await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
  for (const id of created.groups.splice(0)) await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
  for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
});

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

const insertBase = async (): Promise<string> => {
  const baseId = Bun.randomUUIDv7();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId()}, 'Last manager')`;
  created.bases.push(baseId);
  return baseId;
};

const insertUser = async (displayName: string, avatar = false): Promise<{ id: string; uid: string }> => {
  const uid = `grids-manager-${crypto.randomUUID().slice(0, 8)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, avatar_data_url, avatar_hash)
    VALUES (${uid}, 'local', 'user', ${displayName}, ${avatar ? "data:image/png;base64,AAAA" : null}, ${avatar ? AVATAR_HASH : null})
    RETURNING id::text
  `;
  created.users.push(row!.id);
  return { id: row!.id, uid };
};

const insertGroup = async (name: string, members: string[] = []): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.groups (cn, provider, name) VALUES (${`grids-manager-${crypto.randomUUID()}`}, 'local', ${name}) RETURNING id::text
  `;
  created.groups.push(row!.id);
  for (const userId of members) await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${row!.id}::uuid)`;
  return row!.id;
};

const insertServiceAccount = async (name: string, kind: "agent" | "resource_bound", baseId: string): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    VALUES (
      ${name},
      ${kind},
      ${kind === "resource_bound" ? "grids" : null},
      ${kind === "resource_bound" ? "base" : null},
      ${kind === "resource_bound" ? baseId : null}
    )
    RETURNING id::text
  `;
  created.serviceAccounts.push(row!.id);
  return row!.id;
};

/** Grants as the platform admin path does: no actor authorization. */
const grant = async (baseId: string, principal: Principal, permission: PermissionLevel): Promise<string> => {
  const result = await grantAccess({ resourceType: "base", resourceId: baseId, principal, permission });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.accessId;
};

const as = (userId: string): BaseAdminAuthorization => ({ subject: { type: "user", userId }, permissionCap: "admin" });

const permissionOf = async (accessId: string) =>
  (await sql<{ permission: PermissionLevel }[]>`SELECT permission FROM auth.access WHERE id = ${accessId}::uuid`)[0]?.permission ?? null;

const expectLastManager = (result: { ok: boolean; error?: { code: string; status: number; message: string } }, locale = "en") => {
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "LAST_MANAGER", status: 409 });
  expect(result.error?.message).toContain(locale === "de" ? "„Verwalten“" : "“Manage”");
};

describe("Grids base keeps a manager", () => {
  postgresTest("the only manager can neither lower nor remove their own access", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn");
    const own = await grant(baseId, { type: "user", userId: qdt.id }, "admin");

    expectLastManager(await updateAccessLevel(own, "write", qdt.id, as(qdt.id), "de"), "de");
    expectLastManager(await revokeAccess(own, qdt.id, as(qdt.id)));
    expect(await permissionOf(own)).toBe("admin");
  });

  postgresTest("a manager cannot lower or remove the last other manager, and a second manager unlocks both", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn");
    const lym = await insertUser("Lya Meyer");
    const qdtAccess = await grant(baseId, { type: "user", userId: qdt.id }, "admin");
    const lymAccess = await grant(baseId, { type: "user", userId: lym.id }, "admin");

    expect(await updateAccessLevel(lymAccess, "read", qdt.id, as(qdt.id))).toEqual({ ok: true, data: undefined });
    // The base admin path follows the same rule; it recovers by granting first.
    expectLastManager(await revokeAccess(qdtAccess, null));
    expect(await updateAccessLevel(lymAccess, "admin", null)).toEqual({ ok: true, data: undefined });
    expect(await revokeAccess(qdtAccess, null)).toEqual({ ok: true, data: undefined });
    expect(await permissionOf(lymAccess)).toBe("admin");
  });

  postgresTest("of two managers lowering themselves at once, exactly one succeeds", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn");
    const lym = await insertUser("Lya Meyer");
    const qdtAccess = await grant(baseId, { type: "user", userId: qdt.id }, "admin");
    const lymAccess = await grant(baseId, { type: "user", userId: lym.id }, "admin");

    const results = await Promise.all([
      updateAccessLevel(qdtAccess, "read", qdt.id, as(qdt.id)),
      revokeAccess(lymAccess, lym.id, as(lym.id)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused?.ok === false && refused.error.code).toBe("LAST_MANAGER");
    expect((await listBaseAccess(baseId)).filter((entry) => entry.permission === "admin")).toHaveLength(1);
  });

  postgresTest("a group can be the only manager regardless of its members", async () => {
    const baseId = await insertBase();
    const staff = await insertGroup("Staff");
    const staffAccess = await grant(baseId, { type: "group", groupId: staff }, "admin");

    expectLastManager(await updateAccessLevel(staffAccess, "write", null));
    expectLastManager(await revokeAccess(staffAccess, null));
  });

  postgresTest("a deny that shadows the only manager is refused", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn");
    await grant(baseId, { type: "user", userId: qdt.id }, "admin");
    const ownDeny = await grantAccess({
      resourceType: "base",
      resourceId: baseId,
      principal: { type: "user", userId: qdt.id },
      permission: "none",
      authorization: as(qdt.id),
    });
    expectLastManager(ownDeny);

    const groupBase = await insertBase();
    const staff = await insertGroup("Staff", [qdt.id]);
    await grant(groupBase, { type: "group", groupId: staff }, "admin");
    expectLastManager(
      await grantAccess({ resourceType: "base", resourceId: groupBase, principal: { type: "group", groupId: staff }, permission: "none" }),
    );
    expect(await listBaseAccess(groupBase)).toHaveLength(1);
  });

  postgresTest("a deny for another group neither counts against a group manager nor switches the guard off", async () => {
    const baseId = await insertBase();
    const alice = await insertUser("Alice Brandt");
    const bob = await insertUser("Bob Weiss");
    const staff = await insertGroup("Staff", [alice.id]);
    const interns = await insertGroup("Interns", [bob.id]);
    const staffAccess = await grant(baseId, { type: "group", groupId: staff }, "admin");

    const internsDeny = await grantAccess({
      resourceType: "base",
      resourceId: baseId,
      principal: { type: "group", groupId: interns },
      permission: "none",
      authorization: as(alice.id),
    });
    expect(internsDeny.ok).toBe(true);
    expectLastManager(await updateAccessLevel(staffAccess, "read", alice.id, as(alice.id)));
    expectLastManager(await revokeAccess(staffAccess, null));
    expect(await permissionOf(staffAccess)).toBe("admin");
  });

  postgresTest("a resource-bound key does not count as a manager, an agent does", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn");
    const own = await grant(baseId, { type: "user", userId: qdt.id }, "admin");
    const key = await insertServiceAccount("Import key", "resource_bound", baseId);
    await grant(baseId, { type: "service_account", serviceAccountId: key }, "admin");

    expectLastManager(await updateAccessLevel(own, "read", qdt.id, as(qdt.id)));

    const agent = await insertServiceAccount("Release agent", "agent", baseId);
    await grant(baseId, { type: "service_account", serviceAccountId: agent }, "admin");
    expect(await updateAccessLevel(own, "read", qdt.id, as(qdt.id))).toEqual({ ok: true, data: undefined });
  });
});

// The same grants as ScopedPermissionEditor.behavior.test.tsx, where the editor locks exactly these rows.
const precedenceCases: {
  name: string;
  build: (baseId: string) => Promise<Record<string, string>>;
  locked: string[];
}[] = [
  {
    name: "a duplicate none grant shadows the second manager",
    build: async (baseId) => {
      const qdt = await insertUser("Quentin Dorn");
      const lym = await insertUser("Lya Meyer");
      return {
        qdt: await grant(baseId, { type: "user", userId: qdt.id }, "admin"),
        lym: await grant(baseId, { type: "user", userId: lym.id }, "admin"),
        "lym-deny": await grant(baseId, { type: "user", userId: lym.id }, "none"),
      };
    },
    locked: ["qdt"],
  },
  {
    name: "a group deny shadows the group's own Manage grant",
    build: async (baseId) => {
      const qdt = await insertUser("Quentin Dorn");
      const staff = await insertGroup(`Staff ${testShortId()}`, [qdt.id]);
      return {
        qdt: await grant(baseId, { type: "user", userId: qdt.id }, "admin"),
        staff: await grant(baseId, { type: "group", groupId: staff }, "admin"),
        "staff-deny": await grant(baseId, { type: "group", groupId: staff }, "none"),
      };
    },
    locked: ["qdt"],
  },
  {
    name: "a deny for another group shadows nothing",
    build: async (baseId) => {
      const staff = await insertGroup(`Staff ${testShortId()}`);
      const interns = await insertGroup(`Interns ${testShortId()}`);
      return {
        staff: await grant(baseId, { type: "group", groupId: staff }, "admin"),
        "interns-deny": await grant(baseId, { type: "group", groupId: interns }, "none"),
      };
    },
    locked: ["staff"],
  },
  {
    name: "two unshadowed managers",
    build: async (baseId) => {
      const qdt = await insertUser("Quentin Dorn");
      const lym = await insertUser("Lya Meyer");
      return {
        qdt: await grant(baseId, { type: "user", userId: qdt.id }, "admin"),
        lym: await grant(baseId, { type: "user", userId: lym.id }, "admin"),
      };
    },
    locked: [],
  },
];

describe("Grids base access editor and service agree", () => {
  for (const scenario of precedenceCases) {
    postgresTest(`the service refuses exactly the rows the editor locks: ${scenario.name}`, async () => {
      const keys = Object.keys(await scenario.build(await insertBase()));
      const refused: Record<string, boolean[]> = {};
      for (const key of keys) {
        // Every change starts from the same grants, so one accepted change cannot unlock the next.
        const lowered = await updateAccessLevel((await scenario.build(await insertBase()))[key]!, "read", null);
        const revoked = await revokeAccess((await scenario.build(await insertBase()))[key]!, null);
        for (const result of [lowered, revoked]) if (!result.ok) expectLastManager(result);
        refused[key] = [!lowered.ok, !revoked.ok];
      }
      expect(refused).toEqual(Object.fromEntries(keys.map((key) => [key, scenario.locked.includes(key) ? [true, true] : [false, false]])));
    });
  }
});

describe("Grids access names", () => {
  postgresTest("lists people by display name with their photo, like every other permission editor", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser("Quentin Dorn", true);
    const unnamed = await insertUser("");
    const staff = await insertGroup("Staff");
    const agent = await insertServiceAccount("Release agent", "agent", baseId);
    await grant(baseId, { type: "user", userId: qdt.id }, "admin");
    await grant(baseId, { type: "user", userId: unnamed.id }, "read");
    await grant(baseId, { type: "group", groupId: staff }, "write");
    await grant(baseId, { type: "service_account", serviceAccountId: agent }, "read");

    const expected = [
      { displayName: "Quentin Dorn", avatarHash: AVATAR_HASH },
      { displayName: unnamed.uid, avatarHash: null },
      { displayName: "Staff" },
      { displayName: "Release agent", serviceAccountKind: "agent" },
    ];
    expect(await listBaseAccess(baseId)).toMatchObject(expected);
    expect(await listAccessForBaseTree(baseId)).toMatchObject(expected.map((entry) => ({ ...entry, resourceType: "base" })));
  });
});
