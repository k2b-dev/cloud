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
        grants: policy.grants!.map((grant) =>
          "appId" in grant ? { ...grant, fixedInput: { ...grant.fixedInput, extra: "fixed" } } : grant,
        ),
      }),
    ).toBe(true);
  });
});

describe("one grant model for scheduled HTTP and database access", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["assistant"],
    operations: ["runtime.http", "runtime.database"],
    actions: "preapproved",
    grants: [
      { kind: "http", fixedInput: { origin: "https://api.example.com", method: "GET" } },
      { kind: "database", fixedInput: { resourceId: "aBc234", operation: "rows.insert", table: "invoices" } },
    ],
  });
  const allows = (operation: string, input: unknown) =>
    mandatePolicyAllows(policy, { appId: "assistant", operation, actionApproval: "none", input });
  test("checks every fixed HTTP field and never borrows a database grant", () => {
    expect(allows("runtime.http", { origin: "https://api.example.com", method: "GET", url: "https://api.example.com/invoices" })).toBe(
      true,
    );
    for (const input of [
      { origin: "https://api.example.com.evil.test", method: "GET" },
      { origin: "https://api.example.com", method: "POST" },
      { method: "GET" },
      null,
    ])
      expect(allows("runtime.http", input)).toBe(false);
    expect(allows("capability.query:read", {})).toBe(false);
  });
  test("checks database resource, operation and table independently", () => {
    expect(allows("runtime.database", { resourceId: "aBc234", operation: "rows.insert", table: "invoices" })).toBe(true);
    for (const input of [
      { resourceId: "other", operation: "rows.insert", table: "invoices" },
      { resourceId: "aBc234", operation: "rows.delete", table: "invoices" },
      { resourceId: "aBc234", operation: "rows.insert", table: "other" },
      { resourceId: "aBc234", operation: "query" },
    ])
      expect(allows("runtime.database", input)).toBe(false);
  });
  test("removing restrictions is an expansion, while adding them narrows authority", () => {
    expect(isMandatePolicyNarrowing({ ...policy, grants: undefined }, policy)).toBe(false);
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ kind: "http", fixedInput: {} }] })).toBe(false);
    expect(
      isMandatePolicyNarrowing(policy, {
        ...policy,
        grants: [{ kind: "http", fixedInput: { origin: "https://api.example.com", method: "GET", url: "https://api.example.com/one" } }],
      }),
    ).toBe(true);
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ kind: "database", fixedInput: { resourceId: "aBc234" } }] })).toBe(
      false,
    );
    expect(
      mandatePolicyAllows(
        { ...policy, grants: [] },
        { appId: "assistant", operation: "runtime.http", actionApproval: "approved", input: {} },
      ),
    ).toBe(false);
  });
});
