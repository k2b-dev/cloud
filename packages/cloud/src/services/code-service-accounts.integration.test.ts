import { expect, test } from "bun:test";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { appAccess } from "../contracts/app-access";
import { sql } from "../runtime/clients";
import { createAccess, getEffectivePermission, getEffectivePermissions, updateAccess } from "../server/services/access";
import { accounts } from "./accounts";
import { directoryShares } from "./accounts/directory-shares";
import * as entities from "./accounts/entities";
import { changeAppAccess } from "./app-access-management";
import { resolveResourceReaders } from "./identity/resource-readers";
import { serviceAccountCredentials } from "./service-account-credentials";
import { serviceAccounts } from "./service-accounts";

const suite = databaseSuite();

suite("code service-account boundaries", () => {
  test("normal credential, directory, sharing and app-access paths refuse code", async () => {
    const id = crypto.randomUUID(),
      creatorId = crypto.randomUUID(),
      recipientId = crypto.randomUUID();
    const appId = `code-test-${id}`;
    await sql`INSERT INTO auth.users(id, uid, provider, profile, admin)
      VALUES (${creatorId}::uuid, ${`creator-${id}`}, 'local', 'user', true)`;
    await sql`INSERT INTO auth.service_accounts(id, name, kind, created_by)
      VALUES (${id}::uuid, ${`code:app:${id}`}, 'code', ${creatorId}::uuid),
        (${recipientId}::uuid, ${`recipient-${id}`}, 'agent', NULL)`;
    const actor = await accounts.users.get({ id: creatorId });
    if (!actor) throw new Error("Missing creator");
    const principal = { type: "service_account" as const, serviceAccountId: id };
    const codeAccount = await serviceAccounts.get({ id });
    if (!codeAccount) throw new Error("Missing code account");
    try {
      const refusals = [
        ["directory list", () => directoryShares.list({ actor, recipientId: id, page: 1, perPage: 10 })],
        [
          "directory search",
          () =>
            directoryShares.search({
              actor: { kind: "service_account", serviceAccount: codeAccount, delegatedUser: null, scopes: ["read"] },
              query: {},
            }),
        ],
        ["generic API token", () => serviceAccountCredentials.createApiToken({ serviceAccountId: id, name: "blocked" })],
        [
          "standalone API token",
          () => serviceAccountCredentials.createStandaloneApiToken({ serviceAccountId: id, actor, name: "blocked" }),
        ],
        [
          "models-only token",
          () => serviceAccountCredentials.createStandaloneApiToken({ serviceAccountId: id, actor, name: "blocked", access: "models" }),
        ],
        ["resource API token", () => serviceAccountCredentials.createResourceApiToken({ serviceAccountId: id, actor, name: "blocked" })],
        ["normal share", () => createAccess({ principal, permission: "write" })],
        ["directory recipient", () => directoryShares.grant({ actor, recipientId: id, principal: { type: "user", userId: creatorId } })],
        ["directory target", () => directoryShares.grant({ actor, recipientId, principal })],
      ] as const;
      for (const [path, call] of refusals) expect((await call()).ok, path).toBe(false);
      for (const query of [{}, { serviceAccountKinds: ["code" as const] }, { serviceAccountIds: [id] }]) {
        const result = await entities.list({ visibility: { type: "directory" }, kinds: ["service_account"], search: id, ...query });
        expect(result.items.some((item) => item.kind === "service_account" && item.serviceAccount.id === id)).toBe(false);
      }
      await expect(
        changeAppAccess({
          app: { id: appId, name: "Fixture", access: appAccess.grants() },
          authority: {
            actor: { kind: "user", user: actor },
            accessSubject: { type: "user", userId: actor.id },
            credentialKind: "session",
            scopes: [],
          },
          repair: true,
          change: { action: "grant", principal, permission: "read" },
        }),
      ).rejects.toThrow();
      // The storage seam refuses both credential kinds, including direct inserts.
      for (const accountId of [id, recipientId]) {
        if (accountId === id)
          await expect(sql`INSERT INTO auth.service_account_credentials
          (service_account_id, name, kind, token_prefix, secret_hash)
          VALUES (${accountId}::uuid, 'blocked', 'api_token', ${crypto.randomUUID()}, 'hash')`).rejects.toMatchObject({ errno: "23514" });
        await expect(sql`INSERT INTO auth.service_account_credentials
          (service_account_id, name, kind, public_key, fingerprint)
          VALUES (${accountId}::uuid, 'blocked', 'app_key', ${"A".repeat(43)}, ${"a".repeat(32)})`).rejects.toMatchObject({
          errno: "23514",
        });
      }
      const ordinary = await serviceAccountCredentials.createApiToken({
        serviceAccountId: recipientId,
        name: "Ordinary token",
        scopes: ["read"],
      });
      if (!ordinary.ok) throw new Error("Expected an ordinary machine credential");
      await expect(sql`UPDATE auth.service_accounts SET kind = 'code' WHERE id = ${recipientId}::uuid`).rejects.toMatchObject({
        errno: "23514",
      });
      await expect(sql`UPDATE auth.service_account_credentials SET service_account_id = ${id}::uuid
        WHERE id = ${ordinary.data.credential.id}::uuid`).rejects.toMatchObject({ errno: "23514" });
      const credentials = await sql`SELECT id FROM auth.service_account_credentials WHERE service_account_id = ${id}::uuid`;
      expect(credentials).toHaveLength(0);
      const listed = await serviceAccounts.listStandalone({ search: id });
      expect(listed.items.some((account) => account.id === id)).toBe(false);
    } finally {
      await sql`DELETE FROM auth.app_access_state WHERE app_id = ${appId}`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${id}::uuid, ${recipientId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;
    }
  });

  test("single resolvers and batched resource readers use only the exact code account grant", async () => {
    const id = crypto.randomUUID(),
      otherId = crypto.randomUUID(),
      groupId = crypto.randomUUID();
    const accessIds: string[] = [];
    await sql`INSERT INTO auth.service_accounts(id, name, kind)
      VALUES (${id}::uuid, ${`code:app:${id}`}, 'code'), (${otherId}::uuid, ${`code:app:${otherId}`}, 'code')`;
    await sql`INSERT INTO auth.groups(id, cn, name, provider) VALUES (${groupId}::uuid, ${id}, 'Fixture', 'local')`;
    // Even a stale membership row must never make a code account a group recipient.
    await sql`INSERT INTO auth.service_account_groups(service_account_id, group_id) VALUES (${id}::uuid, ${groupId}::uuid)`;
    const principal = { type: "service_account" as const, serviceAccountId: id };
    try {
      const ambient = await sql<{ id: string }[]>`INSERT INTO auth.access(group_id, service_account_id, authenticated_only, permission)
        VALUES (NULL, NULL, true, 'admin'), (NULL, NULL, false, 'admin'),
          (${groupId}::uuid, NULL, false, 'admin'), (NULL, ${otherId}::uuid, false, 'write') RETURNING id`;
      accessIds.push(...ambient.map((row) => row.id));
      const check = async (expected: "none" | "write") => {
        expect(await getEffectivePermission({ accessIds, subject: principal })).toBe(expected);
        expect(await getEffectivePermission({ accessIds, serviceAccountId: id })).toBe(expected);
        const readers = await resolveResourceReaders([principal]);
        expect(readers).toHaveLength(1);
        expect(await getEffectivePermissions({ accessIds, subjects: readers.map((reader) => reader.subject) })).toEqual([expected]);
      };
      await check("none");
      const [own] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access(service_account_id, permission) VALUES (${id}::uuid, 'write') RETURNING id`;
      if (!own) throw new Error("Missing direct code grant");
      accessIds.push(own.id);
      await check("write");
      expect((await updateAccess({ id: own.id, permission: "admin" })).ok).toBe(false);
      await sql`DELETE FROM auth.access WHERE id = ${own.id}::uuid`;
      await check("none");
    } finally {
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${id}::uuid, ${otherId}::uuid)`;
      await sql`DELETE FROM auth.groups WHERE id = ${groupId}::uuid`;
    }
  });

  test("storage refuses admin code grants, upgrades, reassignment and account transitions", async () => {
    const codeId = crypto.randomUUID(),
      agentId = crypto.randomUUID();
    await sql`INSERT INTO auth.service_accounts(id, name, kind)
      VALUES (${codeId}::uuid, ${`code:app:${codeId}`}, 'code'), (${agentId}::uuid, ${`agent-${agentId}`}, 'agent')`;
    try {
      await expect(sql`INSERT INTO auth.access(service_account_id, permission)
        VALUES (${codeId}::uuid, 'admin')`).rejects.toMatchObject({ errno: "23514" });
      const [codeGrant] = await sql<{ id: string }[]>`INSERT INTO auth.access(service_account_id, permission)
        VALUES (${codeId}::uuid, 'write') RETURNING id`;
      const [agentGrant] = await sql<{ id: string }[]>`INSERT INTO auth.access(service_account_id, permission)
        VALUES (${agentId}::uuid, 'admin') RETURNING id`;
      if (!codeGrant || !agentGrant) throw new Error("Missing fixture grants");
      await expect(sql`UPDATE auth.access SET permission = 'admin' WHERE id = ${codeGrant.id}::uuid`).rejects.toMatchObject({
        errno: "23514",
      });
      await expect(
        sql`UPDATE auth.access SET service_account_id = ${codeId}::uuid WHERE id = ${agentGrant.id}::uuid`,
      ).rejects.toMatchObject({ errno: "23514" });
      await expect(sql`UPDATE auth.service_accounts SET kind = 'code' WHERE id = ${agentId}::uuid`).rejects.toMatchObject({
        errno: "23514",
      });
      expect(await sql<{ permission: string }[]>`SELECT permission FROM auth.access WHERE id = ${codeGrant.id}::uuid`).toEqual([
        { permission: "write" },
      ]);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id IN (${codeId}::uuid, ${agentId}::uuid)`;
    }
  });

  test("deleting the creator preserves the code account and mandate with a null creator", async () => {
    const id = crypto.randomUUID(),
      creatorId = crypto.randomUUID();
    await sql`INSERT INTO auth.users(id, uid, provider, profile) VALUES (${creatorId}::uuid, ${id}, 'local', 'user')`;
    await sql`INSERT INTO auth.service_accounts(id, name, kind, created_by) VALUES (${id}::uuid, ${`code:app:${id}`}, 'code', ${creatorId}::uuid)`;
    try {
      await sql`INSERT INTO auth.mandates(subject_kind, subject_service_account_id, owner_app_id, workload_type, workload_id, policy, created_by_user_id)
        VALUES ('service_account', ${id}::uuid, 'core', 'code.version', ${id}, '{"version":1}'::jsonb, ${creatorId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;
      expect(await serviceAccounts.get({ id })).toMatchObject({ id, kind: "code", createdBy: null });
      const rows = await sql<
        { created_by_user_id: string | null }[]
      >`SELECT created_by_user_id FROM auth.mandates WHERE subject_service_account_id = ${id}::uuid`;
      expect(rows).toEqual([{ created_by_user_id: null }]);
    } finally {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${creatorId}::uuid`;
    }
  });
});
