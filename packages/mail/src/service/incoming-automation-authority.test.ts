import { describe, expect, test } from "bun:test";
import { mandatePolicyAllows } from "@k2b/cloud/services/mandates";
import type { MailAutomationStep } from "../contracts";
import { incomingAutomationMandatePolicy, migrateIncomingAutomationPolicy } from "./incoming-automation-authority";

describe("incoming automation authority", () => {
  test("creates a minimal deterministic policy for nested Spaces effects", () => {
    const steps: MailAutomationStep[] = [
      {
        id: crypto.randomUUID(),
        kind: "if",
        condition: { sourceStepId: crypto.randomUUID(), operator: "equals", value: "yes" },
        then: [{ id: crypto.randomUUID(), kind: "link_space_item", spaceId: "Space1", itemId: "Item01" }],
        else: [
          {
            id: crypto.randomUUID(),
            kind: "create_space_event",
            spaceId: "Space1",
            columnId: "Column",
            event: { kind: "step_output", sourceStepId: crypto.randomUUID() },
          },
        ],
      },
    ];

    expect(incomingAutomationMandatePolicy(steps)).toEqual({
      version: 1,
      apps: ["spaces"],
      operations: ["capability.action.run:event.create", "capability.action.run:item.reference.add"],
      actions: "preapproved",
      grants: [
        {
          appId: "spaces",
          capabilityId: "item.reference.add",
          kind: "action",
          target: { type: "spaces.space", id: "Space1" },
          refs: {},
          fixedInput: { itemId: "Item01" },
        },
        {
          appId: "spaces",
          capabilityId: "event.create",
          kind: "action",
          target: { type: "spaces.space", id: "Space1" },
          refs: {},
          fixedInput: { columnId: "Column" },
        },
      ],
    });
  });

  test("does not create authority for Mail-only effects", () => {
    expect(incomingAutomationMandatePolicy([{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }])).toBeNull();
  });
});

test("old item-only definitions require confirmation, never an inferred Space", () => {
  const steps: MailAutomationStep[] = [{ id: "00000000-0000-4000-8000-000000000001", kind: "link_space_item", itemId: "Item01" }];
  const old = { version: 1, apps: ["spaces"], operations: ["capability.action.run:item.reference.add"], actions: "preapproved" };
  expect(migrateIncomingAutomationPolicy(old, steps)).toBeNull();
  expect(() => incomingAutomationMandatePolicy(steps)).toThrow();
});

test("migration retains old restrictions and refuses a changed configured target", () => {
  const steps: MailAutomationStep[] = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "create_space_event",
      spaceId: "Space1",
      columnId: "Column",
      event: { kind: "step_output", sourceStepId: "00000000-0000-4000-8000-000000000002" },
    },
  ];
  const old = {
    version: 1,
    apps: ["spaces"],
    operations: ["capability.action.run:event.create"],
    actions: "preapproved",
    grants: [
      {
        appId: "spaces",
        capabilityId: "event.create",
        kind: "action",
        fixedInput: { spaceId: "Space1", columnId: "Column", title: "Fictional title" },
      },
    ],
  };
  const migrated = migrateIncomingAutomationPolicy(old, steps);
  expect(migrated?.grants?.[0]?.fixedInput).toEqual({ columnId: "Column", title: "Fictional title" });
  expect(migrateIncomingAutomationPolicy(migrated, steps)).toEqual(migrated);
  const event = steps[0]!;
  if (event.kind !== "create_space_event") throw new Error("Expected event step");
  expect(migrateIncomingAutomationPolicy(old, [{ ...event, spaceId: "Space2" }])).toBeNull();
  expect(old.grants[0]?.fixedInput.spaceId).toBe("Space1");
});

test("keeps each operation, Space, and configured column paired", () => {
  const step = {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "create_space_event" as const,
    spaceId: "Space1",
    columnId: "Column",
    event: { kind: "step_output" as const, sourceStepId: "00000000-0000-4000-8000-000000000002" },
  };
  const policy = incomingAutomationMandatePolicy([
    step,
    { ...step, id: "00000000-0000-4000-8000-000000000003", spaceId: "Space2", columnId: "OtherC" },
  ])!;
  for (const [spaceId, columnId, allowed] of [
    ["Space1", "Column", true],
    ["Space2", "OtherC", true],
    ["Space1", "OtherC", false],
    ["Space2", "Column", false],
    ["Other1", "Column", false],
  ] as const) {
    const input = { columnId, title: "Fictional title" };
    expect(
      mandatePolicyAllows(policy, {
        appId: "spaces",
        operation: "capability.action.run:event.create",
        actionApproval: "none",
        input,
        call: { capability: "spaces.event.create", target: { type: "spaces.space", id: spaceId }, refs: {}, input },
        capabilityApproval: "rememberable",
      }),
    ).toBe(allowed);
  }
});
