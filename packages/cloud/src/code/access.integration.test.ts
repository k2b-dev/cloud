import { beforeAll, beforeEach, expect } from "bun:test";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import type { CodeAccessAdapter } from "../contracts/code-access";
import type { User } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { listCodeAccess, removeCodeAccess, setCodeAccess } from "./access";
import type { CodeAccessProofClaims } from "./access-proof";

const suite = databaseSuite();
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mia",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia@example.com",
  avatarHash: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  accountExpires: null,
  lastLoginLocal: null,
  ipa: null,
};
const actor = {
  kind: "user" as const,
  user: person,
  delegation: {
    kind: "invocation" as const,
    callingAppId: "core",
    credentialKind: "session" as const,
    invocationId: "invocation",
    codeAccess: "set" as const,
  },
};
const context: CapabilityExecutionContext = {
  actor,
  user: person,
  accessSubject: { type: "user", userId: person.id },
  authority: { actor, accessSubject: { type: "user", userId: person.id }, credentialKind: "invocation", scopes: [] },
  locale: "en",
  requestId: "code-access-integration",
  origin: "app",
  signal: new AbortController().signal,
};
const listContext: CapabilityExecutionContext = {
  ...context,
  actor: { ...actor, delegation: { ...actor.delegation, codeAccess: "list" } },
};
const removeContext: CapabilityExecutionContext = {
  ...context,
  actor: { ...actor, delegation: { ...actor.delegation, codeAccess: "rm" } },
};
const principal = "22222222-2222-4222-8222-222222222222";
const grantId = "33333333-3333-4333-8333-333333333333";
const target = { type: "inventory.item", id: "item-1" };
const claims: CodeAccessProofClaims = {
  ver: 1,
  iss: "https://cloud.example",
  aud: "app:inventory",
  token_use: "code_access",
  iat: 1,
  nbf: 1,
  exp: 31,
  codeId: "code-1",
  versionId: "version-1",
  activationId: "44444444-4444-4444-8444-444444444444",
  activatingPerson: person.id,
  principal,
  grantId,
  target,
  operations: ["inventory.item.update"],
};
const dependencies = { db: sql, verifyProof: async () => claims };
const input = { proof: "verified-proof-fixture", target, operations: claims.operations };
const adapter: CodeAccessAdapter = {
  manages: () => true,
  grant: async (tx, value) => {
    // Deliberately writes on dryRun: the platform must roll this back as well.
    await tx`INSERT INTO capabilities.code_access_fixture (grant_id, principal, resource_id, level) VALUES (${value.grantId}::uuid, ${value.principal}::uuid, ${value.id}, 'write')`;
    return { granted: true, level: "write" };
  },
  list: async (tx, value) =>
    tx<
      { grantId: string; id: string; level: string }[]
    >`SELECT grant_id AS "grantId", resource_id AS id, level FROM capabilities.code_access_fixture WHERE principal = ${value.principal}::uuid`,
  revoke: async (tx, value) =>
    Boolean(
      (
        await tx`DELETE FROM capabilities.code_access_fixture WHERE grant_id = ${value.grantId}::uuid AND resource_id = ${value.id} RETURNING grant_id`
      )[0],
    ),
};
const bindings = new Map([[target.type, adapter]]);
beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCloudCapabilities();
  await sql`CREATE TABLE IF NOT EXISTS capabilities.code_access_fixture (grant_id uuid PRIMARY KEY, principal uuid NOT NULL, resource_id text NOT NULL, level text NOT NULL)`;
  await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${principal}::uuid, 'Code access fixture', 'code') ON CONFLICT (id) DO NOTHING`;
});
beforeEach(async () => {
  if (!testInfra.database) return;
  await sql`DELETE FROM capabilities.code_access_fixture`;
  await sql`DELETE FROM capabilities.code_access_grants WHERE app_id = 'inventory'`;
  await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${principal}::uuid, 'Code access fixture', 'code') ON CONFLICT (id) DO UPDATE SET status = 'active'`;
  await sql`DELETE FROM audit.events WHERE request_id = ${context.requestId}`;
});

suite("dry run leaves no permission, routing or audit rows", async () => {
  expect(await setCodeAccess("inventory", bindings, { ...input, dryRun: true }, context, dependencies)).toMatchObject({ granted: true });
  expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(0);
  expect(await sql`SELECT * FROM capabilities.code_access_grants WHERE app_id = 'inventory'`).toHaveLength(0);
  expect(await sql`SELECT * FROM audit.events WHERE request_id = ${context.requestId}`).toHaveLength(0);
});
suite("parallel retries create one grant, list is live, and target removal cannot be undone by replay", async () => {
  const results = await Promise.all(Array.from({ length: 3 }, () => setCodeAccess("inventory", bindings, input, context, dependencies)));
  expect(results.every((result) => result.granted)).toBe(true);
  expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(1);
  expect(await sql`SELECT * FROM audit.events WHERE request_id = ${context.requestId} AND action = 'code.access.set'`).toHaveLength(1);
  expect(await listCodeAccess("inventory", bindings, principal, listContext)).toEqual([{ grantId, principal, target, level: "write" }]);
  expect(await removeCodeAccess("inventory", bindings, grantId, { context: removeContext })).toBe(true);
  expect(await listCodeAccess("inventory", bindings, principal, listContext)).toEqual([]);
  expect(await setCodeAccess("inventory", bindings, input, context, dependencies)).toMatchObject({ granted: false });
  expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(0);
});
suite("cleanup cannot remove another account, and adapter failure rolls back every layer", async () => {
  const broken = {
    ...adapter,
    grant: async (tx: Parameters<CodeAccessAdapter["grant"]>[0], value: Parameters<CodeAccessAdapter["grant"]>[1]) => {
      await adapter.grant(tx, value);
      throw new Error("adapter failure");
    },
  };
  await expect(setCodeAccess("inventory", new Map([[target.type, broken]]), input, context, dependencies)).rejects.toThrow(
    "adapter failure",
  );
  expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(0);
  await setCodeAccess("inventory", bindings, input, context, dependencies);
  expect(await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: person.id, requestId: "cleanup" })).toBe(false);
  expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(1);
  expect(await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: principal, requestId: "cleanup" })).toBe(true);
});

suite("live grants block account deletion, cleanup releases the account and preserves replay tombstones", async () => {
  await setCodeAccess("inventory", bindings, input, context, dependencies);
  await expect(sql`DELETE FROM auth.service_accounts WHERE id = ${principal}::uuid`).rejects.toThrow();
  await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${principal}::uuid`;
  expect(await listCodeAccess("inventory", bindings, principal, { listPrincipal: principal })).toHaveLength(1);
  await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: principal, requestId: "cleanup" });
  await sql`DELETE FROM auth.service_accounts WHERE id = ${principal}::uuid`;
  expect(await sql`SELECT * FROM capabilities.code_access_grants WHERE app_id = 'inventory' AND revoked`).toHaveLength(1);
});
