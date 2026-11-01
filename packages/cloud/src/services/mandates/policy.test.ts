import { describe, expect, test } from "bun:test";
import type { CapabilityActionPolicy } from "../../contracts/capabilities";
import { isMandatePolicyNarrowing, mandatePolicyAllows, mandatePolicyCanPermitCapability, parseMandatePolicy } from "./policy";

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
    for (const capabilityPolicy of [undefined, { ask: "sends" }] as const) {
      expect(
        mandatePolicyAllows(policy, {
          appId: "spaces",
          operation: "capability.action.run:event.create",
          actionApproval: "approved",
          capabilityPolicy,
        }),
      ).toBe(true);
      expect(
        mandatePolicyCanPermitCapability(policy, { appId: "spaces", capabilityId: "event.create", kind: "action", capabilityPolicy }),
      ).toBe(false);
    }
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

describe("capability discovery under a mandate", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["spaces", "mail"],
    operations: ["capability.query:space.read", "capability.query:space.list", "capability.action.run:space.edit"],
    actions: "preapproved",
    grants: [
      { appId: "spaces", capabilityId: "space.read", kind: "query", fixedInput: { id: "fixed" } },
      { appId: "mail", capabilityId: "space.list", kind: "query", fixedInput: {} },
      { appId: "spaces", capabilityId: "space.edit", kind: "action", fixedInput: { id: "fixed" } },
    ],
  });
  const query = { appId: "spaces", capabilityId: "space.read", kind: "query" as const };
  const action = { appId: "spaces", capabilityId: "space.edit", kind: "action" as const, approval: "rememberable" as const };

  test("ignores fixed input for discovery but preserves exact grant pairs and kinds", () => {
    expect(mandatePolicyCanPermitCapability(policy, query)).toBe(true);
    expect(mandatePolicyCanPermitCapability(policy, { ...query, capabilityId: "space.list" })).toBe(false);
    expect(mandatePolicyCanPermitCapability(policy, { ...query, appId: "mail" })).toBe(false);
    expect(mandatePolicyCanPermitCapability(policy, { ...query, kind: "action" })).toBe(false);
    expect(mandatePolicyCanPermitCapability({ ...policy, grants: [] }, query)).toBe(false);
    expect(mandatePolicyCanPermitCapability({ ...policy, grants: [{ kind: "http", fixedInput: {} }] }, query)).toBe(false);
  });

  test("enforces app and operation ceilings even with matching grants", () => {
    expect(mandatePolicyCanPermitCapability({ ...policy, apps: ["mail"] }, query)).toBe(false);
    expect(mandatePolicyCanPermitCapability({ ...policy, operations: [] }, query)).toBe(false);
    expect(mandatePolicyCanPermitCapability({ ...policy, grants: undefined }, query)).toBe(true);
    expect(
      mandatePolicyCanPermitCapability(parseMandatePolicy({ version: 1, apps: "*", operations: "*", actions: "require_approval" }), query),
    ).toBe(true);
  });

  test("respects action denial and capability approval without requiring call inputs", () => {
    expect(mandatePolicyCanPermitCapability(policy, action)).toBe(true);
    expect(mandatePolicyCanPermitCapability({ ...policy, actions: "require_approval" }, action)).toBe(false);
    expect(mandatePolicyCanPermitCapability({ ...policy, actions: "deny" }, action)).toBe(false);
    expect(mandatePolicyCanPermitCapability(policy, { ...action, approval: "always" })).toBe(false);
    expect(mandatePolicyCanPermitCapability(policy, { ...action, approval: undefined })).toBe(false);
    expect(mandatePolicyCanPermitCapability(policy, { ...action, approval: "none" })).toBe(true);
  });
});

test("policy Actions allow only silent routine grants, independently of derived approval", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["demo"],
    operations: ["capability.action.run:edit", "capability.action.review:edit"],
    actions: "preapproved",
    grants: [{ appId: "demo", capabilityId: "edit", kind: "action", fixedInput: {} }],
  });
  for (const capabilityPolicy of [{ ask: "sends" }, { silent: "you", routines: false }, { silent: "you" }] as const) {
    const allowed = "silent" in capabilityPolicy && !("routines" in capabilityPolicy && capabilityPolicy.routines === false);
    for (const operation of ["capability.action.run:edit", "capability.action.review:edit"])
      expect(
        mandatePolicyAllows(policy, {
          appId: "demo",
          operation,
          actionApproval: "approved",
          capabilityApproval: "rememberable",
          capabilityPolicy,
        }),
      ).toBe(allowed);
    expect(mandatePolicyCanPermitCapability(policy, { appId: "demo", capabilityId: "edit", kind: "action", capabilityPolicy })).toBe(
      allowed,
    );
  }
});

