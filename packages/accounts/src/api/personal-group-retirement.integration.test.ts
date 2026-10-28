import { afterAll, expect, test } from "bun:test";
import { createAccess, getEffectivePermission } from "@k2b/cloud/server/services/access";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import groups from "./groups";
import users from "./users";

suiteFor(
  "database",
  "nats",
  "valkey",
)("account deletion retires personal groups through the HTTP API", () => {
  const ids: string[] = [];
  let groupId: string | undefined;
  afterAll(async () => {
    for (const id of ids) await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    if (groupId) {
      await sql`DELETE FROM auth.groups WHERE id=${groupId}::uuid`;
      await sql`DELETE FROM auth.personal_groups WHERE group_id=${groupId}::uuid`;
    }
    for (const id of ids) await sql`DELETE FROM auth.deleted_accounts WHERE deleted_user_id=${id}::uuid`;
  });
  test("removes old group grants and rejects further membership requests", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const person = async (name: string, admin = false) => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
        VALUES(${`retire_${name}_${suffix}`},'local','user',${admin}) RETURNING id`;
      ids.push(row!.id);
      return row!.id;
    };
    const admin = await person("admin", true);
    const owner = await person("owner");
    const member = await person("member");
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,provider,name,gid_number)
      VALUES(${`local:retire_${suffix}`},'local',${`retire_${suffix}`},1900030) RETURNING id`;
    groupId = row!.id;
    await sql`INSERT INTO auth.user_groups_v2 VALUES(${owner}::uuid,${groupId}::uuid),(${member}::uuid,${groupId}::uuid)`;
    await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
      VALUES(${owner}::uuid,'local',1900030,1900030,${groupId}::uuid,'/home/example','/bin/bash')`;
    const grant = await createAccess({ principal: { type: "group", groupId }, permission: "write" });
    if (!grant.ok) throw new Error(grant.error.message);
    expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: member } })).toBe("write");
    const headers = { cookie: `session_token=${await createTestSession(admin)}`, "x-forwarded-for": uniqueCallerAddress() };
    const response = await users.request(`/${owner}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: member } })).toBe("none");
    const lookup = await groups.request(`/${groupId}/members`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "user", id: member }),
    });
    expect(lookup.status).toBe(404);
    expect(await sql`SELECT * FROM auth.personal_groups WHERE group_id=${groupId}::uuid AND retired_at IS NOT NULL`).toHaveLength(1);
  });
  test("an admin deletes a reviewed historical orphan normally, removing members and grants while reserving its GID", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const [admin] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,admin) VALUES(${`review_admin_${suffix}`},'local','user',true) RETURNING id`;
    const [member] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile) VALUES(${`review_member_${suffix}`},'local','user') RETURNING id`;
    ids.push(admin!.id, member!.id);
    const [orphan] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,provider,name,gid_number)
      VALUES(${`local:review_${suffix}`},'local',${`review_${suffix}`},1900031) RETURNING id`;
    const id = orphan!.id;
    try {
      await sql`INSERT INTO auth.posix_allocations(kind,number,owner_id) VALUES('gid',1900031,${id}::uuid)`;
      await sql`INSERT INTO auth.personal_group_review(group_id,reason,details,completed_at)
        VALUES(${id}::uuid,'remaining_references','{}'::jsonb,now())`;
      await sql`INSERT INTO auth.user_groups_v2 VALUES(${member!.id}::uuid,${id}::uuid)`;
      const grant = await createAccess({ principal: { type: "group", groupId: id }, permission: "write" });
      if (!grant.ok) throw new Error(grant.error.message);
      expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: member!.id } })).toBe("write");
      const headers = { cookie: `session_token=${await createTestSession(admin!.id)}`, "x-forwarded-for": uniqueCallerAddress() };
      const response = await groups.request(`/${id}`, { method: "DELETE", headers });
      expect(response.status).toBe(200);
      expect(await sql`SELECT * FROM auth.groups WHERE id=${id}::uuid`).toHaveLength(0);
      expect(await sql`SELECT * FROM auth.user_groups_v2 WHERE group_id=${id}::uuid`).toHaveLength(0);
      expect(await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "user", userId: member!.id } })).toBe("none");
      expect(await sql`SELECT * FROM auth.posix_allocations WHERE kind='gid' AND owner_id=${id}::uuid AND number=1900031`).toHaveLength(1);
    } finally {
      await sql`DELETE FROM auth.groups WHERE id=${id}::uuid`;
      await sql`DELETE FROM auth.personal_group_review WHERE group_id=${id}::uuid`;
      await sql`DELETE FROM auth.posix_allocations WHERE kind='gid' AND owner_id=${id}::uuid`;
    }
  });
});
