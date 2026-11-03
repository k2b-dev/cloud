import { expect, test } from "bun:test";
import { Hono } from "hono";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { appAccess } from "../../contracts/app-access";
import { sql } from "../../runtime/clients";
import { canUseApp } from "../../services/app-access";
import { invocationAuthorityFromRequest } from "../../services/identity/invocation-authority";
import { resolveIssuanceAuthority } from "../../services/identity/issue-invocation";
import { toPgUuidArray } from "../../services/postgres";
import { serviceAccountCredentials } from "../../services/service-account-credentials";
import { createTestSession } from "../../services/session/session.test-fixture";
import { type AuthContext, auth, type RequestAuthority } from "../middleware/auth";
import { getEffectivePermission, getEffectivePermissions, getMemberPermission } from "./access";

suiteFor(
  "database",
  "nats",
  "valkey",
)("a tier meant for people admits machines", () => {
  test("only people and guests receive authenticated resource and app grants, including personal keys and invocations", async () => {
    const appId = `people-${crypto.randomUUID()}`;
    const users: string[] = [];
    const accounts: string[] = [];
    const grants: string[] = [];
    const authorities: RequestAuthority[] = [];
    const router = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/", (c) => {
      authorities.push(auth.getAuthority(c));
      return c.text("resolved");
    });
    try {
      for (const profile of ["user", "guest"] as const) {
        const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile)
          VALUES (${`${appId}-${profile}`}, 'local', ${profile}) RETURNING id`;
        if (!user) throw new Error("Missing person fixture");
        users.push(user.id);
        const token = await createTestSession(user.id);
        expect((await router.request("/", { headers: { cookie: `session_token=${token}` } })).status).toBe(200);
      }
      for (const kind of ["agent", "standalone", "resource_bound", "user_delegated"] as const) {
        const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts
          (name, kind, app_id, resource_type, resource_id, delegated_user_id)
          VALUES (${`${appId}-${kind}`}, ${kind}, ${kind === "resource_bound" ? appId : null},
            ${kind === "resource_bound" ? "fixture" : null}, ${kind === "resource_bound" ? "one" : null},
            ${kind === "user_delegated" ? users[0]! : null}::uuid) RETURNING id`;
        if (!account) throw new Error("Missing machine fixture");
        accounts.push(account.id);
        const key = await serviceAccountCredentials.createApiToken({ serviceAccountId: account.id, name: "Fixture", scopes: ["read"] });
        if (!key.ok) throw new Error(key.error.message);
        expect((await router.request("/", { headers: { authorization: `Bearer ${key.data.token}` } })).status).toBe(200);
      }
      const interactive = [...authorities];
      for (const authority of interactive) {
        const invocation = await resolveIssuanceAuthority(invocationAuthorityFromRequest(authority), "core");
        if (!invocation) throw new Error("Invocation lost its resolved authority");
        authorities.push(invocation);
        expect(invocation.accessSubject).toEqual(authority.accessSubject);
      }
      const [audience] = await sql<{ id: string }[]>`INSERT INTO auth.access(authenticated_only, permission)
        VALUES (true, 'read') RETURNING id`;
      if (!audience) throw new Error("Missing audience fixture");
      grants.push(audience.id);
      await sql`INSERT INTO auth.app_access_state(app_id, configured_at) VALUES (${appId}, now())`;
      await sql`INSERT INTO auth.app_access(app_id, access_id) VALUES (${appId}, ${audience.id}::uuid)`;
      const subjects = authorities.map((authority) => authority.accessSubject);
      const expected = subjects.map((subject) => (subject.type === "user" ? "read" : "none"));
      expect(expected).toEqual(["read", "read", "none", "none", "none", "read", "read", "read", "none", "none", "none", "read"]);
      expect(await getEffectivePermissions({ accessIds: grants, subjects })).toEqual(expected);
      for (const [index, authority] of authorities.entries()) {
        expect(await getEffectivePermission({ accessIds: grants, subject: authority.accessSubject })).toBe(expected[index]!);
        expect(await getMemberPermission({ accessIds: grants, subject: authority.accessSubject })).toBe(expected[index]!);
        expect(await canUseApp(authority, { id: appId, access: appAccess.grants() })).toBe(authority.accessSubject.type === "user");
      }
      expect(await getEffectivePermission({ accessIds: grants, subject: null })).toBe("none");
      await sql`UPDATE auth.access SET authenticated_only = false WHERE id = ${audience.id}::uuid`;
      expect(await getEffectivePermissions({ accessIds: grants, subjects })).toEqual(subjects.map(() => "read"));
      for (const authority of authorities) expect(await canUseApp(authority, { id: appId, access: appAccess.grants() })).toBe(false);
    } finally {
      await sql`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(grants)}::uuid[])`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray(accounts)}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(users)}::uuid[])`;
    }
  }, 30_000);
});