describe("live capability policy across mandate shapes", () => {
  const capabilities: Array<{
    name: string;
    capabilityPolicy?: CapabilityActionPolicy;
    capabilityApproval?: "none" | "rememberable" | "always";
    unattended: boolean;
  }> = [
    { name: "silent personal", capabilityPolicy: { silent: "you" }, unattended: true },
    { name: "silent draft", capabilityPolicy: { silent: "draft" }, unattended: true },
    { name: "silent shared", capabilityPolicy: { silent: "shared" }, unattended: true },
    { name: "routines disabled", capabilityPolicy: { silent: "you", routines: false }, unattended: false },
    { name: "ask sends", capabilityPolicy: { ask: "sends" }, unattended: false },
    { name: "ask sensitive", capabilityPolicy: { ask: "sensitive" }, unattended: false },
    { name: "legacy none", capabilityApproval: "none", unattended: true },
    { name: "legacy rememberable", capabilityApproval: "rememberable", unattended: true },
    { name: "legacy always", capabilityApproval: "always", unattended: false },
    { name: "missing metadata", unattended: false },
  ];
  for (const hasGrants of [false, true]) {
    for (const actions of ["preapproved", "require_approval", "deny"] as const) {
      for (const capability of capabilities) {
        test(`${hasGrants ? "with" : "without"} grants / ${actions} / ${capability.name}`, () => {
          const policy = parseMandatePolicy({
            version: 1,
            apps: ["demo"],
            operations: ["capability.action.run:edit", "capability.action.review:edit"],
            actions,
            ...(hasGrants ? { grants: [{ appId: "demo", capabilityId: "edit", kind: "action", fixedInput: { id: "fixed" } }] } : {}),
          });
          const routineAllowed = (!hasGrants && actions !== "preapproved") || capability.unattended;
          for (const actionApproval of ["none", "approved"] as const) {
            const call = { appId: "demo", actionApproval, input: { id: "fixed" }, ...capability };
            expect(mandatePolicyAllows(policy, { ...call, operation: "capability.action.run:edit" })).toBe(
              routineAllowed && (actions === "preapproved" || (actions === "require_approval" && actionApproval === "approved")),
            );
            expect(mandatePolicyAllows(policy, { ...call, operation: "capability.action.review:edit" })).toBe(routineAllowed);
          }
          expect(
            mandatePolicyCanPermitCapability(policy, {
              appId: "demo",
              capabilityId: "edit",
              kind: "action",
              capabilityPolicy: capability.capabilityPolicy,
              approval: capability.capabilityApproval,
            }),
          ).toBe(actions === "preapproved" && capability.unattended);
          expect(
            mandatePolicyAllows(policy, {
              appId: "demo",
              operation: "capability.action.run:edit",
              actionApproval: "approved",
              input: { id: "other" },
              ...capability,
            }),
          ).toBe(!hasGrants && routineAllowed && actions !== "deny");
        });
      }
    }
  }
});

