import { describe, expect, test } from "bun:test";
import { actorWorkload, userFromActor } from "./actor";

// Only the fields the helpers read; the real shapes carry far more.
const user = { id: "u-1", uid: "alice" } as never;
const other = { id: "u-2", uid: "bob" } as never;

const session = { kind: "user", user } as never;
const personalKey = { kind: "service_account", delegatedUser: user, scopes: [] } as never;
const resourceKey = { kind: "service_account", delegatedUser: null, scopes: ["read"] } as never;

describe("userFromActor", () => {
  test("a session acts as itself", () => {
    expect(userFromActor(session)).toBe(user);
  });

  test("a user-delegated credential acts as its user", () => {
    expect(userFromActor(personalKey)).toBe(user);
    expect(userFromActor(personalKey)).not.toBe(other);
  });

  test("a resource-bound credential has no user", () => {
    expect(userFromActor(resourceKey)).toBeNull();
    expect(userFromActor(undefined)).toBeNull();
  });
});

describe("actorWorkload", () => {
  const person = { kind: "user", user } as never;
  const delegated = (delegation: Record<string, unknown>) =>
    ({ kind: "user", user, delegation: { kind: "invocation", credentialKind: "mandate", invocationId: "i", ...delegation } }) as never;

  test("work names its resource as owning app and workload type, for any app", () => {
    expect(actorWorkload(delegated({ callingAppId: "billing", workloadType: "sync.job", workloadId: "j1" }))).toEqual({
      type: "billing.sync.job",
      id: "j1",
    });
    expect(
      actorWorkload(
        delegated({ callingAppId: "core", workloadType: "code.version", workloadId: "v1", workloadRun: "r1", workloadOwner: "info@" }),
      ),
    ).toEqual({ type: "core.code.version", id: "v1~r1", owner: "info@" });
  });

  test("someone acting directly has no work behind them", () => {
    expect(actorWorkload(undefined)).toBeNull();
    expect(actorWorkload(person)).toBeNull();
    expect(actorWorkload(delegated({ callingAppId: "chat", credentialKind: "session" }))).toBeNull();
  });
});
