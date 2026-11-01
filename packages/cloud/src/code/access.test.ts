import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { z } from "zod";
import { generatedCodeAccess } from "../_internal/code-access";
import { createCodeAccessAuthorityRoutes } from "../_internal/code-access-authority";
import * as resourcePrincipals from "../_internal/resource-principals";
import { CAPABILITY_MAX_RESULT_BYTES, type CapabilityExecutionContext, CloudResourceReaderViewSchema } from "../contracts/capabilities";
import { CODE_ACCESS_MAX_MANAGER_USER_IDS, type CodeAccessAdapter, CodeAccessDecisionSchema } from "../contracts/code-access";
import type { User } from "../contracts/shared";
import * as installationAdmin from "../services/accounts/installation-admin";
import { audit } from "../services/audit";
import * as accessService from "./access";
import { type CodeAccessDependencies, codeAccessPersonAllowed, listCodeAccess, removeCodeAccess, setCodeAccess } from "./access";
import type { CodeAccessProofClaims } from "./access-proof";
import * as accessProof from "./access-proof";

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
  requestId: "request-1",
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
let rows: Record<string, unknown>[];
let grants: { grantId: string; id: string; level: string }[];
let writes: number;
let canManage: boolean;
let activeCode: boolean;
let auditSpy: ReturnType<typeof spyOn<typeof audit, "record">>;
let adminSpy: ReturnType<typeof spyOn<typeof installationAdmin, "hasInstallationAdminInTransaction">>;
let beforeTransaction: (() => void) | undefined;
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
  beforeTransaction = undefined;
  auditSpy = spyOn(audit, "record").mockResolvedValue(undefined);
  adminSpy = spyOn(installationAdmin, "hasInstallationAdminInTransaction").mockResolvedValue(true);
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("auth.service_accounts")) return activeCode || values[1] === false ? [{ id: principal }] : [];
    if (statement.includes("SELECT * FROM capabilities.code_access_grants"))
      return statement.includes("AND principal")
        ? rows.filter((row) => row.app_id === values[0] && row.principal === values[1] && !row.revoked)
        : rows.filter((row) => row.app_id === values[0] && row.grant_id === values[1]);
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
  const db = Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => query(strings, ...values), {
    begin: async (fn: (tx: SQL) => Promise<unknown>) => {
      beforeTransaction?.();
      const snapshot = structuredClone({ rows, grants, writes });
      try {
        return await fn(query as unknown as SQL);
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
afterEach(() => {
  auditSpy.mockRestore();
  adminSpy.mockRestore();
});

test("manager changes before the write transaction refuse set and rm without changing grants", async () => {
  const check = spyOn(adapter, "manages").mockImplementation((tx, current, id) => {
    expect(tx).not.toBe(deps.db);
    expect(current.actor).toMatchObject({ kind: "user", user: { id: person.id } });
    expect(id).toBe(target.id);
    return canManage;
  });
  // A preflight can see a manager, then the manager change commits before begin.
  expect(canManage).toBe(true);
  beforeTransaction = () => {
    canManage = false;
  };
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false, reasonCode: "not_manager" });
  expect({ rows, grants, writes }).toEqual({ rows: [], grants: [], writes: 0 });
  beforeTransaction = undefined;
  canManage = true;
  await setCodeAccess("inventory", bindings(), input, context, deps);
  const snapshot = structuredClone({ rows, grants, writes });
  beforeTransaction = () => {
    canManage = false;
  };
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context: removeContext }, deps.db)).toBe(false);
  expect({ rows, grants, writes }).toEqual(snapshot);
  expect(check).toHaveBeenCalledTimes(3);
});

