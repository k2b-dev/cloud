import { describe, expect, test } from "bun:test";
import { capabilityGrantAllows, type MandatePolicyV1 } from "./policy";
import {
  legacyTargetOperation,
  legacyTargetOperations,
  migratedCapabilityToolArgs,
  migrateLegacyCapabilityCall,
  migrateLegacyRoutinePolicy,
} from "./target-migration";

const policy = (fixedInput: Record<string, string>, capabilityId = "task.create"): MandatePolicyV1 => ({
  version: 1,
  apps: ["spaces"],
  operations: [`capability.action.run:${capabilityId}`],
  actions: "preapproved",
  grants: [{ appId: "spaces", capabilityId, kind: "action", fixedInput }],
});

describe("legacy target migration", () => {
  test("an unavailable mandate needs confirmation without inventing a capability", () => {
    expect(migrateLegacyRoutinePolicy(null)).toEqual({ ok: false, capability: null });
    const { grants: _grants, ...operationOnly } = policy({});
    expect(migrateLegacyRoutinePolicy(operationOnly)).toEqual({ ok: false, capability: null });
  });

  test("a fixed Space grant moves the coordinate and retains every other restriction", () => {
    const original = policy({ spaceId: "SpaceA", columnId: "ColumnA", title: "Fictional task" });
    const before = JSON.stringify(original);
    const migrated = migrateLegacyRoutinePolicy(original);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) throw new Error("Expected upgrade");
    expect(JSON.stringify(original)).toBe(before);
    const grant = migrated.policy.grants![0]!;
    if (!("appId" in grant)) throw new Error("Expected capability grant");
    expect(grant).toEqual({
      appId: "spaces",
      capabilityId: "task.create",
      kind: "action",
      target: { type: "spaces.space", id: "SpaceA" },
      refs: {},
      fixedInput: { columnId: "ColumnA", title: "Fictional task" },
    });
    for (const [target, title, allowed] of [
      ["SpaceA", "Fictional task", true],
      ["SpaceB", "Fictional task", false],
      ["SpaceA", "Other", false],
    ] as const) {
      const input = { columnId: "ColumnA", title };
      expect(
        capabilityGrantAllows(grant, {
          appId: "spaces",
          capabilityId: "task.create",
          kind: "action",
          input,
          call: { capability: "spaces.task.create", target: { type: "spaces.space", id: target }, refs: {}, input },
        }),
      ).toBe(allowed);
    }
    expect(migrateLegacyRoutinePolicy(migrated.policy)).toEqual({ ok: true, policy: migrated.policy, changed: false });
  });

  test.each([
    {},
    { spaceId: null },
    { spaceId: ["SpaceA", "SpaceB"] },
    { spaceId: "${space}" },
    { spaceId: "*" },
    { spaceId: "SpaceA", removedRestriction: "keep-me" },
    { itemId: "TaskA" },
  ])("unmappable target fails closed: %j", (fixedInput) => {
    const value = { ...policy({}), grants: [{ appId: "spaces", capabilityId: "task.create", kind: "action", fixedInput }] };
    const before = JSON.stringify(value);
    expect(migrateLegacyRoutinePolicy(value)).toEqual({ ok: false, capability: "spaces.task.create" });
    expect(JSON.stringify(value)).toBe(before);
  });

  test("unknown capabilities and conflicting old/new coordinates require confirmation", () => {
    expect(migrateLegacyRoutinePolicy(policy({ spaceId: "SpaceA" }, "unknown"))).toEqual({ ok: false, capability: "spaces.unknown" });
    const value = policy({ spaceId: "SpaceA" });
    value.grants![0] = {
      appId: "spaces",
      capabilityId: "task.create",
      kind: "action",
      target: { type: "spaces.space", id: "SpaceB" },
      fixedInput: { spaceId: "SpaceA" },
    };
    expect(migrateLegacyRoutinePolicy(value).ok).toBe(false);
  });

  test("all frozen target operations move their literal coordinates, including destination refs", () => {
    for (const operation of legacyTargetOperations.filter((operation) => operation.target)) {
      const args = {
        [operation.legacyTarget!]: "ContainerA",
        ...Object.fromEntries(Object.values(operation.refs ?? {}).map((ref) => [ref.field, "ContainerB"])),
      };
      const call = migrateLegacyCapabilityCall(operation, args);
      expect(call.target?.type).toBe(`${operation.appId}.${operation.target}`);
      expect(call.input).toEqual({});
      expect(Object.keys(call.refs)).toEqual(Object.keys(operation.refs ?? {}));
      expect(migratedCapabilityToolArgs(call)).toEqual({
        [operation.target!]: call.target!.id,
        ...Object.fromEntries(Object.entries(call.refs).map(([field, ref]) => [field, ref.id])),
      });
    }
  });

  test("known app-wide approval calls adopt the normalized digest shape too", () => {
    const operation = legacyTargetOperations.find((entry) => entry.kind === "action" && !entry.target && !entry.refs)!;
    const call = migrateLegacyCapabilityCall(operation, { fictionalInput: "unchanged" });
    expect(call).toEqual({
      capability: `${operation.appId}.${operation.capabilityId}`,
      target: null,
      refs: {},
      input: { fictionalInput: "unchanged" },
    });
    expect(migratedCapabilityToolArgs(call)).toEqual({ fictionalInput: "unchanged" });
  });

  test("Chat conversation Actions retain their existing conversation field", () => {
    for (const capability of ["chat.notifications.set", "chat.thread.follow"]) {
      const call = migrateLegacyCapabilityCall(legacyTargetOperation(capability)!, { conversation: "ConversationA", following: true });
      expect(call.target).toEqual({ type: "chat.conversation", id: "ConversationA" });
      expect(call.input).toEqual({ following: true });
    }
  });

  test("Files root conversion preserves both base identities without consulting live state", () => {
    const operation = legacyTargetOperation("filesv2.entry.copy")!;
    const call = migrateLegacyCapabilityCall(operation, {
      baseId: "cloud:users:fictional-a",
      targetBaseId: "cloud:groups:fictional-b",
      path: "a.txt",
      folder: "reports",
    });
    expect(Buffer.from(call.target!.id, "base64url").toString()).toBe("cloud:users:fictional-a\n");
    expect(Buffer.from(call.refs.targetRootId!.id, "base64url").toString()).toBe("cloud:groups:fictional-b\n");
    expect(call.input).toEqual({ path: "a.txt", folder: "reports" });
  });

  test("unchanged built-in discovery capabilities retain their exact grants", () => {
    for (const [appId, capabilityId, kind] of [
      ["assistant", "app.search", "query"],
      ["assistant", "chat.search", "query"],
      ["assistant", "project.search", "query"],
      ["accounts", "search", "query"],
      ["capabilities", "search", "query"],
      ["gateway-ops", "app-status.summary", "query"],
      ["gateway-ops", "app-status.detail", "query"],
      ["gateway-ops", "app-status.forget", "action"],
    ] as const) {
      const value: MandatePolicyV1 = {
        version: 1,
        apps: [appId],
        operations: [kind === "query" ? `capability.query:${capabilityId}` : `capability.action.run:${capabilityId}`],
        actions: "preapproved",
        grants: [{ appId, capabilityId, kind, fixedInput: { q: "fictional" } }],
      };
      expect(migrateLegacyRoutinePolicy(value)).toEqual({ ok: true, policy: value, changed: false });
    }
  });

  test("HTTP, database, and known app-wide grants retain their exact authority", () => {
    const value: MandatePolicyV1 = {
      version: 1,
      apps: ["assistant", "weather"],
      operations: ["runtime.http", "runtime.database", "capability.query:forecast.get"],
      actions: "preapproved",
      grants: [
        { kind: "http", fixedInput: { origin: "https://example.test", method: "GET" } },
        { kind: "database", fixedInput: { resourceId: "FictionalApp", operation: "rows.list", table: "reports" } },
      ],
    };
    const result = migrateLegacyRoutinePolicy(value);
    expect(result.ok && result.policy.grants).toEqual(value.grants);
    expect(result.ok && result.changed).toBe(false);
  });

  test("the upgrade snapshot matches every converted operation in the published frozen manifests", async () => {
    for (const appId of ["spaces", "contacts", "mail", "grids", "notebooks", "pulse", "venue", "weather"]) {
      const frozen = await Bun.file(new URL(`../../../../../tests/fixtures/capabilities/v2/${appId}.json`, import.meta.url)).json();
      for (const kind of ["queries", "actions"] as const)
        for (const operation of frozen[kind]) {
          if (!operation.target && !operation.refs) continue;
          const saved = legacyTargetOperation(`${appId}.${operation.localId}`, kind === "queries" ? "query" : "action");
          expect(saved?.target).toBe(operation.target);
          expect(Object.fromEntries(Object.entries(saved?.refs ?? {}).map(([key, ref]) => [key, ref.type]))).toEqual(operation.refs ?? {});
        }
    }
  });
});
