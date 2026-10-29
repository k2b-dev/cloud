import { expect, test } from "bun:test";
import {
  type AuthContext,
  auth,
  buildAccessPrincipalCondition,
  createAccess,
  getEffectivePermission,
  getEffectivePermissions,
  hasPermission,
} from "@k2b/cloud/server";
import { accountsAppService, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import groups from "./groups";

const suite = suiteFor("database", "nats", "valkey");

suite("local group machine recipients with real credentials", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: a human manager adds and revokes a named recipient; resource grants follow membership`, async () => {
      const suffix = crypto.randomUUID();
      const [manager] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users (uid, provider, profile)
        VALUES (${`group-manager-${suffix}`}, 'local', 'user') RETURNING id, uid`;
      const [parent] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
        VALUES (${`local:parent-${suffix}`}, 'local', ${`parent-${suffix}`}) RETURNING id`;
      const [child] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
        VALUES (${`local:child-${suffix}`}, 'local', ${`child-${suffix}`}) RETURNING id`;
      const [account] = await sql<{ id: string; name: string }[]>`INSERT INTO auth.service_accounts (name, kind)
        VALUES (${`Named ${kind} ${suffix}`}, ${kind}) RETURNING id, name`;
      const grant = await createAccess({ principal: { type: "group", groupId: parent!.id }, permission: "write" });
      if (!grant.ok) throw new Error(grant.error.message);
      try {
        await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parent!.id}::uuid, ${child!.id}::uuid)`;
        await sql`INSERT INTO auth.group_manager_users_v2 (group_id, user_id) VALUES (${child!.id}::uuid, ${manager!.id}::uuid)`;
        const cookie = `session_token=${await createTestSession(manager!.id)}`;
        const membership = (method: "POST" | "DELETE") =>
          groups.request(`/${child!.id}/members`, {
            method,
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ type: "service_account", id: account!.id }),
          });
        const subject = { type: "service_account" as const, serviceAccountId: account!.id };
        const accessIds = [grant.data.id];
        const permission = () => getEffectivePermission({ accessIds, subject });
        const listed = async () => {
          const rows = await sql<{ id: string }[]>`SELECT id FROM auth.access a
            WHERE a.id = ${grant.data.id}::uuid AND ${buildAccessPrincipalCondition({
              subject,
              columns: {
                userId: sql`a.user_id`,
                groupId: sql`a.group_id`,
                serviceAccountId: sql`a.service_account_id`,
                authenticatedOnly: sql`a.authenticated_only`,
              },
            })}`;
          return rows.map((row) => row.id);
        };
        // A small test resource at the shared authorization seam. No production Accounts management route is opened to machines.
        const resource = new Hono<AuthContext>().use(auth.requireRole("authenticated")).on(["GET", "PUT"], "/resource", async (c) => {
          const actor = c.get("actor");
          if (actor.kind !== "service_account" || actor.serviceAccount.kind === "resource_bound") return c.json({ error: "binding" }, 403);
          const required = c.req.method === "PUT" ? "write" : "read";
          const effective = await getEffectivePermission({ accessIds, subject: c.get("accessSubject") });
          if (!hasPermission(effective, required) || !actor.scopes.includes(required)) return c.json({ error: "denied" }, 403);
          if (required === "write") await sql`UPDATE auth.groups SET description = 'Changed by machine' WHERE id = ${parent!.id}::uuid`;
          const [row] = await sql<{ description: string | null }[]>`SELECT description FROM auth.groups WHERE id = ${parent!.id}::uuid`;
          return c.json(row);
        });
        const token = async (scopes: string[]) => {
          const result = await serviceAccountCredentials.createApiToken({ serviceAccountId: account!.id, name: "Group test", scopes });
          if (!result.ok) throw new Error(result.error.message);
          return `Bearer ${result.data.token}`;
        };
        const authorization = await token(["read", "write", "admin"]);
        const call = (method = "GET", credential = authorization) =>
          resource.request("/resource", { method, headers: { authorization: credential } });
        expect(await permission()).toBe("none");
        expect((await call()).status).toBe(403);
        expect((await membership("POST")).status).toBe(200);
        expect((await membership("POST")).status).toBe(409);
        expect(await permission()).toBe("write");
        expect(await getEffectivePermissions({ accessIds, subjects: [subject] })).toEqual(["write"]);
        expect(await listed()).toEqual(accessIds);
        expect((await call()).status).toBe(200);
        expect((await call("PUT")).status).toBe(200);
        expect(await (await call()).json()).toEqual({ description: "Changed by machine" });
        const readOnly = await token(["read"]);
        expect((await call("GET", readOnly)).status).toBe(200);
        expect((await call("PUT", readOnly)).status).toBe(403);
        const actor = { userId: manager!.id, uid: manager!.uid, roles: ["user", "group-manager"] };
        const direct = await accountsAppService.entity.list({
          actor,
          memberOfGroupId: child!.id,
          kinds: ["service_account"],
          serviceAccountIds: [account!.id],
        });
        expect(direct.items).toMatchObject([
          { kind: "service_account", serviceAccount: { id: account!.id, name: account!.name, kind }, relation: { direct: true } },
        ]);
        const inherited = await accountsAppService.entity.list({
          actor,
          memberOfGroupId: parent!.id,
          kinds: ["service_account"],
          recursive: true,
        });
        expect(inherited.items).toMatchObject([
          { kind: "service_account", serviceAccount: { id: account!.id, name: account!.name, kind }, relation: { direct: false } },
        ]);
        expect((await accountsAppService.group.member.list({ id: child!.id })).items).toMatchObject([
          { type: "service_account", id: account!.id, displayName: account!.name, serviceAccountKind: kind },
        ]);
        // A resource scope never becomes installation/group management authority or directory visibility.
        expect(
          (
            await groups.request(`/${child!.id}/members`, {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify({ type: "service_account", id: account!.id }),
            })
          ).status,
        ).toBe(403);
        expect((await groups.request("/", { headers: { authorization } })).status).toBe(403);
        await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${account!.id}::uuid`;
        expect(await permission()).toBe("none");
        expect(await getEffectivePermissions({ accessIds, subjects: [subject] })).toEqual(["none"]);
        expect(await listed()).toEqual([]);
        // Coverage uses recursive relations and must exclude inactive direct members too.
        for (const groupId of [child!.id, parent!.id]) {
          expect(
            (await accountsAppService.entity.list({ actor, memberOfGroupId: groupId, kinds: ["service_account"], recursive: true })).items,
          ).toEqual([]);
          expect(
            (await accountsAppService.group.member.list({ id: groupId, filter: { type: "service_account" }, recursive: true })).items,
          ).toEqual([]);
        }
        // Direct membership remains visible to a manager so a disabled member can still be removed.
        expect((await accountsAppService.group.member.list({ id: child!.id, filter: { type: "service_account" } })).items).toMatchObject([
          { type: "service_account", id: account!.id },
        ]);
        await sql`UPDATE auth.service_accounts SET status = 'active' WHERE id = ${account!.id}::uuid`;
        expect((await membership("DELETE")).status).toBe(200);
        expect(await permission()).toBe("none");
        expect(await getEffectivePermissions({ accessIds, subjects: [subject] })).toEqual(["none"]);
        expect(await listed()).toEqual([]);
        expect((await call()).status).toBe(403);
        expect((await call("PUT")).status).toBe(403);
        expect(
          (await accountsAppService.entity.list({ actor, memberOfGroupId: parent!.id, kinds: ["service_account"], recursive: true })).items,
        ).toEqual([]);
      } finally {
        await sql`DELETE FROM auth.access WHERE id = ${grant.data.id}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id IN (${parent!.id}::uuid, ${child!.id}::uuid)`;
        await sql`DELETE FROM auth.users WHERE id = ${manager!.id}::uuid`;
      }
    });
  }
});

