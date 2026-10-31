import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import type { CapabilityExecutionContext } from "../contracts/capabilities";
import type { CodeAccessAdapter } from "../contracts/code-access";
import type { User } from "../contracts/shared";
import { audit } from "../services/audit";
import { type CodeAccessDependencies, codeAccessPersonAllowed, listCodeAccess, removeCodeAccess, setCodeAccess } from "./access";
import type { CodeAccessProofClaims } from "./access-proof";

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
  delegation: { kind: "invocation" as const, callingAppId: "core", credentialKind: "session" as const, invocationId: "invocation" },
};
const context: CapabilityExecutionContext = {
  actor,
  user: person,
  accessSubject: { type: "user", userId: person.id },
  authority: { actor, accessSubject: { type: "user", userId: person.id }, credentialKind: "invocation", scopes: [] },
  locale: "en",
  requestId: "request-1",
  origin: "app",
  signal: new AbortController().signal,
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
let rows: Record<string, unknown>[];
let grants: { grantId: string; id: string; level: string }[];
let writes: number;
let canManage: boolean;
let activeCode: boolean;
let auditSpy: ReturnType<typeof spyOn<typeof audit, "record">>;
let adapter: CodeAccessAdapter;
let deps: CodeAccessDependencies;
const bindings = () => new Map([[target.type, adapter]]);
const input = { proof: "proof", target, operations: claims.operations };
beforeEach(() => {
  rows = [];
  grants = [];
  writes = 0;
  canManage = true;
  activeCode = true;
  auditSpy = spyOn(audit, "record").mockResolvedValue(undefined);
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("auth.service_accounts")) return activeCode ? [{ id: principal }] : [];
    if (statement.includes("SELECT * FROM capabilities.code_access_grants"))
      return rows.filter((row) => row.app_id === values[0] && row.grant_id === values[1]);
    if (statement.includes("INSERT INTO capabilities.code_access_grants")) {
      rows.push({
        app_id: values[0],
        grant_id: values[1],
        principal: values[2],
        target_type: values[3],
        target_id: values[4],
        binding_hash: values[5],
        level: values[6],
        revoked: false,
      });
      writes++;
    }
    if (statement.includes("UPDATE capabilities.code_access_grants")) {
      for (const row of rows) if (row.app_id === values[0] && row.grant_id === values[1]) row.revoked = true;
      writes++;
    }
    return [];
  };
  const db = Object.assign(query, {
    begin: async (fn: (tx: SQL) => Promise<unknown>) => {
      const snapshot = structuredClone({ rows, grants, writes });
      try {
        return await fn(db as unknown as SQL);
      } catch (error) {
        ({ rows, grants, writes } = snapshot);
        throw error;
      }
    },
  });
  deps = { db: db as unknown as SQL, verifyProof: async () => claims };
  adapter = {
    manages: () => canManage,
    grant: async (_tx, value) => {
      grants.push({ grantId: value.grantId, id: value.id, level: "write" });
      writes++;
      return { granted: true, level: "write" };
    },
    revoke: (_tx, value) => {
      grants = grants.filter((grant) => grant.grantId !== value.grantId);
      writes++;
      return true;
    },
    list: () => grants,
  };
});
afterEach(() => auditSpy.mockRestore());

test("dryRun rolls back even an adapter that writes; a refusal rolls back too", async () => {
  expect(await setCodeAccess("inventory", bindings(), { ...input, dryRun: true }, context, deps)).toEqual({
    granted: true,
    grantId,
    level: "write",
  });
  expect({ grants, rows, writes }).toEqual({ grants: [], rows: [], writes: 0 });
  expect(auditSpy).not.toHaveBeenCalled();
  adapter.grant = async () => {
    writes++;
    return { granted: false, reason: "No suitable level" };
  };
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toEqual({ granted: false, reason: "No suitable level" });
  expect(writes).toBe(0);
});
test("set is idempotent, rejects changed bindings, and removed access never returns on retry", async () => {
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: true, grantId });
  const before = writes;
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: true, grantId });
  expect(writes).toBe(before);
  deps.verifyProof = async () => ({ ...claims, versionId: "other-version" });
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false });
  deps.verifyProof = async () => claims;
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context }, deps.db)).toBe(true);
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false });
  expect(grants).toEqual([]);
});
test("proof, live account, target manager and app boundaries are enforced before grant", async () => {
  deps.verifyProof = async () => null;
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false });
  deps.verifyProof = async () => claims;
  activeCode = false;
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false });
  activeCode = true;
  canManage = false;
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false });
  expect(writes).toBe(0);
  const adminActor = { ...actor, user: { ...person, roles: ["admin" as const] } };
  const admin = { ...context, actor: adminActor };
  expect(await setCodeAccess("inventory", bindings(), input, admin, deps)).toMatchObject({ granted: true });
  expect(await listCodeAccess("inventory", bindings(), principal, context, deps.db)).toEqual([]);
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context }, deps.db)).toBe(false);
});
test("code and personal-Code origin, foreign apps, direct credentials, and phone sessions are refused", async () => {
  for (const invalid of [
    { ...context, authority: undefined },
    { ...context, actor: { ...actor, delegation: { ...actor.delegation, callingAppId: "consumer" } } },
    { ...context, actor: { ...actor, delegation: { ...actor.delegation, credentialKind: "mandate" as const, workloadType: "code.run" } } },
    { ...context, actor: { ...actor, delegation: { ...actor.delegation, parentInvocationId: "parent" } } },
    { ...context, actor: { ...actor, sessionKind: "app" as const } },
  ]) {
    expect(codeAccessPersonAllowed(invalid)).toBe(false);
    expect(await setCodeAccess("inventory", bindings(), input, invalid, deps)).toMatchObject({ granted: false });
    expect(await removeCodeAccess("inventory", bindings(), grantId, { context: invalid }, deps.db)).toBe(false);
  }
  expect(writes).toBe(0);
});
test("cleanup removes only its account's code grants; retries stay safe", async () => {
  await setCodeAccess("inventory", bindings(), input, context, deps);
  expect(await removeCodeAccess("inventory", bindings(), grantId, { cleanupPrincipal: person.id, requestId: "cleanup" }, deps.db)).toBe(
    false,
  );
  expect(grants).toHaveLength(1);
  expect(await removeCodeAccess("inventory", bindings(), grantId, { cleanupPrincipal: principal, requestId: "cleanup" }, deps.db)).toBe(
    true,
  );
  expect(await removeCodeAccess("inventory", bindings(), grantId, { cleanupPrincipal: principal, requestId: "cleanup" }, deps.db)).toBe(
    true,
  );
  expect(grants).toEqual([]);
  expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "code.access.rm", requestId: "cleanup" }), deps.db);
});
