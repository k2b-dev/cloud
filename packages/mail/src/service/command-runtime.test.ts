import { describe, expect, test } from "bun:test";
import { mutationFailureState } from "./command-runtime";

describe("mail mutation failure classification", () => {
  test("never retries a mutation with a potentially partial provider side effect", () => {
    for (const code of [
      "DELETE_RECONCILIATION_FAILED",
      "FLAG_RECONCILIATION_FAILED",
      "MOVE_RECONCILIATION_FAILED",
      "REMOTE_DELETE_FAILED",
      "REMOTE_MOVE_FAILED",
    ]) {
      expect(mutationFailureState(Object.assign(new Error(code), { code })), code).toBe("needs_attention");
    }
  });

  test("reconciles transport ambiguity and fails known precondition errors", () => {
    expect(mutationFailureState(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("database"), { code: "AMBIGUOUS_LOCAL_PERSISTENCE" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("lease"), { code: "COMMAND_JOB_LEASE_LOST" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("partial state"), { code: "REMOTE_STATE_PARTIAL" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("unconfirmed state"), { code: "REMOTE_STATE_UNCONFIRMED" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("unconfirmed flags"), { code: "REMOTE_FLAGS_UNCONFIRMED" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("unconfirmed subscription"), { code: "REMOTE_SUBSCRIPTION_UNCONFIRMED" }))).toBe(
      "ambiguous",
    );
    expect(mutationFailureState(Object.assign(new Error("partial folder"), { code: "REMOTE_CREATE_SUBSCRIBE_PARTIAL" }))).toBe("ambiguous");
    expect(mutationFailureState(Object.assign(new Error("rights"), { code: "PROVIDER_RIGHTS_CHANGED" }), false)).toBe("failed");
  });

  test("never fails a command whose provider effect already started", () => {
    for (const error of [
      new Error("plain failure after the provider effect"),
      Object.assign(new Error("rights"), { code: "PROVIDER_RIGHTS_CHANGED" }),
      Object.assign(new Error("missing"), { code: "REMOTE_MESSAGE_MISSING" }),
    ]) {
      expect(mutationFailureState(error, true)).toBe("ambiguous");
      expect(mutationFailureState(error, false)).toBe("failed");
    }
  });

  test("retries connection failures that happen before a provider mutation can start", () => {
    for (const code of ["ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"]) {
      const error = Object.assign(new Error(code), { code });
      expect(mutationFailureState(error, false), code).toBe("queued");
      expect(mutationFailureState(error, true), code).toBe("ambiguous");
    }
  });
});
