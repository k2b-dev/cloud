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

describe("bounded background capability grants", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["notebooks", "mail"],
    operations: ["capability.action.run:note.edit", "capability.query:message.read"],
    actions: "preapproved",
    grants: [
      { appId: "notebooks", kind: "action", capabilityId: "note.edit", fixedInput: { noteId: "abc123", options: { a: 1, b: [2, 3] } } },
      { appId: "mail", kind: "query", capabilityId: "message.read", fixedInput: {} },
    ],
  });
  const call = {
    appId: "notebooks",
    operation: "capability.action.run:note.edit",
    actionApproval: "none" as const,
    capabilityApproval: "rememberable" as const,
    input: { noteId: "abc123", options: { b: [2, 3], a: 1 }, content: "new" },
  };
  test("enforces exact JSON values while leaving unspecified inputs free", () => {
    expect(mandatePolicyAllows(policy, call)).toBe(true);
    expect(mandatePolicyAllows(policy, { ...call, input: { ...call.input, noteId: "other" } })).toBe(false);
    expect(mandatePolicyAllows(policy, { ...call, input: { noteId: "abc123" } })).toBe(false);
    expect(mandatePolicyAllows(policy, { ...call, input: { ...call.input, options: { a: 1, b: [3, 2] } } })).toBe(false);
  });
  test("never crosses grant app/operation pairs or bypasses always approval", () => {
    expect(mandatePolicyAllows(policy, { ...call, appId: "mail" })).toBe(false);
    expect(mandatePolicyAllows(policy, { ...call, capabilityApproval: "always", actionApproval: "approved" })).toBe(false);
    expect(mandatePolicyAllows(policy, { ...call, capabilityApproval: undefined })).toBe(false);
  });
  test("allows unrestricted inputs only for an exact unbounded grant", () => {
    expect(
      mandatePolicyAllows(policy, {
        appId: "mail",
        operation: "capability.query:message.read",
        actionApproval: "none",
        input: { messageId: "any" },
      }),
    ).toBe(true);
  });
  test("workload narrowing cannot remove or weaken fixed inputs", () => {
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: policy.grants!.map((grant) => ({ ...grant, fixedInput: {} })) })).toBe(
      false,
    );
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: undefined })).toBe(false);
    expect(
      isMandatePolicyNarrowing(policy, {
        ...policy,
        grants: policy.grants!.map((grant) => ({ ...grant, fixedInput: { ...grant.fixedInput, extra: "fixed" } })),
      }),
    ).toBe(true);
  });
});
