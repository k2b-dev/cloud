import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { appAccess } from "../contracts/app-access";
import { GrantAccessSchema } from "../contracts/shared";
import { sql } from "../runtime/clients";
import type { AuthContext } from "../server";
import * as auth from "../server/middleware/auth";
import { createAccess, getEffectivePermission } from "../server/services/access";
import { inventory, person, publishedEntry } from "./define-app.test-fixture";

// This application's ordinary share endpoint has no Code declaration or adapter.
// PermissionEditor exercises the matching ordinary grant callback in its behavior suite.
databaseSuite()("an app with no Code declaration accepts a service account through normal sharing", () => {
  test("the app's normal share route grants View/Edit without generating Code rights operations", async () => {
    const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind)
      VALUES(${`code:no-declaration:${crypto.randomUUID()}`},'code') RETURNING id`;
    if (!account) throw new Error("Missing fixture account");
    const principal = { type: "service_account" as const, serviceAccountId: account.id };
    const authenticated = spyOn(auth, "loadAuthenticatedActor").mockImplementation(async (c) => {
      c.set("actor", { kind: "user", user: person });
      c.set("accessSubject", { type: "user", userId: person.id });
      c.set("credentialKind", "session");
      return { token: "fixture-session", user: person, actor: c.get("actor") };
    });
    const routes = new Hono<AuthContext>().post("/api/inventory/items/item-1/access", async (c) => {
      const grant = GrantAccessSchema.parse(await c.req.json());
      const result = await sql.begin((tx) => createAccess(grant, tx));
      return result.ok ? c.json(result.data) : c.json(result.error, 400);
    });
    try {
      const entry = await publishedEntry(
        { ...inventory, access: appAccess.signedIn() },
        async (server) => {
          for (const permission of ["read", "write"] as const) {
            const response = await server.fetch(
              new Request("http://inventory/api/inventory/items/item-1/access", {
                method: "POST",
                headers: { "content-type": "application/json", origin: "http://inventory" },
                body: JSON.stringify({ principal, permission }),
              }),
            );
            expect(response.status).toBe(200);
            const { id } = z.object({ id: z.uuid() }).parse(await response.json());
            expect(await getEffectivePermission({ accessIds: [id], subject: principal })).toBe(permission);
          }
        },
        undefined,
        { fetch: routes.fetch },
      );
      expect(entry.capabilities).toBeUndefined();
    } finally {
      authenticated.mockRestore();
      await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
    }
  });
});
