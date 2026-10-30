import { afterAll, expect, test } from "bun:test";
import type { ResourcePrincipal } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { databaseSuite, testInfra, useMigratedDatabase } from "../../../scripts/fixtures/test-infra";

const database = testInfra.database ? await useMigratedDatabase("notebooks_readers") : undefined;
const { serviceAccountCredentials, toPgUuidArray } = await import("@k2b/cloud/services");
const { encryptValue } = await import("@k2b/cloud/services/settings/crypto");
const { notebooksCapabilities } = await import("./capabilities");
afterAll(async () => {
  await database?.drop();
});
const suite = databaseSuite();

suite("notebooks current resource readers", () => {
  test("resolves current users and accounts, groups, wildcards and bindings without credential ceilings", async () => {
    const containerId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const expiredId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const disabledId = crypto.randomUUID();
    const boundId = crypto.randomUUID();
    const delegatedId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const parentGroupId = crypto.randomUUID();
    const user = { type: "user", userId } as const;
    const account = { type: "service_account", serviceAccountId: accountId } as const;
    const bound = { type: "service_account", serviceAccountId: boundId } as const;
    const delegated = { type: "service_account", serviceAccountId: delegatedId } as const;
    const candidates: ResourcePrincipal[] = [
      user,
      account,
      bound,
      delegated,
      { type: "user", userId: expiredId },
      { type: "user", userId: crypto.randomUUID() },
      { type: "service_account", serviceAccountId: disabledId },
      { type: "service_account", serviceAccountId: crypto.randomUUID() },
    ];
    const grants: string[] = [];
    const check = (principals = candidates) =>
      notebooksCapabilities.types.note.access.readable({
        id: "Read04",
        container: { type: "notebooks.notebook", id: "Read01" },
        principals,
      });
    const checkContainer = () => notebooksCapabilities.types.notebook.access.readable({ id: "Read01", principals: candidates });
    try {
      await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${containerId}::uuid, 'Read01', 'Readers'), (${otherId}::uuid, 'Read02', 'Other')`;
      await sql`INSERT INTO notebooks.notes (id, short_id, notebook_id, title, position) VALUES (${itemId}::uuid, 'Read04', ${containerId}::uuid, 'Note', 0)`;
      await sql`INSERT INTO auth.users (id, uid, provider, profile, given_name, sn, display_name) VALUES
        (${userId}::uuid, ${userId}, 'local', 'user', 'Reader', 'User', 'Reader User'),
        (${expiredId}::uuid, ${expiredId}, 'local', 'user', 'Expired', 'User', 'Expired User')`;
      await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${expiredId}::uuid`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, status) VALUES
        (${accountId}::uuid, ${accountId}, 'agent', 'active'), (${disabledId}::uuid, ${disabledId}, 'standalone', 'disabled')`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, app_id, resource_type, resource_id)
        VALUES (${boundId}::uuid, ${boundId}, 'resource_bound', 'notebooks', 'notebook', ${containerId})`;
      await sql`INSERT INTO auth.service_accounts (id, name, kind, delegated_user_id)
        VALUES (${delegatedId}::uuid, ${delegatedId}, 'user_delegated', ${userId}::uuid)`;
      const credential = await serviceAccountCredentials.createApiToken({ serviceAccountId: accountId, name: "No read scope", scopes: [] });
      expect(credential.ok).toBeTrue();
      if (!credential.ok) throw new Error("Expected a credential with no read scope");
      expect(credential.data.credential.scopes).toEqual([]);
      const direct = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'read') RETURNING id`;
      const accountGrant = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (service_account_id, permission) VALUES (${accountId}::uuid, 'read'), (${boundId}::uuid, 'read') RETURNING id`;
      grants.push(...direct.map((grant) => grant.id), ...accountGrant.map((grant) => grant.id));
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id)
        SELECT ${containerId}::uuid, id FROM unnest(${toPgUuidArray(grants)}::uuid[]) id`;
      expect(await check()).toEqual([user, account, bound, delegated]);
      expect(await checkContainer()).toEqual([user, account, bound, delegated]);
      // Category policy and expiry also constrain a delegated account's current user.
      await sql`INSERT INTO settings.entries (key, value) VALUES ('user.category.login.enabled', ${await encryptValue(false)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
      expect(await check()).toEqual([account, bound]);
      await sql`DELETE FROM settings.entries WHERE key = 'user.category.login.enabled'`;
      await sql`UPDATE auth.users SET account_expires = '2000-01-01T00:00:00Z' WHERE id = ${userId}::uuid`;
      expect(await check()).toEqual([account, bound]);
      await sql`UPDATE auth.users SET account_expires = NULL WHERE id = ${userId}::uuid`;
      expect(await check([])).toEqual([]);
      await sql`UPDATE auth.service_accounts SET resource_id = ${otherId} WHERE id = ${boundId}::uuid`;
      expect(await check()).toEqual([user, account, delegated]);
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(grants)}::uuid[])`;
      await sql`INSERT INTO auth.groups (id, provider, name, cn) VALUES (${groupId}::uuid, 'local', ${groupId}, ${groupId}), (${parentGroupId}::uuid, 'local', ${parentGroupId}, ${parentGroupId})`;
      await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id) VALUES (${parentGroupId}::uuid, ${groupId}::uuid)`;
      await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id) VALUES (${userId}::uuid, ${groupId}::uuid)`;
      await sql`INSERT INTO auth.service_account_groups (service_account_id, group_id) VALUES (${accountId}::uuid, ${groupId}::uuid)`;
      const [groupGrant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (group_id, permission) VALUES (${parentGroupId}::uuid, 'read') RETURNING id`;
      if (!groupGrant) throw new Error("Expected group grant");
      grants.push(groupGrant.id);
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${containerId}::uuid, ${groupGrant.id}::uuid)`;
      expect(await check()).toEqual([user, account, delegated]);
      await sql`DELETE FROM auth.access WHERE id = ${groupGrant.id}::uuid`;
      for (const authenticated of [true, false]) {
        const [grant] = await sql<
          { id: string }[]
        >`INSERT INTO auth.access (authenticated_only, permission) VALUES (${authenticated}, 'read') RETURNING id`;
        if (!grant) throw new Error("Expected wildcard grant");
        grants.push(grant.id);
        await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${containerId}::uuid, ${grant.id}::uuid)`;
        // Expired, disabled and deleted principals stay excluded even for public grants.
        expect(await check()).toEqual([user, account, delegated]);
        expect(await checkContainer()).toEqual([user, account, delegated]);
        await sql`DELETE FROM auth.access WHERE id = ${grant.id}::uuid`;
      }
      await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${delegatedId}::uuid`;
      expect(await check()).toEqual([]);
      const [grant] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'read') RETURNING id`;
      if (!grant) throw new Error("Expected user grant");
      grants.push(grant.id);
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${containerId}::uuid, ${grant.id}::uuid)`;
      expect(await check()).toEqual([user]);
      await sql`UPDATE notebooks.notes SET notebook_id = ${otherId}::uuid WHERE id = ${itemId}::uuid`;
      expect(await check()).toEqual([]);
      expect(
        await notebooksCapabilities.types.note.access.readable({
          id: "Gone00",
          container: { type: "notebooks.notebook", id: "Read01" },
          principals: candidates,
        }),
      ).toEqual([]);
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${containerId}::uuid`;
      expect(await checkContainer()).toEqual([]);
    } finally {
      await sql`DELETE FROM notebooks.notebooks WHERE id = ANY(${toPgUuidArray([containerId, otherId])}::uuid[])`;
      await sql`DELETE FROM auth.access WHERE id = ANY(${toPgUuidArray(grants)}::uuid[])`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ANY(${toPgUuidArray([accountId, disabledId, boundId, delegatedId])}::uuid[])`;
      await sql`DELETE FROM auth.groups WHERE id = ANY(${toPgUuidArray([groupId, parentGroupId])}::uuid[])`;
      await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray([userId, expiredId])}::uuid[])`;
    }
  });
});
