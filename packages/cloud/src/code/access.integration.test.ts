import { beforeAll, beforeEach, expect, test } from "bun:test";
import type { SQL } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrateCloudCapabilities } from "../capabilities/migrate";
import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityExecutionContext } from "../contracts/capabilities";
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
  manages: async (tx, _context, id) =>
    Boolean(
      (
        await tx<{ can_manage: boolean }[]>`
    SELECT can_manage FROM capabilities.code_access_target_fixture WHERE resource_id = ${id} FOR SHARE
  `
      )[0]?.can_manage,
    ),
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
suite("Code access at the target", () => {
  beforeAll(async () => {
    if (!testInfra.database) return;
    await migrateCloudCapabilities();
    await sql`CREATE TABLE IF NOT EXISTS capabilities.code_access_fixture (grant_id uuid PRIMARY KEY, principal uuid NOT NULL, resource_id text NOT NULL, level text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS capabilities.code_access_target_fixture (resource_id text PRIMARY KEY, can_manage boolean NOT NULL)`;
    await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${principal}::uuid, 'Code access fixture', 'code') ON CONFLICT (id) DO NOTHING`;
  });
  beforeEach(async () => {
    if (!testInfra.database) return;
    await sql`DELETE FROM capabilities.code_access_fixture`;
    await sql`DELETE FROM capabilities.code_access_grants WHERE app_id = 'inventory'`;
    for (const id of [target.id, "x".repeat(512)])
      await sql`INSERT INTO capabilities.code_access_target_fixture (resource_id, can_manage) VALUES (${id}, true) ON CONFLICT (resource_id) DO UPDATE SET can_manage = true`;
    await sql`INSERT INTO auth.service_accounts (id, name, kind) VALUES (${principal}::uuid, 'Code access fixture', 'code') ON CONFLICT (id) DO UPDATE SET status = 'active'`;
    await sql`DELETE FROM audit.events WHERE request_id = ${context.requestId}`;
  });

  test("dry run leaves no permission, routing or audit rows", async () => {
    expect(await setCodeAccess("inventory", bindings, { ...input, dryRun: true }, context, dependencies)).toMatchObject({ granted: true });
    expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(0);
    expect(await sql`SELECT * FROM capabilities.code_access_grants WHERE app_id = 'inventory'`).toHaveLength(0);
    expect(await sql`SELECT * FROM audit.events WHERE request_id = ${context.requestId}`).toHaveLength(0);
  });
  test("parallel retries create one grant, list is live, and target removal cannot be undone by replay", async () => {
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

  test("set and rm refuse using committed authority after a concurrent manager change", async () => {
    for (const operation of ["set", "rm"] as const) {
      await sql`UPDATE capabilities.code_access_target_fixture SET can_manage = true WHERE resource_id = ${target.id}`;
      if (operation === "rm") await setCodeAccess("inventory", bindings, input, context, dependencies);
      const changed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const checking = Promise.withResolvers<void>();
      const change = sql.begin(async (tx) => {
        await tx`UPDATE capabilities.code_access_target_fixture SET can_manage = false WHERE resource_id = ${target.id}`;
        changed.resolve();
        await release.promise;
      });
      const checkedBindings = new Map([
        [
          target.type,
          {
            ...adapter,
            manages: async (tx: SQL, current: CapabilityExecutionContext, id: string) => {
              checking.resolve();
              return adapter.manages(tx, current, id);
            },
          },
        ],
      ]);
      let pending: Promise<unknown> | undefined;
      try {
        await Promise.race([
          changed.promise,
          change.then(() => {
            throw new Error("Manager change ended before the checkpoint");
          }),
        ]);
        pending =
          operation === "set"
            ? setCodeAccess("inventory", checkedBindings, input, context, dependencies)
            : removeCodeAccess("inventory", checkedBindings, grantId, { context: removeContext });
        await Promise.race([
          checking.promise,
          pending.then(() => {
            throw new Error("Operation skipped the manager check");
          }),
        ]);
        release.resolve();
        await change;
        if (operation === "set") expect(await pending).toMatchObject({ granted: false, reasonCode: "not_manager" });
        else expect(await pending).toBe(false);
        expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(operation === "set" ? 0 : 1);
        expect(await sql`SELECT * FROM capabilities.code_access_grants WHERE app_id = 'inventory' AND NOT revoked`).toHaveLength(
          operation === "set" ? 0 : 1,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([change, ...(pending ? [pending] : [])]);
      }
    }
  });

  test("manager locks remain held through both grant and revoke writes", async () => {
    for (const operation of ["set", "rm"] as const) {
      const writing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const lockedAdapter: CodeAccessAdapter = {
        ...adapter,
        grant: async (tx, value) => {
          const result = await adapter.grant(tx, value);
          writing.resolve();
          await release.promise;
          return result;
        },
        revoke: async (tx, value) => {
          const result = await adapter.revoke(tx, value);
          writing.resolve();
          await release.promise;
          return result;
        },
      };
      const lockedBindings = new Map([[target.type, lockedAdapter]]);
      const pending =
        operation === "set"
          ? setCodeAccess("inventory", lockedBindings, input, context, dependencies)
          : removeCodeAccess("inventory", lockedBindings, grantId, { context: removeContext });
      try {
        await Promise.race([
          writing.promise,
          pending.then(() => {
            throw new Error("Operation skipped the adapter write");
          }),
        ]);
        await expect(
          sql.begin(async (tx) => {
            await tx`SELECT resource_id FROM capabilities.code_access_target_fixture WHERE resource_id = ${target.id} FOR UPDATE NOWAIT`;
          }),
        ).rejects.toThrow(/could not obtain lock/);
      } finally {
        release.resolve();
        await pending;
      }
    }
  });
  test("cleanup cannot remove another account, and adapter failure rolls back every layer", async () => {
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

  test("live grants block account deletion, cleanup releases the account and preserves replay tombstones", async () => {
    await setCodeAccess("inventory", bindings, input, context, dependencies);
    // Bun's rejection matcher observes the promise without starting a lazy SQL query.
    await expect(sql`DELETE FROM auth.service_accounts WHERE id = ${principal}::uuid`.execute()).rejects.toMatchObject({
      errno: "23503",
      constraint: "code_access_grants_live_principal_fkey",
    });
    await sql`UPDATE auth.service_accounts SET status = 'disabled' WHERE id = ${principal}::uuid`;
    expect(await listCodeAccess("inventory", bindings, principal, { listPrincipal: principal })).toHaveLength(1);
    await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: principal, requestId: "cleanup" });
    await sql`DELETE FROM auth.service_accounts WHERE id = ${principal}::uuid`;
    expect(await sql`SELECT * FROM capabilities.code_access_grants WHERE app_id = 'inventory' AND revoked`).toHaveLength(1);
  });

  test("concurrent distinct grants cannot overflow the account reconciliation budget", async () => {
    const largeTarget = { ...target, id: "x".repeat(512) };
    const entryBytes = new TextEncoder().encode(JSON.stringify({ grantId, principal, target: largeTarget, level: "write" })).byteLength + 1;
    const count = Math.floor((CAPABILITY_MAX_RESULT_BYTES - 11) / entryBytes) - 1;
    await sql`INSERT INTO capabilities.code_access_fixture (grant_id, principal, resource_id, level)
    SELECT ('55555555-5555-4555-8555-' || lpad(n::text, 12, '0'))::uuid, ${principal}::uuid, ${largeTarget.id}, 'write'
    FROM generate_series(1, ${count}) AS n`;
    await sql`INSERT INTO capabilities.code_access_grants (app_id, grant_id, principal, target_type, target_id, binding_hash, level, live_principal)
    SELECT 'inventory', grant_id, principal, ${target.type}, resource_id, 'fixture', level, principal FROM capabilities.code_access_fixture`;
    const results = await Promise.all(
      [grantId, "66666666-6666-4666-8666-666666666666"].map((nextId) =>
        setCodeAccess("inventory", bindings, { ...input, target: largeTarget }, context, {
          db: sql,
          verifyProof: async () => ({ ...claims, grantId: nextId, target: largeTarget }),
        }),
      ),
    );
    expect(results.filter((result) => result.granted)).toHaveLength(1);
    expect(results.find((result) => !result.granted)).toMatchObject({ reasonCode: "capacity_exceeded" });
    const live = await listCodeAccess("inventory", bindings, principal, { listPrincipal: principal });
    expect(live).toHaveLength(count + 1);
    expect(new TextEncoder().encode(JSON.stringify({ data: live })).byteLength).toBeLessThanOrEqual(CAPABILITY_MAX_RESULT_BYTES);
  });
  test("cleanup before the first set fences a delayed activation proof", async () => {
    expect(await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: principal, requestId: "cleanup" })).toBe(true);
    expect(await setCodeAccess("inventory", bindings, input, context, dependencies)).toMatchObject({ granted: false, reasonCode: "removed" });
    expect(await sql`SELECT * FROM capabilities.code_access_fixture`).toHaveLength(0);
    expect(await listCodeAccess("inventory", bindings, principal, listContext)).toEqual([]);
    expect(await removeCodeAccess("inventory", bindings, grantId, { cleanupPrincipal: principal, requestId: "cleanup" })).toBe(true);
  });
});
