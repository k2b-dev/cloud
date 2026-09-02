import { describe, expect, test } from "bun:test";
import type { MailAutomationStep } from "../contracts";
import { incomingAutomationAuthorityMode, incomingAutomationMandatePolicy } from "./incoming-automation-authority";

describe("incoming automation authority", () => {
  test("keeps legacy issuance as the explicit rollout default", () => {
    expect(incomingAutomationAuthorityMode(undefined)).toBe("legacy");
    expect(incomingAutomationAuthorityMode("mandate")).toBe("mandate");
    expect(() => incomingAutomationAuthorityMode("mixed")).toThrow("CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE must be legacy or mandate");
  });

  test("creates a minimal deterministic policy for nested Spaces effects", () => {
    const steps: MailAutomationStep[] = [
      {
        id: crypto.randomUUID(),
        kind: "if",
        condition: { sourceStepId: crypto.randomUUID(), operator: "equals", value: "yes" },
        then: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
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
      operations: ["capability.action.run:event.create-once", "capability.action.run:item.reference.add"],
      actions: "preapproved",
    });
  });

  test("does not create authority for Mail-only effects", () => {
    expect(incomingAutomationMandatePolicy([{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }])).toBeNull();
  });
});