describe("operation and target grants", () => {
  const target = { type: "demo.folder", id: "a" };
  const refs = { destination: { type: "demo.folder", id: "b" } };
  const grant = { appId: "demo", capabilityId: "move", kind: "action" as const, target, refs, fixedInput: { id: "item" } };
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["demo"],
    operations: ["capability.action.run:move", "capability.action.review:move"],
    actions: "preapproved",
    grants: [grant],
  });
  const call = { capability: "demo.move", target, refs, input: { id: "item", title: "New" } };
  const check = {
    appId: "demo",
    operation: "capability.action.run:move",
    actionApproval: "none" as const,
    capabilityPolicy: { silent: "shared" } as const,
    input: call.input,
    call,
  };

  test("the complete pair is checked for both people and Code, before run and review", () => {
    for (const codeAccount of [false, true]) {
      for (const operation of policy.operations) {
        expect(mandatePolicyAllows(policy, { ...check, operation, codeAccount })).toBe(true);
        for (const changed of [
          { ...call, target: { ...target, id: "other" } },
          { ...call, target: { ...target, type: "other.folder" } },
          { ...call, refs: { destination: { ...refs.destination, id: "other" } } },
          { ...call, refs: {} },
          { ...call, refs: { ...refs, extra: target } },
          { ...call, capability: "demo.delete" },
        ])
          expect(mandatePolicyAllows(policy, { ...check, codeAccount, operation, call: changed })).toBe(false);
      }
    }
    expect(
      mandatePolicyCanPermitCapability(policy, {
        appId: "demo",
        capabilityId: "move",
        kind: "action",
        capabilityPolicy: { silent: "shared" },
      }),
    ).toBe(true);
    expect(
      mandatePolicyCanPermitCapability(policy, {
        appId: "demo",
        capabilityId: "other",
        kind: "action",
        capabilityPolicy: { silent: "shared" },
      }),
    ).toBe(false);
  });

  test("legacy and operation-only grants cannot authorize bound calls", () => {
    const legacy = { ...grant, target: undefined, refs: undefined };
    expect(mandatePolicyAllows({ ...policy, grants: [legacy] }, check)).toBe(false);
    expect(mandatePolicyAllows({ ...policy, grants: undefined }, check)).toBe(false);
    expect(mandatePolicyAllows(policy, { ...check, call: undefined })).toBe(false);
    expect(mandatePolicyAllows({ ...policy, grants: [legacy] }, { ...check, codeAccount: true, call: undefined })).toBe(false);
    expect(mandatePolicyAllows(policy, { ...check, input: { id: "other" } })).toBe(false);
  });

  test("app-wide Code Actions need an explicit null target and never inherit query grants", () => {
    const appCall = { ...call, target: null, refs: {} };
    const appGrant = { ...grant, target: null, refs: {} };
    expect(mandatePolicyAllows({ ...policy, grants: [appGrant] }, { ...check, codeAccount: true, call: appCall })).toBe(true);
    expect(
      mandatePolicyAllows({ ...policy, grants: [{ ...appGrant, target: undefined }] }, { ...check, codeAccount: true, call: appCall }),
    ).toBe(false);
    expect(mandatePolicyAllows({ ...policy, grants: undefined }, { ...check, codeAccount: true, codeVersion: true, call: appCall })).toBe(
      false,
    );
    expect(
      mandatePolicyAllows({ ...policy, grants: [{ ...appGrant, kind: "query" }] }, { ...check, codeAccount: true, call: appCall }),
    ).toBe(false);
  });

  test("Code queries check operations; person routines can additionally bind query targets", () => {
    const queryPolicy = parseMandatePolicy({
      version: 1,
      apps: ["demo"],
      operations: ["capability.query:read"],
      actions: "deny",
      grants: [{ appId: "demo", capabilityId: "read", kind: "query", fixedInput: {} }],
    });
    const queryCall = { capability: "demo.read", target, refs: {}, input: {} };
    const queryCheck = { appId: "demo", operation: "capability.query:read", actionApproval: "none" as const, call: queryCall };
    expect(mandatePolicyAllows(queryPolicy, { ...queryCheck, codeAccount: true })).toBe(true);
    expect(mandatePolicyAllows(queryPolicy, queryCheck)).toBe(false);
    const bound = { ...queryPolicy, grants: [{ ...queryPolicy.grants![0]!, target }] };
    expect(mandatePolicyAllows(bound, queryCheck)).toBe(true);
    expect(mandatePolicyAllows(bound, { ...queryCheck, call: { ...queryCall, target: { ...target, id: "other" } } })).toBe(false);
    expect(mandatePolicyAllows({ ...queryPolicy, grants: undefined }, { ...queryCheck, codeVersion: true })).toBe(true);
    expect(mandatePolicyAllows({ ...policy, grants: undefined }, { ...check, codeVersion: true })).toBe(true);
  });

  test("unattended target grants never authorize ask Actions", () => {
    expect(
      mandatePolicyAllows(policy, { ...check, codeAccount: true, actionApproval: "approved", capabilityPolicy: { ask: "sends" } }),
    ).toBe(false);
  });

  test("removing or changing coordinates is expansion; fixed inputs can narrow", () => {
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ ...grant, target: { ...target, id: "other" } }] })).toBe(false);
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ ...grant, target: undefined }] })).toBe(false);
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ ...grant, refs: undefined }] })).toBe(false);
    expect(isMandatePolicyNarrowing(policy, { ...policy, grants: [{ ...grant, fixedInput: { id: "item", title: "New" } }] })).toBe(true);
    const legacy = { ...policy, grants: [{ ...grant, target: undefined, refs: undefined }] };
    expect(isMandatePolicyNarrowing(legacy, policy)).toBe(false);
    expect(isMandatePolicyNarrowing({ ...policy, grants: undefined }, policy)).toBe(false);
  });

  test("app-wide Action authority cannot be added by a workload narrowing", () => {
    const appWide = { ...policy, grants: [{ ...grant, target: null, refs: {} }] };
    const operationOnly = { ...policy, grants: [{ ...grant, target: undefined, refs: undefined }] };
    expect(isMandatePolicyNarrowing(operationOnly, appWide)).toBe(false);
    expect(isMandatePolicyNarrowing({ ...policy, grants: undefined }, appWide)).toBe(false);
    expect(isMandatePolicyNarrowing(appWide, appWide)).toBe(true);
  });
});

