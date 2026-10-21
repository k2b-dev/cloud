import { expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { adminFixtureIdentity } from "../store/admin-identity.test-fixture";
import { baseStore } from "../store/base-store";
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

const databaseName = (n: number) => `pulse_${n.toString(16).padStart(32, "0")}`;
test("orphan deletion resolves store settings before reserving its transaction", async () => {
  const steps: string[] = [];
  const store = {
    ...baseStore,
    prepare: async () => {
      steps.push("prepare");
      return async () => [];
    },
  };
  const boundary = spyOn(sql, "begin").mockImplementation(async () => {
    steps.push("begin");
    throw new Error("Fixture transaction boundary");
  });
  try {
    await expect(deleteOrphan(adminFixtureIdentity(), databaseName(1), store)).rejects.toThrow("Fixture transaction boundary");
    expect(steps).toEqual(["prepare", "begin"]);
  } finally {
    boundary.mockRestore();
  }
});

const orphanFixture = (total: number, reserved: (name: string) => boolean) => {
  const names = Array.from({ length: total }, (_, index) => databaseName(index + 1));
  const cursors: string[] = [];
  const lookups: string[][] = [];
  const store = {
    ...baseStore,
    query: async (query: string, params?: Record<string, string | number>) => {
      expect(query).toContain("match(name,{pattern:String}) AND name > {after:String} ORDER BY name LIMIT 500");
      expect(params?.pattern).toBe("^pulse_[0-9a-f]{32}$");
      const after = String(params?.after ?? "");
      cursors.push(after);
      return names
        .filter((name) => name > after)
        .slice(0, 500)
        .map((name) => ({ name }));
    },
  };
  const findReserved = async (candidates: string[]) => {
    expect(candidates.length).toBeLessThanOrEqual(500);
    lookups.push(candidates);
    return candidates.filter(reserved);
  };
  const list = (params: { limit?: number; after?: string } = {}) => listOrphans(adminFixtureIdentity(), params, store, findReserved);
  return { list, cursors, lookups };
};

test("orphan discovery passes reserved batches and resumes from the last scanned name without skipping candidates", async () => {
  const fixture = orphanFixture(1003, (name) => name <= databaseName(1000));
  expect(await fixture.list({ limit: 2 })).toEqual({
    items: [{ database: databaseName(1001) }, { database: databaseName(1002) }],
    nextCursor: databaseName(1002),
  });
  expect(fixture.cursors).toEqual(["", databaseName(500), databaseName(1000)]);
  expect(await fixture.list({ limit: 2, after: databaseName(1002) })).toEqual({
    items: [{ database: databaseName(1003) }],
    nextCursor: null,
  });
});

test("an orphan page exactly at the batch boundary returns a cursor even when the next batch is empty", async () => {
  const fixture = orphanFixture(500, (name) => name !== databaseName(500));
  expect(await fixture.list({ limit: 1 })).toEqual({ items: [{ database: databaseName(500) }], nextCursor: databaseName(500) });
  expect(await fixture.list({ after: databaseName(500) })).toEqual({ items: [], nextCursor: null });
});

test("orphan scanning stops after four reserved batches and the cursor reaches later databases", async () => {
  const fixture = orphanFixture(2001, (name) => name <= databaseName(2000));
  expect(await fixture.list()).toEqual({ items: [], nextCursor: databaseName(2000) });
  expect(fixture.cursors).toHaveLength(4);
  expect(fixture.lookups).toHaveLength(4);
  expect(await fixture.list({ after: databaseName(2000) })).toEqual({ items: [{ database: databaseName(2001) }], nextCursor: null });
});

test("orphan cursors and limits are validated before querying", async () => {
  const fixture = orphanFixture(1, () => false);
  for (const after of ["invalid", "pulse_" + "A".repeat(32), "other_" + "a".repeat(32)])
    await expect(fixture.list({ after })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const limit of [0, 101]) await expect(fixture.list({ limit })).rejects.toThrow();
  expect(fixture.cursors).toEqual([]);
  expect(await fixture.list({ after: "" })).toEqual({ items: [{ database: databaseName(1) }], nextCursor: null });
});
