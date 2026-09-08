import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import {
  grantAccess,
  listAccessForBaseTree,
  listBaseAccess,
  listCustomAppAccess,
  lockBaseAuthorization,
  resolveAccessBinding,
  resolveResourceBinding,
} from "./access";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const insertFixture = async () => {
  const baseId = uuid();
  const customAppId = uuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Access registry')`;
  await sql`
    INSERT INTO grids.custom_apps (id, short_id, base_id, name, draft_definition, draft_capabilities)
    VALUES (${customAppId}::uuid, ${shortId("C")}, ${baseId}::uuid, 'Request portal', '{}'::jsonb, NULL)
  `;
  return { baseId, customAppId };
};

const cleanup = async (baseId: string, accessIds: string[]) => {
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("access resource registry integration", () => {
  postgresTest("rejects new Grids App service-account grants without hiding stored rows", async () => {
    const item = await insertFixture();
    const [serviceAccount] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Legacy Grids App access', 'resource_bound', 'grids', 'base', ${item.baseId})
      RETURNING id::text AS id
    `;
    if (!serviceAccount) throw new Error("Failed to create service account fixture");
    const [storedAccess] = await sql<{ id: string }[]>`
      INSERT INTO auth.access (service_account_id, permission)
      VALUES (${serviceAccount.id}::uuid, 'read')
      RETURNING id::text AS id
    `;
    if (!storedAccess) throw new Error("Failed to create stored access fixture");
    try {
      await sql`
        INSERT INTO grids.custom_app_access (custom_app_id, access_id)
        VALUES (${item.customAppId}::uuid, ${storedAccess.id}::uuid)
      `;

      const rejected = await grantAccess({
        resourceType: "customApp",
        resourceId: item.customAppId,
        principal: { type: "service_account", serviceAccountId: serviceAccount.id },
        permission: "read",
      });

      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.message).toBe(
          "Grids App access does not support service accounts. Grant access to the delegated user instead.",
        );
      }
      expect(await listCustomAppAccess(item.customAppId)).toEqual([
        expect.objectContaining({
          id: storedAccess.id,
          principal: { type: "service_account", serviceAccountId: serviceAccount.id },
          permission: "read",
        }),
      ]);
    } finally {
      await cleanup(item.baseId, [storedAccess.id]);
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccount.id}::uuid`;
    }
  });

  postgresTest("rechecks base administration after a concurrent revocation", async () => {
    const item = await insertFixture();
    const [user] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
    if (!user) throw new Error("Access registry integration test needs one auth user");
    const [adminAccess] = await sql<Array<{ id: string }>>`
      INSERT INTO auth.access (user_id, permission) VALUES (${user.id}::uuid, 'admin') RETURNING id::text
    `;
    if (!adminAccess) throw new Error("Failed to create admin access fixture");
    let release = () => {};
    let locked = () => {};
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    const waitForLock = new Promise<void>((resolve) => (locked = resolve));
    try {
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${item.baseId}::uuid, ${adminAccess.id}::uuid)`;
      const revocation = sql.begin(async (tx) => {
        await lockBaseAuthorization([item.baseId], tx);
        await tx`DELETE FROM auth.access WHERE id = ${adminAccess.id}::uuid`;
        locked();
        await waitForRelease;
      });
      await waitForLock;
      const pending = grantAccess({
        resourceType: "customApp",
        resourceId: item.customAppId,
        principal: { type: "public" },
        permission: "read",
        actorId: user.id,
        authorization: { subject: { type: "user", userId: user.id }, permissionCap: "admin" },
      });
      await Bun.sleep(20);
      release();
      await revocation;
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(await listCustomAppAccess(item.customAppId)).toHaveLength(0);
    } finally {
      release();
      await cleanup(item.baseId, [adminAccess.id]);
    }
  });

  postgresTest("grants, lists, resolves, and projects only base and Grids App access", async () => {
    const item = await insertFixture();
    const accessIds: string[] = [];
    try {
      for (const resource of [
        { type: "base" as const, id: item.baseId, permission: "admin" as const },
        { type: "customApp" as const, id: item.customAppId, permission: "read" as const },
      ]) {
        const result = await grantAccess({
          resourceType: resource.type,
          resourceId: resource.id,
          principal: resource.type === "base" ? { type: "authenticated" } : { type: "public" },
          permission: resource.permission,
        });
        if (!result.ok) throw new Error(result.error.message);
        accessIds.push(result.data.accessId);
      }

      expect((await listBaseAccess(item.baseId)).length).toBe(1);
      expect((await listCustomAppAccess(item.customAppId)).length).toBe(1);
      const bindings = await Promise.all(accessIds.map((accessId) => resolveAccessBinding(accessId)));
      expect(bindings).toEqual([
        { resourceType: "base", baseId: item.baseId },
        { resourceType: "customApp", baseId: item.baseId, customAppId: item.customAppId },
      ]);
      expect(await resolveResourceBinding("base", item.baseId)).toEqual(bindings[0]!);
      expect(await resolveResourceBinding("customApp", item.customAppId)).toEqual(bindings[1]!);
      expect((await listAccessForBaseTree(item.baseId)).map((entry) => entry.resourceType)).toEqual(["base", "customApp"]);
    } finally {
      await cleanup(item.baseId, accessIds);
    }
  });
});
