import { describe, expect, test } from "bun:test";
import { isMandatePolicyNarrowing, mandatePolicyAllows, parseMandatePolicy } from "./policy";

describe("mandate policy", () => {
  test("normalizes bounded allowlists and rejects unknown fields", () => {
    expect(
      parseMandatePolicy({
        version: 1,
        apps: ["spaces", "mail", "spaces"],
        operations: ["capability.query:item.read", "search.query", "search.query"],
        actions: "deny",
      }),
    ).toEqual({
      version: 1,
      apps: ["mail", "spaces"],
      operations: ["capability.query:item.read", "search.query"],
      actions: "deny",
    });
    expect(() => parseMandatePolicy({ version: 1, apps: [], operations: [], actions: "deny", extra: true })).toThrow();
    expect(() =>
      parseMandatePolicy({ version: 1, apps: Array.from({ length: 101 }, (_, index) => `app-${index}`), operations: [], actions: "deny" }),
    ).toThrow();
  });

  test("keeps wildcard and preapproved authority mutually exclusive", () => {
    expect(() => parseMandatePolicy({ version: 1, apps: "*", operations: "*", actions: "preapproved" })).toThrow();
    expect(() => parseMandatePolicy({ version: 1, apps: [], operations: [], actions: "preapproved" })).toThrow();
    expect(parseMandatePolicy({ version: 1, apps: "*", operations: "*", actions: "require_approval" })).toEqual({
      version: 1,
      apps: "*",
      operations: "*",
      actions: "require_approval",
    });
  });

  test("classifies narrowing across targets, operations, and action approval", () => {
    const broad = parseMandatePolicy({ version: 1, apps: "*", operations: "*", actions: "require_approval" });
    const exact = parseMandatePolicy({
      version: 1,
      apps: ["spaces"],
      operations: ["capability.action.run:event.create-once"],
      actions: "require_approval",
    });
    const denied = { ...exact, actions: "deny" as const };
    const preapproved = { ...exact, actions: "preapproved" as const };
    expect(isMandatePolicyNarrowing(broad, exact)).toBe(true);
    expect(isMandatePolicyNarrowing(exact, broad)).toBe(false);
    expect(isMandatePolicyNarrowing(exact, denied)).toBe(true);
    expect(isMandatePolicyNarrowing(exact, preapproved)).toBe(false);
  });

  test("requires approval only for action execution", () => {
    const policy = parseMandatePolicy({
      version: 1,
      apps: ["spaces"],
      operations: ["capability.action.review:event.create", "capability.action.run:event.create"],
      actions: "require_approval",
    });
    expect(
      mandatePolicyAllows(policy, {
        appId: "spaces",
        operation: "capability.action.review:event.create",
        actionApproval: "none",
      }),
    ).toBe(true);
    expect(mandatePolicyAllows(policy, { appId: "spaces", operation: "capability.action.run:event.create", actionApproval: "none" })).toBe(
      false,
    );
    expect(
      mandatePolicyAllows(policy, { appId: "spaces", operation: "capability.action.run:event.create", actionApproval: "approved" }),
    ).toBe(true);
  });
});