test("grant references retain the declaration's case-sensitive field names", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["demo"],
    operations: ["capability.action.run:move"],
    actions: "preapproved",
    grants: [
      {
        appId: "demo",
        capabilityId: "move",
        kind: "action",
        target: { type: "demo.book", id: "a" },
        refs: { targetBookId: { type: "demo.book", id: "b" } },
      },
    ],
  });
  expect(policy.grants?.[0]).toMatchObject({ refs: { targetBookId: { type: "demo.book", id: "b" } } });
});

test("only trusted Core Code version issuance may use Core runtime.http grants", () => {
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["core"],
    operations: ["runtime.http", "runtime.database"],
    actions: "preapproved",
    grants: [{ kind: "http", fixedInput: { origin: "https://api.example:8443" } }],
  });
  const call = { appId: "core", operation: "runtime.http", actionApproval: "none" as const, input: { origin: "https://api.example:8443" } };
  expect(mandatePolicyAllows(policy, call)).toBe(false);
  expect(mandatePolicyAllows(policy, { ...call, codeVersion: true })).toBe(true);
  expect(mandatePolicyAllows(policy, { ...call, codeVersion: true, input: { origin: "https://api.example" } })).toBe(false);
  expect(mandatePolicyAllows(policy, { ...call, codeVersion: true, operation: "runtime.database" })).toBe(false);
  expect(mandatePolicyAllows(policy, { ...call, codeVersion: true, appId: "other" })).toBe(false);
});

test("personal Code operation grants retain dynamic targets alongside HTTP grants, while explicit restrictions bind", () => {
  const target = { type: "demo.book", id: "dynamic" };
  const call = { capability: "demo.move", target, refs: { destination: { ...target, id: "other" } }, input: { allowed: true } };
  const grant = { kind: "action" as const, appId: "demo", capabilityId: "move", fixedInput: { allowed: true } };
  const policy = parseMandatePolicy({
    version: 1,
    apps: ["core", "demo"],
    operations: ["runtime.http", "capability.action.run:move"],
    actions: "preapproved",
    grants: [grant, { kind: "http", fixedInput: { origin: "https://api.example" } }],
  });
  const input = {
    appId: "demo",
    operation: "capability.action.run:move",
    actionApproval: "none" as const,
    codeVersion: true,
    codeAccount: false,
    capabilityPolicy: { silent: "shared" as const },
    call,
    input: call.input,
  };
  expect(mandatePolicyAllows(policy, input)).toBe(true);
  expect(mandatePolicyAllows(policy, { ...input, codeVersion: false })).toBe(false);
  expect(mandatePolicyAllows(policy, { ...input, codeAccount: true })).toBe(false);
  expect(mandatePolicyAllows(policy, { ...input, input: { allowed: false } })).toBe(false);
  for (const restricted of [
    { ...grant, target: { ...target, id: "fixed" } },
    { ...grant, refs: {} },
  ]) {
    expect(mandatePolicyAllows({ ...policy, grants: [restricted] }, input)).toBe(false);
  }
});
