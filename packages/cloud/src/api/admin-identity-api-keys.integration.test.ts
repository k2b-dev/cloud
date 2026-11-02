import { expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { appAccess } from "../contracts/app-access";
import { sql } from "../runtime/clients";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { usableAppIds } from "../services/app-access";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { serviceAccounts } from "../services/service-accounts";
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
  for (const kind of ["standalone", "agent"] as const)
    test(`${kind}: a key stores the named scopes and enters only what its rules allow`, async () => {
      const suffix = crypto.randomUUID();
      const [admin] = await sql<{ id: string }[]>`
        INSERT INTO auth.users(uid,provider,profile,admin) VALUES (${`key-admin-${suffix}`},'local','user',true) RETURNING id`;
      const account = await serviceAccounts.createStandalone({ name: `Key worker ${suffix}`, kind, createdBy: admin!.id });
      if (!account.ok) throw new Error("Fixture account failed");
      const actor = { id: admin!.id, uid: `key-admin-${suffix}`, provider: "local", roles: ["admin"] } as AuthContext["Variables"]["user"];
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
        return (await response.json()) as { token: string; credential: { scopes: string[] } };
      };
      try {
        // The browser dialog names these scopes for "Full access".
        const full = await create({ name: "Full", access: "full", scopes: ["read", "write", "admin"] });
        expect(full.credential.scopes).toEqual(["read", "write", "admin"]);
        expect(await usableAppIds(await authorityOf(full.token), [signedIn, granted])).toEqual(new Set([signedIn.id]));

        const narrow = await create({ name: "Narrow", scopes: ["read"] });
        expect(narrow.credential.scopes).toEqual(["read"]);

        // A key issued before the fix stays without scopes and stays denied.
        const issued = await serviceAccountCredentials.createStandaloneApiToken({
          serviceAccountId: account.data.id,
          actor,
          name: "Issued earlier",
        });
        if (!issued.ok) throw new Error("Fixture key failed");
        expect(issued.data.credential.scopes).toEqual([]);
        expect(await usableAppIds(await authorityOf(issued.data.token), [signedIn, granted])).toEqual(new Set());
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id=${account.data.id}::uuid`;
        await sql`DELETE FROM audit.events WHERE actor_user_id=${admin!.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${admin!.id}::uuid`;
      }
    });
});
