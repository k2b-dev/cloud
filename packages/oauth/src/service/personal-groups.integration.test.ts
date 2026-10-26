import { expect, test } from "bun:test";
import { accounts } from "@k2b/cloud/services";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { createUserInfo } from "./tokens";

// Exercise the emitted claim with real membership queries, including an ordinary
// ancestor reached through the private primary group.
databaseSuite()("personal Linux groups in OAuth/OIDC claims", () => {
  test("UserInfo excludes personal groups while retaining inherited team groups", async () => {
    const [owner] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
      VALUES('claim_personal_fixture','local','user') RETURNING id`;
    const [personal] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,name,provider,gid_number)
      VALUES('local:claim_personal_fixture','claim_personal_fixture','local',1500001) RETURNING id`;
    const [team] = await sql<{ id: string }[]>`INSERT INTO auth.groups(cn,name,provider)
      VALUES('local:claim_personal_team','claim_personal_team','local') RETURNING id`;
    try {
      await sql`INSERT INTO auth.user_groups_v2 VALUES(${owner!.id}::uuid,${personal!.id}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 VALUES(${team!.id}::uuid,${personal!.id}::uuid)`;
      await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
        VALUES(${owner!.id}::uuid,'local',1500001,1500001,${personal!.id}::uuid,'/home/fixture','/bin/bash')`;
      const user = await accounts.users.get({ id: owner!.id });
      if (!user) throw new Error("Missing claim fixture");
      expect(await createUserInfo({ user, subject: owner!.id, scopes: ["openid", "groups"] })).toMatchObject({
        sub: owner!.id,
        groups: ["claim_personal_team"],
      });
      expect(await createUserInfo({ user, subject: owner!.id, scopes: ["openid"] })).not.toHaveProperty("groups");
      // Removing the mutable Linux projection must not restore a personal claim.
      await sql`DELETE FROM auth.user_posix WHERE user_id=${owner!.id}::uuid`;
      expect((await createUserInfo({ user, subject: owner!.id, scopes: ["groups"] })).groups).toEqual(["claim_personal_team"]);
    } finally {
      await sql`DELETE FROM auth.user_posix WHERE user_id=${owner!.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${personal!.id}::uuid,${team!.id}::uuid)`;
      await sql`DELETE FROM auth.personal_groups WHERE group_id=${personal!.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${owner!.id}::uuid`;
    }
  });
});
