import { beforeAll, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudAi } from "../ai/migrate";
import { aiProjects } from "../ai/projects";
import { appAccess } from "../contracts/app-access";
import { sql } from "../runtime/clients";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { canUseApp, usableAppIds } from "../services/app-access";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { serviceAccounts } from "../services/service-accounts";
import { buildProjectedUser } from "../services/session/user";
import { createAdminIdentityRoutes } from "./admin-identity";

const suite = suiteFor("database", "nats", "valkey");
const signedIn = { id: "fixture-signed-in", access: appAccess.signedIn() };
const granted = { id: "fixture-needs-a-grant", access: appAccess.grants() };

const authorityOf = async (token: string): Promise<RequestAuthority> => {
  const key = await serviceAccountCredentials.authenticateApiToken(token);
  if (!key) throw new Error("Fixture key did not authenticate");
  return {
    actor: {
      kind: "service_account",
      serviceAccount: key.serviceAccount,
      delegatedUser: null,
      scopes: key.credential.scopes,
      credentialId: key.credential.id,
      credentialExpiresAt: key.credential.expiresAt,
    },
    accessSubject: { type: "service_account", serviceAccountId: key.serviceAccount.id },
    credentialKind: "api_key",
    scopes: key.credential.scopes,
  };
};

suite("machine API keys from the administrator route", () => {
  beforeAll(() => migrateCloudAi());
  for (const kind of ["standalone", "agent"] as const)
    test(`P15: ${kind}: issued keys never get wider`, async () => {
      const suffix = crypto.randomUUID();
      const [admin] = await sql<{ id: string }[]>`
        INSERT INTO auth.users(uid,provider,profile,admin) VALUES (${`key-admin-${suffix}`},'local','user',true) RETURNING id`;
      const account = await serviceAccounts.createStandalone({ name: `Key worker ${suffix}`, kind, createdBy: admin!.id });
      if (!account.ok) throw new Error("Fixture account failed");
      const actor = buildProjectedUser({
        id: admin!.id,
        uid: `key-admin-${suffix}`,
        provider: "local",
        profile: "user",
        effective_admin: true,
      });
      const owner = { actor: { kind: "user" as const, user: actor }, accessSubject: { type: "user" as const, userId: actor.id } };
      const projectIds: string[] = [];
      const app = { ...granted, id: `${granted.id}-${suffix}` };
      let appGrantId: string | undefined;
      const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
        c.set("user", actor);
        await next();
      };
      const routes = createAdminIdentityRoutes(authenticate);
      const create = async (body: Record<string, unknown>) => {
        const response = await routes.request(`/service-accounts/${account.data.id}/api-keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(201);
        return z
          .object({ token: z.string(), credential: z.object({ id: z.string(), scopes: z.array(z.string()) }) })
          .parse(await response.json());
      };
      try {
        const issued = await serviceAccountCredentials.createApiToken({
          serviceAccountId: account.data.id,
          name: "Issued earlier",
          scopes: [],
        });
        if (!issued.ok) throw new Error("Fixture key failed");
        const before = await serviceAccountCredentials.getOverview({ id: issued.data.credential.id });
        const full = await create({ name: "Full", access: "full" });
        expect(full.credential.scopes).toEqual(["read", "write", "admin"]);
        expect(await serviceAccountCredentials.getOverview({ id: issued.data.credential.id })).toEqual(before);
        const authority = await authorityOf(full.token);
        expect(await usableAppIds(authority, [signedIn, app])).toEqual(new Set([signedIn.id]));
        await sql`INSERT INTO auth.app_access_state(app_id,configured_at) VALUES (${app.id}, '2026-11-03T00:00:00Z')`;
        const [appGrant] = await sql<{ id: string }[]>`
          INSERT INTO auth.access(service_account_id,permission) VALUES (${account.data.id}::uuid,'read') RETURNING id`;
        appGrantId = appGrant!.id;
        await sql`INSERT INTO auth.app_access(app_id,access_id) VALUES (${app.id},${appGrantId}::uuid)`;
        expect(await canUseApp(authority, app)).toBe(true);

        const project = await aiProjects.create({ subject: owner, name: `Granted ${suffix}` });
        projectIds.push(project.id);
        const privateProject = await aiProjects.create({ subject: owner, name: `Private ${suffix}` });
        projectIds.push(privateProject.id);
        expect(
          await aiProjects.grantAccess(project.id, owner, {
            principal: { type: "service_account", serviceAccountId: account.data.id },
            permission: "write",
          }),
        ).not.toBeNull();
        expect((await aiProjects.get(project.id, authority))?.permission).toBe("write");
        expect(await aiProjects.get(project.id, authority, "admin")).toBeNull();
        expect(await aiProjects.get(privateProject.id, authority)).toBeNull();
        expect(await aiProjects.update(project.id, authority, { description: "Allowed" })).not.toBeNull();

        const narrow = await create({ name: "Narrow", access: "full", scopes: ["read"] });
        expect(narrow.credential.scopes).toEqual(["read"]);
        const reader = await authorityOf(narrow.token);
        expect((await aiProjects.get(project.id, reader))?.permission).toBe("read");
        expect(await aiProjects.update(project.id, reader, { description: "Denied" })).toBeNull();

        const empty = await routes.request(`/service-accounts/${account.data.id}/api-keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Explicit empty", access: "full", scopes: [] }),
        });
        expect(empty.status).toBe(400);
        expect(await usableAppIds(await authorityOf(issued.data.token), [signedIn, app])).toEqual(new Set());
        expect((await serviceAccountCredentials.getOverview({ id: issued.data.credential.id }))?.scopes).toEqual([]);
        expect((await serviceAccountCredentials.getOverview({ id: narrow.credential.id }))?.scopes).toEqual(["read"]);

        const models = await create({ name: "Models", access: "models" });
        expect(models.credential.scopes).toEqual(["ai:inference"]);
        expect(await usableAppIds(await authorityOf(models.token), [signedIn, app])).toEqual(new Set());
      } finally {
        for (const id of projectIds) await aiProjects.admin.delete(id);
        await sql`DELETE FROM auth.app_access_state WHERE app_id=${app.id}`;
        if (appGrantId) await sql`DELETE FROM auth.access WHERE id=${appGrantId}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id=${account.data.id}::uuid`;
        await sql`DELETE FROM audit.events WHERE actor_user_id=${admin!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${admin!.id}::uuid`;
      }
    });
});
