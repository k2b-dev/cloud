import { expect, test } from "bun:test";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import {
  addInternalTarget,
  adminBaseAction,
  deleteOrphan,
  listAdminBases,
  listInternalTargets,
  listOrphans,
  normalizeInternalTarget,
  removeInternalTarget,
  updateBaseLimits,
} from "./base-admin";
import { getPolicy, setPolicy } from "./base-policy";

test("delegating a Cloud admin to a service account does not authorize store administration", async () => {
  const identity = adminFixtureIdentity();
  if (identity.actor.kind !== "user") throw new Error("Expected person fixture");
  await expect(
    getPolicy({
      ...identity,
      actor: {
        kind: "service_account",
        scopes: ["admin"],
        delegatedUser: identity.actor.user,
        serviceAccount: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Delegated fixture",
          kind: "agent",
          status: "active",
          delegatedUserId: identity.actor.user.id,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdBy: null,
          createdAt: "2026-10-17T12:00:00.000Z",
        },
      },
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED", status: 403 });
});

test("every administration service denies non-admins before reading data or validating targets", async () => {
  const person = adminFixtureIdentity(undefined, false),
    agent = { ...person, accessSubject: { type: "service_account" as const, serviceAccountId: "11111111-1111-4111-8111-111111111111" } };
  for (const identity of [person, agent])
    for (const run of [
      () => getPolicy(identity),
      () => setPolicy(identity, {}),
      () => listAdminBases(identity),
      () => updateBaseLimits(identity, "Base01", {}),
      () => adminBaseAction(identity, "Base01", "retry"),
      () => adminBaseAction(identity, "Base01", "recheck"),
      () => adminBaseAction(identity, "Base01", "recreate"),
      () => listOrphans(identity),
      () => deleteOrphan(identity, "invalid"),
      () => listInternalTargets(identity),
      () => addInternalTarget(identity, { baseId: "Base01", entry: "127.0.0.1" }),
      () => removeInternalTarget(identity, "invalid"),
    ])
      await expect(run()).rejects.toMatchObject({ code: "ACCESS_DENIED", status: 403 });
});
test("internal target normalization preserves scope and refuses broad or malformed targets", () => {
  expect(normalizeInternalTarget("WEB.local.")).toEqual({ entry: "web.local", scope: "host", port: null });
  expect(normalizeInternalTarget("WEB.local.:9100")).toEqual({ entry: "web.local:9100", scope: "host_port", port: 9100 });
  expect(normalizeInternalTarget("[FD00::1]:443")).toEqual({ entry: "[fd00::1]:443", scope: "host_port", port: 443 });
  expect(normalizeInternalTarget("10.0.0.0/8")).toEqual({ entry: "10.0.0.0/8", scope: "network", port: null });
  for (const entry of ["0.0.0.0/0", "::/0"]) expect(() => normalizeInternalTarget(entry)).toThrow("TARGET_TOO_BROAD");
  for (const entry of ["web:01", "web:65536", "10.0.0.0/8:80", "*.internal"])
    expect(() => normalizeInternalTarget(entry)).toThrow("INVALID_TARGET");
});