test("a stale admin role cannot authorize a set or removal after live admin authority changes", async () => {
  const admin = { ...context, actor: { ...actor, user: { ...person, roles: ["admin" as const] } } };
  await setCodeAccess("inventory", bindings(), input, admin, deps);
  const snapshot = structuredClone({ rows, grants, writes });
  canManage = false;
  beforeTransaction = () => {
    adminSpy.mockResolvedValue(false);
  };
  expect(await setCodeAccess("inventory", bindings(), input, admin, deps)).toMatchObject({ granted: false, reasonCode: "not_manager" });
  const removeAdmin = { ...admin, actor: { ...admin.actor, delegation: { ...actor.delegation, codeAccess: "rm" as const } } };
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context: removeAdmin }, deps.db)).toBe(false);
  expect(adminSpy).toHaveBeenCalledTimes(3);
  for (const [, tx] of adminSpy.mock.calls) expect(tx).not.toBe(deps.db);
  expect({ rows, grants, writes }).toEqual(snapshot);
});

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
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toEqual({
    granted: false,
    reasonCode: "adapter_refused",
    reason: "No suitable level",
  });
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
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context: removeContext }, deps.db)).toBe(true);
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
  expect(await listCodeAccess("inventory", bindings(), principal, listContext, deps.db)).toEqual([]);
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context: removeContext }, deps.db)).toBe(false);
});
test("code and personal-Code origin, foreign apps, direct credentials, and phone sessions are refused", async () => {
  for (const invalid of [
    { ...context, actor: { ...actor, delegation: { ...actor.delegation, codeAccess: undefined } } },
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
  expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "code.access.rm", requestId: "cleanup" }), expect.anything());
});

test("Core account inspection preserves unchanged foreign grants without target-manager authority", async () => {
  await setCodeAccess("inventory", bindings(), input, context, deps);
  canManage = false;
  expect(await listCodeAccess("inventory", bindings(), principal, listContext, deps.db)).toEqual([]);
  expect(await listCodeAccess("inventory", bindings(), principal, { listPrincipal: principal }, deps.db)).toEqual([
    { grantId, principal, target, level: "write" },
  ]);
  expect(await listCodeAccess("inventory", bindings(), principal, { listPrincipal: person.id }, deps.db)).toEqual([]);
});
test("audit failures roll back permission writes and a refused removal remains retryable", async () => {
  auditSpy.mockRejectedValueOnce(new Error("audit unavailable"));
  await expect(setCodeAccess("inventory", bindings(), input, context, deps)).rejects.toThrow("audit unavailable");
  expect({ rows, grants, writes }).toEqual({ rows: [], grants: [], writes: 0 });
  await setCodeAccess("inventory", bindings(), input, context, deps);
  adapter.revoke = () => false;
  await expect(removeCodeAccess("inventory", bindings(), grantId, { context: removeContext }, deps.db)).rejects.toThrow("refused");
  expect(rows[0]?.revoked).toBe(false);
  expect(grants).toHaveLength(1);
});

test("app-wide adapters use the receiving app ID and never accept another app target", async () => {
  const appBindings = new Map([["app", adapter]]);
  const appTarget = { type: "app", id: "inventory" };
  deps.verifyProof = async () => ({ ...claims, target: appTarget });
  expect(await setCodeAccess("inventory", appBindings, { ...input, target: appTarget }, context, deps)).toMatchObject({ granted: true });
  expect(await listCodeAccess("inventory", appBindings, principal, listContext, deps.db)).toEqual([
    { grantId, level: "write", principal, target: appTarget },
  ]);
  expect(await setCodeAccess("inventory", appBindings, { ...input, target: { type: "app", id: "other" } }, context, deps)).toMatchObject({
    granted: false,
  });
});

