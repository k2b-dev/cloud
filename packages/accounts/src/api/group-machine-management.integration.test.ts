import { expect, test } from "bun:test";
import { accountsAppService, serviceAccountCredentials } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import groups from "./groups";

const suite = suiteFor("database", "nats", "valkey");
suite("direct machine group management", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: membership is not management; exact grant, revoke, scope and account state apply through real tokens`, async () => {
      const suffix = crypto.randomUUID();
      const [admin] = await sql<{ id: string; uid: string }[]>`INSERT INTO auth.users(uid,provider,profile,admin)
        VALUES (${`management-admin-${suffix}`},'local','user',true) RETURNING id,uid`;
      const [member] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid,provider,profile)
        VALUES (${`management-member-${suffix}`},'local','user') RETURNING id`;
      const createdGroups = await sql<{ id: string; provider: string }[]>`INSERT INTO auth.groups(cn,name,provider) VALUES
        (${`local:managed-${suffix}`},${`managed-${suffix}`},'local'),
        (${`local:other-${suffix}`},${`other-${suffix}`},'local'),
        (${`directory-${suffix}`},${`directory-${suffix}`},'ipa') RETURNING id,provider`;
      const [managed, other, directory] = createdGroups;
      const [machine] = await sql<{ id: string; name: string }[]>`INSERT INTO auth.service_accounts(name,kind)
        VALUES (${`Group helper ${suffix}`},${kind}) RETURNING id,name`;
      const actor = { userId: admin!.id, uid: admin!.uid, roles: ["user", "admin"] };
      try {
        const key = await serviceAccountCredentials.createApiToken({
          serviceAccountId: machine!.id,
          name: "Management",
          scopes: ["write"],
        });
        const readKey = await serviceAccountCredentials.createApiToken({
          serviceAccountId: machine!.id,
          name: "Read only",
          scopes: ["read"],
        });
        if (!key.ok || !readKey.ok) throw new Error("Fixture keys failed");
        const authorization = `Bearer ${key.data.token}`;
        const cookie = `session_token=${await createTestSession(admin!.id)}`;
        const call = (method = "POST", id = managed!.id, credential = authorization) =>
          groups.request(`/${id}/members`, {
            method,
            headers: { authorization: credential, "content-type": "application/json" },
            body: JSON.stringify({ type: "user", id: member!.id }),
          });
        const grant = (method: "POST" | "DELETE", id = managed!.id) =>
          groups.request(`/${id}/managers`, {
            method,
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({ type: "service_account", id: machine!.id }),
          });
        expect((await call()).status).toBe(403);
        expect((await accountsAppService.group.member.add({ actor, id: managed!.id, serviceAccountId: machine!.id })).ok).toBe(true);
        expect((await call()).status).toBe(403);
        expect((await grant("POST")).status).toBe(200);
        const managers = await accountsAppService.entity.list({
          actor,
          managerOfGroupId: managed!.id,
          kinds: ["service_account"],
          recursive: true,
        });
        expect(managers.items).toMatchObject([
          { kind: "service_account", serviceAccount: { id: machine!.id, name: machine!.name, kind }, relation: { direct: true } },
        ]);
        expect((await accountsAppService.group.manager.list({ id: managed!.id })).items).toMatchObject([
          { type: "service_account", id: machine!.id },
        ]);
        expect((await call()).status).toBe(200);
        expect(
          await sql`SELECT 1 FROM auth.user_groups_v2 WHERE user_id=${member!.id}::uuid AND group_id=${managed!.id}::uuid`,
        ).toHaveLength(1);
        expect((await call("POST", other!.id)).status).toBe(403);
        expect((await call("DELETE", managed!.id, `Bearer ${readKey.data.token}`)).status).toBe(403);
        expect(
          (
            await groups.request(`/${managed!.id}/managers`, {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify({ type: "service_account", id: machine!.id }),
            })
          ).status,
        ).toBe(403);
        expect((await groups.request("/", { headers: { authorization } })).status).toBe(403);
        expect((await grant("POST", directory!.id)).status).toBe(400);
        // A malformed imported directory grant still cannot make the machine use IPA credentials.
        await sql`INSERT INTO auth.group_manager_service_accounts(group_id,service_account_id) VALUES(${directory!.id}::uuid,${machine!.id}::uuid)`;
        expect((await call("POST", directory!.id)).status).toBe(403);
        expect((await grant("DELETE")).status).toBe(200);
        expect((await call("DELETE")).status).toBe(403);
        expect((await grant("POST")).status).toBe(200);
        await sql`UPDATE auth.service_accounts SET status='disabled' WHERE id=${machine!.id}::uuid`;
        expect((await call("DELETE")).status).toBe(401);
        await sql`UPDATE auth.service_accounts SET status='active' WHERE id=${machine!.id}::uuid`;
        expect((await call("DELETE")).status).toBe(200);

        // Deletion owns the group before cascading into manager grants. A waiting
        // membership write must not hold the grant and reverse that lock order.
        expect((await grant("POST", other!.id)).status).toBe(200);
        let pending: Promise<Response> | undefined;
        try {
          await sql.begin(async (db) => {
            await db`SELECT id FROM auth.groups WHERE id=${other!.id}::uuid FOR UPDATE`;
            const [deleting] = await db<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pending = Promise.resolve(call("POST", other!.id));
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const [waiter] = await sql`SELECT pid FROM pg_stat_activity WHERE ${deleting!.pid}=ANY(pg_blocking_pids(pid))`;
              if (waiter) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
            await db`DELETE FROM auth.groups WHERE id=${other!.id}::uuid`;
          });
          expect((await pending!).status).toBe(403);
        } finally {
          await pending;
        }
        await sql`UPDATE auth.service_account_credentials SET status='revoked',revoked_at=now() WHERE id=${key.data.credential.id}::uuid`;
        expect((await call()).status).toBe(401);
        const audits = await sql<{ outcome: string; credential: string }[]>`SELECT outcome,metadata->>'credentialId' AS credential
          FROM audit.events WHERE metadata->>'actorServiceAccountId'=${machine!.id}`;
        expect(audits.some((row) => row.outcome === "allowed" && row.credential === key.data.credential.id)).toBe(true);
        expect(audits.some((row) => row.outcome === "denied")).toBe(true);
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id=${machine!.id}::uuid`;
        for (const group of createdGroups) await sql`DELETE FROM auth.groups WHERE id=${group.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${admin!.id}::uuid,${member!.id}::uuid)`;
      }
    });
  }
});
