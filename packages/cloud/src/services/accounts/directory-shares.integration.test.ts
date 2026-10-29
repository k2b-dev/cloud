import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { z } from "zod";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { EntityListItemSchema } from "../../contracts";
import { prepareIdentitySigner } from "../identity/key-ring";
import { getIdentityRuntimeConfig } from "../identity/runtime-config";
import "../../../../../scripts/fixtures/authorization-preload";
import { createAccountsEntitiesRoutes } from "../../api/accounts-entities";
import adminDirectoryShares from "../../api/admin-directory-shares";
import { serviceAccountCredentials } from "../service-account-credentials";
import { serviceAccounts } from "../service-accounts";
import { directoryShares } from "./directory-shares";
import { accounts } from "./index";

const pageSchema = z.object({ items: z.array(EntityListItemSchema), pagination: z.object({ total: z.number() }) });
const suite = databaseSuite();
suite("machine directory shares", () => {
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(clock!.now);
  });
  afterEach(() => setSystemTime());
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
        const signer = await prepareIdentitySigner("oauth");
        const { issuer } = await getIdentityRuntimeConfig();
        const [epoch] = await sql<{ auth_epoch: string }[]>`SELECT auth_epoch FROM auth.users WHERE id=${adminId}::uuid`;
        const oauth = async (scope: string) =>
          new SignJWT({ token_use: "access", client_id: "cloud-cli", id: adminId, auth_epoch: Number(epoch!.auth_epoch), scope })
            .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
            .setIssuer(issuer)
            .setAudience("cloud")
            .setSubject(adminId)
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(signer.key);
        const readOnlyAdmin = { authorization: `Bearer ${await oauth("read")}`, "content-type": "application/json" };
        expect(
          (
            await routes.request(`/admin/${machineId}`, {
              method: "POST",
              headers: readOnlyAdmin,
              body: JSON.stringify({ principal: { type: "user", userId: visibleId } }),
            })
          ).status,
        ).toBe(403);
        const headers = { authorization: `Bearer ${key.data.token}` };
        const list = async (query = "") => {
          const response = await routes.request(`/accounts/entities${query}`, { headers });
          expect(response.status).toBe(200);
          return pageSchema.parse(await response.json());
        };
        expect((await list()).items).toEqual([]);
        const grant = await directoryShares.grant({ actor: admin, recipientId: machineId, principal: { type: "user", userId: visibleId } });
        if (!grant.ok) throw new Error("Fixture grant failed");
        expect(await list()).toMatchObject({ items: [{ kind: "user", user: { id: visibleId } }], pagination: { total: 1 } });
        expect((await list(`?user_ids=${hiddenId}`)).items).toEqual([]);
        expect((await list(`?search=${encodeURIComponent(`${name}-hidden`)}`)).pagination.total).toBe(0);
        const groupGrant = await directoryShares.grant({ actor: admin, recipientId: machineId, principal: { type: "group", groupId } });
        expect(groupGrant.ok).toBe(true);
        await sql`INSERT INTO auth.user_posix(user_id,managed_by,uid_number,primary_gid_number,primary_group_id,home_directory,login_shell)
          VALUES(${hiddenId}::uuid,'local',19000001,19000001,${groupId}::uuid,'/home/fixture','/bin/false')`;
        const privateGroupResponse = await routes.request(`/accounts/entities?kinds=group&group_ids=${groupId}`, { headers });
        expect(privateGroupResponse.status).toBe(200);
        expect(await privateGroupResponse.json()).toMatchObject({
          items: [],
        });
        const ownerGrant = await directoryShares.grant({
          actor: admin,
          recipientId: machineId,
          principal: { type: "user", userId: hiddenId },
        });
        if (!ownerGrant.ok) throw new Error("Owner share fixture failed");
        await directoryShares.revoke({ actor: admin, recipientId: machineId, id: ownerGrant.data.id });
        expect(await (await routes.request(`/accounts/entities?group_ids=${groupId}`, { headers })).json()).toMatchObject({
          items: [],
        });
        await sql`DELETE FROM auth.user_posix WHERE user_id=${hiddenId}::uuid`;
        expect((await routes.request(`/admin/${machineId}/${grant.data.id}`, { method: "DELETE", headers: readOnlyAdmin })).status).toBe(
          403,
        );
        const writeAdmin = { authorization: `Bearer ${await oauth("write")}`, "content-type": "application/json" };
        expect(
          (
            await routes.request(`/admin/${machineId}`, {
              method: "POST",
              headers: writeAdmin,
              body: JSON.stringify({ principal: { type: "user", userId: visibleId } }),
            })
          ).status,
        ).toBe(201);
        // Removing the mutable POSIX projection must not reclassify a personal group.
        expect((await list("?per_page=1")).pagination.total).toBe(1);
        expect(await list("?per_page=1&page=3")).toMatchObject({ items: [], pagination: { total: 1 } });
        expect((await list("?include_personal=true&per_page=1")).pagination.total).toBe(1);
        expect(await list("?include_personal=true&per_page=1&page=3")).toMatchObject({ items: [], pagination: { total: 1 } });
        expect(await directoryShares.list({ actor: admin, recipientId: machineId, page: 3, perPage: 1 })).toMatchObject({
          ok: true,
          data: { items: [], total: 2 },
        });
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
        await sql`DELETE FROM auth.user_posix WHERE user_id=${hiddenId}::uuid`;
        await sql`DELETE FROM auth.groups WHERE id=${groupId}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${adminId}::uuid,${visibleId}::uuid,${hiddenId}::uuid)`;
      }
    });
  }
});
