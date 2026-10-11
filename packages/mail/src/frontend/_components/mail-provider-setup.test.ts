import { describe, expect, test } from "bun:test";
import { deriveDefaultSenderSetupState } from "./mail-provider-setup";

const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "User@Example.com",
  status: "active" as const,
};

const binding = {
  id: "22222222-2222-4222-8222-222222222222",
  connectionId: connection.id,
  state: "active" as const,
};

describe("default sender setup presentation", () => {
  test("stays unavailable until the current connection has an active binding", () => {
    expect(deriveDefaultSenderSetupState(connection, null, [])).toEqual({ kind: "unavailable" });
    expect(deriveDefaultSenderSetupState(connection, { ...binding, state: "degraded" }, [])).toEqual({
      kind: "unavailable",
    });
  });

  test("treats a connected receive-only mailbox as optional sender setup", () => {
    expect(deriveDefaultSenderSetupState(connection, binding, [])).toEqual({ kind: "optional" });
  });

  test("recognizes a verified default identity case-insensitively", () => {
    const identity = {
      id: "33333333-3333-4333-8333-333333333333",
      fromAddress: "user@example.com",
      isDefault: true,
      status: "verified" as const,
      pendingVerificationCommandId: null,
    };
    expect(deriveDefaultSenderSetupState(connection, binding, [identity])).toEqual({ kind: "ready", identity });
  });

  test("exposes an existing rejected default identity for recovery", () => {
    const identity = {
      id: "44444444-4444-4444-8444-444444444444",
      fromAddress: "user@example.com",
      isDefault: true,
      status: "rejected" as const,
      pendingVerificationCommandId: null,
    };
    expect(deriveDefaultSenderSetupState(connection, binding, [identity])).toEqual({
      kind: "needs-verification",
      identity,
    });
  });

  test("shows a default identity whose verification waits behind synchronization as pending, not as failed", () => {
    const identity = {
      id: "66666666-6666-4666-8666-666666666666",
      fromAddress: "user@example.com",
      isDefault: true,
      status: "unverified" as const,
      pendingVerificationCommandId: "77777777-7777-4777-8777-777777777777",
    };
    expect(deriveDefaultSenderSetupState(connection, binding, [identity])).toEqual({ kind: "verification-pending", identity });
  });

  test("does not treat identities from another address as configured", () => {
    expect(
      deriveDefaultSenderSetupState(connection, binding, [
        {
          id: "55555555-5555-4555-8555-555555555555",
          fromAddress: "other@example.com",
          isDefault: true,
          status: "verified",
          pendingVerificationCommandId: null,
        },
      ]),
    ).toEqual({ kind: "optional" });
  });
});