test("Core authority transport admits only the exact account-scoped token use", async () => {
  const cleanup = spyOn(accessProof, "verifyCodeAccessCleanup").mockResolvedValue(null);
  const inspection = spyOn(accessProof, "verifyCodeAccessList").mockResolvedValue(null);
  const remove = spyOn(accessService, "removeCodeAccess").mockResolvedValue(true);
  const list = spyOn(accessService, "listCodeAccess").mockResolvedValue([]);
  try {
    const router = createCodeAccessAuthorityRoutes("inventory", { protocolVersion: 2, code: { access: { app: adapter } } });
    const request = (path: string, body: object) =>
      router.request(path, {
        method: "POST",
        headers: { authorization: "Bearer fixture", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await request("/actions/code.access.rm", { grantId })).status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
    cleanup.mockResolvedValue({
      ver: 1,
      iss: claims.iss,
      aud: claims.aud,
      iat: 1,
      nbf: 1,
      exp: 31,
      token_use: "code_access_cleanup",
      principal,
    });
    expect((await request("/actions/code.access.rm", { grantId })).status).toBe(200);
    expect(remove).toHaveBeenCalledWith("inventory", expect.anything(), grantId, {
      cleanupPrincipal: principal,
      requestId: expect.any(String),
    });
    expect((await request("/queries/code.access.list", { principal })).status).toBe(403);
    inspection.mockResolvedValue({
      ver: 1,
      iss: claims.iss,
      aud: claims.aud,
      iat: 1,
      nbf: 1,
      exp: 31,
      token_use: "code_access_list",
      principal,
    });
    expect((await request("/queries/code.access.list", { principal: person.id })).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
    expect((await request("/queries/code.access.list", { principal })).status).toBe(200);
    expect(list).toHaveBeenCalledWith("inventory", expect.anything(), principal, { listPrincipal: principal });
    expect((await request("/actions/code.access.set", input)).status).toBe(404);
    remove.mockRejectedValue(new Error("target unavailable"));
    expect((await request("/actions/code.access.rm", { grantId })).status).toBe(503);
  } finally {
    cleanup.mockRestore();
    inspection.mockRestore();
    remove.mockRestore();
    list.mockRestore();
  }
});

test("Cloud admin repair requires a session or the OAuth admin scope", async () => {
  canManage = false;
  const adminActor = {
    ...actor,
    user: { ...person, roles: ["admin" as const] },
    delegation: { ...actor.delegation, credentialKind: "oauth" as const },
  };
  const admin = { ...context, actor: adminActor, authority: { ...context.authority!, actor: adminActor, scopes: ["write"] } };
  expect(await setCodeAccess("inventory", bindings(), input, admin, deps)).toMatchObject({ granted: false, reasonCode: "not_manager" });
  admin.authority.scopes = ["admin"];
  expect(await setCodeAccess("inventory", bindings(), input, admin, deps)).toMatchObject({ granted: true });
});
test("inactive Code accounts remain inspectable and removable; only active accounts receive grants", async () => {
  await setCodeAccess("inventory", bindings(), input, context, deps);
  activeCode = false;
  expect(await listCodeAccess("inventory", bindings(), principal, { listPrincipal: principal }, deps.db)).toHaveLength(1);
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({
    granted: false,
    reasonCode: "account_inactive",
  });
  expect(await removeCodeAccess("inventory", bindings(), grantId, { context: removeContext }, deps.db)).toBe(true);
});
test("denied real changes are audited, dry runs never write an audit row", async () => {
  deps.verifyProof = async () => null;
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toMatchObject({ granted: false, reasonCode: "proof_invalid" });
  expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied", reason: "proof_invalid" }), deps.db);
  auditSpy.mockClear();
  await setCodeAccess("inventory", bindings(), { ...input, dryRun: true }, context, deps);
  expect(auditSpy).not.toHaveBeenCalled();
});
test("unindexed adapter rows never appear as removable platform grants", async () => {
  grants = [{ grantId, id: target.id, level: "write" }];
  expect(await listCodeAccess("inventory", bindings(), principal, { listPrincipal: principal }, deps.db)).toEqual([]);
});

test("an empty operation set only checks the owner in dryRun", async () => {
  const empty = { ...input, operations: [] };
  expect(await setCodeAccess("inventory", bindings(), empty, context, deps)).toMatchObject({
    granted: false,
    reasonCode: "operations_invalid",
  });
  expect(grants).toHaveLength(0);
  expect(await setCodeAccess("inventory", bindings(), { ...empty, dryRun: true }, context, deps)).toMatchObject({ granted: true });
  expect(grants).toHaveLength(0);
});
test("grant admission refuses overflow before an account list becomes unreadable", async () => {
  await setCodeAccess("inventory", bindings(), input, context, deps);
  const prototype = rows[0]!;
  const largeTarget = { ...target, id: "x".repeat(512) };
  const level = "x".repeat(120);
  const entryBytes = new TextEncoder().encode(JSON.stringify({ grantId, principal, target: largeTarget, level })).byteLength + 1;
  const count = Math.floor((CAPABILITY_MAX_RESULT_BYTES - 11) / entryBytes);
  rows = Array.from({ length: count }, (_, index) => ({
    ...prototype,
    grant_id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    target_id: largeTarget.id,
    level,
  }));
  deps.verifyProof = async () => ({ ...claims, target: largeTarget });
  adapter.grant = (_tx, value) => {
    grants.push({ grantId: value.grantId, id: value.id, level });
    writes++;
    return { granted: true, level };
  };
  const snapshot = structuredClone({ rows, grants, writes });
  expect(await setCodeAccess("inventory", bindings(), { ...input, target: largeTarget }, context, deps)).toMatchObject({
    granted: false,
    reasonCode: "capacity_exceeded",
  });
  expect({ rows, grants, writes }).toEqual(snapshot);
});

test("a list exactly at the result byte budget remains readable", async () => {
  const makeGrant = (index: number) => ({
    grantId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    principal,
    target: { ...target, id: "x".repeat(512) },
    level: "write",
  });
  const measure = (data: ReturnType<typeof makeGrant>[]) => new TextEncoder().encode(JSON.stringify({ data })).byteLength;
  const fullSize = new TextEncoder().encode(JSON.stringify(makeGrant(0))).byteLength + 1;
  const count = Math.floor((CAPABILITY_MAX_RESULT_BYTES - 11) / fullSize);
  const expected = Array.from({ length: count }, (_, index) => makeGrant(index));
  expected.push({ ...makeGrant(count), target: { ...target, id: "x" } });
  const remaining = CAPABILITY_MAX_RESULT_BYTES - measure(expected);
  if (remaining >= 0) expected[count]!.target.id += "x".repeat(remaining);
  else expected[count - 1]!.target.id = expected[count - 1]!.target.id.slice(0, remaining);
  expect(measure(expected)).toBe(CAPABILITY_MAX_RESULT_BYTES);
  rows = expected.map((grant) => ({
    app_id: "inventory",
    grant_id: grant.grantId,
    principal,
    target_type: target.type,
    target_id: grant.target.id,
    binding_hash: "fixture",
    level: grant.level,
    revoked: false,
  }));
  grants = expected.map((grant) => ({ grantId: grant.grantId, id: grant.target.id, level: grant.level }));
  expect(await listCodeAccess("inventory", bindings(), principal, { listPrincipal: principal }, deps.db)).toEqual(expected);
});

test("dry-run set preserves managerUserIds, including retries of an existing grant", async () => {
  const original = adapter.grant;
  adapter.grant = async (tx, request) => {
    const decision = await original(tx, request);
    return decision.granted ? { ...decision, managerUserIds: [person.id] } : decision;
  };
  const expected = { granted: true as const, grantId, level: "write", managerUserIds: [person.id] };
  expect(await setCodeAccess("inventory", bindings(), { ...input, dryRun: true }, context, deps)).toEqual(expected);
  expect(await setCodeAccess("inventory", bindings(), input, context, deps)).toEqual(expected);
  expect(await setCodeAccess("inventory", bindings(), { ...input, dryRun: true }, context, deps)).toEqual(expected);
});

test("oversized manager metadata refuses before committing writes, including the set envelope", async () => {
  const managers = Array.from(
    { length: CODE_ACCESS_MAX_MANAGER_USER_IDS },
    (_, index) => `55555555-5555-4555-8555-${index.toString().padStart(12, "0")}`,
  );
  expect(CodeAccessDecisionSchema.safeParse({ granted: true, level: "read", managerUserIds: [...managers, person.id] }).success).toBe(
    false,
  );
  const original = adapter.grant;
  adapter.grant = async (tx, request) => {
    const decision = await original(tx, request);
    return decision.granted ? { ...decision, managerUserIds: managers } : decision;
  };
  for (const dryRun of [true, false]) {
    expect(await setCodeAccess("inventory", bindings(), { ...input, dryRun }, context, deps)).toMatchObject({
      granted: false,
      reasonCode: "capacity_exceeded",
    });
    expect(grants).toHaveLength(0);
    expect(rows).toHaveLength(0);
  }
});

test("generated set answers disclose title and managers only to the activating target reader, including Cloud admins and refusals", async () => {
  const set = spyOn(accessService, "setCodeAccess");
  const proof = spyOn(accessProof, "verifyCodeAccessProof").mockResolvedValue(claims);
  const managers = spyOn(accessService, "readCodeAccessManagers").mockResolvedValue([person.id]);
  const active = spyOn(resourcePrincipals, "activeResourcePrincipals").mockImplementation(async (values) => values);
  try {
    for (const admin of [false, true])
      for (const readable of [false, true])
        for (const granted of [false, true]) {
          const read = { calls: 0 };
          const generated = generatedCodeAccess("inventory", {
            protocolVersion: 2,
            types: {
              item: {
                title: "Item",
                description: "Item.",
                reader: "item.read",
                access: {
                  ...adapter,
                  readable: ({ id, principals }, authority) => {
                    expect(id).toBe(target.id);
                    expect(principals).toEqual([{ type: "user", userId: person.id }]);
                    expect(authority.actor).toEqual({ kind: "app", appId: "core" });
                    return readable ? principals : [];
                  },
                },
              },
            },
            queries: {
              "item.read": {
                title: "Read item",
                description: "Item.",
                openWorld: false,
                // Lifecycle checks need the server-side title; disclosure is what this test checks.
                codeResourceTitle: () => "Fixture target",
                input: z.object({ id: z.string() }),
                data: z.object({ view: CloudResourceReaderViewSchema }),
                run: () => {
                  read.calls++;
                  return { ok: true, data: { data: { view: { title: "Fixture target", permission: "read" } } } };
                },
              },
            },
          });
          set.mockResolvedValue(
            granted
              ? { granted: true, grantId, level: "write", managerUserIds: [person.id] }
              : { granted: false, reasonCode: "not_manager", reason: "Fixture target managers require authority" },
          );
          const result = await generated.actions["code.access.set"]!.run(
            { ...input, dryRun: true },
            {
              ...context,
              locale: "de",
              actor: { ...actor, user: { ...person, roles: admin ? ["admin"] : ["user"] } },
            },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("Expected answer");
          const answer = result.data.data;
          expect(answer).toMatchObject({ granted, readable });
          if (readable) {
            expect(answer).toMatchObject({ title: "Fixture target", managerUserIds: [person.id] });
            expect(read.calls).toBe(1);
          } else {
            expect(answer).not.toHaveProperty("title");
            expect(answer).not.toHaveProperty("managerUserIds");
            expect(JSON.stringify(result)).not.toContain("Fixture target");
            expect(JSON.stringify(result)).not.toContain(person.id);
            if (!granted) expect(answer).toMatchObject({ reason: "Einschalten kann nur, wer dieses Ziel verwaltet" });
            expect(read.calls).toBe(0);
          }
        }
  } finally {
    set.mockRestore();
    proof.mockRestore();
    managers.mockRestore();
    active.mockRestore();
  }
});

test("Core notification manager lookup rolls back adapter writes and checks the bound Code account", async () => {
  adapter.grant = async (_tx, value) => {
    writes++;
    expect(value).toMatchObject({ id: target.id, principal, grantId, dryRun: true });
    return { granted: true, level: "write", managerUserIds: [person.id] };
  };
  expect(await accessService.readCodeAccessManagers("inventory", bindings(), claims, deps.db)).toEqual([person.id]);
  expect(writes).toBe(0);
  activeCode = false;
  expect(await accessService.readCodeAccessManagers("inventory", bindings(), claims, deps.db)).toBeNull();
  expect(writes).toBe(0);
});

test("notification audience endpoint requires its own target-bound Core authority", async () => {
  const verify = spyOn(accessProof, "verifyCodeAccessNotifications").mockResolvedValue(null);
  const managers = spyOn(accessService, "readCodeAccessManagers").mockResolvedValue([person.id]);
  try {
    const router = createCodeAccessAuthorityRoutes("inventory", {
      protocolVersion: 2,
      types: { item: { title: "Item", description: "Item.", access: adapter } },
    });
    const request = () =>
      router.request("/queries/code.access.notifications", { method: "POST", headers: { authorization: "Bearer fixture" } });
    expect((await request()).status).toBe(403);
    expect(managers).not.toHaveBeenCalled();
    verify.mockResolvedValue({ ...claims, operations: [], token_use: "code_access_notifications" });
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { managerUserIds: [person.id] } });
    verify.mockResolvedValue({ ...claims, token_use: "code_access_notifications" });
    expect((await request()).status).toBe(403); // Operations must exist in this application.
    managers.mockResolvedValue(null);
    verify.mockResolvedValue({ ...claims, operations: [], token_use: "code_access_notifications" });
    expect((await request()).status).toBe(422);
  } finally {
    verify.mockRestore();
    managers.mockRestore();
  }
});

test("presentation failures fall back without failing grants, and actual successful sets skip presentation", async () => {
  const set = spyOn(accessService, "setCodeAccess").mockResolvedValue({
    granted: true,
    grantId,
    level: "write",
    managerUserIds: [person.id],
  });
  const active = spyOn(resourcePrincipals, "activeResourcePrincipals").mockRejectedValue(new Error("Reader unavailable"));
  try {
    const generated = generatedCodeAccess("inventory", {
      protocolVersion: 2,
      types: {
        item: {
          title: "Item",
          description: "Item.",
          reader: "item.read",
          access: {
            ...adapter,
            readable: () => {
              throw new Error("Unavailable");
            },
          },
        },
      },
    });
    for (const dryRun of [false, true]) {
      const result = await generated.actions["code.access.set"]!.run({ ...input, dryRun }, context);
      expect(result).toMatchObject({ ok: true, data: { data: { granted: true, readable: false } } });
      expect(JSON.stringify(result)).not.toContain("managerUserIds");
    }
    expect(active).toHaveBeenCalledTimes(1); // Actual successful set never starts a reader check.
    active.mockImplementation(async (values) => values);
    const result = await generated.actions["code.access.set"]!.run({ ...input, dryRun: true }, context);
    expect(result).toMatchObject({ ok: true, data: { data: { granted: true, readable: false } } });
  } finally {
    set.mockRestore();
    active.mockRestore();
  }
});
test("a readable canonical reader may return the target title on its structured reference", async () => {
  const set = spyOn(accessService, "setCodeAccess").mockResolvedValue({
    granted: true,
    grantId,
    level: "write",
    managerUserIds: [person.id],
  });
  const active = spyOn(resourcePrincipals, "activeResourcePrincipals").mockImplementation(async (values) => values);
  try {
    const generated = generatedCodeAccess("inventory", {
      protocolVersion: 2,
      types: {
        item: {
          title: "Item",
          description: "Item.",
          reader: "item.read",
          access: { ...adapter, readable: ({ principals }) => principals },
        },
      },
      queries: {
        "item.read": {
          title: "Read item",
          description: "Item.",
          openWorld: false,
          // Lifecycle checks need the server-side title; disclosure is what this test checks.
          codeResourceTitle: () => "Fixture target",
          input: z.object({ id: z.string() }),
          data: z.object({ name: z.string() }),
          run: () => ({
            ok: true,
            data: {
              data: { name: "Readable item" },
              refs: [
                { type: "inventory.other", id: target.id, title: "Other ref" },
                { ...target, title: "Readable item" },
              ],
            },
          }),
        },
      },
    });
    const result = await generated.actions["code.access.set"]!.run({ ...input, dryRun: true }, context);
    expect(result).toMatchObject({ ok: true, data: { data: { readable: true, title: "Readable item", managerUserIds: [person.id] } } });
    expect(JSON.stringify(result)).not.toContain("Other ref");
  } finally {
    set.mockRestore();
    active.mockRestore();
  }
});
