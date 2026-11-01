import { describe, expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { spacesCapabilities } from "../capabilities";
import { SpaceSettingsContextSchema } from "../settings-context";
import { SPACES_CODE_OPERATION_LEVELS, spaceCodeAccessDecision } from "./code-access";

describe("Spaces Code access contract", () => {
  test("declares Spaces as targets only and generates the Core access operations", () => {
    const manifest = compileCapabilityManifest("spaces", spacesCapabilities);
    expect(manifest.code).toEqual({ access: { app: false, types: ["space"] }, owners: [] });
    expect(
      manifest.actions
        .filter((action) => action.localId.startsWith("code.access."))
        .map((action) => action.localId)
        .sort(),
    ).toEqual(["code.access.rm", "code.access.set"]);
    expect(manifest.queries.some((query) => query.localId === "code.access.list")).toBe(true);
  });

  test("requires a deliberate Spaces level for every declared Query and Action", () => {
    expect(Object.keys(SPACES_CODE_OPERATION_LEVELS).sort()).toEqual(
      [...Object.keys(spacesCapabilities.queries), ...Object.keys(spacesCapabilities.actions)].sort(),
    );
  });

  test("refuses every Action excluded from resource-owned Code", () => {
    for (const action of compileCapabilityManifest("spaces", spacesCapabilities).actions) {
      if (action.code === false) expect(spaceCodeAccessDecision([`spaces.${action.localId}`], false).granted).toBe(false);
    }
  });

  test("chooses the smallest sufficient level, including write-only discovery", () => {
    expect(spaceCodeAccessDecision(["spaces.space.read", "spaces.item.read", "spaces.space.search"], false)).toEqual({
      granted: true,
      level: "read",
    });
    expect(spaceCodeAccessDecision(["spaces.space.read", "spaces.task.create"], false)).toEqual({ granted: true, level: "write" });
    expect(spaceCodeAccessDecision(["spaces.space.assignee.list"], false)).toEqual({ granted: true, level: "write" });
  });

  test("refuses the whole request if any operation lacks a non-manager level", () => {
    for (const operation of [
      "spaces.template.create",
      "spaces.template.update",
      "spaces.template.delete",
      "spaces.event.invitation.prepare",
      "spaces.event.invitation.commit",
      "spaces.calendar-invitation.response.commit",
      "spaces.comment.update",
      "spaces.comment.delete",
      "spaces.code.access.set",
      "spaces.future.action",
      "mail.draft.create",
      "spaces.toString",
      "spaces.constructor",
      "spaces.__proto__",
    ]) {
      const decision = spaceCodeAccessDecision(["spaces.task.create", operation], false);
      expect(decision.granted).toBe(false);
      if (!decision.granted) expect(decision.reason).toContain(operation);
    }
  });

  test("allows empty operations only for a dry run", () => {
    expect(spaceCodeAccessDecision([], true)).toEqual({ granted: true, level: "read" });
    expect(spaceCodeAccessDecision([], false).granted).toBe(false);
  });
});

test("settings share lists preserve the Code grant identity", () => {
  const grantId = "11111111-1111-4111-8111-111111111111";
  const entry = {
    id: grantId,
    principal: { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" },
    permission: "write",
    createdAt: "2026-11-01T00:00:00.000Z",
    serviceAccountKind: "code",
    grantId,
  };
  expect(SpaceSettingsContextSchema.shape.accessEntries.parse([entry])[0]?.grantId).toBe(grantId);
  const { grantId: _grantId, ...withoutGrant } = entry;
  const ordinary = { ...withoutGrant, serviceAccountKind: "standalone" };
  expect(SpaceSettingsContextSchema.shape.accessEntries.parse([ordinary])[0]).not.toHaveProperty("grantId");
});
