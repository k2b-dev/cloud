import { expect, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { appAccess } from "../contracts/app-access";
import type { User } from "../contracts/shared";
import type { RequestAuthority } from "../server/middleware/auth";
import { canUseApp, usableAppIds } from "./app-access";

const suite = databaseSuite();
suite("app access grants", () => {
  test("nested group grants and revocation are read on each decision, and admin is not a bypass", async () => {
    const appId = `app-access-${crypto.randomUUID()}`;
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile, display_name) VALUES (${appId}, 'local', 'user', 'Fictional Access User') RETURNING id`;
    const [parent] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${appId}, 'local', 'Access parent') RETURNING id`;
    const [child] = await sql<
      { id: string }[]
    >`INSERT INTO auth.groups (cn, provider, name) VALUES (${`${appId}-child`}, 'local', 'Access child') RETURNING id`;
    const fixtureUser: User = {
      id: user!.id,
      uid: appId,
      roles: ["admin", "user"],
      provider: "local",
      profile: "user",
      givenname: "Fictional",
      sn: "User",
      displayName: "Fictional User",
      mail: null,
      avatarHash: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    };
    const authority: RequestAuthority = {
      actor: { kind: "user", user: fixtureUser },
      accessSubject: { type: "user", userId: user!.id },
      credentialKind: "session",
      scopes: [],
    };
    let grantId: string | undefined;
    try {
      await sql`INSERT INTO auth.app_access_state (app_id, configured_at) VALUES (${appId}, '2026-10-22T12:00:00Z')`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${user!.id}::uuid, ${child!.id}::uuid)`;
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent!.id}::uuid, ${child!.id}::uuid)`;
      const app = { id: appId, access: appAccess.grants({ until: appAccess.signedIn() }) };
      expect(await canUseApp(authority, app)).toBe(false);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (group_id, permission) VALUES (${parent!.id}::uuid, 'read') RETURNING id`;
      grantId = grant!.id;
      await sql`INSERT INTO auth.app_access (app_id, access_id) VALUES (${appId}, ${grantId}::uuid)`;
      expect(await usableAppIds(authority, [app, { id: "fixed", access: appAccess.signedIn() }])).toEqual(new Set(["fixed", appId]));
      await sql`DELETE FROM auth.user_groups_v2 WHERE user_id = ${user!.id}::uuid`;
      expect(await canUseApp(authority, app)).toBe(false);
      await sql`UPDATE auth.access SET authenticated_only = true, group_id = NULL WHERE id = ${grantId}::uuid`;
      expect(await canUseApp(authority, app)).toBe(true);
      await sql`DELETE FROM auth.access WHERE id = ${grantId}::uuid`;
      expect(await canUseApp(authority, app)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
      if (grantId) await sql`DELETE FROM auth.access WHERE id = ${grantId}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${parent!.id}::uuid, ${child!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
