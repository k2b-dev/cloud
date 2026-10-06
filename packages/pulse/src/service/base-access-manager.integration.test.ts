import { afterEach, expect, test } from "bun:test";
import type { PermissionLevel, Principal } from "@k2b/cloud/server";
import { sql } from "bun";
import { inLockOrder } from "../../../../scripts/fixtures/lock-order";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { grantBaseAccess, revokeBaseAccess, updateBaseAccess } from "./base-management";

const suite = databaseSuite();
const created = { bases: [] as string[], users: [] as string[], groups: [] as string[] };

afterEach(async () => {
  for (const baseId of created.bases.splice(0)) {
    await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM pulse.base_access WHERE base_id = ${baseId}::uuid)`;
    await sql`DELETE FROM pulse.bases WHERE id = ${baseId}::uuid`;
  }
  for (const id of created.groups.splice(0)) await sql`DELETE FROM auth.groups WHERE id = ${id}::uuid`;
  for (const id of created.users.splice(0)) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
});

const insertBase = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO pulse.bases (id, short_id, name) VALUES (${id}::uuid, ${newShortId()}, 'Pulse last manager')`;
  created.bases.push(id);
  return id;
};

const insertUser = async (): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail)
    VALUES (${`pulse-manager-${suffix}`}, 'local', 'user', 'Pulse manager', ${`pulse-manager-${suffix}@example.test`})
    RETURNING id
  `;
  created.users.push(row!.id);
  return row!.id;
};

/** Grants directly, as base creation does for its first manager. */
const bind = async (baseId: string, principal: Principal, permission: PermissionLevel): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, group_id, permission)
    VALUES (
      ${principal.type === "user" ? principal.userId : null}::uuid,
      ${principal.type === "group" ? principal.groupId : null}::uuid,
      ${permission}::auth.permission_level
    )
    RETURNING id
  `;
  await sql`INSERT INTO pulse.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${row!.id}::uuid)`;
  return row!.id;
};

/** Holds the base row and the grants the changes write. */
const holdBase = (baseId: string) => async (holder: typeof sql) => {
  await holder`SELECT id FROM pulse.bases WHERE id = ${baseId}::uuid FOR UPDATE`;
  await holder`SELECT access_id FROM pulse.base_access ba JOIN auth.access a ON a.id = ba.access_id WHERE ba.base_id = ${baseId}::uuid FOR UPDATE OF a`;
};

const expectLastManager = (result: { ok: boolean; error?: { code: string; status: number } }) => {
  expect(result.ok).toBe(false);
  expect(result.error).toMatchObject({ code: "LAST_MANAGER", status: 409 });
};

suite("Pulse base keeps a manager", () => {
  test("the only manager can neither lower nor remove their own access", async () => {
    const baseId = await insertBase();
    const userId = await insertUser();
    const own = await bind(baseId, { type: "user", userId }, "admin");

    expectLastManager(await updateBaseAccess({ baseId, accessId: own, user: { id: userId }, permission: "write", locale: "de" }));
    expectLastManager(await revokeBaseAccess({ baseId, accessId: own, user: { id: userId } }));
  });

  test("a second manager unlocks the change, and a group alone still counts", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser();
    const lym = await insertUser();
    const own = await bind(baseId, { type: "user", userId: qdt }, "admin");
    const granted = await grantBaseAccess({ baseId, user: { id: qdt }, principal: { type: "user", userId: lym }, permission: "admin" });
    expect(granted.ok).toBe(true);
    expect((await revokeBaseAccess({ baseId, accessId: own, user: { id: qdt } })).ok).toBe(true);

    const groupBase = await insertBase();
    const [group] = await sql<{ id: string }[]>`
      INSERT INTO auth.groups (cn, provider, name) VALUES (${`pulse-manager-${crypto.randomUUID()}`}, 'local', 'Ops') RETURNING id
    `;
    created.groups.push(group!.id);
    await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${qdt}::uuid, ${group!.id}::uuid)`;
    const groupAccess = await bind(groupBase, { type: "group", groupId: group!.id }, "admin");
    expectLastManager(await revokeBaseAccess({ baseId: groupBase, accessId: groupAccess, user: { id: qdt } }));
  });

  test("of two managers lowering themselves at once, exactly one succeeds", async () => {
    const baseId = await insertBase();
    const qdt = await insertUser();
    const lym = await insertUser();
    const qdtAccess = await bind(baseId, { type: "user", userId: qdt }, "admin");
    const lymAccess = await bind(baseId, { type: "user", userId: lym }, "admin");

    const results = await inLockOrder(holdBase(baseId), [
      () => updateBaseAccess({ baseId, accessId: qdtAccess, user: { id: qdt }, permission: "read" }),
      () => revokeBaseAccess({ baseId, accessId: lymAccess, user: { id: lym } }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expectLastManager(results.find((result) => !result.ok)!);
    const [row] = await sql<{ admins: number }[]>`
      SELECT COUNT(*)::int AS admins FROM pulse.base_access ba JOIN auth.access a ON a.id = ba.access_id
      WHERE ba.base_id = ${baseId}::uuid AND a.permission = 'admin'
    `;
    expect(row!.admins).toBe(1);
  });

  test("a manager lowered while their own change waits for the base no longer passes", async () => {
    const baseId = await insertBase();
    const [qdt, lym, kim] = [await insertUser(), await insertUser(), await insertUser()];
    await bind(baseId, { type: "user", userId: qdt }, "admin");
    const lymAccess = await bind(baseId, { type: "user", userId: lym }, "admin");
    const kimAccess = await bind(baseId, { type: "user", userId: kim }, "admin");

    const [lowered, stale] = await inLockOrder(holdBase(baseId), [
      () => updateBaseAccess({ baseId, accessId: lymAccess, user: { id: qdt }, permission: "read" }),
      () => updateBaseAccess({ baseId, accessId: kimAccess, user: { id: lym }, permission: "read" }),
    ]);
    expect(lowered!.ok).toBe(true);
    expect(stale).toMatchObject({ ok: false, error: { status: 403 } });
    const [row] = await sql<{ permission: PermissionLevel }[]>`SELECT permission FROM auth.access WHERE id = ${kimAccess}::uuid`;
    expect(row!.permission).toBe("admin");
  });
});
