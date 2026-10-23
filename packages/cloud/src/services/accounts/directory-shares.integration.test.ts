import { expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { createAccountsEntitiesRoutes } from "../../api/accounts-entities";
import adminDirectoryShares from "../../api/admin-directory-shares";
import { serviceAccountCredentials } from "../service-account-credentials";
import { serviceAccounts } from "../service-accounts";
import { directoryShares } from "./directory-shares";
import { accounts } from "./index";

const pageSchema = z.object({ items: z.array(z.object({ id: z.string() })), pagination: z.object({ total: z.number() }) });
const suite = databaseSuite();
suite("machine directory shares", () => {
  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind}: real token sees only explicit entries and loses them immediately on revocation`, async () => {
      const adminId = crypto.randomUUID();
      const visibleId = crypto.randomUUID();
      const hiddenId = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      const name = `directory-${kind}-${adminId}`;
      await sql`INSERT INTO auth.users(id,uid,provider,profile,admin) VALUES(${adminId}::uuid,${`${name}-admin`},'local','user',true)`;
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${visibleId}::uuid,${`${name}-visible`},'local','user'),(${hiddenId}::uuid,${`${name}-hidden`},'local','user')`;
      await sql`INSERT INTO auth.groups(id,cn,name,provider) VALUES(${groupId}::uuid,${name},${name},'local')`;
      const created = await serviceAccounts.createStandalone({ name, kind, createdBy: adminId });
      if (!created.ok) throw new Error("Fixture account failed");
      const machineId = created.data.id;
      try {
        const admin = await accounts.users.get({ id: adminId });
        if (!admin) throw new Error("Fixture admin missing");
        const key = await serviceAccountCredentials.createStandaloneApiToken({
          actor: admin,
          serviceAccountId: machineId,
          name: "directory",
          scopes: ["read"],
        });
        const wrongScope = await serviceAccountCredentials.createStandaloneApiToken({
          actor: admin,
          serviceAccountId: machineId,
          name: "no read",
          scopes: ["write"],
        });
        if (!key.ok || !wrongScope.ok) throw new Error("Fixture key failed");
        const routes = new Hono().route("/accounts", createAccountsEntitiesRoutes()).route("/admin", adminDirectoryShares);
        const headers = { authorization: `Bearer ${key.data.token}` };
        const list = async (query = "") => {
          const response = await routes.request(`/accounts/entities${query}`, { headers });
          expect(response.status).toBe(200);
          return pageSchema.parse(await response.json());
        };
        expect((await list()).items).toEqual([]);
        const grant = await directoryShares.grant({ actor: admin, recipientId: machineId, principal: { type: "user", userId: visibleId } });
        if (!grant.ok) throw new Error("Fixture grant failed");
        expect(await list()).toMatchObject({ items: [{ id: visibleId }], pagination: { total: 1 } });
        expect((await list(`?user_ids=${hiddenId}`)).items).toEqual([]);
        expect((await list(`?search=${encodeURIComponent(`${name}-hidden`)}`)).pagination.total).toBe(0);
        const groupGrant = await directoryShares.grant({ actor: admin, recipientId: machineId, principal: { type: "group", groupId } });
        expect(groupGrant.ok).toBe(true);
        expect((await list("?per_page=1")).pagination.total).toBe(2);
        expect((await routes.request(`/accounts/entities?member_of_group_id=${groupId}`, { headers })).status).toBe(403);
        expect((await routes.request("/accounts/entities", { headers: { authorization: `Bearer ${wrongScope.data.token}` } })).status).toBe(
          403,
        );
        expect((await routes.request(`/admin/${machineId}`, { headers })).status).toBe(403);
        const other = await serviceAccounts.createStandalone({ name: `${name}-other`, kind });
        if (!other.ok) throw new Error("Other fixture failed");
        try {
          const otherKey = await serviceAccountCredentials.createStandaloneApiToken({
            actor: admin,
            serviceAccountId: other.data.id,
            name: "other",
            scopes: ["read"],
          });
          if (!otherKey.ok) throw new Error("Other key failed");
          const response = await routes.request("/accounts/entities", { headers: { authorization: `Bearer ${otherKey.data.token}` } });
          expect(pageSchema.parse(await response.json()).items).toEqual([]);
        } finally {
          await sql`DELETE FROM auth.service_accounts WHERE id=${other.data.id}::uuid`;
        }
        expect((await directoryShares.revoke({ actor: admin, recipientId: machineId, id: grant.data.id })).ok).toBe(true);
        expect((await list(`?user_ids=${visibleId}`)).items).toEqual([]);
        expect((await serviceAccounts.setStatus({ id: machineId, status: "disabled" })).ok).toBe(true);
        expect((await routes.request("/accounts/entities", { headers })).status).toBe(401);
        const audits = await sql<{ action: string }[]>`SELECT action FROM audit.events WHERE metadata->>'serviceAccountId'=${machineId}`;
        expect(audits.map((entry) => entry.action)).toContain("accounts.directory.grant");
        expect(audits.map((entry) => entry.action)).toContain("accounts.directory.revoke");
        expect(audits.map((entry) => entry.action)).toContain("accounts.directory.search");
      } finally {
        await sql`DELETE FROM auth.service_accounts WHERE id=${machineId}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id=${groupId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${adminId}::uuid,${visibleId}::uuid,${hiddenId}::uuid)`;
      }
    });
  }
});