suite("local group recipient policy", () => {
  test("rejects disabled, delegated and resource-bound recipients and keeps directory membership separate", async () => {
    const suffix = crypto.randomUUID();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile)
      VALUES (${`group-policy-${suffix}`}, 'local', 'user') RETURNING id`;
    const [local] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`local:policy-${suffix}`}, 'local', ${`policy-${suffix}`}) RETURNING id`;
    const [directory] = await sql<{ id: string }[]>`INSERT INTO auth.groups (cn, provider, name)
      VALUES (${`ipa-policy-${suffix}`}, 'ipa', ${`ipa-policy-${suffix}`}) RETURNING id`;
    const accounts = await sql<{ id: string; kind: string; status: string }[]>`INSERT INTO auth.service_accounts
      (name, kind, status, delegated_user_id, app_id, resource_type, resource_id) VALUES
      (${`Bound ${suffix}`}, 'resource_bound', 'active', NULL, 'test', 'resource', 'one'),
      (${`Delegated ${suffix}`}, 'user_delegated', 'active', ${user!.id}::uuid, NULL, NULL, NULL),
      (${`Disabled ${suffix}`}, 'standalone', 'disabled', NULL, NULL, NULL, NULL),
      (${`Active ${suffix}`}, 'agent', 'active', NULL, NULL, NULL, NULL)
      RETURNING id, kind, status`;
    const actor = { userId: user!.id, uid: `group-policy-${suffix}`, roles: ["user", "admin"] };
    const grant = await createAccess({ principal: { type: "group", groupId: local!.id }, permission: "admin" });
    if (!grant.ok) throw new Error(grant.error.message);
    try {
      for (const account of accounts) {
        const added = await accountsAppService.group.member.add({ actor, id: local!.id, serviceAccountId: account.id });
        expect(added.ok).toBe(account.kind === "agent");
        // Even malformed imported membership cannot turn a bound/delegated/disabled identity into an independent group recipient.
        await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id)
          VALUES (${account.id}::uuid, ${local!.id}::uuid) ON CONFLICT DO NOTHING`;
        expect(
          await getEffectivePermission({ accessIds: [grant.data.id], subject: { type: "service_account", serviceAccountId: account.id } }),
        ).toBe(account.kind === "agent" ? "admin" : "none");
      }
      const active = accounts.find((account) => account.kind === "agent")!;
      const denied = await accountsAppService.group.member.add({
        actor,
        id: directory!.id,
        provider: "local",
        serviceAccountId: active.id,
      });
      expect(denied).toMatchObject({ ok: false, error: { status: 400 } });
      expect(await sql`SELECT 1 FROM auth.service_account_groups WHERE group_id = ${directory!.id}::uuid`).toHaveLength(0);
      expect(
        (await accountsAppService.entity.list({ actor, memberOfGroupId: directory!.id, recursive: true, kinds: ["service_account"] }))
          .items,
      ).toEqual([]);
      expect(
        (await accountsAppService.entity.list({ actor, managerOfGroupId: local!.id, recursive: true, kinds: ["service_account"] })).items,
      ).toEqual([]);
    } finally {
      await sql`DELETE FROM auth.access WHERE id = ${grant.data.id}::uuid`;
      for (const account of accounts) await sql`DELETE FROM auth.service_accounts WHERE id = ${account.id}::uuid`;
      await sql`DELETE FROM auth.groups WHERE id IN (${local!.id}::uuid, ${directory!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${user!.id}::uuid`;
    }
  });
});
